-- =========================================================
-- 20260903015535_quota_reservation_schema.sql
-- Sukima quota reservation（Free 週3回制限の予約方式）
--
--   作成日 : 2026-09-03
--   前提   : 20260901022938_billing_schema.sql
--            20260901041257_session_schema.sql
--            20260901044339_revoke_anon_table_privileges.sql
--            が適用済みであること
--
--   このファイルには秘密情報を含まない。
--     - service_role key / Project URL / Stripe キー / 環境変数は含まない
--     - google_sub / email / セッショントークンを保存も参照もしない
--
--   ⚠ 既存の migration・既存のテーブル・既存の関数定義は一切変更しない。
--     本ファイルは追加のみで構成する。
--     - users / subscriptions / weekly_usage / stripe_events / sessions : 変更なし
--     - set_updated_at() / jst_week_start()                            : 変更なし
--     - upsert_user_and_subscription() / upsert_user_and_create_session()
--       / get_session_context() / delete_session()                     : 変更なし
--     - consume_weekly_usage()  : 定義は変更しない。実行権限のみ剥奪する（8 節）
--
--   ⚠ fail-fast 方針:
--     CREATE TABLE / CREATE INDEX に IF NOT EXISTS を付けない。
--     実課金用の一度きりの migration であり、想定外に同名オブジェクトが
--     存在する状態で「静かに成功」する方が危険なため、明示的に失敗させる。
--     （20260901041257_session_schema.sql と同じ方針）
--
-- ---------------------------------------------------------
-- 方式（確定仕様）
-- ---------------------------------------------------------
--   検索の前に予約を取り、結果が出てから確定または返却する。
--
--       reserve ──▶ pending ──┬── commit ──▶ committed   （used に数える）
--                             └── release ─▶ released    （used に数えない）
--
--   - Free は 週 3 回。週の起点は JST 月曜始まり（jst_week_start() が算出）。
--   - reservation TTL = 120 秒（サーバー側固定値。呼び出し側は指定できない）。
--   - RELEASE_BUDGET = 3（週・ユーザーあたりの返却上限）。
--     最悪ケースでも 3 + 3 = 6 回で有界になる。
--   - 期限切れ pending は committed('expired') に確定する（fail closed）。
--     「commit を送らない」ことで無限に検索する攻撃を封じるため。
--   - release 予算超過は committed('release_budget_exceeded') に確定する。
--   - Web / Extension は user_id 単位で quota を共有する（surface 列を持たない）。
--
-- ---------------------------------------------------------
-- used は「行から導出する」（この設計の要）
-- ---------------------------------------------------------
--     used = COUNT(*) FROM quota_reservations
--            WHERE user_id = ? AND week_start = ?
--              AND state IN ('pending', 'committed')
--
--   加算・減算を一切行わない。これにより
--     - 二重 release による過剰返金
--     - カウンタが負になる
--     - カウンタと予約表の drift
--   が構造的に起こり得なくなる。
--
--   weekly_usage.search_count は権威ではなく、同一トランザクション内で
--   上記の COUNT に追随させる派生キャッシュに降格する。
--
-- ---------------------------------------------------------
-- ロック順（デッドロック回避）
-- ---------------------------------------------------------
--   すべての RPC が weekly_usage(user_id, week_start) 行の FOR UPDATE を
--   最初に取り、そのあとで quota_reservations に触れる。
--
--       weekly_usage  ──▶  quota_reservations   （この一方向のみ）
--
--   users 行はロックしない。ログイン処理 upsert_user_and_create_session() が
--   users 行を更新するため、users を挟むとログインとデッドロックし得る。
--   quota_reservations の FK も users ではなく weekly_usage に張ることで、
--   users 行に触れずに参照整合性を保つ。
--
--   さらに、1つの RPC 呼び出しが触る行は必ず単一の (user_id, week_start) に
--   閉じる。冪等キーの UNIQUE に week_start を含めているため、reserve が
--   別の週の予約行をロックすることがない。異なる週どうしは別の
--   weekly_usage 行で直列化されるため、循環待ちが構造的に発生しない。
--
--   実行順（上から通しで実行する。依存関係あり）:
--      1. quota_reservations テーブル
--      2. indexes
--      3. RLS 有効化 + テーブル権限
--      4. reserve_weekly_usage()  + 実行権限
--      5. commit_weekly_usage()   + 実行権限
--      6. release_weekly_usage()  + 実行権限
--      7. weekly_usage.search_count のコメント更新（派生キャッシュへの降格）
--      8. consume_weekly_usage() の実行権限剥奪
--
--   ※ 権限の REVOKE / GRANT は、対象オブジェクトの直後に置く。
--     PostgreSQL は新規関数の EXECUTE を既定で PUBLIC に与えるため、
--     途中で適用が止まっても「PUBLIC から実行できる窓」を最小化する。
-- =========================================================


-- =========================================================
-- 1. quota_reservations
--    予約1件 = 1行。週の消費実績はこの表が唯一の権威。
--
--    - FK は weekly_usage(user_id, week_start) に張る。
--      これにより「予約がある週は必ず weekly_usage 行が存在する」ことが
--      保証され、commit / release がロック対象を必ず見つけられる。
--      users への CASCADE は users → weekly_usage → quota_reservations と
--      伝播するため、直接 users を参照する必要はない（= users 行を触らない）。
--    - idempotency_key は (user_id, week_start, idempotency_key) で一意にする。
--      グローバル一意にすると、ある利用者が使った鍵を別の利用者が二度と
--      使えなくなる（他人が鍵を先占できる）。さらに週を含めないと、
--      reserve が「別の週に属する予約行」をロックし得るため、
--      weekly_usage(W1) → QR(W2) と weekly_usage(W2) → QR(W1) の
--      循環待ちが週境界の同時実行で理論上成立してしまう。
--      週を鍵に含めることで、1トランザクションが触る行が
--      単一の (user_id, week_start) に閉じ、循環が構造的に消える。
--    - state / reason / settled_at の整合は CHECK で固定する。
--      pending は必ず未確定（settled_at IS NULL / reason IS NULL）。
--    - IF NOT EXISTS は付けない。想定外の既存表があれば失敗させる。
-- =========================================================
CREATE TABLE public.quota_reservations (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL,
  week_start      DATE        NOT NULL,   -- Asia/Tokyo 基準の月曜日
  state           TEXT        NOT NULL DEFAULT 'pending',
  reason          TEXT,                   -- committed の確定理由。通常 commit は NULL
  idempotency_key TEXT        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,   -- created_at + 120 秒
  settled_at      TIMESTAMPTZ,            -- committed / released になった時刻

  -- 予約は必ず「その週の weekly_usage 行」に属する。
  -- 親行はロック対象でもあるため、存在保証をここで取る。
  CONSTRAINT quota_reservations_weekly_usage_fkey
    FOREIGN KEY (user_id, week_start)
    REFERENCES public.weekly_usage (user_id, week_start)
    ON DELETE CASCADE,

  -- 同一利用者・同一週のなかで再送を同定するための一意制約。
  -- 週を含めることで、すべてのロックが単一の (user_id, week_start) に閉じる。
  CONSTRAINT quota_reservations_user_week_idempotency_key
    UNIQUE (user_id, week_start, idempotency_key),

  CONSTRAINT quota_reservations_state_values
    CHECK (state IN ('pending', 'committed', 'released')),

  -- 状態と付随列の整合。pending に確定情報が付くことを構造的に防ぐ。
  --   pending   : 未確定。settled_at / reason は NULL
  --   committed : 確定済み。reason は NULL（通常 commit）/ 'expired' /
  --               'release_budget_exceeded' のいずれか
  --   released  : 返却済み。reason は付かない
  CONSTRAINT quota_reservations_settlement_consistency
    CHECK (
      (state = 'pending'   AND settled_at IS NULL     AND reason IS NULL)
      OR
      (state = 'committed' AND settled_at IS NOT NULL
         AND (reason IS NULL OR reason IN ('expired', 'release_budget_exceeded')))
      OR
      (state = 'released'  AND settled_at IS NOT NULL AND reason IS NULL)
    ),

  -- TTL は必ず未来向き。0 秒や負の TTL を構造的に禁止する。
  CONSTRAINT quota_reservations_expires_after_created
    CHECK (expires_at > created_at),

  -- 週の起点は必ず月曜（ISODOW = 1）。jst_week_start() 以外の値が
  -- 紛れ込んだときに DB 側で気付けるようにする。
  -- ::timestamp を明示するのは、date から timestamptz 側の関数が
  -- 選ばれると STABLE になり CHECK 制約に置けなくなるため。
  CONSTRAINT quota_reservations_week_start_is_monday
    CHECK (EXTRACT(ISODOW FROM week_start::timestamp) = 1),

  -- 鍵は不透明な識別子（UUID 等）を想定。空白・極端な長さを拒否する。
  CONSTRAINT quota_reservations_idempotency_key_format
    CHECK (length(idempotency_key) BETWEEN 8 AND 200
           AND idempotency_key !~ '\s')
);

COMMENT ON TABLE  public.quota_reservations                 IS 'Free 週3回制限の予約。used は state IN (pending, committed) の行数として導出する。加算・減算は行わない。';
COMMENT ON COLUMN public.quota_reservations.week_start      IS 'Asia/Tokyo 基準のその週の月曜日。RPC が jst_week_start() で算出する。週境界を跨いだ commit / release が「予約した週」を対象にできるよう行に保持する。';
COMMENT ON COLUMN public.quota_reservations.state           IS 'pending / committed は used に数える。released は数えない。';
COMMENT ON COLUMN public.quota_reservations.reason          IS 'committed の確定理由。NULL=通常 commit、expired=TTL 切れの fail closed、release_budget_exceeded=返却予算切れ。';
COMMENT ON COLUMN public.quota_reservations.idempotency_key IS 'クライアント生成の不透明な再送キー。(user_id, week_start, idempotency_key) で一意。同じ週での同じ鍵の再送は同じ予約行を返す。';
COMMENT ON COLUMN public.quota_reservations.expires_at      IS 'created_at + 120 秒。経過後の pending は reserve / commit / release のいずれかが committed(expired) へ確定する。';
COMMENT ON COLUMN public.quota_reservations.settled_at      IS 'committed / released が確定した時刻。pending の間は NULL。';


-- =========================================================
-- 2. indexes
--    id は PRIMARY KEY、(user_id, week_start, idempotency_key) は UNIQUE 制約が
--    索引を兼ねるため追加しない。
--
--    IF NOT EXISTS は付けない。索引名はスキーマ内で一意なので、
--    同名索引が別テーブルに存在した場合、IF NOT EXISTS だと
--    「索引が作られないまま成功」してしまう。fail-fast を優先する。
-- =========================================================

-- used の導出（user_id + week_start + state での COUNT）用。
-- FK (user_id, week_start) の親行削除時の走査にも使われる。
CREATE INDEX idx_quota_reservations_user_week_state
  ON public.quota_reservations (user_id, week_start, state);

-- 期限切れ pending の掃除用。pending 以外は対象にならないため部分索引にする。
CREATE INDEX idx_quota_reservations_pending_expires_at
  ON public.quota_reservations (expires_at)
  WHERE state = 'pending';


-- =========================================================
-- 3. RLS 有効化 + テーブル権限
--    ポリシーは1つも作らない（= anon / authenticated は全拒否）。
--    既存5テーブルと同じ方針。
--
--    RLS に加えてテーブル権限自体も剥奪する（多層防御）。
--    Supabase は public スキーマの新規テーブルに anon / authenticated へ
--    既定の GRANT を与えるため、明示的に剥奪する。
-- =========================================================
ALTER TABLE public.quota_reservations ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.quota_reservations FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.quota_reservations TO service_role;


-- =========================================================
-- 4. reserve_weekly_usage(UUID, TEXT, INT)
--    検索の直前に1回分を予約する。
--
--    引数:
--      p_user_id         : users.id。セッションから導出した値のみを渡す。
--                          クライアント入力を直接渡してはならない。
--      p_idempotency_key : クライアント生成の不透明な再送キー。
--      p_limit           : 週あたりの上限（Free = 3）。plan → 上限の対応は
--                          呼び出し側（API）が持つ。TTL は引数にしない
--                          （120 秒はサーバー側固定値）。
--
--    戻り値（常に 1 行）:
--      allowed        : 検索してよいか
--      code           : 'ok' / 'limit_reached' / 'already_settled'
--      reused         : 現在週に同じ鍵の予約行が既にあったか（再送）
--      reservation_id : allowed のときのみ非 NULL
--      week_start     : 現在週（ロックを保持している週）
--      used           : 現在週の used（新規予約を含む）
--      remaining      : GREATEST(p_limit - used, 0)
--      expires_at     : allowed のときのみ非 NULL
--
--    allowed = FALSE のとき reservation_id / expires_at を NULL にするのは、
--    呼び出し側が誤って別状態の予約 ID を掴んで commit しないようにするため。
--
--    処理順:
--      0. 引数検証（不正なら例外。行に触れない）
--      1. v_week_start := jst_week_start() / v_now := now()
--      2. weekly_usage 行を確保して FOR UPDATE（直列化点）
--      3. lazy reclaim：現在週の期限切れ pending を committed('expired') へ
--      4. 冪等キーの照会（★必ずロック取得後。理由は下記）
--      5. used を COUNT で導出
--      6. 再利用 / 上限 / 新規予約の判定
--      7. weekly_usage.search_count を used に追随（派生キャッシュ）
--
--    ★ 4 をロック取得後に置く理由:
--      同じ鍵の同時2重送信では、後続トランザクションが 2 のロック待ちで
--      止まる。ロック取得後に照会すれば、先行トランザクションが commit した
--      予約行を新しいスナップショットで確実に見つけられる（READ COMMITTED）。
--      ロック前に照会すると両方が「無い」と判断し、UNIQUE 違反で落ちる。
--
--    lazy reclaim は used を変えない。pending も committed も used に数える
--    ためであり、これが「commit しない」攻撃に対する fail closed の実体。
--
--    列参照はすべて weekly_usage. / quota_reservations. で修飾する。
--    RETURNS TABLE の列名と同名の PL/pgSQL 変数が作られ、修飾しないと
--    "column reference is ambiguous" になるため（既存 RPC と同じ理由）。
-- =========================================================
CREATE OR REPLACE FUNCTION public.reserve_weekly_usage(
  p_user_id         UUID,
  p_idempotency_key TEXT,
  p_limit           INT DEFAULT 3
)
RETURNS TABLE (
  allowed        BOOLEAN,
  code           TEXT,
  reused         BOOLEAN,
  reservation_id UUID,
  week_start     DATE,
  used           INT,
  remaining      INT,
  expires_at     TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now         TIMESTAMPTZ;
  v_week_start  DATE;
  v_locked      BOOLEAN := FALSE;
  v_cached      INT;
  v_used        INT;
  v_allowed     BOOLEAN;
  v_code        TEXT;
  v_reused      BOOLEAN;
  v_ret_id      UUID        := NULL;
  v_ret_expires TIMESTAMPTZ := NULL;
  v_row_id      UUID;
  v_row_state   TEXT;
  v_row_expires TIMESTAMPTZ;
  v_ttl         CONSTANT INTERVAL := INTERVAL '120 seconds';
BEGIN
  -- Step 0: 引数検証。DB を触る前に落とす。
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id は必須です。';
  END IF;
  IF p_idempotency_key IS NULL
     OR length(p_idempotency_key) NOT BETWEEN 8 AND 200
     OR p_idempotency_key ~ '\s' THEN
    RAISE EXCEPTION 'p_idempotency_key は空白を含まない 8〜200 文字である必要があります。';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 THEN
    RAISE EXCEPTION 'p_limit は 1 以上である必要があります。';
  END IF;

  -- Step 1: 対象週と基準時刻を DB 側で確定する（クライアントの時計は使わない）
  v_week_start := public.jst_week_start();
  v_now        := now();

  -- Step 2: 対象週の weekly_usage 行を確保し、行ロックを取る（直列化点）
  --   行が無ければ作る。作成競合は unique_violation で検知し、
  --   次の周回で SELECT ... FOR UPDATE 側に合流する。
  --   自分で INSERT できた場合、その行はこのトランザクションが保持している。
  FOR v_attempt IN 1..3 LOOP
    SELECT weekly_usage.search_count
    INTO   v_cached
    FROM   public.weekly_usage
    WHERE  weekly_usage.user_id    = p_user_id
      AND  weekly_usage.week_start = v_week_start
    FOR    UPDATE;

    IF FOUND THEN
      v_locked := TRUE;
      EXIT;
    END IF;

    BEGIN
      INSERT INTO public.weekly_usage (user_id, week_start, search_count)
      VALUES (p_user_id, v_week_start, 0);
      v_locked := TRUE;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      NULL;   -- 競合。次の周回で行ロックを取りに行く
    END;
  END LOOP;

  IF NOT v_locked THEN
    RAISE EXCEPTION 'weekly_usage の行ロックを取得できませんでした。';
  END IF;

  -- Step 3: lazy reclaim（現在週のみ）
  --   期限切れ pending を committed('expired') に確定する。
  --   used は変わらない（pending も committed も used に数えるため）。
  UPDATE public.quota_reservations
  SET    state      = 'committed',
         reason     = 'expired',
         settled_at = v_now
  WHERE  quota_reservations.user_id    = p_user_id
    AND  quota_reservations.week_start = v_week_start
    AND  quota_reservations.state      = 'pending'
    AND  quota_reservations.expires_at <= v_now;

  -- Step 4: 冪等キーの照会（現在週に限定する）
  --   週を跨いだ鍵の再送は「別の週の新しい予約」として扱う。
  --   触る行を単一の (user_id, week_start) に閉じるための限定でもある。
  SELECT quota_reservations.id,
         quota_reservations.state,
         quota_reservations.expires_at
  INTO   v_row_id, v_row_state, v_row_expires
  FROM   public.quota_reservations
  WHERE  quota_reservations.user_id         = p_user_id
    AND  quota_reservations.week_start      = v_week_start
    AND  quota_reservations.idempotency_key = p_idempotency_key
  FOR    UPDATE;

  v_reused := FOUND;   -- 直後に別クエリを走らせる前に確定させる

  -- Step 5: used を導出する（加算はしない）
  SELECT COUNT(*)::INT
  INTO   v_used
  FROM   public.quota_reservations
  WHERE  quota_reservations.user_id    = p_user_id
    AND  quota_reservations.week_start = v_week_start
    AND  quota_reservations.state IN ('pending', 'committed');

  -- Step 6: 再利用 / 上限 / 新規予約
  IF v_reused THEN
    IF v_row_state = 'pending'
       AND v_row_expires > v_now THEN
      -- 有効な予約の再送。同じ予約をそのまま返す。
      v_allowed     := TRUE;
      v_code        := 'ok';
      v_ret_id      := v_row_id;
      v_ret_expires := v_row_expires;
    ELSE
      -- 確定済み / 返却済み / 期限切れ。
      -- 新しい鍵で取り直させる（この週のこの鍵では二度と予約を発行しない）。
      v_allowed := FALSE;
      v_code    := 'already_settled';
    END IF;

  ELSIF v_used >= p_limit THEN
    v_allowed := FALSE;
    v_code    := 'limit_reached';

  ELSE
    INSERT INTO public.quota_reservations (
      user_id, week_start, state, idempotency_key, created_at, expires_at
    )
    VALUES (
      p_user_id, v_week_start, 'pending', p_idempotency_key, v_now, v_now + v_ttl
    )
    RETURNING quota_reservations.id, quota_reservations.expires_at
    INTO      v_ret_id, v_ret_expires;

    v_used    := v_used + 1;
    v_allowed := TRUE;
    v_code    := 'ok';
  END IF;

  -- Step 7: 派生キャッシュを追随させる（値が変わるときだけ書く）
  UPDATE public.weekly_usage
  SET    search_count = v_used
  WHERE  weekly_usage.user_id      = p_user_id
    AND  weekly_usage.week_start   = v_week_start
    AND  weekly_usage.search_count IS DISTINCT FROM v_used;

  RETURN QUERY SELECT v_allowed, v_code, v_reused, v_ret_id, v_week_start,
                      v_used, GREATEST(p_limit - v_used, 0), v_ret_expires;
END;
$$;

COMMENT ON FUNCTION public.reserve_weekly_usage(UUID, TEXT, INT) IS
  '検索前に1回分を予約する。week_start は jst_week_start() で内部算出、TTL は 120 秒固定。p_user_id はセッションから導出した users.id のみ。server-side function（service_role）からのみ呼ぶ。';

-- 実行権限：service_role のみ。CREATE の直後に置く。
--   剥奪しないと anon キーだけで任意の user_id の quota を消費できてしまう。
REVOKE ALL ON FUNCTION public.reserve_weekly_usage(UUID, TEXT, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reserve_weekly_usage(UUID, TEXT, INT) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.reserve_weekly_usage(UUID, TEXT, INT) TO service_role;


-- =========================================================
-- 5. commit_weekly_usage(UUID, UUID)
--    検索が成功したときに予約を確定する。
--
--    状態遷移:
--      pending（有効）      → committed              / ok
--      pending（期限切れ）  → committed('expired')   / ok
--      committed            → 変化なし               / ok（冪等）
--      released             → 変化なし               / ng（already_committed の逆）
--      存在しない・他人の予約 → ng（not_found）
--
--    期限切れ pending も ok にするのは、検索自体は成功しており、
--    どちらに転んでも committed（= used に数える）で確定するため。
--    区別は quota_reservations.reason に残す。
--
--    戻り値（常に 1 行）:
--      ok    : 呼び出しが成功したか
--      code  : 'ok' / 'not_found' / 'already_released'
--      state : 処理後の予約の状態（not_found のときは NULL）
--      used  : その予約の週の used（not_found のときは NULL）
--
--    ロック順は reserve と同じ weekly_usage → quota_reservations。
--    週を知るための先読みだけロック無しで行う（週は行の生成後に変わらない）。
--
--    p_limit を取らないため remaining は返さない。上限は呼び出し側が持つ。
-- =========================================================
CREATE OR REPLACE FUNCTION public.commit_weekly_usage(
  p_user_id        UUID,
  p_reservation_id UUID
)
RETURNS TABLE (
  ok    BOOLEAN,
  code  TEXT,
  state TEXT,
  used  INT
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now         TIMESTAMPTZ;
  v_week_start  DATE;
  v_cached      INT;
  v_used        INT;
  v_row_state   TEXT;
  v_row_expires TIMESTAMPTZ;
  v_ok          BOOLEAN;
  v_code        TEXT;
  v_state       TEXT;
BEGIN
  IF p_user_id IS NULL OR p_reservation_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id と p_reservation_id は必須です。';
  END IF;

  v_now := now();

  -- Step 1: 週の先読み（ロック無し）
  --   week_start は行の生成後に変化しないため、ロック前に読んでよい。
  --   user_id も条件に入れることで他人の予約に触れられないようにする。
  SELECT quota_reservations.week_start
  INTO   v_week_start
  FROM   public.quota_reservations
  WHERE  quota_reservations.id      = p_reservation_id
    AND  quota_reservations.user_id = p_user_id;

  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, 'not_found'::TEXT, NULL::TEXT, NULL::INT;
    RETURN;
  END IF;

  -- Step 2: 親の weekly_usage 行をロックする（直列化点）
  --   FK があるため必ず存在する。無ければ不変条件の破れなので失敗させる。
  SELECT weekly_usage.search_count
  INTO   v_cached
  FROM   public.weekly_usage
  WHERE  weekly_usage.user_id    = p_user_id
    AND  weekly_usage.week_start = v_week_start
  FOR    UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION '予約に対応する weekly_usage 行がありません（不変条件違反）。';
  END IF;

  -- Step 3: ロック取得後に予約を読み直す（待たされている間の変化を取り込む）
  SELECT quota_reservations.state, quota_reservations.expires_at
  INTO   v_row_state, v_row_expires
  FROM   public.quota_reservations
  WHERE  quota_reservations.id      = p_reservation_id
    AND  quota_reservations.user_id = p_user_id
  FOR    UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, 'not_found'::TEXT, NULL::TEXT, NULL::INT;
    RETURN;
  END IF;

  -- Step 4: 状態遷移
  IF v_row_state = 'pending' THEN
    UPDATE public.quota_reservations
    SET    state      = 'committed',
           reason     = CASE WHEN v_row_expires <= v_now THEN 'expired' ELSE NULL END,
           settled_at = v_now
    WHERE  quota_reservations.id      = p_reservation_id
      AND  quota_reservations.user_id = p_user_id;

    v_ok    := TRUE;
    v_code  := 'ok';
    v_state := 'committed';

  ELSIF v_row_state = 'committed' THEN
    -- 冪等。reason（expired / release_budget_exceeded）は上書きしない。
    v_ok    := TRUE;
    v_code  := 'ok';
    v_state := 'committed';

  ELSE
    -- released。返却済みの予約は確定できない。
    v_ok    := FALSE;
    v_code  := 'already_released';
    v_state := 'released';
  END IF;

  -- Step 5: used を導出し、派生キャッシュを追随させる
  SELECT COUNT(*)::INT
  INTO   v_used
  FROM   public.quota_reservations
  WHERE  quota_reservations.user_id    = p_user_id
    AND  quota_reservations.week_start = v_week_start
    AND  quota_reservations.state IN ('pending', 'committed');

  UPDATE public.weekly_usage
  SET    search_count = v_used
  WHERE  weekly_usage.user_id      = p_user_id
    AND  weekly_usage.week_start   = v_week_start
    AND  weekly_usage.search_count IS DISTINCT FROM v_used;

  RETURN QUERY SELECT v_ok, v_code, v_state, v_used;
END;
$$;

COMMENT ON FUNCTION public.commit_weekly_usage(UUID, UUID) IS
  '検索成功時に予約を確定する。pending / committed は冪等に ok、released は ng。p_user_id はセッションから導出した users.id のみ。server-side function（service_role）からのみ呼ぶ。';

-- 実行権限：service_role のみ。CREATE の直後に置く。
REVOKE ALL ON FUNCTION public.commit_weekly_usage(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commit_weekly_usage(UUID, UUID) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.commit_weekly_usage(UUID, UUID) TO service_role;


-- =========================================================
-- 6. release_weekly_usage(UUID, UUID)
--    検索が失敗したときに予約を返却する（1回分を返金する）。
--
--    状態遷移:
--      pending（有効・予算内）  → released                          / ok
--      pending（有効・予算切れ）→ committed('release_budget_exceeded') / ng
--      pending（期限切れ）      → committed('expired')              / ng
--      committed                → 変化なし                          / ng
--      released                 → 変化なし                          / ok（冪等）
--      存在しない・他人の予約   → ng（not_found）
--
--    判定順は「期限切れ → 予算」。期限切れは予算の有無に関わらず
--    committed('expired') に確定する（fail closed が優先）。
--
--    RELEASE_BUDGET = 3。予算の消費量は「その週に released になった行数」で
--    数える。予算切れで committed('release_budget_exceeded') になった行は
--    予算を消費しない（すでに使い切っているため）。
--    これにより 1 週間の検索回数は最悪でも 3（quota）+ 3（返却分の再予約）
--    = 6 回で有界になる。
--
--    クライアント主導の返却はサーバー側で真偽を検証できない（受容済み）。
--    Origin 検証は cross-site を防ぐだけで、正規セッションの持ち主が
--    意図的に release を送ることは防げない。RELEASE_BUDGET はその上限装置。
--
--    戻り値（常に 1 行）:
--      ok    : 呼び出しが成功したか（= 返却できたか）
--      code  : 'ok' / 'not_found' / 'expired' /
--              'release_budget_exceeded' / 'already_committed'
--      state : 処理後の予約の状態（not_found のときは NULL）
--      used  : その予約の週の used（not_found のときは NULL）
-- =========================================================
CREATE OR REPLACE FUNCTION public.release_weekly_usage(
  p_user_id        UUID,
  p_reservation_id UUID
)
RETURNS TABLE (
  ok    BOOLEAN,
  code  TEXT,
  state TEXT,
  used  INT
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now         TIMESTAMPTZ;
  v_week_start  DATE;
  v_cached      INT;
  v_used        INT;
  v_released    INT;
  v_row_state   TEXT;
  v_row_expires TIMESTAMPTZ;
  v_ok          BOOLEAN;
  v_code        TEXT;
  v_state       TEXT;
  v_budget      CONSTANT INT := 3;   -- RELEASE_BUDGET
BEGIN
  IF p_user_id IS NULL OR p_reservation_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id と p_reservation_id は必須です。';
  END IF;

  v_now := now();

  -- Step 1: 週の先読み（ロック無し。week_start は不変）
  SELECT quota_reservations.week_start
  INTO   v_week_start
  FROM   public.quota_reservations
  WHERE  quota_reservations.id      = p_reservation_id
    AND  quota_reservations.user_id = p_user_id;

  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, 'not_found'::TEXT, NULL::TEXT, NULL::INT;
    RETURN;
  END IF;

  -- Step 2: 親の weekly_usage 行をロックする（直列化点）
  SELECT weekly_usage.search_count
  INTO   v_cached
  FROM   public.weekly_usage
  WHERE  weekly_usage.user_id    = p_user_id
    AND  weekly_usage.week_start = v_week_start
  FOR    UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION '予約に対応する weekly_usage 行がありません（不変条件違反）。';
  END IF;

  -- Step 3: ロック取得後に予約を読み直す
  SELECT quota_reservations.state, quota_reservations.expires_at
  INTO   v_row_state, v_row_expires
  FROM   public.quota_reservations
  WHERE  quota_reservations.id      = p_reservation_id
    AND  quota_reservations.user_id = p_user_id
  FOR    UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, 'not_found'::TEXT, NULL::TEXT, NULL::INT;
    RETURN;
  END IF;

  -- Step 4: 状態遷移
  IF v_row_state = 'released' THEN
    -- 冪等。二重 release でも used は減らない（そもそも減算しない）。
    v_ok    := TRUE;
    v_code  := 'ok';
    v_state := 'released';

  ELSIF v_row_state = 'committed' THEN
    v_ok    := FALSE;
    v_code  := 'already_committed';
    v_state := 'committed';

  ELSIF v_row_expires <= v_now THEN
    -- 期限切れ pending は予算に関係なく committed('expired') で確定する。
    UPDATE public.quota_reservations
    SET    state      = 'committed',
           reason     = 'expired',
           settled_at = v_now
    WHERE  quota_reservations.id      = p_reservation_id
      AND  quota_reservations.user_id = p_user_id;

    v_ok    := FALSE;
    v_code  := 'expired';
    v_state := 'committed';

  ELSE
    -- 有効な pending。返却予算を数える（released になった行数）。
    SELECT COUNT(*)::INT
    INTO   v_released
    FROM   public.quota_reservations
    WHERE  quota_reservations.user_id    = p_user_id
      AND  quota_reservations.week_start = v_week_start
      AND  quota_reservations.state      = 'released';

    IF v_released >= v_budget THEN
      UPDATE public.quota_reservations
      SET    state      = 'committed',
             reason     = 'release_budget_exceeded',
             settled_at = v_now
      WHERE  quota_reservations.id      = p_reservation_id
        AND  quota_reservations.user_id = p_user_id;

      v_ok    := FALSE;
      v_code  := 'release_budget_exceeded';
      v_state := 'committed';
    ELSE
      UPDATE public.quota_reservations
      SET    state      = 'released',
             reason     = NULL,
             settled_at = v_now
      WHERE  quota_reservations.id      = p_reservation_id
        AND  quota_reservations.user_id = p_user_id;

      v_ok    := TRUE;
      v_code  := 'ok';
      v_state := 'released';
    END IF;
  END IF;

  -- Step 5: used を導出し、派生キャッシュを追随させる
  SELECT COUNT(*)::INT
  INTO   v_used
  FROM   public.quota_reservations
  WHERE  quota_reservations.user_id    = p_user_id
    AND  quota_reservations.week_start = v_week_start
    AND  quota_reservations.state IN ('pending', 'committed');

  UPDATE public.weekly_usage
  SET    search_count = v_used
  WHERE  weekly_usage.user_id      = p_user_id
    AND  weekly_usage.week_start   = v_week_start
    AND  weekly_usage.search_count IS DISTINCT FROM v_used;

  RETURN QUERY SELECT v_ok, v_code, v_state, v_used;
END;
$$;

COMMENT ON FUNCTION public.release_weekly_usage(UUID, UUID) IS
  '検索失敗時に予約を返却する。RELEASE_BUDGET は週3回。期限切れ / 予算切れは committed で確定し ng を返す。p_user_id はセッションから導出した users.id のみ。server-side function（service_role）からのみ呼ぶ。';

-- 実行権限：service_role のみ。CREATE の直後に置く。
REVOKE ALL ON FUNCTION public.release_weekly_usage(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_weekly_usage(UUID, UUID) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.release_weekly_usage(UUID, UUID) TO service_role;


-- =========================================================
-- 7. weekly_usage.search_count を「派生キャッシュ」に降格する
--
--    テーブル定義は変更しない。COMMENT だけを更新して、
--    権威が quota_reservations 側に移ったことを DB 上に明記する。
--
--    以後 search_count は
--      COUNT(*) FROM quota_reservations
--       WHERE user_id / week_start が一致し state IN ('pending','committed')
--    に同一トランザクション内で追随するだけの値であり、
--    これを読んで上限判定してはならない。
-- =========================================================
COMMENT ON COLUMN public.weekly_usage.search_count IS
  '派生キャッシュ。権威は quota_reservations（state IN (pending, committed) の行数）。reserve / commit / release が同一トランザクション内で追随させる。この値を読んで上限判定しないこと。';


-- =========================================================
-- 8. consume_weekly_usage(UUID) の実行権限を剥奪する
--
--    予約方式に置き換わったため、この RPC は使わない。
--    定義は残す（履歴・ロールバック検討のため）が、誤って呼ばれないよう
--    service_role からも EXECUTE を剥奪する。
--
--    この関数は search_count を +1 する加算方式であり、
--    quota_reservations から導出される used と drift する。
--    呼ばれた場合、次の reserve / commit / release が search_count を
--    導出値へ上書きするためデータ破壊には至らないが、
--    その間だけ利用者の残回数表示がずれる。
--
--    REVOKE は冪等（既に権限が無くてもエラーにならない）。
-- =========================================================
REVOKE ALL ON FUNCTION public.consume_weekly_usage(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.consume_weekly_usage(UUID) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.consume_weekly_usage(UUID) FROM service_role;

COMMENT ON FUNCTION public.consume_weekly_usage(UUID) IS
  '【非推奨・実行権限なし】加算方式の旧 quota 消費 RPC。20260903015535_quota_reservation_schema.sql で予約方式（reserve / commit / release）に置き換えた。定義のみ残す。';


-- =========================================================
-- 適用後の期待状態（読み取り専用。この migration には含めず手元で実行する）
--
--   1) テーブルと権限
--        SELECT c.relname, c.relrowsecurity,
--               (SELECT string_agg(a::text, ' | ') FROM unnest(c.relacl) a) AS acl
--        FROM   pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--        WHERE  n.nspname = 'public' AND c.relname = 'quota_reservations';
--
--      期待：relrowsecurity = t
--            acl は postgres=arwdDxtm/postgres | service_role=arwd.../postgres
--            anon / authenticated のエントリが無いこと
--
--   2) ポリシーが 0 件であること
--        SELECT count(*) FROM pg_policies
--        WHERE  schemaname = 'public' AND tablename = 'quota_reservations';
--
--   3) 3 RPC の実行権限
--        SELECT p.proname, p.proacl
--        FROM   pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--        WHERE  n.nspname = 'public'
--          AND  p.proname IN ('reserve_weekly_usage', 'commit_weekly_usage',
--                             'release_weekly_usage', 'consume_weekly_usage');
--
--      期待：前3つは service_role=X/postgres のみ
--            consume_weekly_usage は service_role の X が消えていること
--
-- ---------------------------------------------------------
-- 掃除方針
-- ---------------------------------------------------------
--   quota_reservations の行は増え続ける。
--   v1 は reserve 内の lazy reclaim（現在週の期限切れ pending を
--   committed('expired') に確定する）のみを行い、行の削除はしない。
--
--   過去週の行は used の判定に使われないが残り続けるため、
--   将来 Cloudflare Cron Trigger などで
--     DELETE FROM public.quota_reservations WHERE week_start < (現在週 - 8週);
--   のような定期削除を別途決めること。
--   （20260901041257_session_schema.sql の sessions と同じ扱い）
--
--   weekly_usage 側は user 削除時に CASCADE で消え、
--   quota_reservations も weekly_usage への FK CASCADE で連鎖して消える。
--
-- =========================================================
-- 以上。
-- =========================================================

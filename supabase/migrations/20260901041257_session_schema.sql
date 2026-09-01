-- =========================================================
-- 20260901041257_session_schema.sql
-- Sukima サーバーセッション（Cloudflare Pages Functions 用）
--
--   作成日 : 2026-09-01
--   前提   : 20260901022938_billing_schema.sql が適用済みであること
--            （users / subscriptions / weekly_usage / stripe_events）
--
--   目的:
--     Google ID Token での認証結果を、Sukima 独自の不透明セッションとして
--     サーバー側で管理する。クライアントには HttpOnly Cookie を渡すだけで、
--     内部 ID・プラン判定材料は一切渡さない。
--
--   このファイルには秘密情報を含まない。
--     - セッションの生トークンは DB に保存しない（SHA-256 ハッシュのみ）
--     - service_role key / Project URL / Stripe キーは含まない
--
--   ⚠ 既存の migration・既存のテーブル・既存の関数は一切変更しない。
--     本ファイルは追加のみで構成する。
--     - users / subscriptions / weekly_usage / stripe_events : 変更なし
--     - set_updated_at() / jst_week_start()                  : 変更なし
--     - upsert_user_and_subscription() / consume_weekly_usage() : 変更なし
--
--   ⚠ fail-fast 方針:
--     CREATE TABLE / CREATE INDEX に IF NOT EXISTS を付けない。
--     実課金用の一度きりの migration であり、想定外に同名オブジェクトが
--     存在する状態で「静かに成功」する方が危険なため、明示的に失敗させる。
--
--   有効期限モデル（確定仕様）:
--     - ログイン時 : idle_expires_at = now + 30日
--                    absolute_expires_at = now + 90日
--     - 利用時     : idle_expires_at = LEAST(now + 30日, absolute_expires_at)
--     - absolute_expires_at はログイン後、絶対に延長しない
--     - 常に idle_expires_at <= absolute_expires_at（CHECK 制約で保証）
--     - 有効判定   : now < LEAST(idle_expires_at, absolute_expires_at)
--     - 90日到達または30日放置 → セッション無効 → Google 再ログイン
--     - 複数端末のセッションを同時に許可する（再ログインで他端末を切らない）
--
--   実行順（上から通しで実行する。依存関係あり）:
--      1. sessions テーブル
--      2. indexes
--      3. RLS 有効化 + テーブル権限
--      4. upsert_user_and_create_session() + 実行権限
--      5. get_session_context()             + 実行権限
--      6. delete_session()                  + 実行権限
--
--   ※ 権限の REVOKE / GRANT は、対象オブジェクトの直後に置いている。
--     PostgreSQL は新規関数の EXECUTE を既定で PUBLIC に与えるため、
--     途中で適用が止まっても「PUBLIC から実行できる窓」を最小化する。
-- =========================================================


-- =========================================================
-- 1. sessions
--    不透明なランダムトークンによるサーバーセッション。
--
--    - token_hash は SHA-256(生トークン) の小文字 hex 64文字。
--      生トークンは DB に保存しない。DB が漏れてもセッションを再現できない。
--    - plan_id / status はここに持たない。権限の正は subscriptions。
--      これにより Stripe webhook による変更が次のリクエストで即反映される。
--    - updated_at は持たない（last_seen_at がその役割を担う）ため、
--      set_updated_at トリガの対象外。stripe_events と同じ扱い。
--    - IF NOT EXISTS は付けない。想定外の既存 sessions があれば失敗させる。
-- =========================================================
CREATE TABLE public.sessions (
  token_hash          TEXT        PRIMARY KEY,
  user_id             UUID        NOT NULL
                        REFERENCES public.users(id) ON DELETE CASCADE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  idle_expires_at     TIMESTAMPTZ NOT NULL,   -- 利用のたびに延長（上限あり）
  absolute_expires_at TIMESTAMPTZ NOT NULL,   -- ログイン時に確定。以後不変

  -- 生トークンを誤って保存しないための形式検査。
  -- SHA-256 の hex は小文字64文字で固定。
  CONSTRAINT sessions_token_hash_format
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),

  -- idle は absolute を絶対に超えない。延長ロジックのバグを DB 側で塞ぐ。
  CONSTRAINT sessions_idle_within_absolute
    CHECK (idle_expires_at <= absolute_expires_at),

  -- absolute は必ず作成時より未来。
  CONSTRAINT sessions_absolute_after_created
    CHECK (absolute_expires_at > created_at)
);

COMMENT ON TABLE  public.sessions                     IS 'Sukima のサーバーセッション。Cookie には不透明なランダムトークンのみを載せ、DB にはその SHA-256 ハッシュだけを保存する。';
COMMENT ON COLUMN public.sessions.token_hash          IS 'SHA-256(生トークン) の小文字 hex 64文字。生トークンは保存しない。';
COMMENT ON COLUMN public.sessions.last_seen_at        IS '最終利用時刻。書き込み削減のため idle 期限が実際に前進したときにのみ更新する。';
COMMENT ON COLUMN public.sessions.idle_expires_at     IS '無操作期限。利用のたびに LEAST(now + 30日, absolute_expires_at) へ延長する。';
COMMENT ON COLUMN public.sessions.absolute_expires_at IS 'セッションの絶対期限（ログイン時 + 90日）。いかなる場合も延長しない。';


-- =========================================================
-- 2. indexes
--    token_hash は PRIMARY KEY が索引を兼ねるため追加しない。
--
--    IF NOT EXISTS は付けない。索引名はスキーマ内で一意なので、
--    同名索引が別テーブルに存在した場合、IF NOT EXISTS だと
--    「索引が作られないまま成功」してしまう。fail-fast を優先する。
-- =========================================================

-- ユーザー単位の走査（将来の全端末ログアウト・ユーザー削除時の CASCADE）用。
CREATE INDEX idx_sessions_user_id
  ON public.sessions (user_id);

-- 期限切れセッションの一括掃除用。
-- idle_expires_at <= absolute_expires_at が保証されているため、
-- idle_expires_at < now() だけで両方の期限切れを拾える。
CREATE INDEX idx_sessions_idle_expires_at
  ON public.sessions (idle_expires_at);


-- =========================================================
-- 3. RLS 有効化 + テーブル権限
--    ポリシーは1つも作らない（= anon / authenticated は全拒否）。
--    既存4テーブルと同じ方針。
--
--    RLS に加えてテーブル権限自体も剥奪する（多層防御）。
--    Supabase は public スキーマの新規テーブルに anon / authenticated へ
--    既定の GRANT を与えるため、明示的に剥奪する。
-- =========================================================
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.sessions FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.sessions TO service_role;


-- =========================================================
-- 4. upsert_user_and_create_session(TEXT, TEXT, TEXT)
--    ログイン時に users / subscriptions を用意し、新しいセッションを発行する。
--
--    既存の upsert_user_and_subscription() は変更せず、そのまま残す。
--    本関数は同じ upsert ロジックを内包したうえでセッション作成まで行う。
--    users の id を関数外へ出さずに済ませるため、呼び出しは1往復で完結する。
--
--    設計上の要点:
--      - users は ON CONFLICT DO UPDATE。DO NOTHING では競合時に RETURNING が
--        空になり user_id を取得できないため。email 以外は書き換えない。
--      - subscriptions は ON CONFLICT (user_id) DO NOTHING。
--        既存の有料 subscription を絶対に上書きしない。
--      - セッションは毎回新規 INSERT。クライアントから渡された値を昇格させない
--        （session fixation 対策）。既存の他端末セッションは削除しない。
--      - token_hash が既に存在する場合は PRIMARY KEY 違反で例外になる。
--        256bit 乱数の SHA-256 が衝突することは実質ないため、
--        これが起きるのはトークン再利用のバグか攻撃であり、失敗させるのが正しい。
--      - now() は v_now に1回だけ固定し、created_at / last_seen_at /
--        idle_expires_at / absolute_expires_at をすべて同一基準から導出する。
--      - 全体が1つの関数呼び出し = 1トランザクション。
--        users / subscriptions / sessions の整合が崩れない。
--      - p_google_sub には検証済み ID Token の sub のみが渡される
--        （バックエンド Function 側で保証。クライアントからは受け取らない）。
--      - 戻り値に user_id は含めない。
-- =========================================================
CREATE OR REPLACE FUNCTION public.upsert_user_and_create_session(
  p_google_sub TEXT,
  p_token_hash TEXT,
  p_email      TEXT DEFAULT NULL
)
RETURNS TABLE (
  plan_id             TEXT,
  status              TEXT,
  idle_expires_at     TIMESTAMPTZ,
  absolute_expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id  UUID;
  v_now      TIMESTAMPTZ;
  v_idle     TIMESTAMPTZ;
  v_abs      TIMESTAMPTZ;
  v_idle_ttl CONSTANT INTERVAL := INTERVAL '30 days';
  v_abs_ttl  CONSTANT INTERVAL := INTERVAL '90 days';
BEGIN
  IF p_google_sub IS NULL OR length(trim(p_google_sub)) = 0 THEN
    RAISE EXCEPTION 'p_google_sub は必須です。';
  END IF;
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'p_token_hash は SHA-256 の小文字 hex 64文字である必要があります。';
  END IF;

  -- users: なければ作成、あれば email だけ追随させて id を得る
  INSERT INTO public.users (google_sub, email)
  VALUES (p_google_sub, p_email)
  ON CONFLICT (google_sub) DO UPDATE
    SET email = COALESCE(EXCLUDED.email, public.users.email)
  RETURNING id INTO v_user_id;

  -- subscriptions: Free ユーザーも必ず1行持つ
  INSERT INTO public.subscriptions (user_id, plan_id, status, cancel_at_period_end)
  VALUES (v_user_id, 'free', 'active', false)
  ON CONFLICT (user_id) DO NOTHING;

  -- sessions: 新しいセッションを発行する
  v_now  := now();
  v_idle := v_now + v_idle_ttl;
  v_abs  := v_now + v_abs_ttl;

  INSERT INTO public.sessions (
    token_hash, user_id, created_at, last_seen_at, idle_expires_at, absolute_expires_at
  )
  VALUES (p_token_hash, v_user_id, v_now, v_now, v_idle, v_abs);

  RETURN QUERY
    SELECT s.plan_id, s.status, v_idle, v_abs
    FROM   public.subscriptions s
    WHERE  s.user_id = v_user_id;
END;
$$;

COMMENT ON FUNCTION public.upsert_user_and_create_session(TEXT, TEXT, TEXT) IS
  'ログイン時に users / subscriptions を用意し、新しいセッションを発行する。google_sub は検証済み ID Token の sub のみ。token_hash は SHA-256 hex。server-side function からのみ呼ぶ。';

-- 実行権限：service_role のみ。
--   PostgreSQL は新規関数の EXECUTE を既定で PUBLIC に与える。剥奪しないと
--   anon キーだけで任意の google_sub のセッションを発行できてしまう。
--   CREATE の直後に置き、PUBLIC から実行できる窓を最小化する。
REVOKE ALL ON FUNCTION public.upsert_user_and_create_session(TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_user_and_create_session(TEXT, TEXT, TEXT) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.upsert_user_and_create_session(TEXT, TEXT, TEXT) TO service_role;


-- =========================================================
-- 5. get_session_context(TEXT)
--    セッション検証・idle 延長・subscription 取得を 1 往復で行う。
--
--    戻り値:
--      - 0 行 : セッションが存在しない、または期限切れ（呼び出し側は 401 にする）
--      - 1 行 : 有効。plan_id / status が NULL の場合は subscriptions 行の欠落を
--               意味するデータ異常なので、呼び出し側は 401 ではなくサーバー
--               エラーとして扱うこと（フェイルクローズ）。
--
--    競合と冪等性:
--      - SELECT ... FOR UPDATE で対象行をロックするため、同一セッションへの
--        同時リクエストは直列化される。idle 延長が二重に走らない。
--      - 期限切れ行の DELETE は、待たされた側が再取得時に NOT FOUND となり
--        0 行を返す。二重削除にはならず、結果も同じ（冪等）。
--      - 別セッションどうしは別の行なのでブロックし合わない。
--
--    書き込み削減（2条件の AND）:
--      ① 延長タイミングに到達している（idle 期限の残りが 29日未満）
--      ② 実際に idle 期限が前進する（v_new_idle > v_idle）
--      ②が無いと、absolute 期限まで残り29日を切って idle が absolute に
--      張り付いた後、同じ値を毎リクエスト書き続けてしまう。
--      両方を満たすときだけ idle_expires_at と last_seen_at を更新する。
--      absolute_expires_at は決して UPDATE しない。
--
--    列参照はすべてテーブル別名で修飾する。
--    RETURNS TABLE の列名（user_id / plan_id / status / idle_expires_at /
--    absolute_expires_at）と同名の PL/pgSQL 変数が作られ、修飾しないと
--    "column reference is ambiguous" になるため。
-- =========================================================
CREATE OR REPLACE FUNCTION public.get_session_context(
  p_token_hash TEXT
)
RETURNS TABLE (
  user_id             UUID,
  plan_id             TEXT,
  status              TEXT,
  idle_expires_at     TIMESTAMPTZ,
  absolute_expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id   UUID;
  v_idle      TIMESTAMPTZ;
  v_abs       TIMESTAMPTZ;
  v_now       TIMESTAMPTZ;
  v_new_idle  TIMESTAMPTZ;
  v_idle_ttl  CONSTANT INTERVAL := INTERVAL '30 days';
  v_keep_ttl  CONSTANT INTERVAL := INTERVAL '29 days';
BEGIN
  -- 形式が違うものは DB を触らずに拒否する（総当たりで行ロックを取らせない）
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN;
  END IF;

  v_now := now();

  -- Step 1: 対象セッションを行ロック付きで取得する
  SELECT sess.user_id, sess.idle_expires_at, sess.absolute_expires_at
  INTO   v_user_id, v_idle, v_abs
  FROM   public.sessions sess
  WHERE  sess.token_hash = p_token_hash
  FOR    UPDATE;

  IF NOT FOUND THEN
    RETURN;   -- 存在しない（または直前に他トランザクションが削除した）
  END IF;

  -- Step 2: 期限切れなら行を削除して 0 行を返す
  --   idle <= absolute が CHECK で保証されているため、absolute 到達時は
  --   必ず idle も到達済み。LEAST は意図を明示するための冗長な安全弁。
  IF v_now >= LEAST(v_idle, v_abs) THEN
    DELETE FROM public.sessions WHERE token_hash = p_token_hash;
    RETURN;
  END IF;

  -- Step 3: idle 延長（absolute は絶対に超えない）
  v_new_idle := LEAST(v_now + v_idle_ttl, v_abs);

  IF v_idle < v_now + v_keep_ttl AND v_new_idle > v_idle THEN
    UPDATE public.sessions
    SET    idle_expires_at = v_new_idle,
           last_seen_at    = v_now
    WHERE  token_hash = p_token_hash;
  ELSE
    v_new_idle := v_idle;   -- 書き込みを省いたので現在値をそのまま返す
  END IF;

  -- Step 4: 権限は毎回 subscriptions から読む（Stripe webhook の変更が即反映される）
  --   LEFT JOIN にすることで、subscriptions 行が欠落していても 1 行返し、
  --   呼び出し側が「未認証」と「データ異常」を区別できるようにする。
  RETURN QUERY
    SELECT v_user_id, sub.plan_id, sub.status, v_new_idle, v_abs
    FROM   (SELECT 1) AS one
    LEFT   JOIN public.subscriptions sub ON sub.user_id = v_user_id;
END;
$$;

COMMENT ON FUNCTION public.get_session_context(TEXT) IS
  'セッション検証・idle 延長・subscription 取得を1往復で行う。0行=無効。plan_id が NULL ならデータ異常。server-side function からのみ呼ぶ。';

-- 実行権限：service_role のみ。CREATE の直後に置く。
REVOKE ALL ON FUNCTION public.get_session_context(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_session_context(TEXT) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.get_session_context(TEXT) TO service_role;


-- =========================================================
-- 6. delete_session(TEXT)
--    ログアウト。サーバー側でセッションを即時失効させる。
--
--    - 存在しないトークンでもエラーにしない（冪等）。
--    - 削除件数を返さない。呼び出し側は常に 204 を返し、
--      セッションの存在有無をクライアントへ漏らさない。
-- =========================================================
CREATE OR REPLACE FUNCTION public.delete_session(
  p_token_hash TEXT
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN;
  END IF;

  DELETE FROM public.sessions WHERE token_hash = p_token_hash;
END;
$$;

COMMENT ON FUNCTION public.delete_session(TEXT) IS
  'ログアウト時にセッションを即時失効させる。存在有無を返さない冪等な削除。server-side function からのみ呼ぶ。';

-- 実行権限：service_role のみ。CREATE の直後に置く。
REVOKE ALL ON FUNCTION public.delete_session(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_session(TEXT) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.delete_session(TEXT) TO service_role;


-- =========================================================
-- 以上。
--
-- 期限切れセッションの一括掃除はこの migration では行わない。
-- get_session_context が触れた行は都度削除されるが、二度と使われない
-- セッションは残り続けるため、将来 Cloudflare Cron Trigger などで
--   DELETE FROM public.sessions WHERE idle_expires_at < now();
-- を定期実行する運用を別途決めること。
-- =========================================================

-- =========================================================
-- 20260906xxxxxx_user_timezone_quota.sql
-- Sukima — 週次 quota をユーザー別 IANA timezone 基準へ移行する
--
--   ⚠ このファイルは **draft** です。production へは適用しないこと。
--     他の課金 migration とまとめて適用する。
--
--   このファイルには秘密情報を含まない。
--
--   方針:
--     - **additive のみ**。DROP も既存テーブルの作り直しも行わない。
--     - **backfill しない**。ALTER TABLE ADD COLUMN は NULL 許容・既定値なしで、
--       PostgreSQL 11 以降なら全行書き換えを伴わない（短時間の ACCESS EXCLUSIVE のみ）。
--     - `jst_week_start()` は **削除しない**（rollback 余地と既存 SQL 互換のため）。
--       ただし新しい経路は `user_week_start()` を使う。
--     - `quota_timezone` が NULL のユーザーは **'Asia/Tokyo' にフォールバック**する。
--       つまり適用しただけでは**既存ユーザーの挙動が一切変わらない**。
--     - 既存 RPC の signature は変えない。`reserve_weekly_usage` は
--       週の算出元を差し替えるだけで、引数・戻り値・冪等性・TTL・
--       エラーコードはすべて従来どおり。
--     - 権限は既存の流儀を維持する（SECURITY INVOKER / search_path 固定 /
--       PUBLIC・anon・authenticated から REVOKE / service_role にだけ GRANT）。
--
--   実行順（依存関係あり。上から通しで実行する）:
--      1. users への列追加 + COMMENT
--      2. is_valid_timezone()            + 実行権限
--      3. user_week_start()              + 実行権限
--      4. set_user_timezone()            + 実行権限
--      5. get_quota_status()             + 実行権限
--      6. reserve_weekly_usage() の差し替え
--
--   変更しないもの:
--     - weekly_usage / quota_reservations のテーブル定義
--     - quota_reservations の CHECK（ISODOW = 1）
--       date_trunc('week', ...) は **どの timezone でも月曜**を返すため、
--       timezone 別計算になっても月曜制約は成立し続ける。
--     - commit_weekly_usage / release_weekly_usage
--       いずれも week_start を予約行から読むため、週の算出方法に依存しない。
--     - jst_week_start() / consume_weekly_usage()
-- =========================================================


-- =========================================================
-- 1. users への列追加
--
--    display_timezone
--      ブラウザから取得した IANA timezone。表示と日時計算に使う。
--      **変更は即時反映**してよい（quota には影響しない）。
--
--    quota_timezone
--      quota の週計算に使う anchor。**週境界でしか切り替わらない**。
--      NULL は「未設定」を意味し、'Asia/Tokyo' にフォールバックする。
--
--    quota_timezone_pending
--      次の週境界で quota_timezone へ昇格させる候補。
--
--    quota_week_start
--      quota 上の現在週（月曜）。**単調前進のみ**。巻き戻さない。
--
--    quota_week_started_at
--      quota_week_start が発効した時刻。
--      「前進どうしの実時刻間隔を 7 日以上に保つ」ためのガードに使う。
--      これが無いと、anchor を西から東（例: UTC-11 -> UTC+13）へ動かしたとき
--      次の月曜境界が最大 26 時間早く訪れ、**6 日で 2 回目のリセット**が
--      できてしまう（モデル検証で実際に再現・修正済み）。
--
--    5 列とも NULL 許容・DEFAULT なし。既存行は触らない。
-- =========================================================

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS display_timezone       TEXT,
  ADD COLUMN IF NOT EXISTS quota_timezone         TEXT,
  ADD COLUMN IF NOT EXISTS quota_timezone_pending TEXT,
  ADD COLUMN IF NOT EXISTS quota_week_start       DATE,
  ADD COLUMN IF NOT EXISTS quota_week_started_at  TIMESTAMPTZ;

COMMENT ON COLUMN public.users.display_timezone       IS 'ブラウザ由来の IANA timezone。表示・日時計算用。変更は即時反映してよい。quota には使わない。';
COMMENT ON COLUMN public.users.quota_timezone         IS 'quota の週計算に使う anchor。週境界でのみ切り替わる。NULL は未設定で Asia/Tokyo にフォールバックする。';
COMMENT ON COLUMN public.users.quota_timezone_pending IS '次の週境界で quota_timezone へ昇格させる候補。週の途中の timezone 変更はここへ溜める。';
COMMENT ON COLUMN public.users.quota_week_start       IS 'quota 上の現在週の月曜。単調前進のみ。timezone 変更で巻き戻さない。';
COMMENT ON COLUMN public.users.quota_week_started_at  IS 'quota_week_start が発効した時刻。前進どうしの実時刻間隔を 7 日以上に保つガードに使う。';


-- =========================================================
-- 2. is_valid_timezone(TEXT)
--
--    PostgreSQL が認識する IANA timezone かを判定する。
--
--    - CHECK 制約からは使えない（テーブル参照は IMMUTABLE でないため）。
--      検証は書き込み経路（set_user_timezone）で行う。
--    - **動的 SQL も文字列連結もしない。** 引数をそのまま比較するだけ。
--    - pg_timezone_names は canonical 名を持つ。ブラウザの
--      Intl.DateTimeFormat().resolvedOptions().timeZone も canonical なので
--      完全一致でよい。
-- =========================================================

CREATE OR REPLACE FUNCTION public.is_valid_timezone(p_timezone TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT p_timezone IS NOT NULL
     AND EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = p_timezone);
$$;

COMMENT ON FUNCTION public.is_valid_timezone(TEXT) IS
  'PostgreSQL が認識する IANA timezone 名かを判定する。set_user_timezone が書き込み前に使う。動的 SQL は使わない。';

REVOKE ALL ON FUNCTION public.is_valid_timezone(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_valid_timezone(TEXT) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.is_valid_timezone(TEXT) TO service_role;


-- =========================================================
-- 3. user_week_start(UUID)
--
--    そのユーザーの quota 上の「現在週の week_start」を返す。
--    reserve_weekly_usage と get_quota_status の**唯一の週の決定元**。
--
--    ⚠ この関数は **users 行を書き換える**（週の前進と pending 昇格）。
--      quota を消費するわけではなく、週の anchor を進めるだけ。
--      reserve と status が同じ週を見るために、両方がこの関数を通る。
--
--    ロック順序:
--      users -> weekly_usage -> quota_reservations
--      reserve_weekly_usage は Step 1 でこの関数を呼ぶため、
--      両経路ともこの順序になり循環しない。
--
--    アルゴリズム（3 つの不変条件）:
--      (1) **単調前進**: quota_week_start は決して過去へ戻さない。
--          timezone を西へ動かしても巻き戻らない。
--      (2) **境界でのみ昇格**: pending timezone は「現在の anchor で
--          正式に次週へ入った」ときにだけ quota_timezone へ昇格する。
--          週の途中の timezone 変更では週は動かない。
--      (3) **前進間隔 7 日以上**: 直前の発効時刻から実時刻で 7 日経つまで
--          前進しない。anchor を西->東へ動かすと月曜境界が最大 26 時間
--          早く来るため、(1)(2) だけでは 6 日で 2 回目のリセットができる。
--          この 3 つ目が「1 週間に複数回リセットできない」を保証する。
--
--    発効時刻は「現地月曜 00:00」と「前週発効 + 7 日」の**遅い方**にする。
--    これにより間隔が 7 日を下回らず、かつ恒久的なドリフトも 26 時間で頭打ちになる。
--
--    quota_timezone の妥当性は書き込み側（set_user_timezone）で保証する。
--    ここで再検証しないのは、pg_timezone_names の走査を予約のたびに
--    走らせないため。
-- =========================================================

CREATE OR REPLACE FUNCTION public.user_week_start(p_user_id UUID)
RETURNS DATE
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tz         TEXT;
  v_pending    TEXT;
  v_saved      DATE;
  v_started_at TIMESTAMPTZ;
  v_now        TIMESTAMPTZ;
  v_computed   DATE;
  v_recomputed DATE;
  v_anchor     TEXT;
  v_earliest   TIMESTAMPTZ;
  v_natural    TIMESTAMPTZ;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id は必須です。';
  END IF;

  -- users 行をロックする。同一ユーザーの同時リクエストはここで直列化される。
  SELECT users.quota_timezone,
         users.quota_timezone_pending,
         users.quota_week_start,
         users.quota_week_started_at
  INTO   v_tz, v_pending, v_saved, v_started_at
  FROM   public.users
  WHERE  users.id = p_user_id
  FOR    UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'users 行が見つかりません。';
  END IF;

  v_now := now();

  -- 未設定は JST。これにより既存ユーザーの週は今までと完全に一致する。
  v_tz := COALESCE(v_tz, 'Asia/Tokyo');
  v_computed := (date_trunc('week', (v_now AT TIME ZONE v_tz)))::date;

  -- 初回。現在の anchor で算出した週をそのまま採用する。
  IF v_saved IS NULL THEN
    UPDATE public.users
    SET    quota_week_start      = v_computed,
           quota_week_started_at = (v_computed::timestamp AT TIME ZONE v_tz)
    WHERE  users.id = p_user_id;
    RETURN v_computed;
  END IF;

  -- 週が進んでいない。何も変えない（timezone 変更だけでは絶対にここを通らない）。
  IF v_computed <= v_saved THEN
    RETURN v_saved;
  END IF;

  -- 不変条件 (3): 前進どうしの実時刻間隔を 7 日以上に保つ。
  v_earliest := CASE
                  WHEN v_started_at IS NULL THEN NULL
                  ELSE v_started_at + INTERVAL '7 days'
                END;
  IF v_earliest IS NOT NULL AND v_now < v_earliest THEN
    RETURN v_saved;
  END IF;

  -- 不変条件 (2): ここへ来たときだけ pending を昇格させる。
  v_anchor := v_tz;
  IF v_pending IS NOT NULL AND v_pending <> v_tz THEN
    v_recomputed := (date_trunc('week', (v_now AT TIME ZONE v_pending)))::date;
    -- 不変条件 (1): 巻き戻り禁止。前進側だけを採る。
    v_computed := GREATEST(v_computed, v_recomputed);
    v_anchor   := v_pending;
  END IF;

  -- 発効時刻 = 現地月曜 00:00 と「前週発効 + 7 日」の遅い方。
  v_natural := (v_computed::timestamp AT TIME ZONE v_anchor);
  IF v_earliest IS NOT NULL AND v_earliest > v_natural THEN
    v_natural := v_earliest;
  END IF;

  UPDATE public.users
  SET    quota_timezone         = v_anchor,
         quota_timezone_pending = NULL,
         quota_week_start       = v_computed,
         quota_week_started_at  = v_natural
  WHERE  users.id = p_user_id;

  RETURN v_computed;
END;
$$;

COMMENT ON FUNCTION public.user_week_start(UUID) IS
  'そのユーザーの quota 上の現在週（月曜）を返す。quota_timezone が NULL なら Asia/Tokyo にフォールバックする。週の前進と pending timezone の昇格を行うため users 行を更新する。前進は単調で、実時刻で 7 日以上の間隔を保つ。server-side function（service_role）からのみ呼ぶ。';

REVOKE ALL ON FUNCTION public.user_week_start(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.user_week_start(UUID) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.user_week_start(UUID) TO service_role;


-- =========================================================
-- 4. set_user_timezone(UUID, TEXT)
--
--    ブラウザから取得した IANA timezone を保存する。
--
--    責務:
--      1. 引数と user の存在を確認する
--      2. timezone の妥当性を確認する（不正なら**何も書かずに**例外）
--      3. display_timezone は**即時**更新する
--      4. quota_timezone が未設定なら安全に初期化する
--      5. 異なる timezone は quota_timezone_pending へ回す
--      6. 元の quota_timezone へ戻ったら pending を掃除する
--      7. **quota_week_start は絶対に動かさない**
--
--    初回設定の分岐（ここが最も重要）:
--      既存ユーザーは JST 基準で quota が稼働している可能性がある。
--      初回に America/New_York を受け取った瞬間に anchor を切り替えると、
--      week_start が変わって**新しい 3 回枠が手に入ってしまう**。
--      そのため:
--        - quota_reservations に行が 1 件も無い（＝失うものも得るものも無い）
--          ユーザーだけ、その場で新しい timezone を採用する
--        - 1 件でも履歴があるユーザーは anchor を 'Asia/Tokyo' に固定し、
--          新しい timezone は pending に回して次の週境界で昇格させる
--
--    quota_week_start は user_week_start() だけが動かす。
-- =========================================================

CREATE OR REPLACE FUNCTION public.set_user_timezone(
  p_user_id  UUID,
  p_timezone TEXT
)
RETURNS TABLE (
  display_timezone       TEXT,
  quota_timezone         TEXT,
  quota_timezone_pending TEXT,
  quota_week_start       DATE
)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tz          TEXT;
  v_saved       DATE;
  v_started_at  TIMESTAMPTZ;
  v_now         TIMESTAMPTZ;
  v_new_tz      TEXT;
  v_new_pending TEXT;
  v_has_history BOOLEAN;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id は必須です。';
  END IF;
  IF p_timezone IS NULL OR length(trim(p_timezone)) = 0 THEN
    RAISE EXCEPTION 'p_timezone は必須です。';
  END IF;

  -- 妥当性は DB を書き換える前に確認する（fail closed）。
  IF NOT public.is_valid_timezone(p_timezone) THEN
    RAISE EXCEPTION 'p_timezone が IANA timezone として認識できません。';
  END IF;

  SELECT users.quota_timezone, users.quota_week_start, users.quota_week_started_at
  INTO   v_tz, v_saved, v_started_at
  FROM   public.users
  WHERE  users.id = p_user_id
  FOR    UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'users 行が見つかりません。';
  END IF;

  v_now := now();

  IF v_tz IS NULL THEN
    -- 初回。quota 履歴の有無で扱いを分ける。
    SELECT EXISTS (
      SELECT 1 FROM public.quota_reservations qr WHERE qr.user_id = p_user_id
    ) INTO v_has_history;

    IF NOT v_has_history THEN
      -- 失うものも得るものも無い。その場で採用してよい。
      v_new_tz      := p_timezone;
      v_new_pending := NULL;
      v_saved       := (date_trunc('week', (v_now AT TIME ZONE p_timezone)))::date;
      v_started_at  := (v_saved::timestamp AT TIME ZONE p_timezone);
    ELSE
      -- 既に JST 基準で稼働している。anchor を明示して pending へ回す。
      v_new_tz      := 'Asia/Tokyo';
      v_new_pending := CASE WHEN p_timezone = 'Asia/Tokyo' THEN NULL ELSE p_timezone END;
      IF v_saved IS NULL THEN
        v_saved      := (date_trunc('week', (v_now AT TIME ZONE 'Asia/Tokyo')))::date;
        v_started_at := (v_saved::timestamp AT TIME ZONE 'Asia/Tokyo');
      END IF;
    END IF;
  ELSIF p_timezone = v_tz THEN
    -- 元の anchor へ戻ってきた。予約されていた変更は不要。
    v_new_tz      := v_tz;
    v_new_pending := NULL;
  ELSE
    -- 週の途中の変更。anchor は動かさず pending に溜める。
    v_new_tz      := v_tz;
    v_new_pending := p_timezone;
  END IF;

  UPDATE public.users
  SET    display_timezone       = p_timezone,   -- 表示用は常に即時
         quota_timezone         = v_new_tz,
         quota_timezone_pending = v_new_pending,
         quota_week_start       = v_saved,
         quota_week_started_at  = v_started_at
  WHERE  users.id = p_user_id;

  RETURN QUERY
    SELECT u.display_timezone, u.quota_timezone, u.quota_timezone_pending, u.quota_week_start
    FROM   public.users u
    WHERE  u.id = p_user_id;
END;
$$;

COMMENT ON FUNCTION public.set_user_timezone(UUID, TEXT) IS
  'ブラウザ由来の IANA timezone を保存する。display_timezone は即時、quota_timezone は週境界でのみ切り替わる（週の途中の変更は quota_timezone_pending へ回す）。quota_week_start はここでは動かさない。server-side function（service_role）からのみ呼ぶ。';

REVOKE ALL ON FUNCTION public.set_user_timezone(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_user_timezone(UUID, TEXT) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.set_user_timezone(UUID, TEXT) TO service_role;


-- =========================================================
-- 5. get_quota_status(UUID, INT)
--
--    quota を**消費しない**読み取り専用の残数照会。
--
--    - 予約行を作らない / 冪等キーを作らない / used を増やさない
--    - used は reserve と同じ定義（state IN ('pending','committed') の行数）
--      released は数えない。期限切れ pending は committed('expired') へ
--      変わるだけで used は変わらないため、ここで lazy reclaim は行わない
--    - remaining は 0 未満にしない
--
--    ※ 週の決定に user_week_start() を通すため、users 行の週 anchor は
--      前進し得る。これは quota の消費ではなく、reserve と status が
--      必ず同じ週を見るために必要。
--
--    next_reset_at の作り方（DST 対応 + 7 日ガード整合。ここが要）:
--        GREATEST( ((week_start + 7)::timestamp) AT TIME ZONE anchor_tz,
--                  quota_week_started_at + INTERVAL '7 days' )
--
--      第 1 項は「その timezone の、次の月曜の 00:00」という**壁時計**を
--      timestamptz へ変換したもの。
--      **168 時間を足してはいけない。** DST のある US / GB / AU では
--      週の実長が 167 時間や 169 時間になる（例:
--      America/New_York 2026-03-02 は 167h、2026-10-26 は 169h）。
--
--      第 2 項が必要な理由:
--      実際に週が前進できるのは user_week_start() の
--      「前進どうしの実時刻間隔を 7 日以上に保つ」ガードを満たしてから。
--      anchor を大きく東へ動かした直後は現地月曜 00:00 のほうが早く来るため、
--      第 1 項だけだと**表示上のリセットが実際より最大 26 時間早くなる**
--      （ローカル DB で 24 時間のズレを再現）。
--      GREATEST を取ることで user_week_start() の前進条件と完全に一致する。
--      ガードが効いていない通常のユーザーでは第 1 項が勝ち、値は変わらない。
--
--    戻り値の列名を quota_limit にしているのは、LIMIT が予約語で
--    RETURNS TABLE の列名にそのまま使えないため。
-- =========================================================

CREATE OR REPLACE FUNCTION public.get_quota_status(
  p_user_id UUID,
  p_limit   INT DEFAULT 3
)
RETURNS TABLE (
  used          INT,
  remaining     INT,
  quota_limit   INT,
  week_start    DATE,
  next_reset_at TIMESTAMPTZ
)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_week_start DATE;
  v_tz         TEXT;
  v_started_at TIMESTAMPTZ;
  v_used       INT;
  v_next_reset TIMESTAMPTZ;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id は必須です。';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 THEN
    RAISE EXCEPTION 'p_limit は 1 以上である必要があります。';
  END IF;

  -- 週の決定元は reserve と共通にする（ここで anchor の前進も起きる）。
  v_week_start := public.user_week_start(p_user_id);

  SELECT COALESCE(users.quota_timezone, 'Asia/Tokyo'), users.quota_week_started_at
  INTO   v_tz, v_started_at
  FROM   public.users
  WHERE  users.id = p_user_id;

  -- 次回リセット = 現地の次の月曜 00:00 と「発効 + 7 日」の遅い方。
  -- user_week_start() の前進条件とそろえる（表示だけ先走らせない）。
  v_next_reset := ((v_week_start + 7)::timestamp AT TIME ZONE v_tz);
  IF v_started_at IS NOT NULL
     AND (v_started_at + INTERVAL '7 days') > v_next_reset THEN
    v_next_reset := v_started_at + INTERVAL '7 days';
  END IF;

  -- used は reserve と同じ定義。予約は作らない。
  SELECT COUNT(*)::INT
  INTO   v_used
  FROM   public.quota_reservations qr
  WHERE  qr.user_id    = p_user_id
    AND  qr.week_start = v_week_start
    AND  qr.state IN ('pending', 'committed');

  RETURN QUERY
    SELECT v_used,
           GREATEST(p_limit - v_used, 0),
           p_limit,
           v_week_start,
           v_next_reset;
END;
$$;

COMMENT ON FUNCTION public.get_quota_status(UUID, INT) IS
  'quota を消費せずに used / remaining / week_start / next_reset_at を返す。used は state IN (pending, committed) の行数で reserve と同じ定義。next_reset_at はそのユーザーの anchor timezone における次の月曜 00:00 と quota_week_started_at + 7 日の遅い方で、user_week_start() が実際に前進できる時刻と一致する。DST を跨ぐ週でも正しい（168 時間加算ではない）。server-side function（service_role）からのみ呼ぶ。';

REVOKE ALL ON FUNCTION public.get_quota_status(UUID, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_quota_status(UUID, INT) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.get_quota_status(UUID, INT) TO service_role;


-- =========================================================
-- 6. reserve_weekly_usage(UUID, TEXT, INT) の差し替え
--
--    **変更点は 1 行だけ**:
--        v_week_start := public.jst_week_start();
--      -> v_week_start := public.user_week_start(p_user_id);
--
--    変更しないもの（互換性の約束）:
--      - 引数: (p_user_id UUID, p_idempotency_key TEXT, p_limit INT DEFAULT 3)
--      - 戻り値: allowed / code / reused / reservation_id / week_start /
--                used / remaining / expires_at
--      - code の値: 'ok' / 'limit_reached' / 'already_settled'
--      - 冪等性の鍵: (user_id, week_start, idempotency_key)
--      - TTL 120 秒 / lazy reclaim / 派生キャッシュ追随
--      - SECURITY INVOKER / search_path / 権限
--
--    これにより API 側（functions/api/quota/reserve.js と
--    functions/api/ext/quota/reserve.js）は**一切変更不要**。
--
--    副作用の注意:
--      users 行が存在しないとき、従来は weekly_usage の FK 違反で失敗していたが、
--      これからは user_week_start() の明示的な例外で失敗する。
--      どちらも例外であり、API 側の分類（database_unavailable / internal_error）は
--      変わらない。
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
  --   user_week_start() はそのユーザーの anchor timezone で週を決め、
  --   必要なら users 行の週 anchor を前進させる（users 行のロックもここ）。
  --   ロック順序は users -> weekly_usage -> quota_reservations で一貫する。
  v_week_start := public.user_week_start(p_user_id);
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
  '検索前に1回分を予約する。week_start は user_week_start(p_user_id) で内部算出し、そのユーザーの anchor timezone（未設定なら Asia/Tokyo）の週になる。TTL は 120 秒固定。p_user_id はセッションから導出した users.id のみ。server-side function（service_role）からのみ呼ぶ。';

-- 実行権限：service_role のみ。CREATE の直後に置く。
--   CREATE OR REPLACE では既存の権限が引き継がれるが、
--   明示的に置き直して既存 migration と同じ状態を保証する。
REVOKE ALL ON FUNCTION public.reserve_weekly_usage(UUID, TEXT, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reserve_weekly_usage(UUID, TEXT, INT) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.reserve_weekly_usage(UUID, TEXT, INT) TO service_role;


-- =========================================================
-- 以上。
--
-- 他の課金 migration とまとめて適用する。
-- =========================================================

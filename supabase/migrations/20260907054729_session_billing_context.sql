-- =========================================================
-- 20260907054729_session_billing_context.sql
-- Sukima — get_session_context に billing 状態を追加する
--
--   ⚠ このファイルは **draft** です。production へは適用しないこと。
--     他の課金 migration とまとめて適用する。
--
--   このファイルには秘密情報を含まない。
--
--   目的:
--     migration 20260907041329 で追加し webhook RPC が書き込む billing 列を、
--     セッション経路から読めるようにする。
--     とくに **`past_due_since`** を返すことで、entitlement.js の
--     「past_due + 7 日未満は Pro」が実際に効く。
--
--   追加する戻り列（5 本）:
--     past_due_since       7 日猶予の起点。entitlement が読む（最重要）
--     current_period_end   期間終了日。Settings 表示用
--     cancel_at_period_end 解約予約フラグ
--     currency             契約通貨（free は NULL）
--     price_phase          launch / standard。価格表示の材料
--
--   **追加しない列とその理由**:
--     stripe_customer_id / stripe_subscription_id / stripe_price_id
--       -> Stripe の内部 ID。session 経路で必要になる場面が無く、
--          client へ露出する事故の芽を作らない。必要な endpoint
--          （Billing Portal 等）は subscriptions を直接読めばよい
--     last_stripe_event_at
--       -> webhook 内部の watermark。表示にも権限判定にも使わない
--
--   方針:
--     - 既存の戻り列（user_id / plan_id / status / idle_expires_at /
--       absolute_expires_at）を**削除も rename もしない**。順序も先頭から維持する
--     - 関数の**本体ロジックを変えない**。idle 延長・期限切れ削除・
--       行ロック・LEFT JOIN の挙動は既存のまま
--     - session 行へ plan / status / grace を**コピーしない**。
--       権限の正は subscriptions で、webhook の変更が次のリクエストで即反映される
--       という 既存の設計を維持する
--     - `SECURITY INVOKER` + `search_path` 固定 + 動的 SQL なし（既存流儀）
--
--   ■ なぜ DROP + CREATE なのか
--     PostgreSQL は `CREATE OR REPLACE FUNCTION` で **戻り値の型を変更できない**
--     （"cannot change return type of existing function"）。
--     RETURNS TABLE に列を足すのは戻り値型の変更にあたるため、
--     いったん DROP してから作り直す必要がある。
--
--     安全性の根拠:
--       - 消すのは**関数だけ**。テーブルもデータも消さない
--       - この関数に依存する view / trigger / 他関数は無い
--         （呼び出し元は PostgREST 経由の `functions/api/_lib/session.js` のみ。
--          `pg_depend` で確認できる）
--       - `DROP FUNCTION IF EXISTS` にしてあるので再実行できる
--
--     ⚠ **DROP は関数の GRANT も一緒に消す。** 作り直した直後に
--       REVOKE / GRANT を必ずやり直すこと（本ファイル末尾で実施している）。
--
--     ⚠ **production へ適用するときは、このファイルを
--       トランザクション内で実行すること。** DROP と CREATE の間に
--       関数が存在しない瞬間があり、その間の全リクエストが失敗する。
--       トランザクションで囲めば入れ替えは原子的になる。
--
--   実行順:
--      1. DROP FUNCTION IF EXISTS get_session_context(TEXT)
--      2. CREATE FUNCTION get_session_context(TEXT)  + COMMENT
--      3. REVOKE / GRANT（DROP で失われた権限を張り直す）
-- =========================================================


-- =========================================================
-- 1. 旧定義を落とす
--    戻り値型を変えるため CREATE OR REPLACE では置き換えられない。
-- =========================================================
DROP FUNCTION IF EXISTS public.get_session_context(TEXT);


-- =========================================================
-- 2. 新定義
--    既存 5 列を先頭に据え置き、billing 5 列を後ろへ足すだけ。
--    本体ロジックは 20260901041257 のものと同一。
-- =========================================================
CREATE FUNCTION public.get_session_context(
  p_token_hash TEXT
)
RETURNS TABLE (
  user_id              UUID,
  plan_id              TEXT,
  status               TEXT,
  idle_expires_at      TIMESTAMPTZ,
  absolute_expires_at  TIMESTAMPTZ,
  past_due_since       TIMESTAMPTZ,
  current_period_end   TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN,
  currency             TEXT,
  price_phase          TEXT
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

  -- Step 4: 権限と billing 状態は毎回 subscriptions から読む
  --   （Stripe webhook の変更が次のリクエストで即反映される）
  --   LEFT JOIN にすることで、subscriptions 行が欠落していても 1 行返し、
  --   呼び出し側が「未認証」と「データ異常」を区別できるようにする。
  --   billing 列も欠落時は NULL になり、呼び出し側は plan_id の NULL で
  --   データ異常を検知する（既存の判定基準を変えない）。
  RETURN QUERY
    SELECT v_user_id, sub.plan_id, sub.status, v_new_idle, v_abs,
           sub.past_due_since, sub.current_period_end,
           sub.cancel_at_period_end, sub.currency, sub.price_phase
    FROM   (SELECT 1) AS one
    LEFT   JOIN public.subscriptions sub ON sub.user_id = v_user_id;
END;
$$;

COMMENT ON FUNCTION public.get_session_context(TEXT) IS
  'セッション検証・idle 延長・subscription 取得を1往復で行う。0行=無効。plan_id が NULL ならデータ異常。past_due_since は 7 日猶予の起点で entitlement が読む。Stripe の内部 ID（customer / subscription / price）と last_stripe_event_at は返さない。server-side function からのみ呼ぶ。';


-- =========================================================
-- 3. 実行権限を張り直す
--    DROP FUNCTION で旧関数の GRANT は消えている。
--    20260901041257 と同じ権限モデルへ戻す。
-- =========================================================
REVOKE ALL ON FUNCTION public.get_session_context(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_session_context(TEXT) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.get_session_context(TEXT) TO service_role;


-- =========================================================
-- 以上。
--   他の課金 migration とまとめて production へ適用する。
--   適用時は **トランザクション内で実行**すること（冒頭の注意を参照）。
-- =========================================================

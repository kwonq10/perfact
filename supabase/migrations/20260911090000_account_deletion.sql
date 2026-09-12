-- =========================================================
-- 20260911090000_account_deletion.sql
-- Sukima — アカウント削除の RPC と、削除後に届く Stripe event の扱い
--
--   ⚠ このファイルは **draft** です。production へは適用しないこと。
--     他の課金 migration とまとめて適用する。
--
--   このファイルには秘密情報を含まない。
--
--   目的:
--     1. `delete_user_account(p_user_id)` を追加する。
--        users 行を消し、FK の ON DELETE CASCADE で利用者に紐づく行を消す。
--     2. `apply_stripe_subscription_event(...)` を**最小限だけ**変える。
--        アカウント削除後に届いた「終了済み subscription」の event を
--        例外にせず no-op で受け取れるようにする。
--
--   消えるもの（users からの CASCADE）:
--     subscriptions / weekly_usage（-> quota_reservations）/ sessions
--     sessions には拡張機能のセッションも入っているため、**全端末の
--     ログイン状態がここで失効する**。
--
--   消さないもの（意図的）:
--     terms_consents  users への FK を持たない監査用の同意履歴
--                     （20260907051255 の設計どおり、削除後も残す）
--     stripe_events   event の冪等キー。利用者の情報を持たない
--
--   Stripe 側の後始末（subscription の即時解約・未払い invoice の自動回収停止）は
--   API 層（functions/api/account/delete.js）が **この RPC を呼ぶ前に**行う。
--   DB は Stripe を知らないので、ここでは「行を消す」ことだけを担う。
--
--   方針:
--     - 既存テーブル・既存の列・制約・権限は変更しない。
--     - `apply_stripe_subscription_event` は **signature と戻り値の型を変えない**
--       （CREATE OR REPLACE で差し替える。呼び出し側の変更は不要）。
--       変えるのは「subscriptions 行が無い」ときの 2 か所の分岐だけで、
--       それ以外の本体は 20260907052839 と同一。
--     - `SECURITY INVOKER` + `search_path` 固定（既存流儀）
--     - 動的 SQL を使わない
--     - **再実行可能**（`CREATE OR REPLACE FUNCTION`）
--
--   前提となる migration:
--     20260901022938  users / subscriptions / weekly_usage / stripe_events
--     20260901041257  sessions
--     20260903015535  quota_reservations
--     20260907051255  terms_consents
--     20260907052839  apply_stripe_subscription_event
--
--   実行順:
--     1. delete_user_account() + COMMENT + 実行権限
--     2. apply_stripe_subscription_event() の差し替え + COMMENT + 実行権限
-- =========================================================


-- =========================================================
-- 1. delete_user_account(p_user_id)
--
--    ■ 冪等
--      行が既に無ければ deleted = FALSE を返して成功する（例外にしない）。
--      API の再試行や二重送信で失敗させないため。
--
--    ■ 1 行だけ返す
--      deleted = TRUE  : この呼び出しで users 行を消した
--      deleted = FALSE : 呼び出し時点で users 行が無かった
--
--    ■ 並行する webhook との関係
--      apply_stripe_subscription_event は subscriptions 行を FOR UPDATE で
--      ロックする。ここでの CASCADE 削除はそのロックを待つので、
--      「適用の途中で行が消える」ことはない。削除が先に確定した場合は
--      下の 2. の分岐で扱う。
-- =========================================================
CREATE OR REPLACE FUNCTION public.delete_user_account(
  p_user_id UUID
)
RETURNS TABLE (
  deleted BOOLEAN
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id は必須です。';
  END IF;

  -- CASCADE で subscriptions / weekly_usage / quota_reservations / sessions が消える。
  -- terms_consents / stripe_events は users を参照しないので残る。
  DELETE FROM public.users u
  WHERE  u.id = p_user_id;

  RETURN QUERY SELECT FOUND;
END;
$$;

COMMENT ON FUNCTION public.delete_user_account(UUID) IS
  'アカウント削除。users 行を消し、CASCADE で subscriptions / weekly_usage / quota_reservations / sessions を消す。terms_consents と stripe_events は残す。行が無ければ deleted=false で成功する（冪等）。Stripe 側の解約・回収停止は呼び出し側が先に済ませること。server-side function（service_role）からのみ呼ぶ。';

REVOKE ALL ON FUNCTION public.delete_user_account(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_user_account(UUID) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.delete_user_account(UUID) TO service_role;


-- =========================================================
-- 2. apply_stripe_subscription_event(...) の差し替え
--
--    ■ 変更点（これだけ）
--      これまで「subscriptions 行が無い」ときは常に例外だった（2 か所）。
--      アカウント削除後は、終了済み subscription の event
--      （customer.subscription.deleted など）が遅れて届く。
--      それを例外にすると Stripe が再送を続け、webhook が失敗し続ける。
--
--      そこで次の**両方**を満たすときだけ、例外にせず no-op の行を返す。
--        a. users 行が存在しない（= アカウント削除済み）
--        b. 取り直した subscription の status が終了状態
--           （'canceled' / 'incomplete_expired'）
--
--      no-op の行: processed = FALSE / stale = FALSE / plan_id = NULL /
--                  status = p_status / past_due_since = NULL / watermark = NULL
--      already_processed は分岐に応じて従来どおり（Step 1 側は TRUE）。
--
--    ■ 変えないこと
--      - users 行はあるのに subscriptions 行だけが無い -> **従来どおり例外**
--        （データ異常。fail closed）
--      - users 行が無く、status が終了状態でない（active / past_due など）
--        -> **従来どおり例外**。削除済みの利用者へ権限を付けない。
--           Stripe 側で契約が生きている異常なので、webhook を失敗させて気づけるようにする。
--      - 行を INSERT しない（webhook だけで利用者の行を生やさない）
--      - signature / 戻り値の型 / 検証 / 冪等性 / watermark / past_due_since の扱い
--
--    ■ stripe_events への記録
--      no-op でも Step 1 で記録した event は残す（commit される）。
--      同じ event が再送されたら Step 1 の already_processed 側で同じく no-op になる。
--      stripe_events は利用者の情報を持たない。
-- =========================================================
CREATE OR REPLACE FUNCTION public.apply_stripe_subscription_event(
  p_stripe_event_id        TEXT,
  p_event_type             TEXT,
  p_event_created_at       TIMESTAMPTZ,
  p_user_id                UUID,
  p_plan_id                TEXT,
  p_status                 TEXT,
  p_stripe_customer_id     TEXT,
  p_stripe_subscription_id TEXT,
  p_stripe_price_id        TEXT        DEFAULT NULL,
  p_currency               TEXT        DEFAULT NULL,
  p_price_phase            TEXT        DEFAULT NULL,
  p_current_period_end     TIMESTAMPTZ DEFAULT NULL,
  p_cancel_at_period_end   BOOLEAN     DEFAULT FALSE
)
RETURNS TABLE (
  processed            BOOLEAN,
  already_processed    BOOLEAN,
  stale                BOOLEAN,
  plan_id              TEXT,
  status               TEXT,
  past_due_since       TIMESTAMPTZ,
  last_stripe_event_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_old_status         TEXT;
  v_old_past_due_since TIMESTAMPTZ;
  v_old_watermark      TIMESTAMPTZ;
  v_old_plan_id        TEXT;
  v_new_past_due_since TIMESTAMPTZ;
  v_ret_plan_id        TEXT;
  v_ret_status         TEXT;
  v_ret_past_due_since TIMESTAMPTZ;
  v_ret_watermark      TIMESTAMPTZ;
  v_future_skew        CONSTANT INTERVAL := INTERVAL '1 hour';
  -- アカウント削除後に届く event のうち、no-op で受け取ってよい status。
  v_terminal_statuses  CONSTANT TEXT[] := ARRAY['canceled', 'incomplete_expired'];
BEGIN
  -- -------------------------------------------------------
  -- Step 0: 引数検証。DB を触る前に落とす（既存 RPC と同じ流儀）。
  --   エラー文には受け取った値を入れない（ログ経由の漏洩を避ける）。
  -- -------------------------------------------------------
  IF p_stripe_event_id IS NULL
     OR p_stripe_event_id <> btrim(p_stripe_event_id)
     OR length(p_stripe_event_id) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'p_stripe_event_id は前後空白の無い 1〜255 文字である必要があります。';
  END IF;

  IF p_event_type IS NULL
     OR p_event_type <> btrim(p_event_type)
     OR length(p_event_type) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'p_event_type は前後空白の無い 1〜255 文字である必要があります。';
  END IF;

  IF p_event_created_at IS NULL THEN
    RAISE EXCEPTION 'p_event_created_at は必須です。';
  END IF;

  -- 極端な未来の event を弾く（20260907052839 と同じ）。
  IF p_event_created_at > now() + v_future_skew THEN
    RAISE EXCEPTION 'p_event_created_at が未来すぎます。';
  END IF;

  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id は必須です。';
  END IF;

  IF p_plan_id IS NULL
     OR p_plan_id NOT IN ('free', 'web_pro', 'extension_pro', 'all_pro') THEN
    RAISE EXCEPTION 'p_plan_id が不正です。';
  END IF;

  IF p_status IS NULL
     OR p_status NOT IN ('active', 'trialing', 'past_due',
                         'canceled', 'unpaid', 'incomplete', 'incomplete_expired') THEN
    RAISE EXCEPTION 'p_status が不正です。';
  END IF;

  IF p_stripe_customer_id IS NULL
     OR p_stripe_customer_id <> btrim(p_stripe_customer_id)
     OR length(p_stripe_customer_id) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'p_stripe_customer_id は前後空白の無い 1〜255 文字である必要があります。';
  END IF;

  IF p_stripe_subscription_id IS NULL
     OR p_stripe_subscription_id <> btrim(p_stripe_subscription_id)
     OR length(p_stripe_subscription_id) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'p_stripe_subscription_id は前後空白の無い 1〜255 文字である必要があります。';
  END IF;

  IF p_stripe_price_id IS NOT NULL
     AND (p_stripe_price_id <> btrim(p_stripe_price_id)
          OR length(p_stripe_price_id) NOT BETWEEN 1 AND 255) THEN
    RAISE EXCEPTION 'p_stripe_price_id の形式が不正です。';
  END IF;

  IF p_currency IS NOT NULL AND p_currency NOT IN ('jpy', 'usd') THEN
    RAISE EXCEPTION 'p_currency が不正です。';
  END IF;

  IF p_price_phase IS NOT NULL AND p_price_phase NOT IN ('launch', 'standard') THEN
    RAISE EXCEPTION 'p_price_phase が不正です。';
  END IF;

  IF p_cancel_at_period_end IS NULL THEN
    RAISE EXCEPTION 'p_cancel_at_period_end は必須です。';
  END IF;

  -- -------------------------------------------------------
  -- Step 1: 冪等キーの記録（20260907052839 と同じ）。
  -- -------------------------------------------------------
  INSERT INTO public.stripe_events (stripe_event_id, event_type)
  VALUES (p_stripe_event_id, p_event_type)
  ON CONFLICT (stripe_event_id) DO NOTHING;

  IF NOT FOUND THEN
    -- 既に処理済み。subscriptions は読むだけで書かない。
    SELECT s.plan_id, s.status, s.past_due_since, s.last_stripe_event_at
    INTO   v_ret_plan_id, v_ret_status, v_ret_past_due_since, v_ret_watermark
    FROM   public.subscriptions s
    WHERE  s.user_id = p_user_id;

    IF NOT FOUND THEN
      -- 【変更点 1】削除済みアカウントの、終了済み subscription の再送は no-op。
      IF p_status = ANY (v_terminal_statuses)
         AND NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_user_id) THEN
        RETURN QUERY SELECT FALSE, TRUE, FALSE,
                            NULL::TEXT, p_status,
                            NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ;
        RETURN;
      END IF;
      -- それ以外（行だけ欠けている / 終了状態でない）はデータ異常。fail closed。
      RAISE EXCEPTION 'subscriptions 行が存在しません。';
    END IF;

    RETURN QUERY SELECT FALSE, TRUE, FALSE,
                        v_ret_plan_id, v_ret_status,
                        v_ret_past_due_since, v_ret_watermark;
    RETURN;
  END IF;

  -- -------------------------------------------------------
  -- Step 2: 対象行をロックして現在値を読む（直列化点）。
  -- -------------------------------------------------------
  SELECT s.plan_id, s.status, s.past_due_since, s.last_stripe_event_at
  INTO   v_old_plan_id, v_old_status, v_old_past_due_since, v_old_watermark
  FROM   public.subscriptions s
  WHERE  s.user_id = p_user_id
  FOR    UPDATE;

  IF NOT FOUND THEN
    -- 【変更点 2】削除済みアカウントの、終了済み subscription の event は no-op。
    --   Step 1 で記録した event は残す（再送は Step 1 側の no-op になる）。
    IF p_status = ANY (v_terminal_statuses)
       AND NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_user_id) THEN
      RETURN QUERY SELECT FALSE, FALSE, FALSE,
                          NULL::TEXT, p_status,
                          NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ;
      RETURN;
    END IF;
    -- それ以外は従来どおり例外（Step 1 の event INSERT も rollback され、Stripe が再送できる）。
    -- webhook だけで有料権限の行を生やす方が危険なので INSERT はしない。
    RAISE EXCEPTION 'subscriptions 行が存在しません。';
  END IF;

  -- -------------------------------------------------------
  -- Step 3: stale 判定（20260907052839 と同じ）。
  -- -------------------------------------------------------
  IF v_old_watermark IS NOT NULL AND p_event_created_at < v_old_watermark THEN
    RETURN QUERY SELECT FALSE, FALSE, TRUE,
                        v_old_plan_id, v_old_status,
                        v_old_past_due_since, v_old_watermark;
    RETURN;
  END IF;

  -- -------------------------------------------------------
  -- Step 4: past_due_since を決める（20260907052839 と同じ）。
  -- -------------------------------------------------------
  IF p_status = 'past_due' THEN
    IF v_old_status = 'past_due' AND v_old_past_due_since IS NOT NULL THEN
      v_new_past_due_since := v_old_past_due_since;
    ELSE
      v_new_past_due_since := p_event_created_at;
    END IF;
  ELSE
    v_new_past_due_since := NULL;
  END IF;

  -- -------------------------------------------------------
  -- Step 5: snapshot を適用する（20260907052839 と同じ）。
  -- -------------------------------------------------------
  UPDATE public.subscriptions s
  SET    plan_id                = p_plan_id,
         status                 = p_status,
         stripe_customer_id     = p_stripe_customer_id,
         stripe_subscription_id = p_stripe_subscription_id,
         stripe_price_id        = p_stripe_price_id,
         currency               = p_currency,
         price_phase            = p_price_phase,
         current_period_end     = p_current_period_end,
         cancel_at_period_end   = p_cancel_at_period_end,
         past_due_since         = v_new_past_due_since,
         last_stripe_event_at   = p_event_created_at
  WHERE  s.user_id = p_user_id
  RETURNING s.plan_id, s.status, s.past_due_since, s.last_stripe_event_at
  INTO   v_ret_plan_id, v_ret_status, v_ret_past_due_since, v_ret_watermark;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscriptions の更新に失敗しました。';
  END IF;

  RETURN QUERY SELECT TRUE, FALSE, FALSE,
                      v_ret_plan_id, v_ret_status,
                      v_ret_past_due_since, v_ret_watermark;
END;
$$;

COMMENT ON FUNCTION public.apply_stripe_subscription_event(
  TEXT, TEXT, TIMESTAMPTZ, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, BOOLEAN
) IS
  'Stripe webhook の subscription snapshot を、event 記録と同一トランザクションで適用する。stripe_event_id が冪等キー。last_stripe_event_at を watermark にして順不同 event に耐える。past_due_since は past_due へ遷移した時だけ設定し、抜けたら NULL に戻す。plan_id / currency / price_phase は webhook layer が billing-config で確定した検証済みの値を渡すこと（DB は price_id から plan を推論しない）。users 行が無く status が canceled / incomplete_expired のときだけ no-op（processed=false）を返し、それ以外で subscriptions 行が無ければ例外にする。server-side function（service_role）からのみ呼ぶ。';

REVOKE ALL ON FUNCTION public.apply_stripe_subscription_event(
  TEXT, TEXT, TIMESTAMPTZ, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, BOOLEAN
) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.apply_stripe_subscription_event(
  TEXT, TEXT, TIMESTAMPTZ, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, BOOLEAN
) FROM anon, authenticated;

GRANT EXECUTE ON FUNCTION public.apply_stripe_subscription_event(
  TEXT, TEXT, TIMESTAMPTZ, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, BOOLEAN
) TO service_role;


-- =========================================================
-- 以上。
--   他の課金 migration とまとめて production へ適用する。
-- =========================================================

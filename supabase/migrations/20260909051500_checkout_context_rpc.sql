-- =========================================================
-- 20260909051500_checkout_context_rpc.sql
-- Sukima — Checkout が開始前に確認する情報を 1 往復で読む RPC
--
--   ⚠ このファイルは **draft** です。production へは適用しないこと。
--     他の課金 migration とまとめて適用する。
--
--   このファイルには秘密情報を含まない。
--   Stripe の Price ID / Customer ID / Secret Key の実値は 1 つも書かない。
--
--   なぜ新しい関数が要るのか:
--     Checkoutは開始前に 3 つを知る必要がある。
--       1. **既に有効な契約が無いか**（1 user = 1 active subscription）
--       2. **その利用者の Stripe Customer**（1 user = 1 Stripe Customer）
--       3. **現行版の Subscription Terms へ同意済みか**
--     `get_session_context()` は既存の方針で
--     **Stripe の内部 ID を返さない**。あちらは毎リクエストで呼ばれる
--     認証経路なので、Checkout のためだけに返す列を増やさない。
--     そこで **読み取り専用の別関数**を足す。
--
--   方針:
--     - **additive のみ。** 既存テーブル・既存関数・権限を一切変更しない。
--       列を足さない。CHECK も UNIQUE も触らない。
--     - **読み取り専用（STABLE）。** INSERT / UPDATE / DELETE を書かない。
--       同意の記録は `record_terms_consent()`（20260907051255）の責務で、
--       この関数は「同意済みか」を見るだけ。
--     - 既存の読み取り RPC（`get_quota_status`）と同じ流儀:
--       `SECURITY INVOKER` + `SET search_path` + service_role のみ EXECUTE。
--     - **再実行可能**（`CREATE OR REPLACE FUNCTION`）。
--
--   前提となる migration:
--     20260901022938  subscriptions（stripe_customer_id 列）
--     20260907051255  terms_consents
--
--   返さないもの（意図的）:
--     stripe_subscription_id / current_period_end / past_due_since /
--     email / google_sub / セッション情報。
--     Checkout の判断に要らないものは返さない。
-- =========================================================


-- =========================================================
-- 1. get_checkout_context
--
--    1 行を返す（subscriptions は user_id が UNIQUE）。
--    行が無い＝利用者行が無いということなので、呼び出し側は 0 行を
--    「異常」として扱う（free として扱わない。フェイルクローズ）。
--
--    terms_consented は **locale を問わない**。
--    ja と en のどちらで同意したかは terms_consents 側の記録が正で、
--    Checkout の判断に必要なのは「この版へ同意したか」だけ。
-- =========================================================

CREATE OR REPLACE FUNCTION public.get_checkout_context(
  p_user_id       UUID,
  p_terms_version TEXT
)
RETURNS TABLE (
  plan_id            TEXT,
  status             TEXT,
  stripe_customer_id TEXT,
  terms_consented    BOOLEAN
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id は必須です。';
  END IF;

  -- 版は server config が正。空白付きの版を黙って正規化せず拒否する
  -- （terms_consents_terms_version_format と同じ方針）。
  IF p_terms_version IS NULL
     OR p_terms_version <> btrim(p_terms_version)
     OR length(p_terms_version) NOT BETWEEN 1 AND 64 THEN
    RAISE EXCEPTION 'p_terms_version は前後空白の無い 1〜64 文字である必要があります。';
  END IF;

  RETURN QUERY
    SELECT s.plan_id,
           s.status,
           s.stripe_customer_id,
           EXISTS (
             SELECT 1
             FROM   public.terms_consents tc
             WHERE  tc.user_id       = p_user_id
               AND  tc.terms_version = p_terms_version
           )
    FROM   public.subscriptions s
    WHERE  s.user_id = p_user_id;
END;
$$;

COMMENT ON FUNCTION public.get_checkout_context(UUID, TEXT) IS
  'Checkout 開始前の確認用。契約状態・Stripe Customer・現行版への同意有無を読み取り専用で返す。書き込みは一切行わない。';

REVOKE ALL ON FUNCTION public.get_checkout_context(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_checkout_context(UUID, TEXT) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.get_checkout_context(UUID, TEXT) TO service_role;

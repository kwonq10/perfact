-- =========================================================
-- 20261018090000_billing_reflection_rpc.sql
-- Sukima — 今回の契約が webhook で DB へ反映済みかを確かめる読み取り専用 RPC
--
--   ⚠ このファイルは **draft** です。production へは、
--     /api/billing/conversion を含むコードを deploy する **前に** 適用すること。
--     未適用のまま deploy すると、計測 API は 502 database_unavailable を返す
--     （決済・権限・アプリの動作には影響しない。計測が行われないだけ）。
--
--   このファイルには秘密情報を含まない。
--
--   なぜ新しい関数が要るのか:
--     初回契約のコンバージョンは「今回の subscription が DB に反映済み」の
--     ときだけ送る。既存の読み取り RPC（get_session_context /
--     get_checkout_context）は stripe_subscription_id を返さないため照合できない。
--     既存関数の戻り値は変えずに、**照合結果の真偽だけを返す別関数**を足す。
--
--   方針:
--     - **additive のみ。** 既存テーブル・既存関数・権限を一切変更しない。
--     - **読み取り専用（STABLE）。** INSERT / UPDATE / DELETE を書かない。
--     - **返すのは真偽 1 つだけ。** stripe_subscription_id や契約状態そのものは返さない。
--       呼び出し側が知っている subscription ID と一致するかを答えるだけ。
--     - 既存の読み取り RPC と同じ流儀:
--       `SECURITY INVOKER` + `SET search_path` + **service_role のみ EXECUTE**。
--       anon / authenticated（ブラウザから届く鍵）には EXECUTE を与えない。
--       user_id はサーバーが Cookie session から得た値だけを渡す
--       （functions/api/billing/conversion.js）。
--     - **再実行可能**（`CREATE OR REPLACE FUNCTION`）。
--
--   前提となる migration:
--     20260901022938  subscriptions（stripe_subscription_id / plan_id / status 列）
-- =========================================================

CREATE OR REPLACE FUNCTION public.get_billing_reflection(
  p_user_id                UUID,
  p_stripe_subscription_id TEXT
)
RETURNS TABLE (
  reflected BOOLEAN
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

  IF p_stripe_subscription_id IS NULL
     OR p_stripe_subscription_id <> btrim(p_stripe_subscription_id)
     OR length(p_stripe_subscription_id) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'p_stripe_subscription_id は前後空白の無い 1〜255 文字である必要があります。';
  END IF;

  -- 行が無い利用者でも 1 行（false）を返す。呼び出し側は 1 行を前提にする。
  RETURN QUERY
    SELECT EXISTS (
      SELECT 1
      FROM   public.subscriptions s
      WHERE  s.user_id                = p_user_id
        AND  s.stripe_subscription_id = p_stripe_subscription_id
        AND  s.plan_id                = 'web_pro'
        AND  s.status                 = 'active'
    );
END;
$$;

COMMENT ON FUNCTION public.get_billing_reflection(UUID, TEXT) IS
  '初回契約の計測用。指定した subscription が、その利用者の契約行に web_pro・active として反映済みかだけを返す。書き込みは一切行わない。server-side function（service_role）からのみ呼ぶ。';

REVOKE ALL ON FUNCTION public.get_billing_reflection(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_billing_reflection(UUID, TEXT) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.get_billing_reflection(UUID, TEXT) TO service_role;

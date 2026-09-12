-- =========================================================
-- 20260912000000_user_exists.sql
-- Sukima — users 行の存在だけを返す読み取り専用 RPC
--
--   ⚠ このファイルは **draft** です。production へは適用しないこと。
--     他の課金 migration とまとめて適用する。
--
--   このファイルには秘密情報を含まない。
--
--   なぜ要るのか:
--     `apply_stripe_subscription_event` は subscriptions 行が無いとき例外を投げる。
--     その原因は 2 つあり、webhook 層では区別できなかった。
--
--       (a) **アカウントが削除された**（users も subscriptions も無い）
--           決済完了の直後、webhook が stripe_customer_id を書く前に
--           /api/account/delete が走ると起きる。削除 API は
--           stripe_customer_id が NULL のため Stripe を呼ばずに終わり、
--           Stripe 側に **課金され続ける孤児 subscription** が残る。
--       (b) **データ異常**（users はあるのに subscriptions 行だけ欠落）
--
--     (a) は Stripe 側を即時解約して回収したい。(b) は従来どおり
--     500 で止めて運用で気づきたい。**両者を区別する材料が要る。**
--
--   なぜ apply_stripe_subscription_event を変えないのか:
--     「孤児だった」ことを呼び出し側へ伝えるには戻り値の列を増やすことになる。
--     `RETURNS TABLE` の列を変えると CREATE OR REPLACE では差し替えられず
--     DROP FUNCTION が要る。20260911090000 で守った
--     **signature・戻り値の不変**という約束を壊さないため、
--     独立した読み取り専用の関数を 1 本足す形にする。
--
--   方針:
--     - **additive のみ。** 既存テーブル・既存関数・権限を一切変更しない。
--     - **読み取り専用（STABLE）。** INSERT / UPDATE / DELETE を書かない。
--     - 既存の読み取り RPC（`get_checkout_context`）と同じ流儀:
--       `SECURITY INVOKER` + `SET search_path` + service_role のみ EXECUTE。
--     - 動的 SQL を使わない。
--     - **再実行可能**（`CREATE OR REPLACE FUNCTION`）。
--
--   前提となる migration:
--     20260901022938  users
--
--   返さないもの（意図的）:
--     email / google_sub / created_at / 契約情報。
--     **返すのは「行があるか」だけ。** 削除済み利用者の情報を
--     webhook のログや応答へ運ばないための形。
--
--   ⚠ 列名 `exists` は SQL の予約語なので、宣言・参照とも
--     **必ず二重引用符で囲む**こと。
-- =========================================================


-- =========================================================
-- 1. user_exists(p_user_id)
--
--    1 行だけ返す。
--      "exists" = TRUE  : users 行がある
--      "exists" = FALSE : users 行が無い（削除済み、または最初から無い）
--
--    Checkout は Cookie session を必須にしているので、
--    **Checkout を通った user_id は必ず一度は存在していた**。
--    したがって webhook から見た FALSE は「削除された」を意味する。
-- =========================================================

CREATE OR REPLACE FUNCTION public.user_exists(
  p_user_id UUID
)
RETURNS TABLE (
  "exists" BOOLEAN
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

  RETURN QUERY
    SELECT EXISTS (
      SELECT 1
      FROM   public.users u
      WHERE  u.id = p_user_id
    );
END;
$$;

COMMENT ON FUNCTION public.user_exists(UUID) IS
  'users 行の有無だけを返す読み取り専用の関数。webhook が apply_stripe_subscription_event の例外を「アカウント削除済み（孤児 subscription）」と「subscriptions 行だけの欠落（データ異常）」に切り分けるために使う。利用者の属性は一切返さない。server-side function（service_role）からのみ呼ぶ。';

REVOKE ALL ON FUNCTION public.user_exists(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.user_exists(UUID) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.user_exists(UUID) TO service_role;

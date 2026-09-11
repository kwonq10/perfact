-- =========================================================
-- 20260907052839_stripe_subscription_event_rpc.sql
-- Sukima — Stripe webhook の subscription snapshot を原子的に適用する RPC
--
--   ⚠ このファイルは **draft** です。production へは適用しないこと。
--     他の課金 migration とまとめて適用する。
--
--   このファイルには秘密情報を含まない。
--
--   目的:
--     `stripe_events` への event 記録と `subscriptions` の更新を
--     **1 トランザクションで**行う。webhook endpoint は functions/api/billing/webhook.js。
--
--   このRPCの責務（これだけをやる）:
--     1. `stripe_event_id` を冪等キーとして記録する
--     2. 同一 event の再送は**副作用ゼロ**で already_processed を返す
--     3. 検証済みの subscription snapshot を 1 トランザクションで反映する
--     4. 順不同 event に耐える（`last_stripe_event_at` を watermark にする）
--     5. `past_due_since` を**遷移した時だけ**設定する
--     6. past_due 以外へ移ったら `past_due_since` を NULL に戻す
--
--   このRPCがやらないこと:
--     - **price_id から plan を推論しない。** 逆引きは webhook layer が
--       `functions/api/_lib/billing-config.js` の
--       `priceDefinitionFromPriceId()` で行い、確定した値を渡す（責務分離）
--     - **event_type ごとの Stripe ロジックを持たない。** 対象 event の選別は
--       webhook endpoint 側の責務。このRPCは「snapshot 適用」だけに集中する
--     - **raw payload を保存しない。** email / address / card 情報も保存しない
--     - entitlement 判定をしない（`functions/api/_lib/entitlement.js` の責務）
--
--   方針:
--     - **additive のみ**。既存テーブル・既存関数を 1 つも変更しない。
--       `stripe_events` / `subscriptions` の定義には触れない
--     - **再実行可能**（`CREATE OR REPLACE FUNCTION`）
--     - `SECURITY INVOKER` + `search_path` 固定（既存流儀。DEFINER は repo に 0 件）
--     - **動的 SQL を使わない**（`EXECUTE` / `format()` を書かない）
--
--   実行順:
--      1. apply_stripe_subscription_event() + COMMENT
--      2. 実行権限（PUBLIC / anon / authenticated から REVOKE、service_role へ GRANT）
-- =========================================================


-- =========================================================
-- 1. apply_stripe_subscription_event(...)
--
--    ■ 原子性（最重要点）
--      plpgsql 関数は呼び出し側と**同一トランザクション**で走る。
--      途中で RAISE EXCEPTION すると `stripe_events` への INSERT も含めて
--      **すべて rollback** される。だから Stripe は同じ event を再送でき、
--      「event は記録されたのに subscription が更新されていない」状態にならない。
--
--      このため本関数は **UPDATE 経路に EXCEPTION ハンドラを置かない**。
--      `BEGIN ... EXCEPTION` を挟むとサブトランザクションが張られ、
--      エラーを握り潰して event INSERT だけが残る危険がある。
--      `stripe_customer_id` / `stripe_subscription_id` の UNIQUE 違反も
--      そのまま呼び出し側へ伝播させ、webhook に retry させるのが正しい。
--
--    ■ 冪等性
--      `stripe_events` の PRIMARY KEY (`stripe_event_id`) を冪等キーにする。
--      `ON CONFLICT DO NOTHING` が 0 行なら **既に処理済み**なので、
--      subscriptions を一切触らずに現在値を返す。
--      再送で `past_due_since` や `current_period_end` が動かないことが要件。
--
--    ■ 順不同 event（watermark）
--      `subscriptions.last_stripe_event_at`（migration 20260907041329 で追加）と比べ、
--        incoming <  watermark -> **stale**。event は記録するが状態は更新しない
--        incoming >= watermark -> 適用し、watermark を incoming へ進める
--      同時刻は「適用」に倒す。厳密な順序保証は DB では作れないため、
--      **webhook 側が Stripe から subscription の現在値を再取得して渡す**のが本命で、
--      この watermark は多重防御。DB 単体で event 履歴を再構成はしない。
--
--    ■ snapshot 適用
--      渡された値は「Stripe から取り直した現在の状態」である前提で、
--      状態列（plan_id / status / price_id / currency / price_phase /
--      current_period_end / cancel_at_period_end）は**そのまま代入**する。
--      COALESCE で古い値を温存すると、解約や price 変更を反映できなくなる。
--
--    ■ Stripe 識別子を必須にした理由
--      本関数が扱う event は必ず「ある Stripe subscription の話」なので、
--      customer / subscription の id が NULL であることは webhook 側のバグ。
--      NULL を許して COALESCE で温存するより、**必須にして大きく失敗させる**方が
--      安全（Stripe との紐付けを静かに失う事故を防ぐ）。
--      `stripe_price_id` は状態列なので NULL を許す。
--
--    ■ 引数に無いもの
--      `billing_country` は 列を作らない方針のため受け取らない。
--      raw payload / email / address も受け取らない（PII 最小化）。
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

  -- 極端な未来の event を弾く。
  --   watermark が遠い未来へ飛ぶと、以降の正しい event がすべて stale 扱いになり
  --   subscription が永久に更新できなくなる。event.created は Stripe の署名付きで
  --   偽造できないため、これが起きるのは時計の異常だけ。1 時間は十分に寛容。
  --   例外にして webhook を失敗させ、Stripe に retry させるのが正しい
  --   （静かに握り潰して状態を凍結させるより安全）。
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

  -- Stripe 識別子は必須。理由は冒頭のコメント参照。
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

  -- price_id は状態列なので NULL を許す。ただし空白だけの値は弾く。
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
  -- Step 1: 冪等キーの記録。
  --   既に同じ event.id があれば 0 行になり、以降の更新は一切行わない。
  --   ここで INSERT した行は、後段で例外が出れば一緒に rollback される。
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
      -- 処理済みの event なのに行が無いのはデータ異常。fail closed。
      RAISE EXCEPTION 'subscriptions 行が存在しません。';
    END IF;

    RETURN QUERY SELECT FALSE, TRUE, FALSE,
                        v_ret_plan_id, v_ret_status,
                        v_ret_past_due_since, v_ret_watermark;
    RETURN;
  END IF;

  -- -------------------------------------------------------
  -- Step 2: 対象行をロックして現在値を読む（直列化点）。
  --   同一ユーザーへの同時 webhook はここで直列化される。
  --
  --   行が無ければ**失敗させる**（fail closed）。
  --   free 行は login / session 作成時に必ず作られる設計なので、
  --   行が無いのは「まだログインしていない user へ webhook が来た」等の異常。
  --   webhook だけで有料権限の行を生やす方が危険なので INSERT はしない。
  --   例外にすれば Step 1 の event INSERT も rollback され、Stripe が再送できる。
  -- -------------------------------------------------------
  SELECT s.plan_id, s.status, s.past_due_since, s.last_stripe_event_at
  INTO   v_old_plan_id, v_old_status, v_old_past_due_since, v_old_watermark
  FROM   public.subscriptions s
  WHERE  s.user_id = p_user_id
  FOR    UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscriptions 行が存在しません。';
  END IF;

  -- -------------------------------------------------------
  -- Step 3: stale 判定。
  --   watermark より古い event は「記録はするが状態は変えない」。
  --   watermark が NULL（Stripe 初回）なら必ず適用する。
  -- -------------------------------------------------------
  IF v_old_watermark IS NOT NULL AND p_event_created_at < v_old_watermark THEN
    RETURN QUERY SELECT FALSE, FALSE, TRUE,
                        v_old_plan_id, v_old_status,
                        v_old_past_due_since, v_old_watermark;
    RETURN;
  END IF;

  -- -------------------------------------------------------
  -- Step 4: past_due_since を決める（7 日猶予の起点）。
  --
  --     past_due でない -> past_due    : 起点 = p_event_created_at（遷移時のみ）
  --     past_due        -> past_due    : 既存の起点を**そのまま維持**
  --     past_due        -> それ以外     : NULL に戻す
  --     past_due 以外   -> past_due 以外: NULL のまま
  --
  --   起点に now() ではなく p_event_created_at を使う。
  --   webhook の再送や配送遅延で猶予の起点がずれると、
  --   同じ支払い失敗なのに利用者ごとに Pro の残り時間が変わってしまうため。
  --
  --   同一 event の再送は Step 1 で弾かれるのでここへ来ない。
  --   past_due が続く間の後続 event（invoice.payment_failed の再発など）でも、
  --   既存の起点を維持するので**猶予が延びない**。
  --
  --   past_due を抜けて再び past_due になった場合は、
  --   old status が past_due ではないので新しい起点が入る（猶予が作り直される）。
  --   これは「別の支払い失敗」なので正しい。
  --
  --   entitlement.js は past_due_since から 7 日未満だけ Pro と判定する。
  --   ここで NULL に戻しておけば、active / trialing は素直に Pro、
  --   canceled / unpaid / incomplete 系は素直に Free になる。
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
  -- Step 5: snapshot を適用する。
  --   状態列はそのまま代入（COALESCE しない）。理由は冒頭のコメント参照。
  --   `updated_at` は既存の BEFORE UPDATE トリガが更新するので触らない。
  --
  --   ここで stripe_customer_id / stripe_subscription_id の UNIQUE 違反が
  --   起きた場合、**例外はそのまま伝播**して Step 1 の event INSERT ごと
  --   rollback される（EXCEPTION ハンドラを置いていないため）。
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
    -- Step 2 で行ロックを取っているのでここへは来ないが、fail closed で守る。
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
  'Stripe webhook の subscription snapshot を、event 記録と同一トランザクションで適用する。stripe_event_id が冪等キー。last_stripe_event_at を watermark にして順不同 event に耐える。past_due_since は past_due へ遷移した時だけ設定し、抜けたら NULL に戻す。plan_id / currency / price_phase は webhook layer が billing-config で確定した検証済みの値を渡すこと（DB は price_id から plan を推論しない）。server-side function（service_role）からのみ呼ぶ。';


-- =========================================================
-- 2. 実行権限
--    PostgreSQL は新規関数の EXECUTE を既定で PUBLIC に与える。
--    明示的に剥奪しないと anon キーだけで RPC を叩ける状態になる。
-- =========================================================
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

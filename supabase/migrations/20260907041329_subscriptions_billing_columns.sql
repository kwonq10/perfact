-- =========================================================
-- 20260907041329_subscriptions_billing_columns.sql
-- Sukima — subscriptions を Stripe 連携できるよう拡張する
--
--   ⚠ このファイルは **draft** です。production へは適用しないこと。
--     他の課金 migration とまとめて適用する。
--
--   このファイルには秘密情報を含まない。
--   Stripe の Price ID / Customer ID / Secret Key / Webhook Secret の
--   実値は 1 つも書かない（列を用意するだけ）。
--
--   方針:
--     - **additive のみ**。既存列の型・CHECK・UNIQUE を一切変更しない。
--     - DROP / ALTER COLUMN / TRUNCATE / DELETE / UPDATE を行わない。
--       **backfill しない**。
--     - 追加する 5 列はすべて **NULL 許容・DEFAULT なし**。
--       PostgreSQL 11 以降、DEFAULT の無い ADD COLUMN は全行書き換えを伴わない
--       （短時間の ACCESS EXCLUSIVE ロックのみ）。
--     - **適用しただけでは既存ユーザーの挙動が一切変わらない。**
--       既存行（free / 課金済みとも）は 5 列すべて NULL のままで、
--       entitlement の判定結果も API の応答も変化しない。
--     - 新しい関数を作らない。既存 RPC の signature を変えない。
--
--   実行順（上から通しで実行する）:
--      1. subscriptions への列追加
--      2. CHECK 制約の追加（再実行可能な DO ブロック）
--      3. COMMENT
--
--   変更しないもの:
--     - subscriptions の既存列（plan_id / status の CHECK を含む）。
--       plan_id は既に 4 プラン、status は既に Stripe の 7 ステータスに対応済み。
--     - `user_id` の UNIQUE（1 ユーザー 1 行を構造的に強制する。仕様と一致）
--     - `upsert_user_and_subscription()`。
--       `ON CONFLICT (user_id) DO NOTHING` を維持する。
--       新規列は NULL 許容なので、この INSERT は列を増やさなくても通る。
--     - RLS の有効/無効・ポリシー（1 件も追加しない）
--     - テーブル権限。列単位の GRANT は使っていないため、
--       20260901022938 と 20260901044339 で確定したテーブル権限
--       （anon / authenticated は権限なし・service_role のみ arwd）が
--       **新規列にもそのまま及ぶ**。追加の GRANT / REVOKE は不要。
--     - `get_session_context()`。`past_due_since` を session context へ
--       返すのは migration 20260907054729。それまで 7 日猶予ロジック（entitlement.js）は
--       無害に空回りしたままで、既存挙動は変わらない。
--     - 他テーブル（users / weekly_usage / stripe_events / sessions /
--       quota_reservations）と他 migration
--
--   今回入れなかったもの:
--     - `billing_country`（請求先国）。
--       **含めない**と判断した。
--       請求先国は webhook が Stripe Customer から都度判定する（対象外なら
--       即時 cancel）。保存が必要になったら別 migration で追加する。
--       additive なので後から足しても既存行に影響しない。
-- =========================================================


-- =========================================================
-- 1. subscriptions への列追加
--
--    stripe_price_id
--      現在契約中の Stripe Price の ID。表示と phase 判定に使う。
--      実値はコードにも migration にも書かない。webhook が書き込む。
--      逆引き（price_id -> plan / currency / phase）は
--      functions/api/_lib/billing-config.js の
--      priceDefinitionFromPriceId() が env 経由で行う。
--
--    currency
--      契約通貨。'jpy' / 'usd' のみ。CHECK で **契約中の通貨変更不可**を
--      支えるための記録でもある（変更したい場合は解約 -> 期間終了 ->
--      新通貨で再契約という仕様）。
--      将来 gbp / cad / aud を売るときは CHECK に値を足すだけでよい。
--
--    price_phase
--      'launch' / 'standard'。ローンチ価格の対象契約かどうかの記録。
--      2027 年最初の更新日で standard へ移行させる判定に使う。
--
--    past_due_since
--      past_due へ**遷移した時刻**。7 日猶予の起点。
--      entitlement.js（isWithinPastDueGrace）がこの値を読む。
--      「past_due の間ずっと現在時刻で上書きする」のではなく起点を固定するため、
--      webhook の再送や順不同 event で猶予が延び続けることがない。
--      past_due を抜けたら NULL に戻す（実装は webhook）。
--
--    last_stripe_event_at
--      適用済み Stripe event の watermark。
--      Stripe の event は順不同で届き得るため、これより古い event を
--      無視して古い状態で上書きするのを防ぐ（実装は webhook）。
--      stripe_events テーブルの冪等性（同一 event の二重処理防止）とは
--      役割が異なり、両方必要。
--
--    5 列とも NULL 許容・DEFAULT なし。既存行は触らない。
-- =========================================================

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS stripe_price_id      TEXT,
  ADD COLUMN IF NOT EXISTS currency             TEXT,
  ADD COLUMN IF NOT EXISTS price_phase          TEXT,
  ADD COLUMN IF NOT EXISTS past_due_since       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_stripe_event_at TIMESTAMPTZ;


-- =========================================================
-- 2. CHECK 制約
--
--    PostgreSQL は ADD CONSTRAINT IF NOT EXISTS を持たないため、
--    pg_constraint を見てから追加する（再実行可能にするため）。
--
--    条件を `IS NULL OR ... IN (...)` と明示的に書く。
--    SQL では `NULL IN ('jpy','usd')` は NULL に評価され、CHECK は
--    「false でなければ通る」ので NULL は書かなくても通過するが、
--    「NULL を許すのは意図的」であることをコードに残すため明示する。
--
--    既存行は全て NULL なので、この制約の検証スキャンは必ず成功する。
--    NOT VALID + VALIDATE に分けていないのは、対象テーブルが
--    1 ユーザー 1 行と小さく、スキャンが問題にならないため。
--
--    制約名は PostgreSQL が列 CHECK に自動生成する名前と同じ形にそろえる。
-- =========================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   pg_constraint
    WHERE  conrelid = 'public.subscriptions'::regclass
      AND  conname  = 'subscriptions_currency_check'
  ) THEN
    ALTER TABLE public.subscriptions
      ADD CONSTRAINT subscriptions_currency_check
      CHECK (currency IS NULL OR currency IN ('jpy', 'usd'));
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   pg_constraint
    WHERE  conrelid = 'public.subscriptions'::regclass
      AND  conname  = 'subscriptions_price_phase_check'
  ) THEN
    ALTER TABLE public.subscriptions
      ADD CONSTRAINT subscriptions_price_phase_check
      CHECK (price_phase IS NULL OR price_phase IN ('launch', 'standard'));
  END IF;
END;
$$;


-- =========================================================
-- 3. COMMENT
--    既存 migration の流儀にそろえ、全ての新規列に付ける。
-- =========================================================

COMMENT ON COLUMN public.subscriptions.stripe_price_id      IS '現在契約中の Stripe Price ID。webhook が書き込む。plan / currency / phase の逆引きは billing-config.js が env 経由で行う。Free は NULL。';
COMMENT ON COLUMN public.subscriptions.currency             IS '契約通貨。jpy / usd のみ。契約中の通貨変更は不可（変更は解約 -> 期間終了 -> 新通貨で再契約）。将来 gbp / cad / aud は CHECK に追加する。Free は NULL。';
COMMENT ON COLUMN public.subscriptions.price_phase          IS 'launch / standard。ローンチ価格の対象契約かの記録。2027 年最初の更新日での standard 移行判定に使う。Free は NULL。';
COMMENT ON COLUMN public.subscriptions.past_due_since       IS 'past_due へ遷移した時刻。7 日猶予の起点で entitlement.js が読む。past_due の間は上書きしない（再送・順不同 event で猶予が延びないため）。past_due を抜けたら NULL に戻す。';
COMMENT ON COLUMN public.subscriptions.last_stripe_event_at IS '適用済み Stripe event の watermark。これより古い event を無視して古い状態で上書きするのを防ぐ。stripe_events の冪等性とは役割が別で、両方必要。';


-- =========================================================
-- 以上。
--   他の課金 migration とまとめて production へ適用する。
-- =========================================================

-- =========================================================
-- 001_billing_schema.sql
-- Sukima 課金基盤 — Supabase スキーマ（STEP 3 確定版）
--
--   対象プロジェクト : sukima-billing
--   復元日           : 2026-09-01
--   出典             : BILLING_SPEC.md §15（2026-08-30 時点の確定版）
--                      + step7_upsert_user_and_subscription.sql（STEP 7 確定版）
--
--   このファイルには秘密情報を含まない。
--     - Secret key / service_role key 本体
--     - Project URL / DB パスワード
--     - Stripe キー / 環境変数
--     - テストユーザー・検証用クエリ・クリーンアップ SQL
--
--   ⚠ 本番環境で実行する前に必ずレビューすること。
--   ⚠ 本ファイルは「新規構築用」。IF NOT EXISTS のため、既にテーブルがある
--     場合は定義差分（カラム変更・制約変更）が反映されない。
--
--   実行順（上から通しで実行する。依存関係あり）:
--      1. pgcrypto
--      2. set_updated_at()
--      3. jst_week_start()
--      4. users
--      5. subscriptions
--      6. weekly_usage
--      7. stripe_events
--      8. indexes
--      9. updated_at triggers
--     10. RLS 有効化
--     11. upsert_user_and_subscription()
--     12. consume_weekly_usage()
--     13. REVOKE / GRANT
--
--   ※ 13 まで実行して初めて安全な状態になる。途中で止めない。
--     途中で止めると RPC が anon から実行可能なまま残る。
-- =========================================================


-- =========================================================
-- 1. pgcrypto
--    gen_random_uuid() は PostgreSQL 13 以降コアに含まれる（Supabase は 15 以降）。
--    古い環境への保険として有効化する（すでに有効なら何もしない）。
-- =========================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;


-- =========================================================
-- 2. set_updated_at()
--    updated_at 自動更新用の共通トリガ関数。
--    users / subscriptions / weekly_usage の3テーブルで共有する。
-- =========================================================
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.set_updated_at() IS
  'BEFORE UPDATE トリガ用。updated_at を now() で上書きする共通関数。';


-- =========================================================
-- 3. jst_week_start()
--    Asia/Tokyo 基準で現在が属する週の月曜日を返す。
--    consume_weekly_usage が内部で使用する（クライアント側では週を算出しない）。
--
--    - Asia/Tokyo
--    - 月曜始まり（date_trunc('week', ...) は ISO 週 = 月曜始まり）
--    - STABLE（now() を使うため IMMUTABLE 不可）
--    - SECURITY INVOKER
--    - search_path 固定
--    - 引数を取らない（呼び出し側に任意の週を指定させないため）
-- =========================================================
CREATE OR REPLACE FUNCTION public.jst_week_start()
RETURNS DATE
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT (date_trunc('week', (now() AT TIME ZONE 'Asia/Tokyo')))::date;
$$;

COMMENT ON FUNCTION public.jst_week_start() IS
  'Asia/Tokyo 基準で現在が属する週の月曜日を返す。consume_weekly_usage が使用する。';


-- =========================================================
-- 4. users
--    認証は Google OAuth。Supabase Auth は使わない。
-- =========================================================
CREATE TABLE IF NOT EXISTS public.users (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  google_sub TEXT        NOT NULL UNIQUE,
  email      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE  public.users            IS 'Google ログインユーザー。認証は Google OAuth、Supabase Auth は使わない。';
COMMENT ON COLUMN public.users.google_sub IS 'Google ID Token の sub クレーム。server-side function が検証した値のみ格納する。';
COMMENT ON COLUMN public.users.email      IS '表示・連絡用。識別には使わないため UNIQUE を付けない。';


-- =========================================================
-- 5. subscriptions
--    1ユーザー1行。Free ユーザーも行を持つ（plan_id='free', status='active'）。
--    権限は plan_id + status の組み合わせで判定する。
-- =========================================================
CREATE TABLE IF NOT EXISTS public.subscriptions (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID        NOT NULL UNIQUE
                           REFERENCES public.users(id) ON DELETE CASCADE,
  plan_id                TEXT        NOT NULL DEFAULT 'free'
                           CHECK (plan_id IN ('free', 'web_pro', 'extension_pro', 'all_pro')),
  stripe_customer_id     TEXT        UNIQUE,   -- Free は NULL
  stripe_subscription_id TEXT        UNIQUE,   -- Free は NULL
  status                 TEXT        NOT NULL DEFAULT 'active'
                           CHECK (status IN (
                             'active', 'trialing', 'past_due',
                             'canceled', 'unpaid', 'incomplete', 'incomplete_expired'
                           )),
  current_period_end     TIMESTAMPTZ,          -- Free は NULL
  cancel_at_period_end   BOOLEAN     NOT NULL DEFAULT false,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE  public.subscriptions        IS '1ユーザー1行。Free も行を持つ。権限は plan_id + status で判定する。';
COMMENT ON COLUMN public.subscriptions.status IS 'Stripe の subscription status に準拠。Free の active は「契約が正常」の意味で Pro 権限ではない。';


-- =========================================================
-- 6. weekly_usage
--    Free の週3回制限カウント。Web版・拡張機能版を合算して1行で管理する。
--    google_sub は保存しない。users.id (UUID) を参照する。
--    上限（3）は consume_weekly_usage が制御するため CHECK には入れない。
-- =========================================================
CREATE TABLE IF NOT EXISTS public.weekly_usage (
  user_id      UUID        NOT NULL
                 REFERENCES public.users(id) ON DELETE CASCADE,
  week_start   DATE        NOT NULL,   -- Asia/Tokyo 基準の月曜日
  search_count INT         NOT NULL DEFAULT 0 CHECK (search_count >= 0),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (user_id, week_start)   -- UNIQUE 制約を兼ねる
);

COMMENT ON TABLE  public.weekly_usage              IS 'Free の週3回制限カウント。Web版と拡張機能版を合算して1行で管理する。';
COMMENT ON COLUMN public.weekly_usage.week_start   IS 'Asia/Tokyo 基準のその週の月曜日。consume_weekly_usage RPC が jst_week_start() で算出する。';
COMMENT ON COLUMN public.weekly_usage.search_count IS '上限（3）は consume_weekly_usage RPC が制御する。CHECK は >= 0 のみ。';


-- =========================================================
-- 7. stripe_events
--    Webhook 冪等性管理。payload は保存しない（PII 最小化）。
--    追記専用のため updated_at を持たない → トリガ対象外。
-- =========================================================
CREATE TABLE IF NOT EXISTS public.stripe_events (
  stripe_event_id TEXT        PRIMARY KEY,   -- Stripe の event.id
  event_type      TEXT        NOT NULL,
  processed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE  public.stripe_events                 IS 'Webhook 冪等性用。INSERT の UNIQUE 違反で二重処理を検知する。payload は保存しない。';
COMMENT ON COLUMN public.stripe_events.stripe_event_id IS 'Stripe の event.id。重複 INSERT が UNIQUE 違反になることを冪等性の判定に使う。';


-- =========================================================
-- 8. indexes
--    UNIQUE 制約には暗黙のインデックスが張られるが、検索経路を明示するため
--    設計どおり明示的にも作成する（BILLING_SPEC.md §15-2 / §15-3）。
--    weekly_usage は PRIMARY KEY (user_id, week_start) が索引を兼ねるため追加なし。
--    stripe_events は PRIMARY KEY (stripe_event_id) のみで足りるため追加なし。
-- =========================================================
CREATE INDEX IF NOT EXISTS idx_users_google_sub
  ON public.users (google_sub);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id
  ON public.subscriptions (user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_customer_id
  ON public.subscriptions (stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_subscription_id
  ON public.subscriptions (stripe_subscription_id);


-- =========================================================
-- 9. updated_at triggers
--    stripe_events は updated_at を持たないため対象外。
-- =========================================================
DROP TRIGGER IF EXISTS trg_users_set_updated_at ON public.users;
CREATE TRIGGER trg_users_set_updated_at
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_subscriptions_set_updated_at ON public.subscriptions;
CREATE TRIGGER trg_subscriptions_set_updated_at
  BEFORE UPDATE ON public.subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_weekly_usage_set_updated_at ON public.weekly_usage;
CREATE TRIGGER trg_weekly_usage_set_updated_at
  BEFORE UPDATE ON public.weekly_usage
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- =========================================================
-- 10. RLS 有効化
--     ポリシーは1つも作らない（= anon / authenticated は全拒否）。
--     service_role は RLS をバイパスするためバックエンド Function からは操作できる。
--
--     ポリシーを1つも作らないこと自体が仕様（BILLING_SPEC.md §15-7）。
--     将来クライアントから直接読ませたいデータが出ても、
--     課金・利用回数テーブルにはポリシーを追加しない。
-- =========================================================
ALTER TABLE public.users         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.weekly_usage  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_events ENABLE ROW LEVEL SECURITY;


-- =========================================================
-- 11. upsert_user_and_subscription(TEXT, TEXT)
--     ログイン時に users / subscriptions を作成する RPC。
--
--     設計上の要点:
--       - users は ON CONFLICT DO UPDATE を使う。
--         DO NOTHING だと競合時に RETURNING が空になり user_id を取得できないため。
--         email 以外の列は書き換えないので実質的な副作用はない。
--       - subscriptions は ON CONFLICT (user_id) DO NOTHING。
--         既存の有料 subscription を絶対に上書きしない。
--       - 全体が1つの関数呼び出し = 1トランザクションなので、
--         同時ログインでも users と subscriptions の整合が崩れない。
--       - p_google_sub には検証済み ID Token の sub のみが渡される
--         （バックエンド Function 側で保証。クライアントからは受け取らない）。
--       - 戻り値に user_id は含めない。
-- =========================================================
CREATE OR REPLACE FUNCTION public.upsert_user_and_subscription(
  p_google_sub TEXT,
  p_email      TEXT DEFAULT NULL
)
RETURNS TABLE (plan_id TEXT, status TEXT)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id UUID;
BEGIN
  IF p_google_sub IS NULL OR length(trim(p_google_sub)) = 0 THEN
    RAISE EXCEPTION 'p_google_sub は必須です。';
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

  RETURN QUERY
    SELECT s.plan_id, s.status
    FROM   public.subscriptions s
    WHERE  s.user_id = v_user_id;
END;
$$;

COMMENT ON FUNCTION public.upsert_user_and_subscription(TEXT, TEXT) IS
  'ログイン時に users / subscriptions を作成する。google_sub は検証済み ID Token の sub のみ。server-side function からのみ呼ぶ。';


-- =========================================================
-- 12. consume_weekly_usage(UUID)
--     Free の週3回制限を原子的に消費する。
--
--     - 引数は p_user_id のみ（week_start は受け取らない）
--     - week_start は jst_week_start() で内部算出
--     - 上限 3。search_count < 3 のときだけ +1
--     - allowed / search_count / remaining を返す
--     - SECURITY INVOKER・search_path 固定
--     - 列参照は weekly_usage. で修飾する
--       （戻り値の列名 search_count と PL/pgSQL 変数が衝突し
--        "column reference is ambiguous" になるのを避けるため）
--     - updated_at は 9. のトリガが更新するため RPC 内で代入しない
-- =========================================================
CREATE OR REPLACE FUNCTION public.consume_weekly_usage(
  p_user_id UUID
)
RETURNS TABLE (allowed BOOLEAN, search_count INT, remaining INT)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_week_start DATE;
  v_new_count  INT;
  v_limit      CONSTANT INT := 3;
BEGIN
  -- Step 0: 対象週（Asia/Tokyo の月曜日）を DB 側で算出する
  v_week_start := public.jst_week_start();

  -- Step 1: 対象週の行がなければ作成（競合時は何もしない）
  INSERT INTO weekly_usage (user_id, week_start, search_count)
  VALUES (p_user_id, v_week_start, 0)
  ON CONFLICT (user_id, week_start) DO NOTHING;

  -- Step 2: 行ロックを取得し、上限未満なら +1
  --   UPDATE が行レベルロックを取るため、同時リクエストはここで直列化される
  UPDATE weekly_usage
  SET    search_count = weekly_usage.search_count + 1
  WHERE  weekly_usage.user_id      = p_user_id
    AND  weekly_usage.week_start   = v_week_start
    AND  weekly_usage.search_count < v_limit
  RETURNING weekly_usage.search_count INTO v_new_count;

  IF v_new_count IS NULL THEN
    -- UPDATE が0行 = 上限到達
    SELECT wu.search_count
    INTO   v_new_count
    FROM   weekly_usage wu
    WHERE  wu.user_id    = p_user_id
      AND  wu.week_start = v_week_start;

    RETURN QUERY SELECT FALSE, COALESCE(v_new_count, 0), 0;
  ELSE
    RETURN QUERY SELECT TRUE, v_new_count, (v_limit - v_new_count);
  END IF;
END;
$$;

COMMENT ON FUNCTION public.consume_weekly_usage(UUID) IS
  'Free の週3回制限を原子的に消費する。server-side function（service_role）からのみ呼ぶこと。p_user_id は users.id（UUID）。week_start は jst_week_start() で内部算出する。';


-- =========================================================
-- 13. REVOKE / GRANT
--     ここまで実行して初めて安全な状態になる。
-- =========================================================

-- ---------------------------------------------------------
-- 13-1. テーブル権限（RLS に加えた多層防御）
--       Supabase は public スキーマの新規テーブルに anon / authenticated へ
--       既定の GRANT を与えるため、明示的に剥奪する。
-- ---------------------------------------------------------
REVOKE ALL ON TABLE public.users         FROM anon, authenticated;
REVOKE ALL ON TABLE public.subscriptions FROM anon, authenticated;
REVOKE ALL ON TABLE public.weekly_usage  FROM anon, authenticated;
REVOKE ALL ON TABLE public.stripe_events FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.users         TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.subscriptions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.weekly_usage  TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.stripe_events TO service_role;


-- ---------------------------------------------------------
-- 13-2. 関数の実行権限
--       PostgreSQL は新規関数の EXECUTE を既定で PUBLIC に与える。
--       明示的に剥奪しないと anon キーだけで RPC を叩ける状態になる。
-- ---------------------------------------------------------

-- upsert_user_and_subscription：service_role のみ実行可
REVOKE ALL ON FUNCTION public.upsert_user_and_subscription(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_user_and_subscription(TEXT, TEXT) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.upsert_user_and_subscription(TEXT, TEXT) TO service_role;

-- consume_weekly_usage：service_role のみ実行可
REVOKE ALL ON FUNCTION public.consume_weekly_usage(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.consume_weekly_usage(UUID) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.consume_weekly_usage(UUID) TO service_role;

-- jst_week_start：クライアントから直接呼ぶ必要はない。
--   ただし consume_weekly_usage が SECURITY INVOKER で内部呼び出しするため、
--   service_role には EXECUTE が必要（無いと RPC が権限エラーになる）。
REVOKE ALL ON FUNCTION public.jst_week_start() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.jst_week_start() FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.jst_week_start() TO service_role;

-- set_updated_at：トリガ関数。アプリロールから直接呼ぶ必要はない。
--   トリガはテーブル所有者の権限で起動されるため EXECUTE の付与は不要。
REVOKE ALL ON FUNCTION public.set_updated_at() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_updated_at() FROM anon, authenticated;


-- =========================================================
-- 以上。
-- =========================================================

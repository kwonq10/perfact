-- =========================================================
-- 20260907051255_terms_consents.sql
-- Sukima — Subscription Terms の同意履歴を追記型で保存する
--
--   ⚠ このファイルは **draft** です。production へは適用しないこと。
--     他の課金 migration とまとめて適用する。
--
--   このファイルには秘密情報を含まない。
--
--   目的:
--     Checkout 前の Subscription Terms 同意を、**監査目的で追記保存**する。
--     API は functions/api/terms/consent.js の担当で、ここは DB 層だけを作る。
--
--   確定仕様:
--     - ja / en の Subscription Terms を用意する
--     - Checkout 前に checkbox 同意を必須にする
--     - 保存項目は internal user identifier / accepted_at / terms_version / locale
--     - **IP は保存しない**
--     - consent 履歴は**追記型**（更新しない）
--     - **account 削除後も監査目的で保持できる構造**にする
--
--   方針:
--     - **additive のみ**。既存テーブル・既存関数を 1 つも変更しない。
--     - **backfill しない**。
--     - **再実行可能**にする。
--       `CREATE TABLE IF NOT EXISTS` は `20260901022938_billing_schema.sql` の流儀。
--       制約は CREATE TABLE の内側に置いてあるので、2 回目は表ごとスキップされる。
--     - 関数は既存流儀に合わせて **SECURITY INVOKER + search_path 固定**。
--       このリポジトリの migration に `SECURITY DEFINER` は 1 件も無い。
--     - **動的 SQL を使わない**（`EXECUTE` / `format()` を書かない）。
--
--   実行順（依存関係あり。上から通しで実行する）:
--      1. terms_consents            + COMMENT
--      2. RLS 有効化（ポリシーは作らない）
--      3. テーブル権限（anon / authenticated から REVOKE、service_role へ GRANT）
--      4. record_terms_consent()    + 実行権限
--
--   変更しないもの:
--     - users / subscriptions / weekly_usage / stripe_events /
--       sessions / quota_reservations のテーブル定義
--     - 既存の RPC すべて（signature も本体も触らない）
--     - 既存の RLS / ポリシー / 権限
-- =========================================================


-- =========================================================
-- 1. terms_consents
--    Subscription Terms への同意履歴。**追記専用**。
--
--    ■ users への FOREIGN KEY を張らない（設計上の要）
--      account 削除後も監査用の consent 履歴を残すため。
--      FK + ON DELETE CASCADE を張ると、users を消した瞬間に
--      同意記録まで消えてしまい「削除後も保持できる構造」を満たせない。
--      FK を張らずに NO ACTION 相当にするより、**FK 自体を持たない**方が
--      意図が明確で、users を消しても参照整合エラーが起きない。
--
--      user_id は `public.users.id` と同じ UUID だが、users 行が消えた後は
--      **email / google_sub と直接結び付かない内部識別子**として残る。
--      terms_consents 単体からは本人を特定できない（PII を持たないため）。
--
--      前例: `quota_reservations.user_id` も users への直接 FK を持たない
--      （20260903015535）。本表はそれをさらに進めて親を一切持たない。
--
--    ■ 保存しないもの（PII 最小化）
--      IP / user agent / billing address / google_sub / email /
--      Stripe customer ID / Stripe subscription ID
--
--    ■ updated_at を持たない
--      追記専用なので更新されない。`stripe_events` / `sessions` と同じ扱いで、
--      `set_updated_at` トリガの対象外にする。
--      「列が無い」ことが「更新しない」の構造的な表明になる。
--
--    ■ accepted_at と created_at
--      accepted_at = 利用者が同意した時刻
--      created_at  = 行が書かれた時刻
--      現時点ではどちらも now() で一致するが、意味が違うので両方持つ。
--      RPC が accepted_at を引数に取らないため、**同意時刻を client から
--      さかのぼって指定することはできない**（監査記録の信頼性のため）。
-- =========================================================

CREATE TABLE IF NOT EXISTS public.terms_consents (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- public.users.id と同じ UUID。**FK は張らない**（上のコメント参照）。
  user_id       UUID        NOT NULL,

  -- 同意した規約の版。'2026-12-01' / '2026-12-01-1' など、将来の版番号規則を
  -- 縛らないため TEXT で持ち、形式は DB で決めない。
  -- 「現行版がどれか」は server config の責務で、DB は知らなくてよい。
  terms_version TEXT        NOT NULL,

  -- 同意時に表示していた言語。初期は ja / en のみ。
  locale        TEXT        NOT NULL,

  accepted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- 同一利用者が同じ版・同じ言語へ二重に同意した記録を作らない。
  -- API の retry や checkbox の二度押しで行が増殖するのを構造的に防ぐ。
  -- 版が変われば別行になるため、追記型（過去の同意を上書きしない）は保たれる。
  CONSTRAINT terms_consents_user_version_locale_key
    UNIQUE (user_id, terms_version, locale),

  -- locale は小文字の 2 文字のみ。'JA' / 'EN' は弾く。
  -- 将来 locale を増やすときはこの CHECK に値を足す。
  CONSTRAINT terms_consents_locale_values
    CHECK (locale IN ('ja', 'en')),

  -- terms_version の最低限の健全性。形式は縛らないが、
  --   - 空文字 / 空白のみ を許さない
  --   - 前後に空白が付いた版を別物として保存させない
  --     （' 2026-12-01' と '2026-12-01' が UNIQUE 上で別行になるのを防ぐ）
  --   - 無制限に長い文字列を保存させない
  -- 正規化（trim）は**しない**。不正な値は保存せず拒否する
  -- （timezone を正規化せず拒否するのと同じ方針）。
  CONSTRAINT terms_consents_terms_version_format
    CHECK (
      terms_version = btrim(terms_version)
      AND length(terms_version) BETWEEN 1 AND 64
    )
);

COMMENT ON TABLE  public.terms_consents               IS 'Subscription Terms の同意履歴。追記専用で更新しない。users への FK を持たないため account 削除後も監査記録として残る。IP / email / google_sub / Stripe ID は保存しない。';
COMMENT ON COLUMN public.terms_consents.user_id       IS 'public.users.id と同じ UUID。FK は張らない（削除後も残すため）。users 行が消えた後は email / google_sub と結び付かない内部識別子になる。';
COMMENT ON COLUMN public.terms_consents.terms_version IS '同意した規約の版。形式は DB で縛らない（将来の版番号規則に追随するため）。現行版の正は server config が持つ。';
COMMENT ON COLUMN public.terms_consents.locale        IS '同意時に表示していた言語。初期は ja / en のみ。増やすときは CHECK に値を足す。';
COMMENT ON COLUMN public.terms_consents.accepted_at   IS '利用者が同意した時刻。RPC は引数に取らないため client からさかのぼって指定できない。';
COMMENT ON COLUMN public.terms_consents.created_at    IS '行が書かれた時刻。accepted_at とは意味が異なるため別に持つ。';


-- =========================================================
-- 2. index について
--
--    **追加のインデックスは作らない。**
--
--    UNIQUE (user_id, terms_version, locale) に暗黙のインデックスが張られ、
--    これが以下の検索経路を両方カバーする。
--      - 「この利用者は現行版へ同意済みか」 -> (user_id, terms_version) の前方一致
--      - 「この利用者の同意履歴」           -> user_id の前方一致
--
--    (user_id, accepted_at DESC) の索引も検討したが、
--    1 利用者あたりの行数は「版 × 言語」でせいぜい数行にしかならず、
--    上の索引で user_id に絞った後の並べ替えは無視できる。
--    書き込みコストと引き換えに得るものが無いため、必要最小限に留める
--    （`weekly_usage` / `stripe_events` が PK だけで済ませているのと同じ判断）。
--
--    将来 1 利用者あたりの行数が増える設計変更（毎回の再同意を記録する等）を
--    するなら、そのときに 1 行足せばよい。
-- =========================================================


-- =========================================================
-- 3. RLS 有効化
--    ポリシーは 1 つも作らない（= anon / authenticated は全拒否）。
--    service_role は RLS をバイパスするためバックエンド Function からは操作できる。
--    既存 6 テーブルと同じ扱い。
-- =========================================================
ALTER TABLE public.terms_consents ENABLE ROW LEVEL SECURITY;


-- =========================================================
-- 4. テーブル権限
--    Supabase は public スキーマの新規テーブルに anon / authenticated へ
--    既定の GRANT を与えるため、明示的に剥奪する（20260901044339 と同じ理由）。
--
--    service_role へは **SELECT と INSERT だけ**を与える。
--    UPDATE / DELETE を与えない理由:
--      - 追記型であり、アプリ経路が既存行を書き換える正当な理由が無い
--      - account 削除で consent を消してはいけない。
--        DELETE を与えないことで「消せない」ことを権限として担保する
--    これは既存 4 テーブルが 4 権限すべてを持つ流儀からの意図的な逸脱で、
--    「追記専用」を構造として表現するための選択。
--    運用上どうしても修正が要る場合は owner（supabase_admin）で行う。
-- =========================================================
REVOKE ALL ON TABLE public.terms_consents FROM anon, authenticated;

GRANT SELECT, INSERT ON TABLE public.terms_consents TO service_role;


-- =========================================================
-- 5. record_terms_consent(UUID, TEXT, TEXT)
--    同意を 1 件記録する。**retry しても行が増えない**。
--
--    設計上の要点:
--      - `p_user_id` は **server side が session から取り出した値**だけを渡す。
--        client から受け取った user_id を渡してはいけない。
--        （consent API がこの前提を守る。既存 quota API と同じ流儀）
--      - `accepted_at` を引数に取らない。DEFAULT now() で必ずサーバー時刻になり、
--        同意時刻をさかのぼって作れない
--      - `ON CONFLICT ... DO NOTHING` + 空なら既存行を SELECT。
--        API の retry を失敗扱いにせず、**同じ行を返して冪等**にする
--      - 検証は RPC でも行うが、最後の砦はテーブルの CHECK。
--        二重にしているのは、RPC が明確なエラーメッセージを返せるようにするため
--      - users 行の存在は確認しない。terms_consents は users に依存しない設計で、
--        存在確認を入れると「削除後も残す」という性質と噛み合わなくなる。
--        有効な session がある限り users 行は存在するため実害も無い
--      - SECURITY INVOKER / search_path 固定 / 動的 SQL なし（既存流儀）
--      - 列参照はすべて `tc.` で修飾する。
--        RETURNS TABLE の列名（id / terms_version / locale / accepted_at）と
--        同名の PL/pgSQL 変数が作られ、修飾しないと
--        "column reference is ambiguous" になるため
--      - 戻り値に user_id を含めない。呼び出し側が渡した値であり、
--        返す必要が無い（`upsert_user_and_subscription` と同じ判断）
-- =========================================================
CREATE OR REPLACE FUNCTION public.record_terms_consent(
  p_user_id       UUID,
  p_terms_version TEXT,
  p_locale        TEXT
)
RETURNS TABLE (
  id            UUID,
  terms_version TEXT,
  locale        TEXT,
  accepted_at   TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Step 0: 引数の検証。エラー文には受け取った値を入れない。
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id は必須です。';
  END IF;

  IF p_terms_version IS NULL THEN
    RAISE EXCEPTION 'p_terms_version は必須です。';
  END IF;

  IF p_terms_version <> btrim(p_terms_version)
     OR length(p_terms_version) < 1
     OR length(p_terms_version) > 64 THEN
    RAISE EXCEPTION 'p_terms_version の形式が不正です。';
  END IF;

  IF p_locale IS NULL THEN
    RAISE EXCEPTION 'p_locale は必須です。';
  END IF;

  IF p_locale NOT IN ('ja', 'en') THEN
    RAISE EXCEPTION 'p_locale は ja または en のみ指定できます。';
  END IF;

  -- Step 1: 追記。同一 (user_id, terms_version, locale) が既にあれば何もしない。
  RETURN QUERY
    INSERT INTO public.terms_consents AS tc (user_id, terms_version, locale)
    VALUES (p_user_id, p_terms_version, p_locale)
    ON CONFLICT ON CONSTRAINT terms_consents_user_version_locale_key DO NOTHING
    RETURNING tc.id, tc.terms_version, tc.locale, tc.accepted_at;

  -- Step 2: DO NOTHING で RETURNING が空になった場合は既存行を返す。
  --   retry を成功として扱うため。ここで初めて SELECT する
  --   （毎回 SELECT してから INSERT すると競合で二重に入り得る）。
  IF NOT FOUND THEN
    RETURN QUERY
      SELECT tc.id, tc.terms_version, tc.locale, tc.accepted_at
      FROM   public.terms_consents tc
      WHERE  tc.user_id       = p_user_id
        AND  tc.terms_version = p_terms_version
        AND  tc.locale        = p_locale;
  END IF;
END;
$$;

COMMENT ON FUNCTION public.record_terms_consent(UUID, TEXT, TEXT) IS
  'Subscription Terms の同意を 1 件記録する。同一 (user_id, terms_version, locale) の再送は既存行を返して冪等。p_user_id は server side が session から取り出した値のみを渡すこと。server-side function（service_role）からのみ呼ぶ。';


-- =========================================================
-- 6. 関数の実行権限
--    PostgreSQL は新規関数の EXECUTE を既定で PUBLIC に与える。
--    明示的に剥奪しないと anon キーだけで RPC を叩ける状態になる。
-- =========================================================
REVOKE ALL ON FUNCTION public.record_terms_consent(UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_terms_consent(UUID, TEXT, TEXT) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.record_terms_consent(UUID, TEXT, TEXT) TO service_role;


-- =========================================================
-- 以上。
--   他の課金 migration とまとめて production へ適用する。
-- =========================================================

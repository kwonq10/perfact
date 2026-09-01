-- =========================================================
-- 20260901044339_revoke_anon_table_privileges.sql
-- 既存4テーブルの anon / authenticated 権限ハードニング
--
--   作成日 : 2026-09-01
--   前提   : 20260901022938_billing_schema.sql
--            20260901041257_session_schema.sql
--            が適用済みであること
--
--   このファイルには秘密情報を含まない。
--
-- ---------------------------------------------------------
-- 背景（remote 実測 2026-09-01）
-- ---------------------------------------------------------
--   users / subscriptions / weekly_usage / stripe_events の ACL に
--   下記が残っていた。
--
--     anon=Dxtm/postgres | authenticated=Dxtm/postgres
--
--     D = TRUNCATE
--     x = REFERENCES
--     t = TRIGGER
--     m = MAINTAIN
--
--   SELECT / INSERT / UPDATE / DELETE はすでに剥奪済み（4テーブルとも false）。
--   残っているのは上記4権限のみ。
--
--   これは Supabase が public スキーマの新規テーブルへ既定で付与する
--   権限の名残であり、billing_schema を SQL Editor で手動適用した際に
--   残ったものと考えられる。
--
--   RLS は TRUNCATE を防がないため、anon が TRUNCATE を保持している状態は
--   本来あるべきではない。現時点で anon が到達できるのは PostgREST 経由のみで、
--   PostgREST は TRUNCATE を公開しないため実際の悪用経路は存在しないが、
--   実課金運用に入る前に権限そのものを取り除いておく。
--
--   20260901041257 で追加した public.sessions は
--   anon / authenticated の ACL エントリ自体を持たない
--   （postgres と service_role のみ）。既存4テーブルもこれに揃える。
--
-- ---------------------------------------------------------
-- 方針
-- ---------------------------------------------------------
--   TRUNCATE / TRIGGER / REFERENCES / MAINTAIN を個別に列挙するのではなく、
--   REVOKE ALL を用いる。
--
--   「anon / authenticated はこの4テーブルに対して
--     直接のテーブル権限を一切持たない」
--
--   という設計意図をそのまま SQL として表現するため。
--   将来 PostgreSQL に新しいテーブル権限が増えても取りこぼさない。
--
-- ---------------------------------------------------------
-- このマイグレーションが変更しないもの
-- ---------------------------------------------------------
--   - service_role の権限（4テーブルとも arwdDxtm を維持）
--   - postgres（owner）の権限
--   - RLS の有効/無効、ポリシー（1件も追加・削除しない）
--   - 関数 / RPC の EXECUTE 権限
--   - スキーマレベルの USAGE 等の権限（今回対象外）
--   - テーブル定義（users / subscriptions / weekly_usage /
--                   stripe_events / sessions のいずれも変更しない）
--   - 既存データ（INSERT / UPDATE / DELETE を一切行わない）
--   - public.sessions のテーブル権限（すでに意図した状態）
-- =========================================================


-- =========================================================
-- 1. anon / authenticated からテーブル権限を全剥奪
--
--    REVOKE は冪等（既に権限が無くてもエラーにならない）。
--    service_role と postgres には一切触れない。
-- =========================================================
REVOKE ALL ON TABLE
  public.users,
  public.subscriptions,
  public.weekly_usage,
  public.stripe_events
FROM anon, authenticated;


-- =========================================================
-- 適用後の期待状態
--
--   4テーブルとも ACL が下記になること（sessions と同形）:
--     postgres=arwdDxtm/postgres | service_role=arwdDxtm/postgres
--
--   検証クエリ（読み取り専用。この migration には含めず手元で実行する）:
--
--     SELECT c.relname,
--            (SELECT string_agg(a::text, ' | ') FROM unnest(c.relacl) a) AS acl
--     FROM   pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--     WHERE  n.nspname = 'public' AND c.relkind = 'r'
--     ORDER  BY c.relname;
--
--   期待：anon / authenticated のエントリが4テーブルとも消えていること。
--         service_role は arwdDxtm のまま。
-- =========================================================

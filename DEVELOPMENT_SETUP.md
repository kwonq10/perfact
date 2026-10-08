# DEVELOPMENT_SETUP.md

どのPCでも同じ手順で「clone → 環境設定 → npm ci → ローカル起動 → test」まで再現するための手順です。
パスはすべてリポジトリルート基準で書きます。作業場所はPCごとに自由です
（例: `C:\Users\<user>\claude-work\perfact`）。

本番 deploy の手順とルールは [DEPLOYMENT.md](DEPLOYMENT.md)、
現在の状態は [PROJECT_STATUS.md](PROJECT_STATUS.md) を参照してください。

---

## 1. 必要要件

| ツール | バージョン | 備考 |
|---|---|---|
| Node.js | **24.14.1**（`.nvmrc`） | `package.json` の `engines` は `>=20` |
| npm | **11.11.0**（`package.json` の `packageManager`） | pnpm / yarn は使わない |
| Git | 2.4x 以降 | |
| GitHub CLI (`gh`) | 任意 | private repo の clone 認証に使える |
| Wrangler | `devDependencies` に固定（`package-lock.json`） | グローバルインストール不要。`npx wrangler` で使う |
| Supabase CLI | **未固定**（`npx supabase` で都度取得） | migration 確認・適用時のみ必要 |

nvm / nvm-windows / fnm を使う場合は、リポジトリルートで `nvm use`（または `fnm use`）すると `.nvmrc` のバージョンになります。

確認:

```bash
node -v   # v24.14.1
npm -v    # 11.11.0
```

---

## 2. clone

```bash
git clone https://github.com/kwonq10/perfact.git
cd perfact
```

このリポジトリだけに commit 用の identity を設定します（グローバルにはしない）。
GitHub の noreply アドレスを使います。

```bash
git config --local user.name  "<GitHub に表示する名前>"
git config --local user.email "<id>+<login>@users.noreply.github.com"
```

noreply アドレスは `gh api user --jq '"\(.id)+\(.login)@users.noreply.github.com"'` で確認できます。

---

## 3. 依存のインストール

```bash
npm ci
```

- `npm install` / `npm update` / `npm audit fix` は使わない（`package-lock.json` が変わるため）。
  依存の更新は独立した作業として扱う。
- `npm ci` 後に `git status` で `package.json` / `package-lock.json` が変わっていないことを確認する。

---

## 4. テスト

```bash
npm test
```

- Node 標準の `node --test` で、backend（`functions/api/_tests/`）・frontend（`tests/frontend/`）・
  extension（`tests/extension/`）を実行します。
- `.dev.vars` も外部サービスも不要です。
- build と lint の手順はありません（静的配信 + Pages Functions のため build 不要、lint 未導入）。

---

## 5. `.dev.vars` の作り方（ローカル起動するときだけ）

```bash
cp .dev.vars.example .dev.vars            # Git Bash
# Copy-Item .dev.vars.example .dev.vars   # PowerShell
```

値は各PCで手入力します。変数の意味は `.dev.vars.example` のコメントを参照してください。

- `.dev.vars` は `.gitignore` 済みです。**commit しない・チャットや文書に値を貼らない。**
- 値の受け渡しはパスワードマネージャ等の安全な経路で行う。Git・Google Drive の平文・メールは使わない。
- ローカルでは `ALLOWED_ORIGINS` にローカルの origin（例: `http://localhost:8788`）を入れる。
  設定すると本番 origin の既定値を上書きする。
- **注意: 開発専用の Supabase プロジェクトは記録上ありません。**
  本番 Supabase の `SUPABASE_SERVICE_ROLE_KEY` を入れると、ローカル起動で本番 DB に書き込みます。
  入れる場合は事前に明示承認を得てください。
- Stripe はテストモードのキーのみ使う。live キーはローカルに置かない。

---

## 6. ローカル起動（wrangler pages dev）

リポジトリルートで実行します。配信ディレクトリは `public/`、Functions はルートの `functions/` が自動検出されます。

```bash
npx wrangler pages dev public --compatibility-date=2026-07-25
```

- 既定で `http://localhost:8788` で起動します。
- `.dev.vars` はリポジトリルートのものが読まれます。
- `.wrangler/`（ローカル状態・キャッシュ）は `.gitignore` 済みです。
- `wrangler.toml` は使っていません。本番の設定は Cloudflare Pages の project 側にあります。
- ルートにある `index.html` などは本番配信の対象外です（配信されるのは `public/`）。

ローカル起動の制約（要確認事項を含む）:

- セッション Cookie は `__Host-` 接頭辞（Secure 必須）です。Chrome は `http://localhost` を secure context として扱います。
- Google ログインをローカルで通すには、OAuth クライアントの「承認済みの JavaScript 生成元」に
  ローカルの origin が登録されている必要があります。**登録状況は未確認です。**
  OAuth 設定の変更は AGENTS.md の禁止事項に従い、承認なしに行わないでください。

---

## 7. Wrangler / Supabase CLI の扱い

### Wrangler

- 必ず `npx wrangler`（lockfile に固定されたバージョン）を使う。
- ローカル起動（`pages dev`）だけならログイン不要。
- `npx wrangler login` は、`pages deployment list` などアカウント情報を読むときだけ必要。
- **`wrangler pages deploy` は使わない。** 本番反映は main への push（Git 連携）に一本化されている。

### Supabase CLI

- `npx supabase ...` で使う（バージョン未固定。実行時のバージョンを記録に残すこと）。
- migration は `supabase/migrations/` にあり、改行は `.gitattributes` で LF に固定。
- PCごとにリンクが必要です。

  ```bash
  npx supabase login
  npx supabase link --project-ref <project ref>   # ref は HANDOFF_QUOTA_RESERVATION.md の Supabase 節
  npx supabase migration list --linked             # 読み取りのみ
  ```

- リンク状態は `supabase/.temp/` に保存されます（`.gitignore` 済み）。
- **`db push` などの本番 DB への書き込みは明示承認が必要です。**

---

## 8. PCごとに必要なもの

| 項目 | 方法 | Git 管理 |
|---|---|---|
| Node.js / npm | `.nvmrc` / `packageManager` に合わせてインストール | バージョン指定のみ管理 |
| `node_modules/` | `npm ci` | しない |
| `.dev.vars` | `.dev.vars.example` から作成し、値は手入力 | **しない** |
| git user.name / email | `git config --local` | しない |
| GitHub 認証 | `gh auth login` など | しない |
| Wrangler ログイン | `npx wrangler login`（必要なときだけ） | しない |
| Supabase ログイン・リンク | `npx supabase login` / `link` | しない（`supabase/.temp/`） |
| Chrome 拡張の読み込み先フォルダ | `scripts/sync-sukima-extension.ps1` を参照（PC固定パスあり） | しない |

---

## 9. 新しいPCでの再開チェックリスト

```bash
git status
git remote -v
git log --oneline -5
git rev-list --left-right --count HEAD...origin/main
node -v && npm -v
npm ci
npm test
```

最後に [PROJECT_STATUS.md](PROJECT_STATUS.md) の記録と実測値を照合し、差分があれば reset せずに報告します。

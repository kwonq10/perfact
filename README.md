# スキマ（Sukima）

Google カレンダーの空き時間を探す Web アプリです。

- 本番: https://sukimacalendar.com
- Hosting: Cloudflare Pages（`sukima-web`）+ Pages Functions（`functions/`）
- DB: Supabase / 課金: Stripe

> **`main` への push は本番への自動 deploy です。** push の前に [DEPLOYMENT.md](DEPLOYMENT.md) を読んでください。

## クイックスタート

```bash
git clone https://github.com/kwonq10/perfact.git
cd perfact
nvm use            # .nvmrc = Node 24.14.1（任意）
npm ci
npm test
```

ローカルで起動する場合（`.dev.vars` が必要）:

```bash
cp .dev.vars.example .dev.vars   # 値は各PCで手入力。commit しない
npx wrangler pages dev public --compatibility-date=2026-07-25
```

## ドキュメント

| ファイル | 内容 |
|---|---|
| [AGENTS.md](AGENTS.md) | AI エージェント向けの作業ルール・禁止事項（作業前に必読） |
| [DEVELOPMENT_SETUP.md](DEVELOPMENT_SETUP.md) | 開発環境の構築、ローカル起動、テスト、PCごとに必要なもの |
| [DEPLOYMENT.md](DEPLOYMENT.md) | 本番反映の仕組み、push 前のチェック、rollback、secrets |
| [PROJECT_STATUS.md](PROJECT_STATUS.md) | 現在の状態、未解決の課題、次の予定 |
| [HANDOFF_QUOTA_RESERVATION.md](HANDOFF_QUOTA_RESERVATION.md) | quota reservation 作業の引き継ぎ |
| [HANDOFF_CHROME_EXTENSION.md](HANDOFF_CHROME_EXTENSION.md) | Chrome 拡張版の引き継ぎ |

## ディレクトリ

| パス | 内容 |
|---|---|
| `public/` | 本番で配信される静的ファイル（build output） |
| `functions/` | Cloudflare Pages Functions（API） |
| `supabase/migrations/` | DB migration |
| `chrome-extension/` | Chrome 拡張版 |
| `tests/` | frontend / extension のテスト（backend は `functions/api/_tests/`） |

# AGENTS.md

このリポジトリは、Webアプリ「スキマ」の開発リポジトリです。

Claude Code / Codex / その他AIコーディングエージェントは、作業前にこのファイルを必ず読んでください。

## 基本方針

- 既存Web版は Google OAuth 審査対応済みの重要状態です。
- 既存Webアプリを不用意に壊さないでください。
- Chrome拡張機能化は、既存Web版とは分離して進めます。
- Chrome拡張版は chrome-extension/ 以下に別実装します。
- 明示指示がない限り、index.html / privacy.html / sw.js / manifest.json は変更しないでください。

## 正式な作業場所

C:\Users\tetsu\perfact

Tempフォルダ内の古い作業コピーは使わないでください。

G:\マイドライブ\バイブコーディング\perfact は旧コピーです。
参照のみに使い、current source として扱わないでください。G: 側から push しないでください。

## 本番URL

- https://sukimacalendar.com
- Privacy Policy: https://sukimacalendar.com/privacy

## GitHub

- Repository: https://github.com/kwonq10/perfact

## ホスティング

- Hosting: Cloudflare Pages
- Project name: sukima-web
- Production branch: main
- Repository: kwonq10/perfact
- Build output directory: public
- Build command: なし
- Functions: リポジトリ直下の functions/ を Cloudflare Pages Functions として自動検出
- Production domains:
  - https://sukimacalendar.com
  - https://www.sukimacalendar.com
- Git integration: main への push で production へ自動deploy
- wrangler.toml: 現在は不要。Pages project 側の設定を使用する
- compatibility_date: 2026-07-25
- compatibility_flags: なし

Netlify は現在の production ホストではありません。
リポジトリに残っている netlify.toml は現在の配信に使われていません。

### production の環境変数

すべて Cloudflare Pages の secret として登録済みです。
**値はこのファイルに絶対に書かないでください。** 名前のみ記載します。

- GOOGLE_CLIENT_IDS
- SUPABASE_URL
- SUPABASE_SERVICE_ROLE_KEY

### preview 環境

preview には secret が未設定です。production と同等には動作しません。
（GOOGLE_CLIENT_IDS が未設定のとき、/api/auth/session は 500 server_misconfigured を返す実装です）

## Google OAuth

Google Cloud OAuth project:

- Project name: Generative Language Client
- Project ID: gen-lang-client-0558069275
- Project number: 356365978986

現在のGoogle Calendarスコープ:

- https://www.googleapis.com/auth/calendar.events.readonly
- https://www.googleapis.com/auth/calendar.calendarlist.readonly

## 作業前ルール

作業前に必ず確認してください。

- git status
- git remote -v
- git log --oneline -5

## commit前ルール

commit前に必ず確認してください。

- git status
- git diff

変更対象を明確に報告し、ユーザー確認を得てからcommitしてください。

## 禁止事項

- ユーザー確認なしにcommitしない
- ユーザー確認なしにpushしない
- OAuth Client IDを勝手に変更しない
- SCOPESを勝手に変更しない
- privacy.html のOAuth審査向け文言を勝手に変更しない
- sw.js のService Worker挙動を勝手に変更しない
- 既存Web版をChrome拡張用に直接書き換えない
- git init しない
- Tempフォルダ内の古い作業コピーを使わない

## Chrome拡張機能化の方針

Chrome拡張版は、既存Web版を壊さずに chrome-extension/ 以下へ作成します。

最初は課金機能なしのMVPを作ります。

MVP候補:

- popup UI
- Google Calendar認証
- 空き時間検索
- 結果表示
- 候補コピー
- Googleカレンダー作成画面を開く

課金機能は後回しです。

Chrome拡張化については、必ず HANDOFF_CHROME_EXTENSION.md も読んでください。

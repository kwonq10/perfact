# スキマ Chrome拡張機能化 引継ぎメモ

## 目的

既存Webアプリ「スキマ」を、将来的にChrome拡張機能として展開する。

ただし、現在のWeb版はGoogle OAuth審査対応済みで重要な状態のため、既存Web版を直接壊さず、Chrome拡張版は別フォルダで作る。

## 現在の状況

スキマは、Googleカレンダーから空き時間を検索するWebアプリ。

本番URL:

- https://sukimacalendar.com
- Privacy Policy: https://sukimacalendar.com/privacy

Repository:

- https://github.com/kwonq10/perfact

正式ローカル作業場所:

C:\Users\tetsu\perfact

## 直近の重要コミット

最新付近の重要コミット:

- 9773cd6 fix: use network-first cache for HTML
- a18ccc6 chore: remove duplicate privacy policy links
- e80582a fix: wrap long privacy policy URLs
- 227d52d fix: align privacy policy with OAuth data usage

## OAuth審査で対応済みのこと

- 独自ドメイン sukimacalendar.com を取得
- Netlifyに独自ドメイン設定済み
- Google Search Consoleで sukimacalendar.com の所有確認済み
- OAuth consent screen のHomepage URLを更新
- Privacy Policy URLを更新
- Authorized domain に sukimacalendar.com を設定
- OAuth client の Authorized JavaScript origins に以下を追加
  - https://sukimacalendar.com
  - https://www.sukimacalendar.com
- privacy.html をGoogle OAuth審査向けに修正
- メールアドレス取得処理を削除
- 広告利用しないことを明記
- AIモデル学習に使わないことを明記
- Limited Use requirements準拠を明記
- Service WorkerのHTMLキャッシュをnetwork-firstに修正
- Google OAuth審査チームへ修正完了メールを返信済み
- 現在はGoogle側の返信待ち

## 現在のGoogle Calendarスコープ

- https://www.googleapis.com/auth/calendar.events.readonly
- https://www.googleapis.com/auth/calendar.calendarlist.readonly

## 重要方針

Google OAuth審査の結果が返るまでは、Web版の挙動を大きく変更しない。

特に以下は不用意に変更しない。

- index.html
- privacy.html
- sw.js
- manifest.json
- OAuth Client ID
- SCOPES
- Googleログイン処理
- Privacy Policy URL
- Netlify設定

## Chrome拡張機能化の基本方針

Chrome拡張版は、既存Web版とは分離して作る。

推奨フォルダ:

chrome-extension/

Web版:

https://sukimacalendar.com

Chrome拡張版:

chrome-extension/ 以下に別実装

## 既存Webアプリから流用できるもの

- 空き時間検索ロジック
- Google Calendar API呼び出しの考え方
- 日付・時間入力UIの考え方
- 検索結果表示の考え方
- Googleカレンダー予定作成URL
- プライバシーポリシー文章
- OAuth審査で整理したデータ利用方針
- sukimacalendar.com ドメイン

## 作り直しが必要なもの

Chrome拡張版では以下を作り直す必要がある。

- Chrome拡張用 manifest.json
- popup UI
- background/service worker
- Chrome拡張向けGoogle認証
- Chrome Web Store用説明文
- Chrome Web Store用スクリーンショット
- Chrome Web Store用プライバシー説明
- 将来的な課金状態チェック

## Google認証について

Web版ではGoogle Identity Servicesを使っている。

Chrome拡張版では、通常 chrome.identity API を使う想定。

Chrome拡張版を作る場合、以下が必要になる可能性が高い。

- Google CloudでChrome拡張用OAuth Clientを追加
- Chrome拡張IDを使ったOAuth設定
- 拡張機能版のOAuthデモ動画作成
- OAuth審査への追加対応

## Chrome Web Store審査について

Chrome拡張として公開する場合、Web版とは別にChrome Web Store審査が必要。

必要になるもの:

- 拡張機能ZIP
- ストア掲載タイトル
- 概要説明
- 詳細説明
- スクリーンショット
- アイコン
- 権限の説明
- プライバシー項目
- テスト手順
- プライバシーポリシーURL

## 課金制について

将来的に課金制にしたい。

Chrome Web Store内課金ではなく、外部決済を使う方針。

候補:

- Stripe
- Lemon Squeezy
- PayPal
- Supabase
- Firebase
- 自前API

想定構成:

Chrome拡張
↓
ユーザーログイン
↓
外部決済
↓
課金状態をAPIで確認
↓
無料版 / 有料版の機能を切り替え

## 料金設計案

無料版:

- 月5回まで空き時間検索
- 基本的な候補表示
- 候補コピー

有料版:

- 検索回数無制限
- 複数カレンダー選択
- 候補時間の一括コピー
- Googleカレンダー作成
- 日程調整用テキスト生成
- 将来的に日程調整リンク生成

## 最初に作るChrome拡張MVP

最初は課金なしで、無料MVPを作る。

MVP機能:

- Chrome拡張のpopupを開く
- Google Calendar認証
- 開始日・終了日・希望時間を入力
- 空き時間検索
- 結果表示
- 候補をコピー
- Googleカレンダー予定作成画面を開く

## 実装開始時の注意

実装を始める時は、まず以下を行う。

1. git status を確認
2. Web版がクリーンであることを確認
3. chrome-extension/ を新規作成
4. 既存Web版ファイルを直接変更しない
5. まずローカルで「パッケージ化されていない拡張機能」として動作確認
6. commit前に差分を必ず確認

## 絶対に避けること

- OAuth審査中にWeb版の挙動を大きく変える
- 既存のWeb版をChrome拡張用に直接書き換える
- 既存の manifest.json を拡張機能用に上書きする
- privacy.html のOAuth審査向け文言を不用意に変更する
- 課金機能を最初から入れようとする
- Chrome Web Store申請前に不要な権限を増やす
- Tempフォルダ内の古い作業コピーを使う

## 次回Claude Code / Codexで作業を始める時の最初の指示

AGENTS.md と HANDOFF_CHROME_EXTENSION.md を読んでください。
現在のWeb版はGoogle OAuth審査結果待ちなので、既存Webアプリは変更しません。
まず chrome-extension/ にChrome拡張MVPを作るための設計案だけを出してください。
まだ実装・commit・pushはしないでください。

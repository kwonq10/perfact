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

## 2026-07-26 — 再開後の改善候補: 空き時間表示をもっと目立たせる

### 内容

Chrome拡張のサイドパネルで、空き時間の時刻表示をもう少し目立たせたい。
（2026-07-26、コピー成功表示の動作確認中にユーザーから要望。今回は未実装。）

### 現状の実装

- 時刻テキストは `.slot-card p`（sidepanel.css）
  - font-size: 20px / font-weight: 700 / color: #1a1a2e
- 日カード内では入れ子カードに見せず、薄い区切り線（`#eef0f2`）と余白のみで区切っている
- 件数は `.day-result-count`（12px / #5f6368）で「空き時間 N件」

### 検討する案（未着手）

- 時刻テキストのサイズ・字間・色のコントラストを上げる
- 時刻部分だけ淡い背景色やバッジ的な装飾を付ける
- 区切り線ではなく、1件ごとの枠線・影を戻して視認性を上げる
- 件数表示（空き時間 N件）を大きくして、日カードの主役を明確にする

### 判断が必要な点

- Chrome Web Store用スクリーンショットを撮る前に変更するか、撮影後にするか
  （撮影後に見た目を変えると、掲載画像と実物がずれる）
- レイアウト崩れ（`.slot-actions` の35%/65%配分、`max-width: 260px` の折り返し）を壊さないこと
- 色を増やす場合、日曜=赤系 / 土曜=青系の既存ルールと衝突しないこと

## 2026-07-26 — コピー成功表示の実装と動作確認（完了）

### 実装内容

- `chrome-extension/sidepanel.js` に、コピー成功時のボタン文言一時表示を追加（43行追加・削除なし）
  - `showCopyFeedback()` / `resetCopyFeedback()` を追加し、一括コピーと個別コピーの両方へ適用
  - 成功時はボタン文言を「コピーしました」に変更し、2秒後に元へ戻す
  - 失敗時は `console.error` を追加。既存の `setStatus` によるエラー表示は維持
- manifest.json・CSS・HTML・権限は変更していない
- 構文確認（node --check）: 正式ソース・動作フォルダとも OK
- `scripts/sync-sukima-extension.ps1` で動作フォルダへ同期済み（8ファイルSHA256一致）
- 既存の `Projectssukima-sidepanel-backup` は削除せず
  `Projectssukima-sidepanel-backup-archived-20260726` へリネームして退避

### 動作確認結果（2026-07-26、Chrome実機で確認済み・全項目クリア）

一括コピー:

- 「この日の空き枠を一括コピー」を押すと、ボタン文言が「コピーしました」に変わることを確認済み
- 約2秒後に元の文言へ戻ることを確認済み
- コピー内容をメモ帳へ貼り付け、4行・形式正常・文字化けなしを確認済み

個別コピー:

- 個別の「コピー」ボタンでも同じ表示になることを確認済み
- 約2秒後に「コピー」へ戻ることを確認済み
- 貼り付け内容は1行のみで正常
- 押していない他のコピーボタンには干渉しないことを確認済み
- ボタン幅35%でも文言が省略されず表示される

その他:

- レイアウト崩れなし（隣の「Googleカレンダーで予定作成」ボタンの位置・幅も不動）
- console error なし

### 確認中に判明した点

- 画面上部の `#status` に出る「全件コピーしました」は、一括コピーボタン（画面下部）から
  約750px離れており、1画面では同時に確認できず気づきにくい。
  今回追加したボタン文言の切り替えが、この見えにくさを補う役割を果たしている。
- Chrome Web Store用スクリーンショット4枚目（一括コピー）の構図検討でも、
  同じ縦幅の制約が論点になっている。

### 今後の改善候補（今回は追加改修しない）

- 空き時間の件数表示（`.day-result-count`「空き時間 N件」、現在12px / #5f6368）を
  目立たせて、日カードの主役を明確にする
- 空き時間の時刻表示自体の強調（本ファイルの「再開後の改善候補」節を参照）
- `#status` の表示位置、または結果表示付近への通知手段の見直し

いずれも今回は実装せず、記録のみとする。

# スキマ Chrome拡張 Chrome Web Store 掲載情報（下書き）

作成日：2026-07-25
最終更新：2026-09-05（1.2.0 / 多言語化対応）
ステータス：下書き・未提出。Chrome Web Storeへの提出はまだ行っていない。

このファイルは調査・文章作成のみを目的とした下書きです。`chrome-extension/manifest.json` の実装内容（permissions / host_permissions / oauth2.scopes）と突き合わせて作成しています。

本ファイル内の公開URL（拡張機能紹介ページ・プライバシーポリシー・利用規約）は、2026-07-26に読み取り専用のHTTP GETで到達確認済みです。いずれも404ではありません。結果は「18. 公開URLの到達確認結果」を参照してください。

---

## 1. Chrome Web Store掲載名

```
スキマ - Googleカレンダー空き時間検索
```

この値は `_locales/ja/messages.json` の **`appNameLong`** と同一で、
`manifest.json` の `name`（`__MSG_appNameLong__`）から反映される。
英語掲載名は §19-1 を参照。

---

## 2. 短い説明（132文字以内）

```
Googleカレンダーの空き時間をサイドパネルで検索。期間や必要時間を指定して候補を表示し、コピーや予定作成にすぐ使えます。読み取り専用アクセスのみ、広告・トラッキングなし。
```

文字数：上記本文（改行・記号含む）で132文字以内であることを本文作成時に確認済み（下記「3. 短い説明の文字数」参照）。

---

## 3. 詳細説明

```
スキマは、Googleカレンダーの空き時間を検索し、Chromeのサイドパネルで確認できる拡張機能です。

主な機能：
・Googleカレンダーから空き時間を自動検索
・Chromeのサイドパネルでそのまま操作
・開始日・終了日を指定して検索（最大31日間）
・「今日」「今週」「来週」「今月」「来月」のプリセットから選択
・複数のカレンダーを選んで検索対象にできる
・必要な時間の長さを指定できる
・検索結果を日ごとに表示
・空き時間を1件ずつコピー
・その日の空き時間をまとめてコピー
・候補の時間でGoogleカレンダーの予定作成画面を開く

データの扱いについて：
・Google Calendar APIへのアクセスは読み取り専用です
・取得したカレンダー情報は、空き時間の計算とサイドパネルでの表示のためだけに使用します
・カレンダーの内容を開発者のサーバーに送信することはありません
・広告表示、アクセス解析、行動トラッキングは組み込んでいません

本拡張機能は、Webサイト「スキマ」（https://sukimacalendar.com）と同じ空き時間検索の考え方をもとに、Chromeのサイドパネル向けに作られたものです。
```

---

## 4. 単一目的の説明

```
本拡張機能の単一の目的は、ユーザー自身のGoogleカレンダーの予定情報を読み取り専用で取得し、指定した期間・条件に基づいて空き時間を計算してChromeのサイドパネルに表示することです。
それ以外の機能（広告表示、他サービスとの連携、カレンダー以外のデータ収集など）は持ちません。
```

---

## 5. identity権限が必要な理由

```
identity権限は、次の2つの用途にのみ使用します。

1. Googleアカウントでのログインと、Google Calendar APIを呼び出すためのOAuthアクセストークンの取得（chrome.identity.getAuthToken()）
2. 本拡張機能と、開発者が運営するWebサービス「スキマ」（sukimacalendar.com）のアカウントとの連携（chrome.identity.launchWebAuthFlow() / chrome.identity.getRedirectURL()）。無料利用回数の管理のために、ユーザーが明示的に連携を選んだ場合にのみ実行します。この連携でGoogleカレンダーの情報をやり取りすることはなく、Googleのアクセストークンを開発者のサーバーへ送信することもありません。

いずれも拡張機能自身の実装内で直接呼び出しており、上記以外の用途には使用していません。
```

---

## 6. sidePanel権限が必要な理由

```
本拡張機能はポップアップ形式ではなく、Chromeのサイドパネル（side_panel）にUIを表示する方式で実装しています。検索条件の入力や検索結果の表示など、すべての操作画面をサイドパネル内で提供するため、sidePanel権限が必要です。
```

---

## 7. googleapis.comへのhost_permissionsが必要な理由

```
Google Calendar API（www.googleapis.com）へ、取得したOAuthアクセストークンを使って直接HTTPリクエストを送るため、host_permissionsに https://www.googleapis.com/* を指定しています。
カレンダー一覧の取得、予定（イベント）情報の取得のみに使用しており、googleapis.com以外のドメインへのAPIアクセスは行っていません。
```

---

## 8. calendar.events.readonlyが必要な理由

```
指定した期間内の予定（開始時刻・終了時刻・busy/free状態など）を取得し、空き時間を計算するために必要です。読み取り専用スコープのみを要求しており、予定の作成・変更・削除は本拡張機能から直接行いません（Googleカレンダーの予定作成画面を新しいタブで開く操作のみ提供します）。
```

---

## 9. calendar.calendarlist.readonlyが必要な理由

```
ユーザーが保有する複数のカレンダー一覧を取得し、検索対象とするカレンダーをユーザー自身に選んでもらうために必要です。読み取り専用スコープのみを要求しており、カレンダーの追加・削除・設定変更は行いません。
```

---

## 10. データ利用に関する説明

```
本拡張機能が取得するGoogleカレンダーのデータ（カレンダー一覧・予定情報）は、次の目的にのみ使用します。

・指定期間内の空き時間の計算
・サイドパネル上での検索結果表示
・ユーザーが選択した候補時間をもとにしたGoogleカレンダー予定作成画面へのリダイレクト

広告配信、ユーザー行動のトラッキング、第三者への分析目的での提供、AIモデルの学習などには使用していません。
```

---

## 11. データを保存しないことの説明

```
本拡張機能は、取得したカレンダーデータ（予定の日時・空き時間の検索結果）を、サイドパネルを閉じたり再読み込みしたりした後まで保持する永続的な保存は行っていません。検索結果はその時点のセッション内でのみメモリ上に保持され、開発者のデータベースやサーバーには保存されません。

カレンダーデータとは別に、本拡張機能は次の2種類の情報のみをブラウザの localStorage に保存します。

・スキマとの連携用セッショントークンと有効期限（キー：sukima_ext_session_v1）
・スキマのサーバーから取得した設定値（無料利用回数の制限が有効かどうか）と取得時刻（キー：sukima_ext_config_v1）

どちらにもカレンダーの内容は含まれません。これらはWeb標準の localStorage であり chrome.storage ではないため、"storage" 権限は不要です。

（補足：manifest.json の "storage" 権限は削除済みです。現在の permissions は ["sidePanel", "identity"] のみで、実装コード内に chrome.storage の呼び出しはありません。未使用権限の確認と削除は完了しています。）
```

---

## 12. 第三者提供をしないことの説明

```
本拡張機能は、取得したGoogleカレンダーのデータを、開発者以外の第三者（広告事業者、分析事業者、他のサービス提供者など）へ提供・販売・共有することはありません。

Googleカレンダーから取得したデータ（カレンダー一覧・予定の日時・空き時間の計算結果）の送信先は、Google Calendar API（www.googleapis.com）のみです。開発者が運営するサーバーへは送信しません。

これとは別に、本拡張機能は開発者が運営するサービス「スキマ」（sukimacalendar.com）と、設定値の取得・アカウント連携・無料利用回数の管理のために通信します。この通信にカレンダーの内容は一切含まれません。詳細と送信内容は §12-2 を参照してください。
```

---

## 12-2. Sukima サーバーとの通信について

拡張機能は、**ユーザーが検索ボタンを押したときにかぎり**、
sukimacalendar.com へ設定値の問い合わせ（`GET /api/ext/config`）を行うことがあります。
応答は 5 分間キャッシュされるため、実際の通信はごくまれです。
パネルの起動・ログイン・検索条件の変更・日付の移動では通信しません。

この問い合わせで送信するのは**拡張機能の識別子（Origin）だけ**で、
カレンダーの情報も個人を特定する情報も含みません。

Free の週3回制限（quota）が**サーバー側で有効になっている場合にかぎり**、
続けて次の通信が発生します。**有効化する際は、本ファイルとストアの
プライバシー申告の内容が実装と一致していることを必ず確認すること。**

**申請時点の実態（この段落は内部向けの記録。公開プライバシーポリシーには
現在の env 値に依存する記述を置かないこと）:**
Cloudflare Production の `EXTENSION_QUOTA_ENABLED` は **`false`** です。
したがって拡張機能の利用回数に制限はかかっておらず、実際に発生する通信は
`GET /api/ext/config` のみで、連携（`link/*`）・回数管理（`quota/*`）の
通信は発生しません。公開プライバシーポリシー
（`public/extension/privacy.html` §6）は、この値に依存しない条件付きの
記述にしてあるため、後日 `true` へ切り替えても虚偽にはなりません。

| 宛先 | 目的 | 送信する内容 |
|---|---|---|
| `https://sukimacalendar.com/api/ext/config` | 週3回制限が有効かどうかの確認 | 拡張機能の識別子のみ（本文なし） |
| `https://sukimacalendar.com/api/ext/link/start` | 拡張とアカウントの連携画面 | 拡張機能 ID と使い捨ての state のみ |
| `https://sukimacalendar.com/api/ext/quota/*` | 週3回の残数管理 | 予約 ID と使い捨ての鍵のみ |
| `https://sukimacalendar.com/api/ext/auth/logout` | 連携の解除 | セッショントークンのみ |

**カレンダーの内容（予定名・参加者・時刻・空き時間の計算結果）は、
いずれの通信にも一切含まれません。** Google カレンダーから取得したデータの
送信先は、引き続き `www.googleapis.com` のみです。

保存されるもの:

- 拡張機能側: 次の 2 つを `localStorage` に保存します。
  - `sukima_ext_session_v1` — Sukima の連携用セッショントークンと有効期限
  - `sukima_ext_config_v1` — `/api/ext/config` から取得した `quota_enforced` と
    取得時刻（TTL 5 分）

  どちらにもカレンダーの内容は含まれません。
  これは Web 標準の `localStorage` であり `chrome.storage` ではないため、
  **"storage" 権限は引き続き不要**です（§11 の権限に関する記載は維持できます）。
- サーバー側: 週の利用回数を管理するレコードのみ。
  **カレンダーの内容は保存しません。**

**manifest.json の変更は不要です。**
通信はサーバー側の CORS 許可で成立し（host_permissions を追加しない）、
連携は既存の "identity" 権限だけで動く `launchWebAuthFlow` を使います。
そのため**新しい権限警告は発生せず、既存ユーザーの再承認も不要**です。

---

## 13. リモートコードを使用しないことの説明

```
本拡張機能は、拡張機能パッケージに同梱されたJavaScriptファイルのみを実行します。外部サーバーからスクリプトを動的に取得して実行する仕組み（リモートコードの読み込み・eval等による動的コード実行）は使用していません。
```

---

## 14. 審査担当者向けのテスト手順

```
1. 本拡張機能をインストールし、Chromeツールバーのアイコンをクリックしてサイドパネルを開く
2. 「Googleでログイン」を選択し、テスト用Googleアカウントでログインする
3. OAuth同意画面で、Googleカレンダーの読み取り専用アクセスを確認して許可する
4. 許可後、自動的に今日から7日後までの範囲で空き時間検索が実行され、結果が表示されることを確認する
5. カレンダーに予定がない場合でも、9:00〜22:00の範囲で空き時間候補が表示されることを確認する
6. 開始日・終了日を直接指定する、または「今週」などのプリセットを選択し、日付欄へ反映されることを確認する
7. プリセット選択だけでは検索されず、検索ボタンを押すと結果が更新されることを確認する
8. 複数カレンダーがある場合は、対象カレンダーの選択を変更して検索できることを確認する
9. 候補の「コピー」ボタンで時間帯がコピーされることを確認する
10. 「この日の空き枠を一括コピー」で表示中の日の候補がまとめてコピーされることを確認する
11. 「Googleカレンダーで予定作成」で予定作成画面が新しいタブで開くことを確認する
12. アカウント切り替えとログアウトが動作することを確認する
13. サイドパネルを閉じて再度開き、ログイン状態が維持されていることを確認する

スキマのサーバーとの通信について（審査担当者向け補足）：
・検索ボタンを押した際に、sukimacalendar.com/api/ext/config へ設定値の問い合わせが1回発生します（応答は5分間キャッシュ）。
  この通信は認証不要で、送信するのは拡張機能の識別子のみです。カレンダー情報は含まれません。
・申請時点でこの設定は「無料利用回数の制限：無効」を返すため、アカウント連携の画面は表示されません。
  上記1〜13の手順は、すべてスキマのアカウント連携なしで完了できます。

補足：
・個人のGoogleアカウントを推奨
・Google Workspace管理下のアカウントは、管理者設定により利用できない場合がある
・予定が登録されていないアカウントでもテスト可能
・審査用アカウントが必要な場合はChrome Web Store申請フォームで別途提供する
```

---

## 15. スクリーンショットで見せるべき画面

```
1. サイドパネルのログイン前画面（「Googleでログイン」ボタンが見える状態）
2. 検索条件入力画面（開始日・終了日・プリセットボタン・カレンダー選択・必要時間）
3. 検索結果画面（日ごとの空き時間カード、件数表示）
4. 空き時間候補のコピー操作、または「この日の空き枠を一括コピー」ボタンが見える状態
5. Googleカレンダー予定作成画面が開いた状態（遷移先の様子が分かるもの）

撮影時の注意（STATE.mdの既存メモに基づく）：
・実際の個人カレンダーの予定名やメールアドレスなど、他人に見せる想定のない個人情報が写り込まないようにする
・背景は拡張機能のUI自体が主役になるよう、通常のWebページ等をバックに撮影する
```

---

## 16. 必要な画像サイズと制作物の一覧

```
必須：
・拡張機能アイコン 128×128px（chrome-extension/icon-128.png を使用可能。既存ファイルあり）
・スクリーンショット 1〜5枚、1280×800px または 640×400px（PNGまたはJPEG）

任意（掲載時の見栄えに関わるが必須ではない）：
・小プロモタイル 440×280px
・マーケットプレイス用マーケティング画像 920×680px
・マーキー画像 1400×560px

現時点で確認できているもの：
・icon-128.png（chrome-extension/内に既存）
・icon-48.png、icon-16.png（manifest.json記載のツールバー/拡張機能一覧用、既存）

未作成・要準備：
・上記スクリーンショット一式（撮り直しが必要、STATE.mdに記載あり）
・任意のプロモーション画像（作成するかどうかは要判断）
```

---

## 17. 公開前チェックリスト

```
☑ manifest.jsonの "storage" 権限は削除済み（実装コード内に chrome.storage の呼び出しがないことを確認）。現在の permissions は ["sidePanel", "identity"]
☑ permissions / host_permissions が実装上必要な最小限であることを確認済み（2026-07-26）
☑ 拡張 quota 配線を追加しても manifest.json は無変更（host_permissions / permissions を増やしていない）
☑ 拡張機能のコードに quota の ON / OFF を固定する定数は存在しない（サーバーの `EXTENSION_QUOTA_ENABLED` が唯一の判断元。Store 更新なしで切り替わる）
□ 申請時点で Cloudflare の `EXTENSION_QUOTA_ENABLED` が意図した値か確認する（extension_pro の販売導線が整うまでは false）
□ `EXTENSION_QUOTA_ENABLED` を true にする前に、§12-2 の内容がストアのプライバシー申告と一致しているか確認する
□ OAuthクライアントが公開用（本番）設定になっているか、Google Cloud Console側で確認する（本ファイル作成時点では未確認・未操作）
☑ 紹介ページ（https://sukimacalendar.com/extension）、プライバシーポリシー（https://sukimacalendar.com/extension/privacy）、利用規約（https://sukimacalendar.com/terms）の到達確認済み（2026-07-26、いずれもHTTP 200・404ではない）
□ スクリーンショットを、個人情報が写り込まない状態で撮り直す
□ Chrome Web Store Developer Dashboardのプライバシー診断項目（データ利用目的の申告）と、本ファイルの記載内容が一致していることを確認する
□ Chrome Web Store デベロッパー登録（初回登録料）が完了しているか確認する
☑ Chrome Web Store の update manifest で公開中バージョンを確認済み（1.0.0）
☑ manifest.json の version を 1.2.0 にした（1.1.0 は審査未提出のまま飛ばす。番号の飛びは Store 上問題ない）
☑ manifest に default_locale: "en" を追加し、name / description を __MSG_*__ にした
☑ _locales/ja/messages.json と _locales/en/messages.json を追加した（提出物は 9 → 11 ファイル）
□ public/extension/privacy.html の §5 / §6 / §7 / §10 / §12 の更新を本番へ反映してから申請する
□ **英語プライバシーポリシー（public/extension/privacy/en.html）を本番へ反映してから申請する**
  拡張の英語 UI はフッターから https://sukimacalendar.com/extension/privacy/en を開く。
  未デプロイのまま申請すると英語利用者が 404 に当たる。
□ デプロイ後、日本語版 /extension/privacy が 200 のままであることを再確認する
  （privacy.html と privacy/ ディレクトリが同居する構成になったため）
□ Store Developer Dashboard のデータ使用申告に、認証情報（連携用セッショントークン）と利用回数の記録を反映する
□ Store Developer Dashboard の identity 権限の justification を、launchWebAuthFlow を含む内容へ更新する
□ 単一目的の説明とストア掲載の説明文に矛盾がないか最終確認する
□ 提出用ZIPに marketing/ や開発用ファイル（同期スクリプト等）が混入していないか確認する
```

---

## 18. 公開URLの到達確認結果

確認日：2026-07-26
確認方法：読み取り専用のHTTP GET（設定変更は行っていない。Cloudflare・DNS・Netlifyは未操作）

| URL | ステータス | リダイレクト | 最終URL | ページタイトル |
|-----|-----------|-------------|---------|----------------|
| https://sukimacalendar.com/extension | 301 → 200 | `/extension/` へ301 | https://sukimacalendar.com/extension/ | スキマ Chrome拡張 - Googleカレンダーの空き時間を検索 |
| https://sukimacalendar.com/extension/privacy | 200 | なし | https://sukimacalendar.com/extension/privacy | プライバシーポリシー（Chrome拡張機能） - スキマ |
| https://sukimacalendar.com/terms | 200 | なし | https://sukimacalendar.com/terms | 利用規約 - スキマ |

3件とも404ではなく、意図したページが配信されていることを確認済み。DNS移行に起因する到達不可の状態は解消している。

補足：`/extension` は末尾スラッシュ付きの `/extension/` へ301リダイレクトされる。Chrome Web Storeへ登録する際は、リダイレクトを避けるため `https://sukimacalendar.com/extension/` を使うか、301のままで問題ないことを確認したうえで `/extension` を使う。

---

## 参考：現在の実装情報（chrome-extension/manifest.json）

```json
"permissions": ["sidePanel", "identity"],
"host_permissions": ["https://www.googleapis.com/*"],
"oauth2": {
  "scopes": [
    "https://www.googleapis.com/auth/calendar.events.readonly",
    "https://www.googleapis.com/auth/calendar.calendarlist.readonly"
  ]
}
```

"storage" 権限の削除はコミット 8b17ad7 で実施済みです。本ファイルの更新にあたって manifest.json は読み取りのみ行い、変更していません。

拡張 quota 配線（`sukima-api.js` の追加と `sidepanel.js` の変更）でも、manifest.json は変更していません。セッショントークンの保存に `chrome.storage` ではなく `localStorage` を使うため "storage" 権限は不要で、通信はサーバー側 CORS で許可するため host_permissions の追加も不要です。

---

## 19. 英語版 Store 掲載文（海外展開・1.2.0 から）

1.2.0 で拡張機能が日本語＋英語に対応したため、Store 掲載情報も英語を用意する。
Chrome Web Store は言語ごとに掲載情報を登録できる。以下は英語ロケール用の原稿。

**方針**

- 未実装の機能は書かない（Extension Pro / All Pro の購入導線は未実装のため触れない）
- 週3回制限は「サーバー側の設定で有効・無効を切り替える仕組み」であり、
  公開文では現在の env 値に依存する断定を書かない
- 表示言語は Chrome の UI 言語に自動追従する。拡張内に言語切替 UI は無い

### 19-1. Name

```
Free Time Finder for Google Calendar - Sukima
```

この値は `_locales/en/messages.json` の **`appNameLong`** と同一で、
`manifest.json` の `name`（`__MSG_appNameLong__`）から反映される。
日本語掲載名は §1 を参照。

**名前を 2 つに分けている理由**

| キー | 値（en / ja） | 使われる場所 |
|---|---|---|
| `appName` | `Sukima` / `スキマ` | サイドパネルの見出し `<h1>` と `<title>` |
| `appNameLong` | `Free Time Finder for Google Calendar - Sukima` / `スキマ - Googleカレンダー空き時間検索` | `manifest.name`（ツールバー・拡張機能一覧・Store 掲載名） |

サイドパネルの見出しは 20px の太字で、パネル幅は利用者が変えられる（既定でおよそ
320〜400px、`body` の padding を引くと描画幅は約 292〜372px）。
検索性を意識した長い名前をそのまま見出しに出すと 2〜3 行に折り返し、
検索 UI が下へ押し出される。そのため **見出しは短い名前のまま**にし、
検索性が要る manifest / Store 側だけ長い名前を使う。

`appNameLong` の英語は **45 文字ちょうど**で、Chrome の `name` 上限と同じ。
語を足す余地は無いので、変更する場合は必ず文字数を数えること。

### 19-2. Short description (132 characters or fewer)

```
Find free time in your Google Calendar from the Chrome side panel. Pick a range and duration, then copy slots or create events.
```

### 19-3. Detailed description

```
Sukima finds the free time in your Google Calendar and shows it right in the Chrome side panel.

Features:
- Finds free time in your Google Calendar automatically
- Works in the Chrome side panel, next to whatever you are doing
- Search any range up to 31 days by picking a start and end date
- Presets for Today, This week, Next week, This month and Next month
- Choose which of your calendars to include
- Set the minimum length of a free slot
- Shows results day by day
- Copy a single slot, or copy every slot for the day at once
- Open the Google Calendar event editor prefilled with a slot
- Available in English and Japanese, following your Chrome language

About your data:
- Access to the Google Calendar API is read-only
- Calendar information is used only to calculate free time and display it in the side panel
- Calendar content is never sent to the developer's servers
- No advertising, no analytics, no behavioural tracking

Sukima is also available as a web app at https://sukimacalendar.com, and this extension brings the
same idea to the Chrome side panel.
```

### 19-4. Single purpose

```
The single purpose of this extension is to read the user's own Google Calendar events with read-only
access, calculate the free time within a range and conditions the user specifies, and display the
result in the Chrome side panel.
It has no other purpose, such as showing advertising, integrating with other services, or collecting
data other than calendar information.
```

### 19-5. Justification for the identity permission

```
The identity permission is used for exactly two purposes.

1. Signing in with a Google Account and obtaining the OAuth access token used to call the Google
   Calendar API (chrome.identity.getAuthToken()).
2. Linking the extension with an account on Sukima (sukimacalendar.com), the web service operated by
   the same developer (chrome.identity.launchWebAuthFlow() / chrome.identity.getRedirectURL()).
   This runs only when the user explicitly chooses to link, and only while the free usage limit is
   enabled on the server. No Google Calendar information is exchanged during linking, and the Google
   access token is never sent to the developer's server.

Both are called directly from the extension's own code, and the permission is not used for anything
else.
```

### 19-6. Justification for the sidePanel permission

```
This extension presents its interface in the Chrome side panel rather than in a popup. Entering search
conditions and reading the results all happen inside the side panel, so the sidePanel permission is
required.
```

### 19-7. Justification for the googleapis.com host permission

```
The extension sends HTTP requests directly to the Google Calendar API (www.googleapis.com) using the
OAuth access token it obtains, so https://www.googleapis.com/* is declared in host_permissions.
It is used only to read the calendar list and event information, and the extension does not call any
API on other domains through host_permissions.
```

### 19-8. Justification for calendar.events.readonly

```
Required to read the events in the requested range (start time, end time, busy/free state) in order to
calculate free time. Only the read-only scope is requested. The extension never creates, edits or
deletes events itself; it only opens the Google Calendar event editor in a new tab.
```

### 19-9. Justification for calendar.calendarlist.readonly

```
Required to read the list of calendars the user owns, so that the user can choose which calendars to
include in the search. Only the read-only scope is requested. The extension does not add, remove or
reconfigure calendars.
```

### 19-10. Reviewer instructions

```
1. Install the extension and click its icon in the Chrome toolbar to open the side panel.
2. Choose "Sign in with Google" and sign in with a test Google Account.
3. On the OAuth consent screen, confirm and grant read-only access to Google Calendar.
4. After granting access, a search runs automatically for today through seven days ahead, and the
   results are displayed.
5. Even with no events in the calendar, free time candidates are shown between 09:00 and 22:00.
6. Set a start and end date directly, or choose a preset such as "This week", and confirm the date
   fields update.
7. Confirm that choosing a preset alone does not run a search, and that pressing the search button
   updates the results.
8. If the account has several calendars, change the calendar selection and search again.
9. Use the "Copy" button on a candidate to copy that time range.
10. Use "Copy all slots for this day" to copy every candidate of the day shown.
11. Use "Add to Calendar" to open the Google Calendar event editor in a new tab.
12. Confirm that switching accounts and signing out both work.
13. Close and reopen the side panel and confirm the signed-in state is kept.

Language:
- The interface follows the browser UI language. There is no language switch inside the extension.
- English and Japanese are provided; other languages fall back to English (default_locale is "en").
- To review the Japanese interface, set the Chrome UI language to Japanese and reopen the side panel.

Communication with the Sukima server:
- When the search button is pressed, the extension makes one request to
  sukimacalendar.com/api/ext/config to read a setting. The response is cached for 5 minutes.
  This request needs no sign-in and sends only the extension's identifier. It contains no calendar
  information.
- That setting controls whether a free weekly usage limit applies. While it is not enabled, no account
  linking screen appears, and steps 1-13 above can all be completed without linking a Sukima account.

Notes:
- A personal Google Account is recommended.
- Accounts managed by Google Workspace may be blocked by administrator settings.
- An account with no events can still be used for review.
- If a review account is needed, it will be supplied separately through the Chrome Web Store form.
```

### 19-11. 英語掲載に必要な Store 側の作業（コードでは完結しない）

| 項目 | 状態 |
|---|---|
| 英語ロケールの掲載情報登録（19-1〜19-4） | Dashboard で登録が必要 |
| identity の justification 更新（19-5） | Dashboard で更新が必要。launchWebAuthFlow を含む内容へ |
| データ使用申告（認証情報・利用回数の記録） | Dashboard で判断・登録が必要 |
| 英語プライバシーポリシー URL | https://sukimacalendar.com/extension/privacy/en を登録。**先に本番反映が必要** |
| 販売地域 | 英語圏を追加する必要がある（現状は要確認） |
| スクリーンショット | 英語 UI で撮り直す必要がある。Store は言語ごとに登録できる |

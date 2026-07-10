# スキマ Chrome拡張 MVP 設計ドキュメント

## 前提・制約

| 項目 | 内容 |
|---|---|
| 既存Web版 | Google OAuth審査対応済み。`index.html` 等は一切変更しない |
| Web版OAuth Client ID | `356365978986-kuvg67sktqngrtjmoci8nqef58rnsom3.apps.googleusercontent.com`（変更しない） |
| SCOPEは既存と同じ | `calendar.events.readonly` + `calendar.calendarlist.readonly` |
| 配置場所 | `chrome-extension/` 以下に完全別実装 |

## 実装前の確認事項

**Chrome拡張用OAuth Client IDは未作成。**

`chrome.identity.getAuthToken()` を使うために、Google Cloud Console で「アプリケーションの種類：Chrome拡張機能」として新規作成が必要。
Web版のClient IDをそのまま流用しない。

作成手順:
1. Google Cloud Console → プロジェクト `gen-lang-client-0558069275` を開く
2. 「認証情報」→「認証情報を作成」→「OAuthクライアントID」
3. アプリケーションの種類：**Chrome拡張機能** を選択
4. 拡張機能ID（開発中はローカルID）を入力
5. 作成されたClient IDを `chrome-extension/manifest.json` の `oauth2.client_id` に設定

---

## 1. `chrome-extension/` 以下のファイル構成

```
chrome-extension/
├── manifest.json       ← Chrome拡張用（MV3）※Web版と別ファイル
├── popup.html          ← ポップアップUI本体
├── popup.js            ← UI制御＋API呼び出し＋空き時間計算
├── background.js       ← OAuth tokenをchrome.identityで取得するService Worker
├── icon-16.png         ← ツールバーアイコン（16px）
├── icon-48.png         ← 拡張機能管理画面用（48px）
└── icon-128.png        ← Chrome Web Store用（128px）
```

合計7ファイル。

---

## 2. 各ファイルの役割

| ファイル | 役割 |
|---|---|
| `manifest.json` | MV3宣言・権限定義・oauth2設定・popup・background登録 |
| `popup.html` | UI（ログインボタン → 検索フォーム → 結果一覧）のHTML＋CSS |
| `popup.js` | 画面制御・background.jsへのトークン取得依頼・Calendar API呼び出し・空き時間計算・結果描画 |
| `background.js` | `chrome.identity.getAuthToken()` を処理するメッセージハンドラ。popup.jsからメッセージを受け取りトークンを返す |
| `icon-16.png` | ツールバー表示用アイコン |
| `icon-48.png` | 拡張機能管理画面用アイコン |
| `icon-128.png` | Chrome Web Store用アイコン（既存の192pxをリサイズして作成） |

---

## 3. Web版から流用するロジック

以下は `popup.js` にそのままコピーして使える。

| ロジック | Web版の場所 | 流用方法 |
|---|---|---|
| `findFreeSlots()` | `index.html` 内 `<script>` | そのままコピー |
| `formatResult()` | 同上 | そのままコピー |
| `slotToText()` | 同上 | そのままコピー |
| `slotToCalendarUrl()` | 同上 | そのままコピー |
| `copySlot()` / `copyAll()` | 同上 | そのままコピー |
| Google Calendar API の fetch URL | 同上 | そのままコピー |
| `DAY_START=9` / `DAY_END=22` / `STEP_MIN=30` の定数 | 同上 | そのままコピー |
| 日付フォーム（開始日・終了日・希望時間）のUI | 同上 | HTML・CSSを移植 |
| カレンダーモード（全/選択）のUI | 同上 | HTML・CSSを移植 |
| プライバシーポリシー文章 | `privacy.html` | ストア掲載用に参照 |

---

## 4. Chrome拡張版で作り直すロジック

| 作り直す対象 | 理由 |
|---|---|
| **Google認証処理** | Web版のGSI（`google.accounts.oauth2.initTokenClient`）は拡張機能で使えない。`chrome.identity.getAuthToken()` に完全置き換え |
| **トークン保管** | Web版は `localStorage`。拡張版は `chrome.storage.local`（ポップアップを閉じても保持するため） |
| `manifest.json` | Web版はPWA用。拡張版はMV3形式で完全別物 |
| `background.js` | MV3 Service Workerとして、chrome.identityを通じたトークン取得を担う |
| **ポップアップのサイズ制約対応** | 拡張機能のpopupは幅600px・高さ600pxが上限。結果が多い場合のスクロール対応が必要 |
| **インストールバナー（PWA用）** | 拡張機能には不要。削除 |
| **Service Worker登録（Web版）** | `navigator.serviceWorker.register('/sw.js')` は不要。削除 |

---

## 5. Google認証方式

**Chrome拡張版は `chrome.identity.getAuthToken()` を使う。Web版のGSIは使わない。**

### 認証フロー

```
[popup.js]
↓ chrome.runtime.sendMessage({ type: 'GET_TOKEN' })
[background.js]
↓ chrome.identity.getAuthToken({ interactive: true })
↓ accessToken を返す
[popup.js]
↓ Calendar API を fetch
```

- `interactive: true` のとき、未認証の場合はChromeがOAuth同意画面を表示する
- `interactive: false` のとき、既にトークンがあればサイレントで返す（ログイン済み確認に使う）
- トークンの有効期限切れは `chrome.identity.removeCachedAuthToken()` → 再取得で対応

### manifest.json の oauth2 ブロック（スコープはWeb版と同じ）

```json
"oauth2": {
  "client_id": "【Chrome拡張用Client ID】.apps.googleusercontent.com",
  "scopes": [
    "https://www.googleapis.com/auth/calendar.events.readonly",
    "https://www.googleapis.com/auth/calendar.calendarlist.readonly"
  ]
}
```

### Web版との認証方式の比較

| | Web版 | Chrome拡張版 |
|---|---|---|
| 認証方法 | Google Identity Services (GSI) / `initTokenClient` | `chrome.identity.getAuthToken()` |
| トークン保存 | `localStorage` | `chrome.storage.local` |
| OAuth Client ID | Web用Client ID | **Chrome拡張用Client ID（別途作成）** |
| GSIスクリプト読み込み | 必要 | 不要 |

---

## 6. MVPで作る機能

| 機能 | 内容 |
|---|---|
| popupを開く | ツールバーアイコンクリックでポップアップ表示 |
| Googleログイン | `chrome.identity.getAuthToken()` でChromeアカウント認証 |
| 開始日・終了日入力 | デフォルトは今日〜7日後 |
| 希望時間選択 | 30分 / 1時間 / 1時間30分 / 2時間 |
| カレンダー選択 | 全カレンダー / 選んで使う（チェックボックス） |
| 空き時間検索 | `findFreeSlots()` 流用 |
| 結果表示 | 日付・時間帯のカード一覧 |
| この枠をコピー | `copySlot()` 流用 |
| 全部コピー | `copyAll()` 流用 |
| Googleカレンダー予定追加 | `slotToCalendarUrl()` で `window.open()` |
| ログアウト | `chrome.identity.removeCachedAuthToken()` + `chrome.storage.local.clear()` |

---

## 7. MVPでは作らない機能

| 機能 | 理由 |
|---|---|
| 課金機能（無料版/有料版の切り替え） | 後フェーズ。Stripe等の外部決済連携は審査後 |
| 日程調整リンク生成 | 後フェーズ |
| 日程調整用テキスト自動生成（AI） | 後フェーズ |
| オプション画面（`options.html`） | MVPには不要 |
| Chrome Web Store申請・審査 | MVPはローカル動作確認まで |
| プッシュ通知 | 後フェーズ |
| Googleカレンダーへの直接書き込み | 読み取りのみ（審査も簡単） |

---

## 8. 実装順序

| ステップ | 対象 | 目的 | 検証内容 |
|---|---|---|---|
| 1 | `manifest.json` | Chrome拡張として認識される最小構成 | `chrome://extensions/` で読み込めること |
| 2 | `background.js` | `chrome.identity.getAuthToken()` でトークン取得 | Consoleでトークン文字列が返ること |
| 3 | `popup.html` + `popup.js`（認証部分のみ） | ログイン → トークン取得 → ログイン済み表示まで | popupでGoogleログインが完了すること |
| 4 | `popup.js`（API呼び出し） | Calendar API フェッチ → イベント取得 | カレンダーイベントがConsoleに出ること |
| 5 | `popup.js`（空き時間計算・結果表示） | `findFreeSlots()` 統合 → スロット表示 | 空き時間がカード形式で表示されること |
| 6 | `popup.js`（コピー・カレンダー連携） | `copySlot` / `copyAll` / `slotToCalendarUrl` | コピーとGoogleカレンダー遷移が動くこと |
| 7 | アイコン整備 | 既存192pxから16/48/128pxを生成 | 管理画面・ツールバーにアイコンが出ること |
| 8 | ローカル動作確認 | エンドツーエンドで全機能確認 | 全MVP機能が動作すること |

**ステップ1→2→3の順番が重要。** 認証が通らないと後ろのステップすべてが確認できない。

---

## 9. 最初の実装タスク

**タスク：`chrome-extension/manifest.json` を作成する**

必要な内容:
- `manifest_version: 3`
- `name: "スキマ"`
- `version: "1.0.0"`
- `action.default_popup: "popup.html"`
- `permissions: ["identity", "storage"]`
- `oauth2.client_id`: Chrome拡張用Client ID（**未作成。作成後に設定**）
- `oauth2.scopes`: Web版と同じ2スコープ
- `background.service_worker: "background.js"`
- `icons`: 16 / 48 / 128

**このタスクは、Chrome拡張用OAuth Client IDの作成後に実施する。**

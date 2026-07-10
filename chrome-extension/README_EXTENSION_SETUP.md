# スキマ Chrome拡張 セットアップ手順

## このフォルダについて

`chrome-extension/` はChrome拡張版スキマのMVP用フォルダです。

既存Web版（`index.html` 等）とは完全に分離されています。

## 現在の状態

**OAuth未実装のスケルトン（Step 0）です。**

Googleログインは動きません。
Chrome Developer DashboardへのZIPアップロードで拡張機能IDを取得するための最小構成です。

---

## 次にやること（順番通りに実施）

### 1. Chrome Developer Dashboardへ ZIP を下書きアップロード

1. `chrome-extension/` フォルダ全体をZIPに圧縮する
2. Chrome Developer Dashboard（https://chrome.google.com/webstore/devconsole）を開く
3. 「新しいアイテム」→ ZIPをアップロード
4. **公開はしない**。下書き保存でOK

### 2. public key を取得して manifest.json に追加

1. ダッシュボードの「パッケージ」タブから `public_key` を取得
2. `chrome-extension/manifest.json` の先頭付近に以下を追加:
   ```json
   "key": "MII...（取得したpublic key）"
   ```
3. これにより、ローカル開発中も本番と同じ拡張機能IDが固定される

### 3. 拡張機能IDを確認

- ダッシュボードに表示される拡張機能ID（32文字）を控える
- または `chrome://extensions/` でローカル読み込み後に確認する

### 4. Google CloudでChrome拡張用OAuth Client IDを作成

1. Google Cloud Console（https://console.cloud.google.com）を開く
2. プロジェクト `gen-lang-client-0558069275` を選択
3. 「APIとサービス」→「認証情報」→「認証情報を作成」→「OAuthクライアントID」
4. アプリケーションの種類：**Chrome 拡張機能** を選択
5. 拡張機能ID（手順3で確認したID）を入力
6. 作成完了 → クライアントIDをコピー

### 5. OAuth Client IDを manifest.json に設定

`chrome-extension/manifest.json` に以下を追加:

```json
"oauth2": {
  "client_id": "【取得したクライアントID】.apps.googleusercontent.com",
  "scopes": [
    "https://www.googleapis.com/auth/calendar.events.readonly",
    "https://www.googleapis.com/auth/calendar.calendarlist.readonly"
  ]
},
"permissions": ["identity", "storage"]
```

---

## 注意事項

- Web版のOAuth Client IDをそのまま使わないこと
- `permissions` に `identity` を追加するのはOAuth Client ID設定後
- 既存Web版ファイル（`index.html` / `privacy.html` / `sw.js` / `manifest.json`）は変更しないこと

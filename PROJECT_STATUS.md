# PROJECT_STATUS.md

スキマの現在の状態の記録です。作業の区切りごとに上書き更新します。
**記録は記録にすぎず、実環境が唯一の真実です。** 再開時は必ず実測値と照合し、
差分があれば reset せずに報告して停止してください。

記録日: 2026-10-08

---

## 1. Git

| 項目 | 値 |
|---|---|
| branch | `main` |
| HEAD | `bcc36c6` fix: improve Google login feedback |
| origin/main | `bcc36c6` |
| ahead / behind | 0 / 0 |
| test | `npm test` 1870 / 1870 PASS（fail 0 / skipped 0） |
| Node / npm | v24.14.1 / 11.11.0 |

確認コマンド:

```bash
git rev-parse --short HEAD
git rev-parse --short origin/main
git rev-list --left-right --count HEAD...origin/main
npm test
```

---

## 2. 本番関連

| 項目 | 状態 |
|---|---|
| 本番 URL | https://sukimacalendar.com |
| Cloudflare Pages | `sukima-web`（main への push で自動 deploy） |
| 現在の Production deployment | `b7fca107`（source `bcc36c6`）。実際の Google ログインで動作確認済み（2026-10-02） |
| 直前の正常 Production deployment | `b1702aa0`（source `0220a87`）。rollback の第一候補 |
| Supabase | project `sukima-billing`。適用済み migration の詳細は HANDOFF_QUOTA_RESERVATION.md |
| `EXTENSION_QUOTA_ENABLED`（本番） | `false`（CHROME_WEB_STORE_LISTING_DRAFT.md の記録による） |
| 本番 secret の登録状況 | AGENTS.md の記録では GOOGLE_CLIENT_IDS / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY。その他の変数の登録状況は**未確認** |

---

## 3. 作業環境上の注意

- **未追跡の古い migration** `supabase/migrations/001_billing_schema.sql` が一部のPCに残っています。
  Git 管理下の正式な migration（`20260901022938_billing_schema.sql` 以降）とは別物の古い下書きです。
  **commit も適用もしないこと。** 削除するかどうかは別途判断します。
- **worktree `perfact-login-fix` が残っています**（branch `fix/google-login-feedback`、`bcc36c6`）。
  内容は main に取り込み済みです。削除するかどうかは別途判断します。
- **Step 188A**（free-slots P1-1 / P1-2）は旧PCにだけ未コミットで残っている記録があります。
  再開するときは `bcc36c6` を基準に統合します。
- 旧PCの `docs/`（`.gitignore` 対象）は Git に入っていません。PC間で共有が必要な文書は、
  リポジトリルートの追跡対象ファイルに置きます。
- HANDOFF_QUOTA_RESERVATION.md / HANDOFF_CHROME_EXTENSION.md の Workspace 節にある
  PC固定パスは旧PC時点の記録です。作業場所はリポジトリルート基準で読み替えてください。
- `scripts/sync-sukima-extension.ps1` はコピー元とコピー先にPC固定パスを使っています。実行前に各PCのパスを確認します。

---

## 4. 未解決の課題（2026-10-02 時点の記録）

- Google ログインのループの根本原因は未確定（最有力は Google popup → callback の受け渡し）
- `/api/auth/me` が Cookie なしの 401 でも削除用の Set-Cookie を返す（P2-1）
- auth/session の fetch timeout
- 本人確認と Calendar 連携で Google の画面が 2 回出る UX（P1-1）
- ログイン時の 30 秒案内は暫定値

---

## 5. 次に予定している改善案

- 所要時間の選択（30 / 45 / 60 分など）
- 時間帯の指定
- スマホ向けの横スクロール週間カレンダー
- 日付をタップすると、その日の詳細表示へ移動
- 検索条件のブックマーク候補

---

## 6. 更新ルール

- 作業の区切り（commit / push / 本番反映）ごとに §1・§2 を実測値で上書きする。
- 本番反映時は deployment ID と source commit を記録し、1 つ前の deployment を「直前の正常」に移す。
- secrets の値は書かない。

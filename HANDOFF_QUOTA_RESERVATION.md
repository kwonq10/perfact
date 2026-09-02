# Sukima Development Handoff

> **このファイル（リポジトリルートの `HANDOFF_QUOTA_RESERVATION.md`）が、
> quota reservation 作業の唯一の再開用ハンドオフです。**
> 作業内容が進むたびに上書き更新します。過去の記録は残しません。
>
> `docs/handoffs/CURRENT.md` にも同じ内容の控えがありますが、`docs/` は
> `.gitignore` されており commit されません。**正式な参照先は本ファイルです。**

---

## Claude Code 再開ルール（最初に読むこと）

新しい Claude Code セッションでは、quota reservation 関連の作業に入る前に
**必ずリポジトリルートの `HANDOFF_QUOTA_RESERVATION.md` を最初に読んでください。**

読んだあと、**必ず実環境と照合**してください。

```bash
git status --short --untracked-files=all
git rev-parse HEAD
git rev-parse origin/main
git rev-list --left-right --count origin/main...HEAD
npm test
ls supabase/migrations/
ls functions/api/quota 2>/dev/null || echo "(quota API 未実装)"
```

### handoff と実環境が食い違った場合

| してよいこと | してはいけないこと |
|---|---|
| 実測値と本ファイルの差分を報告する | handoff の記述を盲信して作業を進める |
| どちらが新しいか判断材料を示す | `git reset` / `git checkout` で履歴を変更する |
| ユーザーに確認を求めて停止する | 差分を黙って無視する / 勝手に handoff を書き換える |

**差分があったら作業を止めて確認を求めてください。** handoff はあくまで記録であり、実環境が唯一の真実です。

---

## CURRENT CHECKPOINT

```
quota reservation implementation ready
```

STEP 1（migration 作成）に着手する直前の状態です。**quota 関連のコードは 1 行も存在しません。**

---

## Workspace

```
C:\Users\tetsu\perfact
```

正式な作業元はこのディレクトリのみです。
`G:\マイドライブ\バイブコーディング\perfact` を作業元として push してはいけません。

---

## Git

記録時点（実測値）:

```
HEAD        = 45498673b9b946b22239ed3decea9de8d71365a3
origin/main = 45498673b9b946b22239ed3decea9de8d71365a3
ahead 0 / behind 0
working tree clean（未追跡ファイルも 0 件）
baseline tests: 221 / 221 PASS（fail 0 / skipped 0 / todo 0）

直近のコミット:
  4549867  fix: validate origin for session logout
  71e8e2f  fix: require explicit tap for calendar authorization
  26f8521  feat: integrate secure web sessions
```

**実測値が異なる場合は、勝手に reset せず、現在値と差分を記録・報告してください。**

---

## Production

```
https://sukimacalendar.com
Cloudflare Pages project : sukima-web
production branch        : main
```

- **main への push は本番自動 deploy になります。**
- `www.sukimacalendar.com` は Cloudflare Redirect Rule で apex へ **308**（Single Redirect / `http.host eq` + wildcard / preserve query string）。
- 記録時点の本番 deployment: `e2d69b49`（source commit `4549867`）/ status success。

---

## Supabase

```
project : sukima-billing
ref     : lnqblfckupbjvlafhbmt
region  : Tokyo / ap-northeast-1
```

適用済み migration（本番反映済み）:

- `20260901022938_billing_schema.sql`
- `20260901041257_session_schema.sql`
- `20260901044339_revoke_anon_table_privileges.sql`

既存 RPC: `upsert_user_and_create_session` / `get_session_context` / `delete_session` / `consume_weekly_usage`（**未使用**）/ `jst_week_start` / `set_updated_at`

権限方針: 全テーブル RLS 有効・policy 0 件。anon / authenticated に直接権限なし。**service_role のみが server-side から利用**します。

---

## quota reservation 確定仕様

**これらは製品判断として確定済みです。再検討しないでください。**

### 方式と上限

- **案B: reservation（予約）方式**
- Free は **週 3 回**
- 週の起点は **JST 月曜始まり**（`jst_week_start()` が DB 側で算出。クライアントの時計は一切使わない）
- **`RELEASE_BUDGET = 3`**（週・ユーザーあたりの返金上限。最悪ケースは `3 + 3 = 6` 回で有界）
- **reservation TTL = 120 秒**

### 状態とカウント

- `pending` / `committed` は **used にカウントする**
- `released` は **used にカウントしない**
- 期限切れ pending は **`committed('expired')`**（fail closed。「commit しない」攻撃を封じるため）
- release budget 超過は **`committed('release_budget_exceeded')`**
- **`used` は `quota_reservations` の行から導出する**

```sql
used = COUNT(*) FROM quota_reservations
       WHERE user_id = ? AND week_start = ?
         AND state IN ('pending', 'committed')
```

**加算・減算を一切行いません。** これが設計の安全性の要で、「二重 release による過剰返金」「カウンタが負になる」「カウンタと予約表の drift」を構造的に排除します。

### 権限判定

- **`past_due` は Pro 扱いしない**
- Web 無制限の条件:
  `plan_id ∈ {web_pro, all_pro}` **かつ** `status ∈ {active, trialing}`
- **`extension_pro` は Web では quota 対象**（拡張機能専用の権利）
- `canceled` / `unpaid` / `incomplete` / `incomplete_expired` は quota 対象

### 検索の扱い

- **`goToNextWeek` は 1 検索としてカウントする**
- **Calendar events API が 1 件以上 2xx なら検索成功**（一部のカレンダーが 403 でも成功扱い）
- **Calendar 401 は `authExpired`** として別扱い（→ release し、既存の再認可フローへ）
- **正常検索で 0 件でも成功**（consume する）
- カレンダー一覧（`calendarList`）の失敗は判定に含めない（`calIds=['primary']` で続行できるため）

### その他

- **Web / Extension は `user_id` 単位で quota 共有**（`weekly_usage` / `quota_reservations` に surface 列を持たない）
- commit / release の引数は **JSON body**
- Origin 検証は既存の `functions/api/_lib/origin.js`（`checkOrigin`）を再利用。**このファイルは変更しない**
- **Stripe webhook には Origin 検証を適用しない**（未実装。Origin ヘッダを持たず、署名検証で守る領域）

### 状態機械

```
              reserve
                 │
                 ▼
            ┌─────────┐
            │ pending │ ── used にカウント
            └────┬────┘
   commit ┌──────┼──────┐ release（予算内）
          ▼      │      ▼
   ┌───────────┐ │ ┌──────────┐
   │ committed │ │ │ released │ ── used にカウントしない
   └───────────┘ │ └──────────┘
        ▲        │
        └────────┴── expires_at 経過 / release 予算切れ
                     （committed へ確定）
```

| From \ 操作 | `commit` | `release` |
|---|---|---|
| `pending`（有効・予算内） | → `committed` / ok | → `released` / ok |
| `pending`（有効・予算切れ） | → `committed` / ok | → `committed('release_budget_exceeded')` / **ng** |
| `pending`（期限切れ） | → `committed('expired')` / ok | → `committed('expired')` / **ng** |
| `committed` | ok（冪等） | **ng** |
| `released` | **ng** | ok（冪等） |
| 存在しない / 他人の予約 | **ng** `not_found` | **ng** `not_found` |

---

## 実装予定（4 STEP）

**STEP をまたいで先回りしないでください。**

### STEP 1 — quota reservation migration 作成・静的レビュー

- 成果物: `supabase/migrations/2026MMDDHHMMSS_quota_reservation_schema.sql`（新規 1 本）
- **DB 適用なし**
- 検証: SQL の静的レビューのみ

### STEP 2 — quota API + tests

- 成果物: `functions/api/quota/{reserve,commit,release}.js` / `functions/api/_lib/request-body.js` / 対応テスト 4 本
- **frontend 変更なし・DB 適用なし**
- 検証: `npm test` が 221 → 約 290 件で全 PASS

### STEP 3 — frontend 連携

- 成果物: `public/index.html`
- `fetchAndCalc()` を `{ ok, authExpired }` を返すよう変更
- reserve / commit / release の接続、i18n 追加
- **DB 適用なし**
- 検証: `npm test` 全 PASS / inline script の `node --check` / ローカル E2E

### STEP 4 — 本番適用・E2E

**本番反映順序（この順を守ること）**

```
① Supabase migration 適用
② migration 確認（table / 3 RPC / 権限）
③ git push origin main
④ Cloudflare deploy 確認（source commit の一致・status success）
⑤ safe probe（Origin ヘッダ必須）
⑥ 実 E2E
```

順序を誤ってコードを先に出した場合、新エンドポイントは `502 database_unavailable` を返します。フロントは reserve 失敗として検索を止めるため **quota は消費されず既存機能も壊れません**（fail closed）が、その間 Free ユーザーは検索できません。

---

## 次に行う作業

# STEP 1 から開始

新規 migration:

```
supabase/migrations/2026MMDDHHMMSS_quota_reservation_schema.sql
```

予定内容:

1. `quota_reservations` table
2. indexes（`(user_id, week_start, state)` と `expires_at WHERE state='pending'`）
3. RLS 有効化
4. service_role privilege（REVOKE anon/authenticated → GRANT service_role）
5. `reserve_weekly_usage(UUID, TEXT, INT)`
6. `commit_weekly_usage(UUID, UUID)`
7. `release_weekly_usage(UUID, UUID)`
8. `consume_weekly_usage` の service_role EXECUTE revoke（誤用防止。定義は残す）
9. comments（`weekly_usage.search_count` を「派生キャッシュ」と明記）
10. 末尾に掃除方針コメント（`session_schema.sql:375-379` と同じ形式）

**このハンドオフ作成時点では migration をまだ作っていません。**

### 設計メモ（STEP 1 の実装に必要）

- 直列化は **`weekly_usage(user_id, week_start)` 行の `FOR UPDATE`**
  （`users` 行はロックしない。ログイン処理 `upsert_user_and_create_session` とのデッドロックを避けるため）
- ロック順は常に `weekly_usage → quota_reservations` の一方向
- `weekly_usage.search_count` は同一トランザクション内で更新する**派生キャッシュ**（権威ではない）
- 全 RPC は `SECURITY INVOKER` + `SET search_path = public, pg_temp` + service_role のみ EXECUTE（既存規約）
- 列参照は `weekly_usage.` / `quota_reservations.` で修飾する
  （戻り値の列名と PL/pgSQL 変数が衝突して "column reference is ambiguous" になるのを避ける。既存 RPC と同じ理由）
- `reserve` は lazy reclaim を内包（同一 user/week の期限切れ pending のみ `committed('expired')` へ確定）
- `idempotency_key` は `UNIQUE`。同じ鍵の再送は同じ予約行を返す（`reused=true`）
- 予約行に `week_start` を持たせる（週境界を跨いだ commit / release が「予約した週」を対象にするため）

---

## frontend 既存問題（STEP 3 の前提）

`public/index.html` の `fetchAndCalc()` は **Calendar API の失敗を握りつぶしています。**

```js
// L2219-2228  カレンダー一覧
try { const listRes = await fetch(...); if (listRes.ok) {...} } catch(e) {}
// L2234-2263  各カレンダーのイベント
try { const calRes  = await fetch(...); if (calRes.ok)  {...} } catch(e) {}
```

`!ok` も例外も無視されるため、**Calendar API が全滅しても `allEvents` が空のまま「終日空き」という正常結果として完走します。**

STEP 3 で以下を返すよう変更します。

```js
return { ok: calendarOk, authExpired: calendarAuthExpired };
```

- `calendarOk` — events 取得で 2xx を 1 件でも受け取ったか
- `calendarAuthExpired` — 401 を受け取ったか

`fetchAndCalc()` の呼び出し元は **2 箇所のみ**です（`startSearch` L2179 / `goToNextWeek` L2617）。
`renderCurrentDay` / `showNextDay` / `showPreviousDay` / `copyAll` / `loadCalendarList` / `restoreSavedBackground` / sessionStorage 復元 / 背景操作 は `fetchAndCalc` を呼ばないため、**誤消費のリスクはありません**（実測確認済み）。

---

## 禁止事項

- **STEP をまたいで先回りしない**
- **STEP 4 まで本番 DB へ適用しない**
- **明示指示なしで commit しない**
- **明示指示なしで push しない**
- **main への push は本番 deploy になることを忘れない**
- Cloudflare / Supabase / Google Cloud の設定を勝手に変更しない
- `.dev.vars` を読まない / 変更しない（秘密値を含む。gitignore 済み）
- secret / token / cookie の実値を表示しない
  （Google ID Token / Calendar access token / session cookie / token hash / google_sub / user_id / email / `SUPABASE_SERVICE_ROLE_KEY`）
- `G:\マイドライブ\バイブコーディング\perfact` を作業元として push しない

---

## STEP 終了時の更新ルール

**各 STEP の終了時に必ず `HANDOFF_QUOTA_RESERVATION.md` を更新してください。**
（`docs/handoffs/CURRENT.md` の控えも合わせて更新すると、ローカル参照がずれません）

記録する項目:

- 完了した STEP
- `git status --short --untracked-files=all`
- `npm test`（tests / pass / fail）
- 変更ファイル（新規 / 変更の別）
- commit ID（あれば）
- HEAD
- origin/main
- ahead / behind
- DB 適用状況
- deploy 状況
- E2E 状況
- 次の STEP
- 未解決事項

### 進捗ログ

| STEP | 状態 | commit | DB 適用 | deploy | 備考 |
|---|---|---|---|---|---|
| STEP 1 migration | **未着手** | — | — | — | 次はここから |
| STEP 2 API + tests | 未着手 | — | — | — | |
| STEP 3 frontend | 未着手 | — | — | — | |
| STEP 4 本番適用・E2E | 未着手 | — | — | — | |

---

## 未解決事項

1. **ハンドオフの配置は解決済み。**
   `.gitignore:2` に `docs/` があるため `docs/handoffs/CURRENT.md` は commit されません。
   そのため **ルート直下の本ファイル `HANDOFF_QUOTA_RESERVATION.md` を正式な参照先**とし、
   リポジトリに追跡させています（既存の `HANDOFF_CHROME_EXTENSION.md` と同じ慣習）。
   `docs/handoffs/CURRENT.md` はローカル控えとして残していますが、**内容が食い違った場合は
   本ファイルを正とします。**

2. **STEP 4 の migration 適用手順が未確立です。**
   既存 3 本は適用済みで、今回が初めての「セッション中の本番 DB 変更」になります。適用方法（`supabase db push` / ダッシュボードの SQL Editor）と必要な権限を STEP 4 の前に確認してください。

3. **body パースは新規パターンです。**
   既存 3 エンドポイント（session / me / logout）は request body を一切読みません。`_lib/request-body.js` に Content-Type 確認・サイズ上限 1KB・`JSON.parse` の try-catch・型検証をまとめる必要があります。

4. **並行性と週境界は単体テストで検証できません。**
   Node のテストは RPC の契約（引数・戻り値・呼び出し回数）しか検証できず、行ロックによる直列化と `jst_week_start()` の週境界は Postgres 側の責務です。`pgTAP` は未導入。

5. **`quota_reservations` の行は増え続けます。**
   v1 は lazy reclaim のみ。古い週の削除は将来 Cron（`session_schema.sql` と同じ扱い）。

6. **クライアント主導 rollback は原理的に悪用可能です。**
   `release` の真偽をサーバーは検証できません。`Origin` 検証は cross-site 攻撃を防ぐだけで、正規セッションを持つ利用者が `curl -H "Origin: …"` で release を送ることは防げません。`RELEASE_BUDGET` はこれを **`3 + 3 = 6` 回/週に有界化**する仕組みです（受容済み）。

7. **crash / タブ閉じ / commit 応答ロスト時は 1 回失います。**
   期限切れ pending を `committed('expired')` にする fail closed 設計の帰結です（受容済み）。

8. **拡張機能は未配線です。**
   DB は `user_id` 単位で共有可能ですが、`chrome-extension/manifest.json` の `host_permissions` は `https://www.googleapis.com/*` のみで、Sukima API へのアクセス権がありません。

9. **`fetchAndCalc` の失敗握りつぶしは quota と独立した既存 UX 問題**でもあります（API 全滅でも「終日空き」と表示）。STEP 3 の改修時に表示自体の見直しも検討価値があります。

---

## 既知の未対応課題（quota とは別件・優先度低）

`public/index.html` のレビューで検出済み、未修正のもの:

- **F5** 起動直後のちらつき（`#searchView` が初期非表示のため実害ほぼなし）
- **F6** 未処理 Promise 2 箇所（`signInWithGoogleIdToken(credential)` / `restoreSukimaSession().then(updateAuthUi)`）
- **F8** 既ログイン中に再サインインすると session 行が増える
- **F9** 未使用コード（`sukimaPlanId` / `sukimaSubscriptionStatus` は代入のみ、i18n キー `loginBtn` は参照なし）
- `requestCalendarAuthorization()` の GIS 未ロード時フォールバック（`waitForGoogle().then()`）と `fetchAndCalc()` の Calendar 401 再認可は、いずれも `await` を跨ぐためポップアップブロックされ得る既存経路

---

## 次回の最短再開指示

新しい Claude Code セッションでは、次の 1 行を貼り付けてください。

```
HANDOFF_QUOTA_RESERVATION.md を読んで、実環境と照合してから続きから再開して。
```

---

*最終更新: STEP 1 着手前（CHECKPOINT: quota reservation implementation ready）*
*正式な参照先: リポジトリルートの `HANDOFF_QUOTA_RESERVATION.md`*

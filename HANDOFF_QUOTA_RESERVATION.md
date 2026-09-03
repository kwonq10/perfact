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

STEP 2 完了後の期待値:

- `supabase/migrations/20260903015535_quota_reservation_schema.sql` が**未追跡で**存在する
- `functions/api/quota/{reserve,commit,release}.js` が**未追跡で**存在する
- `functions/api/_lib/{quota,request-body}.js` が**未追跡で**存在する
- `public/index.html` は**未変更**
- `npm test` は 337 / 337 PASS

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
STEP 2 完了（quota API + tests 実装済み・DB 未適用・未 commit）
```

migration 1 本と quota API 一式が未 commit で存在する状態です。
**DB へは適用していません。commit / push もしていません。**
`public/index.html` は未変更で、**フロントは quota API をまだ一切呼びません**。
そのため現時点でユーザーの動作は STEP 0 と変わりません。

---

## Workspace

```
C:\Users\tetsu\perfact
```

正式な作業元はこのディレクトリのみです。
`G:\マイドライブ\バイブコーディング\perfact` を作業元として push してはいけません。

---

## Git

記録時点（STEP 2 完了時の実測値）:

```
HEAD        = 35ebdd7d0070aecc76c309c4b7e1fe750b0025f2
origin/main = 35ebdd7d0070aecc76c309c4b7e1fe750b0025f2
ahead 0 / behind 0
変更 1 件 / 未追跡 8 件:
   M HANDOFF_QUOTA_RESERVATION.md
  ?? supabase/migrations/20260903015535_quota_reservation_schema.sql
  ?? functions/api/_lib/quota.js
  ?? functions/api/_lib/request-body.js
  ?? functions/api/quota/reserve.js
  ?? functions/api/quota/commit.js
  ?? functions/api/quota/release.js
  ?? functions/api/_tests/quota-helper.test.mjs
  ?? functions/api/_tests/quota-reserve.test.mjs
  ?? functions/api/_tests/quota-commit.test.mjs
  ?? functions/api/_tests/quota-release.test.mjs
  ?? functions/api/_tests/request-body.test.mjs
tests: 337 / 337 PASS（既存 221 + 新規 116。fail 0 / skipped 0 / todo 0）

直近のコミット:
  35ebdd7  docs: add quota reservation handoff
  4549867  fix: validate origin for session logout
  71e8e2f  fix: require explicit tap for calendar authorization
```

※ 前回の記録は HEAD = 4549867 だったが、これは本ハンドオフ自身を
commit する前の値。35ebdd7 は `HANDOFF_QUOTA_RESERVATION.md` と
`AGENTS.md` の追加のみで、quota 実装は含まない。

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

**未適用** migration（STEP 1 で作成。STEP 4 で適用する）:

- `20260903015535_quota_reservation_schema.sql`

既存 RPC: `upsert_user_and_create_session` / `get_session_context` / `delete_session` / `consume_weekly_usage`（**未使用**）/ `jst_week_start` / `set_updated_at`

STEP 4 適用後に増える RPC: `reserve_weekly_usage` / `commit_weekly_usage` / `release_weekly_usage`

権限方針: 全テーブル RLS 有効・policy 0 件。anon / authenticated に直接権限なし。**service_role のみが server-side から利用**します。

PostgreSQL メジャーバージョン: **17 系と推定**（`20260901044339` が記録した本番 ACL の `m` = MAINTAIN が PG17 以降にしか存在しないため）。STEP 1 の検証は PG 15.18 と 17.11 の両方で通しています。

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

# STEP 3 から開始

`public/index.html` を quota API に接続する。

- `fetchAndCalc()` を `{ ok, authExpired }` を返すよう変更する
- reserve / commit / release の接続、i18n 追加
- **DB 適用なし**
- 検証: `npm test` 全 PASS / inline script の `node --check` / ローカル E2E

### STEP 3 が守るべきこと（STEP 2 の実装から確定した前提）

1. **検索試行ごとに新しい `idempotency_key` を生成する。**
   `crypto.randomUUID()` でよい。`reserve` が `code:'already_settled'` を
   返したら、その鍵はもう使えない。新しい鍵を作って取り直すこと。

2. **`quota_enforced === false`（Pro）のときは commit / release を呼ばない。**
   `reserve` の応答は `reservation_id: null` になる。commit / release は
   body 検証が entitlement 判定より先に走るため、`reservation_id` が
   null のまま呼ぶと 400 `invalid_reservation_id` になる。

3. **`allowed === false` は HTTP 200 で返る。** `res.ok` だけで分岐しないこと。
   - `code:'limit_reached'`   → 上限 UI を出す
   - `code:'already_settled'` → 鍵を作り直して再試行

4. **`release` が `ok:false` を返したら「1 回消費された」として扱う。**
   `expired` / `release_budget_exceeded` はいずれも予約が `committed` へ
   確定しており、返金されていない。

5. **`fetchAndCalc()` が `ok:false` を返したときだけ release する。**
   `authExpired` のときも release してから既存の再認可フローへ。

6. **reserve が 4xx / 5xx を返したら検索を止める（fail closed）。**
   quota を消費していないので、リトライしても二重消費にならない。

---

## STEP 2 の成果物（完了・未 commit）

### 新規ファイル

```
functions/api/_lib/request-body.js            155 行  JSON body の読み取りと検証
functions/api/_lib/quota.js                   231 行  entitlement 判定と共通前処理
functions/api/quota/reserve.js                150 行  POST /api/quota/reserve
functions/api/quota/commit.js                 135 行  POST /api/quota/commit
functions/api/quota/release.js                138 行  POST /api/quota/release
functions/api/_tests/request-body.test.mjs     20 件
functions/api/_tests/quota-helper.test.mjs     15 件
functions/api/_tests/quota-reserve.test.mjs    35 件
functions/api/_tests/quota-commit.test.mjs     22 件
functions/api/_tests/quota-release.test.mjs    24 件
```

**既存ファイルは 1 つも変更していない。**
`_lib/session.js` / `_lib/origin.js` / `_lib/supabase.js` / `auth/*.js` /
`public/index.html` / migration 4 本はすべて無変更。

### 共通処理順（3 endpoint 共通・`_lib/quota.js` の `preflight()`）

```
1. method 確認        POST 以外 -> 405
2. Origin 検証        失敗 -> 403（body も Cookie も読まない）
3. JSON body 検証     失敗 -> 400 / 413（session も RPC も呼ばない）
4. requireSession()   -> 401 / 500 / 502
5. entitlement 判定   Pro なら RPC を呼ばず免除を返す
6. RPC
7. no-store + Vary: Cookie を付けて返す
```

Origin を最初に見るのは、cross-site から送られたリクエストで
セッションにも DB にも触れさせないため。

### HTTP ステータスの使い分け（この規則で統一した）

| 区分 | 意味 |
|---|---|
| 4xx / 5xx | リクエストが RPC まで到達できなかった、またはサーバー異常 |
| **200** | **RPC が答えた。成否は body の `allowed` / `ok` と `code`** |

`limit_reached` も `not_found` も `release_budget_exceeded` も 200。
RPC は正しく答えているため 4xx にしない。
フロントは `res.ok` ではなく body の `allowed` / `ok` で分岐する。

### エラー分類

| status | error | 発生源 |
|---|---|---|
| 405 | `method_not_allowed` | POST 以外 |
| 403 | `forbidden_origin` | Origin 不一致・欠落（理由は区別しない） |
| 400 | `invalid_content_type` / `malformed_json` / `invalid_body` / `unreadable_body` | body の形 |
| 400 | `invalid_idempotency_key`（reserve）/ `invalid_reservation_id`（commit・release） | body の内容 |
| 413 | `body_too_large` | 1KB 超 |
| 401 | `unauthenticated` | セッション無効（+ Cookie 削除） |
| 500 | `internal_error` | session の data_error / RPC 戻り値が契約と不一致 |
| 500 | `server_misconfigured` | 環境変数の設定漏れ |
| 502 | `database_unavailable` | Supabase へ到達できない / エラー応答 |

`data_error` を 401 に丸めない、`unavailable` を 500 に丸めない、という
既存 API の分類をそのまま踏襲している。RPC の内部エラー本文は返さない。

### entitlement 判定（`hasWebUnlimited`）

```
plan_id ∈ {web_pro, all_pro}  かつ  status ∈ {active, trialing}  -> 無制限
それ以外                                                          -> quota 対象
```

`past_due` は Pro 扱いしない。`extension_pro` は Web では quota 対象。
context が壊れていたら quota 対象（フェイルクローズ）。
上限 3（`FREE_WEEKLY_LIMIT`）の定義箇所は `_lib/quota.js` のみ。

### RPC mapping

| endpoint | RPC | 引数 |
|---|---|---|
| `POST /api/quota/reserve` | `reserve_weekly_usage` | `p_user_id`（session）/ `p_idempotency_key`（body）/ `p_limit`=3（API） |
| `POST /api/quota/commit` | `commit_weekly_usage` | `p_user_id`（session）/ `p_reservation_id`（body） |
| `POST /api/quota/release` | `release_weekly_usage` | `p_user_id`（session）/ `p_reservation_id`（body） |

**`p_user_id` は body から一切受け取らない。** session context の値のみ。
body に `user_id` / `p_user_id` / `p_limit` を混ぜても無視されることを
テストで固定している。

### レスポンス形（quota 対象 / Pro で形をそろえている）

`reserve`:

```json
{ "quota_enforced": true, "allowed": true, "code": "ok", "reused": false,
  "reservation_id": "…", "week_start": "2026-08-31",
  "used": 1, "remaining": 2, "expires_at": "…" }
```

`commit` / `release`:

```json
{ "quota_enforced": true, "ok": true, "code": "ok",
  "state": "committed", "used": 3 }
```

Pro のときは `quota_enforced: false` / `code: 'unlimited'` で、
値はすべて `null`（RPC は呼ばない）。

### STEP 2 の実装判断

1. **`already_settled` は 409 ではなく 200 + `allowed:false`。**
   STEP 1 の handoff では「409 を想定」と書いていたが、
   「RPC が答えた結果は 200」という規則に統一した。
   RPC の code を読み替えないという要求とも整合する。

2. **共通ヘルパーを 2 本にした。**
   `request-body.js`（body の読み取り）と `quota.js`（前処理と entitlement）。
   3 endpoint の差分は「RPC 名・body 検証・レスポンス整形」だけになった。

3. **`idempotency_key` の文字数はコードポイントで数える。**
   JS の `String#length` は UTF-16 単位なので、絵文字を含む鍵で
   PostgreSQL の `length()` と食い違い、API が通した値を DB が弾く。
   制御文字も追加で拒否する（DB の CHECK にはないが安全側）。

4. **401 で Cookie を削除する。** `/api/auth/me` と同じ挙動。
   Origin 検証を通過した後なので、cross-site から強制ログアウトさせられない。

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
| STEP 1 migration | **完了** | 未実施 | 未適用 | — | 20260903015535 を新規作成（866 行・未追跡） |
| STEP 2 API + tests | **完了** | 未実施 | — | — | quota API 3 本 + helper 2 本 + テスト 5 本（未追跡） |
| STEP 3 frontend | **未着手** | — | — | — | 次はここから |
| STEP 4 本番適用・E2E | 未着手 | — | — | — | |

STEP 1 の検証結果:

- `npm test` : 221 / 221 PASS（fail 0 / skipped 0 / todo 0。SQL のみの変更で不変）
- `git diff --check` : 指摘なし（行末空白 0・tab 0・CRLF 0・UTF-8 BOM なし）
- **使い捨て PostgreSQL による適用検証を実施済み（PG 15.18 / 17.11 の両方）**
  - Supabase 相当ロール（anon / authenticated / service_role）を用意したうえで
    既存 3 本 → 20260903015535 の順に `ON_ERROR_STOP=1` で適用し、4 本とも成功
  - schema / 制約 8 件 / index 4 本 / RLS 有効・policy 0 件 / 3 RPC の
    SECURITY INVOKER・search_path・ACL・`consume_weekly_usage` の剥奪を確認
  - smoke test（予約・冪等・上限・commit/release の冪等と ng・
    RELEASE_BUDGET=3・3+3=6 の上界・期限切れ確定・引数検証・権限拒否・
    制約違反・並行 8 本の直列化）をすべて通過
  - **migration 本体の修正は不要だった**（検証のための変更は一切していない）
  - 使い捨てコンテナは検証後に削除済み

STEP 2 の検証結果:

- `npm test` : **337 / 337 PASS**（既存 221 + 新規 116。fail 0 / skipped 0 / todo 0）
- `git diff --check` : 指摘なし
- 全 5 ファイルで `node --check` 相当（Node の ESM ロード）を通過
- 既存 221 件は 1 件も壊れていない（既存ファイルを変更していないため）
- **API から実 DB への疎通は未検証。** RPC はすべてスタブで、
  ネットワークへは出ていない。実際の PostgREST 越しの往復は STEP 4 の E2E で確認する

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

3. **【解決済み】body パースは `_lib/request-body.js` に実装しました。**
   Content-Type 確認・サイズ上限 1KB（Content-Length と実測の二重チェック）・
   `JSON.parse` の try-catch・型検証・`idempotency_key` と UUID の検証を
   まとめています。20 件のテストで固定済み。

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

10. **【解決済み】STEP 1 の SQL は実 PostgreSQL で検証済みです。**
    使い捨てコンテナ（postgres:15-alpine = 15.18 / postgres:17-alpine = 17.11）で
    既存 3 本 → 20260903015535 の順に適用し、両バージョンとも成功しました。
    静的レビューで気にしていた 3 点はいずれも問題なし:
    - `EXTRACT(ISODOW FROM week_start::timestamp) = 1` は
      `timestamp without time zone` に解決され CHECK 制約として受理された
    - `INSERT ... RETURNING quota_reservations.id` のテーブル名修飾は有効
    - `RETURNS TABLE` の出力変数と列名の衝突は発生しない
    残る差異は本番 Supabase 固有の要素（ロールの実属性・PostgREST 経由の挙動）で、
    これはコンテナでは再現ではなく模擬です。

    **本番の PostgreSQL メジャーバージョンは 17 系と推定されます。**
    `20260901044339` が記録した本番 ACL `anon=Dxtm/postgres` の `m` は MAINTAIN で、
    PostgreSQL 17 以降にしか存在しません（PG15 は `arwdDxt` 止まり）。
    PG17 コンテナでは新テーブルの ACL が
    `postgres=arwdDxtm/postgres  service_role=arwdDxtm/postgres` となり、
    本番の記録と同じ形になることを確認しました。

11. **【一部解決】`already_settled` は HTTP 200 + `allowed:false` に確定しました。**
    「RPC が答えた結果は 200」という規則に統一したためです（409 にはしません）。
    **STEP 3 側の挙動は未実装**で、鍵を再生成して再試行する処理を
    `public/index.html` に入れる必要があります。

13. **API から実 DB への疎通が未検証です。**
    STEP 2 のテストは RPC をすべてスタブ化しており、PostgREST 越しに
    `reserve_weekly_usage` などが本当に呼べるかは確認していません。
    引数名（`p_user_id` / `p_idempotency_key` / `p_limit`）の綴り違いや、
    PostgREST が TABLE 戻り値を配列で返すかどうかは STEP 4 の
    safe probe と実 E2E で初めて検証されます。

14. **Pro ユーザーが reserve 後に Free へ落ちた場合、予約は宙に浮きます。**
    Free で reserve → Pro へ昇格 → commit の順になると、commit は
    `quota_enforced:false` を返して RPC を呼ばないため、pending の予約が
    残り TTL 切れで `committed('expired')` になります。
    その週の used を 1 消費しますが、Pro の間は quota 判定を通らないので
    実害はありません（受容済み）。

12. **`quota_reservations` の FK 先を `weekly_usage` にしたため、
    `weekly_usage` の行は予約が残っている限り削除できません。**
    掃除 Cron を作る際は `quota_reservations` → `weekly_usage` の順に消すか、
    CASCADE 任せにすること（項目 5 と合わせて設計する）。

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

*最終更新: STEP 2 完了時（CHECKPOINT: STEP 2 完了・quota API 実装済み・DB 未適用・未 commit）*
*正式な参照先: リポジトリルートの `HANDOFF_QUOTA_RESERVATION.md`*

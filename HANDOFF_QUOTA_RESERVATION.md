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

STEP 3 完了後の期待値:

- HEAD = `248240c`（STEP 1 + STEP 2 を含む）
- `public/index.html` と `package.json` が**変更済み・未 commit**
- `tests/frontend/{page-harness,quota-integration}.mjs` が**未追跡で**存在する
- `supabase/` と `functions/` は**無変更**
- `npm test` は 378 / 378 PASS

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
STEP 3 完了（frontend 連携済み・DB 未適用・未 commit）
```

STEP 1 + STEP 2 は commit `248240c` に固定済みです。
その上に **STEP 3 の frontend 変更が未 commit** で載っています。

**DB へは適用していません。push もしていません。**
`public/index.html` は quota API を呼ぶようになりましたが、
**本番 DB に quota_reservations が無いため、この状態を deploy すると
Free ユーザーは検索できなくなります**（reserve が 502 を返し、
フロントは fail closed で検索を止める）。STEP 4 の適用順序を必ず守ってください。

---

## Workspace

```
C:\Users\tetsu\perfact
```

正式な作業元はこのディレクトリのみです。
`G:\マイドライブ\バイブコーディング\perfact` を作業元として push してはいけません。

---

## Git

記録時点（STEP 3 完了時の実測値）:

```
HEAD        = 248240ccf53ec04ab743968ecec375bb457f84ae
origin/main = 35ebdd7d0070aecc76c309c4b7e1fe750b0025f2
ahead 1 / behind 0
変更 3 件 / 未追跡 2 件:
   M HANDOFF_QUOTA_RESERVATION.md
   M package.json
   M public/index.html
  ?? tests/frontend/page-harness.mjs
  ?? tests/frontend/quota-integration.test.mjs
tests: 378 / 378 PASS（backend 337 + frontend 41。fail 0 / skipped 0 / todo 0）

直近のコミット:
  248240c  feat: add quota reservation backend   ← STEP 1 + STEP 2（未 push）
  35ebdd7  docs: add quota reservation handoff
  4549867  fix: validate origin for session logout
```

`supabase/` と `functions/` は STEP 3 で 1 文字も変更していない。
migration の SHA256 は `9db79117…4fe9df4d` のまま。

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

# STEP 4 から開始

**本番反映順序（この順を守ること）**

```
① Supabase migration 適用
② migration 確認（table / 3 RPC / 権限）
③ git push origin main
④ Cloudflare deploy 確認（source commit の一致・status success）
⑤ safe probe（Origin ヘッダ必須）
⑥ 実 E2E
```

**順序を逆にすると Free ユーザーが検索できなくなります。**
STEP 3 でフロントは reserve を必ず通すようになったため、
DB に `quota_reservations` が無い状態でコードだけ出すと reserve が
502 を返し、フロントは fail closed で検索を止めます。
quota は消費されず既存データも壊れませんが、その間 Free は使えません。

STEP 4 の前にやること:

- STEP 3 の変更（`public/index.html` / `package.json` / `tests/frontend/`）を commit する
- migration 適用手順を確定する（`supabase db push` か SQL Editor か。未解決事項 2）

---

## STEP 3 の成果物（完了・未 commit）

### 変更ファイル

```
public/index.html          +256 / -6   quota 連携と検索成否判定
package.json               +1 / -1     npm test に frontend テストを追加
tests/frontend/page-harness.mjs         （新規）inline script を vm で読むハーネス
tests/frontend/quota-integration.test.mjs（新規）41 件
```

`supabase/` と `functions/` は無変更。

### 検索フロー（quota を消費する入口は 2 つだけ）

```
startSearch() / goToNextWeek()
        │
        ▼
  runGuardedSearch()
        │
        ├─ reserveQuota()            新しい idempotency_key を生成して POST
        │     ├─ proceed=false ─────▶ Calendar API を呼ばずに終了（理由を表示）
        │     └─ proceed=true
        ▼
    fetchAndCalc()  →  { success, authExpired }
        │
        ├─ success=true  かつ 予約あり ─▶ commitQuota()   （best effort）
        └─ success=false かつ 予約あり ─▶ releaseQuota()  （best effort）
```

`quota_enforced=false`（Pro）のときは `reservation_id` が null になるため
commit / release は呼ばれない。

### fetchAndCalc() の成功判定

```js
let calendarOk = false;          // events API で 2xx を 1 件でも受けたか
let calendarAuthExpired = false; // events API で 401 を受けたか（最優先）
```

- **events API の結果だけ**を見る。`calendarList` の成否は含めない
- 401 を受けたら即座に `{ success: false, authExpired: true }`
  （他のカレンダーが 2xx でも成功にしない）
- 1 件も 2xx が無ければ `{ success: false, authExpired: false }` を返し、
  **結果を描画せず `calendarFetchFailed` を表示する**
  （従来は allEvents が空のまま「終日空き」として完走していた）

### i18n に追加したキー

| key | ja | en |
|---|---|---|
| `quotaLimitReached` | 今週の無料検索回数（3回）を使い切りました。 | You have used all 3 free searches for this week. |
| `quotaRetry` | 検索を開始できませんでした。もう一度お試しください。 | Could not start the search. Please try again. |
| `quotaError` | 検索を開始できませんでした。時間をおいてお試しください。 | Could not start the search. Please try again later. |
| `calendarFetchFailed` | カレンダーを取得できませんでした。時間をおいてお試しください。 | Could not load your calendar. Please try again later. |

`already_settled` は `quotaRetry`（再試行可能）で、`limit_reached` とは
別の文言にしている。

### 二重実行防止

- `startSearch()` の冒頭に `if (isSearching || isAnimating) return;` を追加
- `accessToken` がある経路で `isSearching = true` にしてから
  `runGuardedSearch()` を呼び、`finally` で解除して
  検索ボタンも必ず戻す（quota で止めた場合は `fetchAndCalc()` の
  `finally` へ到達しないため）
- `goToNextWeek()` は既存の `isSearching` ガードをそのまま使う

ガードから `isSearching = true` までの間に `await` が無いため、
同期的な再入は必ず弾かれる（テストで固定済み）。

### frontend テストの方式（新規に用意した）

既存のテストは backend だけで、frontend の仕組みは無かった。
`public/index.html` を分割する大改修は避け、
**inline script を切り出して `vm` で実行するハーネス**を作った。

- `tests/frontend/page-harness.mjs` が index.html を読み、
  最小限の DOM / storage / fetch スタブを与えて inline script を評価する
- テストは `startSearch()` などを直接呼び、fetch の呼び出し記録と
  要素スタブの `textContent` で検証する
- **index.html は読むだけで、テストのための改変はしていない**
- `npm test` に `tests/frontend/*.test.mjs` を追加した

vm コンテキストは別レルムなので、戻り値の比較に
`deepStrictEqual` は使えない（フィールドごとに比較すること）。

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
| STEP 1 migration | **完了** | `248240c` | 未適用 | — | 20260903015535 を新規作成（866 行） |
| STEP 2 API + tests | **完了** | `248240c` | — | — | quota API 3 本 + helper 2 本 + テスト 5 本 |
| STEP 3 frontend | **完了** | 未実施 | — | — | index.html + frontend テスト 41 件（未 commit） |
| STEP 4 本番適用・E2E | **未着手** | — | — | — | 次はここから |

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

STEP 3 の検証結果:

- `npm test` : **378 / 378 PASS**（backend 337 + frontend 41。fail 0 / skipped 0 / todo 0）
- `git diff --check` : 指摘なし
- inline script の構文チェック（切り出して `node --check`）: OK
- `supabase/` と `functions/` は無変更（migration の SHA256 も一致）
- **ブラウザでの実 E2E は未実施。** テストは vm 上の DOM スタブであり、
  実際の Google 認可ポップアップ・レイアウト・スワイプ操作は再現していない

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

9. **【解決済み】`fetchAndCalc` の失敗握りつぶしを修正しました。**
   events API が 1 件も 2xx を返さなかった場合、結果を描画せず
   `calendarFetchFailed` を表示するようにしました。
   これにより「API 全滅でも終日空きと表示される」既存の UX 問題も解消しています。

15. **frontend テストは vm 上の DOM スタブです。**
    実ブラウザでの動作（Google 認可ポップアップ、レイアウト、スワイプ、
    PWA の Service Worker）は再現していません。STEP 4 の実 E2E で
    初めて確認されます。特に確認したいもの:
    - Free で 3 回検索したあと 4 回目に上限表示が出るか
    - 検索失敗時に返却され、回数が戻るか
    - Calendar の再認可フローが従来どおり動くか
    - Pro（web_pro / all_pro）で quota 表示が一切出ないか

16. **`package.json` の test スクリプトを変更しました。**
    `node --test functions/api/_tests/*.test.mjs tests/frontend/*.test.mjs`
    frontend テストを追加したためです。CI は未設定なので影響はありません。

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

11. **【解決済み】`already_settled` は HTTP 200 + `allowed:false` に確定し、フロントも対応しました。**
    「RPC が答えた結果は 200」という規則に統一したためです（409 にはしません）。
    フロントは `quotaRetry`（再試行可能なエラー）として表示し、
    次の検索試行では新しい鍵を生成するため自然に回復します。
    自動リトライは入れていません（利用者の操作で再試行する）。

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

*最終更新: STEP 3 完了時（CHECKPOINT: STEP 3 完了・frontend 連携済み・DB 未適用・未 commit）*
*正式な参照先: リポジトリルートの `HANDOFF_QUOTA_RESERVATION.md`*

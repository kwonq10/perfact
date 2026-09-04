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

STEP 5A 完了後の期待値:

- HEAD = origin/main = `2d9d09b69ecbdcd91331b9076b3b1c0c92188421`
- ahead 0 / behind 0
- working tree clean（本ファイルの更新分を除く）
- `supabase/migrations/` に 4 本、うち `20260903015535` は**本番適用済み**
- `functions/api/quota/{reserve,commit,release}.js` が存在する
- `tests/frontend/` が存在する
- `npm test` は 378 / 378 PASS
- `quota_reservations` は **cleanup 未実施**（8 週より古い行が 0 件のため。「STEP 5 の実績」節を参照）

remote の migration 状態も確認する:

```bash
npx supabase migration list --linked
```

4 本すべて local と remote が一致していれば正常。

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
STEP 4 完了（本番稼働中）+ STEP 5A 完了（cleanup は設計確定・実装保留）
```

**quota reservation は本番で稼働しています。**

- migration `20260903015535` は **本番 DB へ適用済み**（SQL Editor 最終確認 22/22 PASS）
- STEP 1〜3 のコードは **main へ push 済み**（HEAD = origin/main = `2d9d09b`）
- Cloudflare production deployment `2372a229` が **source commit `2d9d09b`** で稼働
- production E2E **PASS**（Free で成功 3 回 → 4 回目は `limit_reached`）
- cleanup 方針は **STEP 5A で確定。ただし実装は保留**（削除対象が 0 件のため）
- **pg_cron は有効化していない。cron migration も作っていない**

**この時点で Free ユーザーは週 3 回の制限を受けています。**
以降の作業で quota / session / Calendar 周辺に触れる場合、
**実利用者に影響が出る可能性がある**ことを前提にしてください。

残っている作業は運用課題のみです（未解決事項を参照）。
cleanup（STEP 5）は設計だけ確定し、実装は保留しています。

---

## Workspace

```
C:\Users\tetsu\perfact
```

正式な作業元はこのディレクトリのみです。
`G:\マイドライブ\バイブコーディング\perfact` を作業元として push してはいけません。

---

## Git

記録時点（STEP 5A 完了時の実測値）:

```
HEAD        = 2d9d09b69ecbdcd91331b9076b3b1c0c92188421
origin/main = 2d9d09b69ecbdcd91331b9076b3b1c0c92188421
ahead 0 / behind 0
working tree clean（本ファイルの更新分を除く）
tests: 378 / 378 PASS（backend 337 + frontend 41。fail 0 / skipped 0 / todo 0）

直近のコミット（すべて push 済み）:
  2d9d09b  docs: finalize quota reservation handoff            ← STEP 4 の記録
  db5a453  feat: integrate quota reservation into web search   ← STEP 3
  248240c  feat: add quota reservation backend                 ← STEP 1 + STEP 2
  35ebdd7  docs: add quota reservation handoff
```

STEP 5A ではコードを一切変更していないため、HEAD は `2d9d09b` から動いていません。
本ファイルの更新を commit すると、HEAD は次の docs コミットへ進みます。

migration の SHA256 は `9db791171114ca97ecd32a92a85dea7209c0979e431a876cf1b177e74fe9df4d`。
STEP 1 の作成時から一度も変更していない（本番適用したのもこのファイル）。

**実測値が異なる場合は、勝手に reset せず、現在値と差分を記録・報告してください。**

---

## Production

```
https://sukimacalendar.com
Cloudflare Pages project : sukima-web
production branch        : main
```

- **main への push は本番自動 deploy になります。**
- `www.sukimacalendar.com` は Cloudflare Redirect Rule で apex へ **308**（Single Redirect / `http.host eq` + wildcard / preserve query string）。STEP 4B の probe で 308・クエリ保持ともに無傷を確認済み。
- 記録時点の本番 deployment:

```
Deployment ID : 2372a229-3ee7-480e-8f24-890b687873a8
Environment   : Production
Branch        : main
Source commit : 2d9d09b
Preview URL   : https://2372a229.sukima-web-8ws.pages.dev
```

  1 つ前は `4ac2338e`（source `db5a453`）、その前は `c0ce3e26`（source `35ebdd7`）。

- deploy の成否は `wrangler pages deployment list` では success/failure ラベルが出ないため、
  **実配信内容で判定した**（`/` が新コードを返し、`/api/quota/*` が仕様どおり応答する）。

---

## Supabase

```
project : sukima-billing
ref     : lnqblfckupbjvlafhbmt
region  : Tokyo / ap-northeast-1
```

適用済み migration（**4 本すべて本番反映済み**）:

- `20260901022938_billing_schema.sql`
- `20260901041257_session_schema.sql`
- `20260901044339_revoke_anon_table_privileges.sql`
- `20260903015535_quota_reservation_schema.sql` ← **STEP 4A で適用**

RPC: `upsert_user_and_create_session` / `get_session_context` / `delete_session` /
`jst_week_start` / `set_updated_at` /
**`reserve_weekly_usage` / `commit_weekly_usage` / `release_weekly_usage`**（STEP 4A で追加）/
`consume_weekly_usage`（**非推奨。service_role からも EXECUTE 不可。定義のみ残存**）

権限方針: 全テーブル RLS 有効・policy 0 件。anon / authenticated に直接権限なし。**service_role のみが server-side から利用**します。

PostgreSQL バージョン: **17.6.1.166**（`supabase/.temp/postgres-version` の実測）。
STEP 1 の推定どおり PG17 系だった。検証は PG 15.18 と 17.11 の両方で通してある。

### STEP 4A の適用と確認

適用方法: `npx supabase db push --linked --skip-vault`
（事前に `--dry-run` で対象 1 本・seed 0・role 0 を確認）

適用後の確認は 2 経路で行った。

1. **CLI**（`gen types` / `inspect db index-stats` / `inspect db table-stats`）
   - テーブル 9 列、index 4 本、3 RPC のシグネチャ（`p_limit` が省略可）を実物で確認
2. **SQL Editor の読み取り専用クエリ 22 項目 → 22/22 PASS**
   - constraint 8 件、RLS 有効・policy 0、anon/authenticated の権限ゼロ、
     service_role の CRUD、3 RPC の SECURITY INVOKER / search_path /
     EXECUTE 権限、`consume_weekly_usage` の service_role EXECUTE 不可、
     COMMENT 2 種

**`supabase db dump` と `db diff` は使えない。** 保存済みの pooler 認証情報が
`EAUTHQUERY`、CLI の一時ログインロールが `password authentication failed` で失敗する。
`migration list` / `db push` / `gen types` / `inspect db` は別経路のため動く。
schema の詳細確認が必要なときは **SQL Editor を使うこと**（再試行しても直らない）。

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

### DB 実装の設計判断（変更しないこと）

これらは STEP 1 で確定し、本番へ適用済みです。理由ごと残します。

- **直列化は `weekly_usage(user_id, week_start)` 行の `FOR UPDATE`**
  `users` 行はロックしない。ログイン処理 `upsert_user_and_create_session` が
  `users` を更新するため、`users` を挟むとログインとデッドロックし得る。
- **ロック順は常に `weekly_usage → quota_reservations` の一方向**
  さらに 1 回の RPC が触る行は必ず単一の `(user_id, week_start)` に閉じる。
- **冪等キーの UNIQUE は `(user_id, week_start, idempotency_key)`（週スコープ）**
  グローバル一意だと他人が鍵を先占できる。さらに週を含めないと reserve が
  別の週の予約行をロックし得るため、`weekly_usage(W1) → QR(W2)` と
  `weekly_usage(W2) → QR(W1)` の循環待ちが週境界の同時実行で理論上成立する。
  週を鍵に含めることで循環が構造的に消える。
  帰結: **週を跨いだ同じ鍵の再送は「別の週の新しい予約」になる。**
- **`weekly_usage.search_count` は派生キャッシュ**（権威ではない）
  同一トランザクション内で `COUNT(*)` の導出値へ追随させるだけ。
  **この値を読んで上限判定してはいけない。** COMMENT にも明記済み。
- **`quota_reservations` の FK は `users` ではなく `weekly_usage(user_id, week_start)`**
  users 行を触らないというロック順の要求を、参照整合性の側でも守るため。
  削除は users → weekly_usage → quota_reservations と CASCADE で伝播する。
- **全 RPC は `SECURITY INVOKER` + `SET search_path = public, pg_temp` +
  service_role のみ EXECUTE**（既存規約）
- **列参照は `weekly_usage.` / `quota_reservations.` で修飾する**
  戻り値の列名と PL/pgSQL 変数が衝突して "column reference is ambiguous" に
  なるのを避けるため（既存 RPC と同じ理由）。
- **`reserve` は lazy reclaim を内包**
  同一 user/week の期限切れ pending のみ `committed('expired')` へ確定する。
  used は変わらない（pending も committed も used に数えるため）。
- **予約行に `week_start` を持たせる**
  週境界を跨いだ commit / release が「予約した週」を対象にできるようにするため。
- **`reserve` の 3 番目の引数は `p_limit`（TTL ではない）**
  TTL 120 秒は関数内の CONSTANT。呼び出し側から指定できない。
- **`consume_weekly_usage` は定義を残したまま EXECUTE を全剥奪**
  加算方式の旧 RPC。service_role からも実行できない。

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

## 実装の全体像（4 STEP・すべて完了）

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

# STEP 4 まで完了。本番稼働中。STEP 5A まで完了。

**quota reservation 本体の実装は完了しています。**
次のセッションで STEP 1〜4 をやり直さないでください。
**cleanup（STEP 5）も方針は確定済みです。STEP 5A をやり直さないでください。**

残っているのは運用課題だけです（詳細は「未解決事項」）。

- 古い `quota_reservations` 行の掃除（項目 5・12）
  → **方針確定・実装保留。** STEP 5A の本番実測で cleanup 対象 0 件。
    着手条件は「8 週より古い行が発生した時点」（「STEP 5 の実績」節を参照）
- 拡張機能の配線（項目 8）← **次フェーズの第一候補**
- `goToNextWeek` の production 実機確認（項目 17）
- Calendar 401 経路の production 実機確認（項目 18）

**本番に触れる作業は、実利用者に影響が出ることを前提に進めてください。**

### 本番反映順序（今後 migration を足すときも同じ）

```
① Supabase migration 適用
② migration 確認（SQL Editor の読み取り専用クエリ）
③ git push origin main
④ Cloudflare deploy 確認（source commit の一致）
⑤ safe probe（Origin ヘッダ必須）
⑥ 実 E2E
```

順序を逆にすると Free ユーザーが検索できなくなります。
フロントは reserve を必ず通すため、DB 側が未整備のままコードだけ出すと
reserve が 502 を返し、fail closed で検索が止まります。

---

## STEP 4 の実績（完了）

### STEP 4A — 本番 migration 適用

- `npx supabase db push --linked --skip-vault` で `20260903015535` を適用（exit 0）
- `migration list` で 4 本すべて local = remote を確認
- SQL Editor の読み取り専用クエリ **22/22 PASS**
- 適用時点で `quota_reservations` は 0 行。既存ユーザーデータに変更なし

### STEP 4B — push と deploy

- `git push origin main`（fast-forward。`35ebdd7..db5a453`）
- HEAD = origin/main = `db5a453` / ahead 0 / behind 0
- Cloudflare production deployment `4ac2338e-dea7-4593-8bbd-532bdddb0ca4`（source `db5a453`）
- 本番 `/` が新コードを配信（`runGuardedSearch` などが存在。旧経路は 0 箇所）

**safe probe（すべて PASS・予約は 1 件も作られていない）**

| probe | 結果 |
|---|---|
| `GET /` | 200 |
| `GET /api/auth/me`（Cookie なし） | 401 |
| `POST /api/quota/reserve` 正規 Origin・正しい body・セッションなし | 401 `unauthenticated` |
| evil Origin / Origin なし | 403 `forbidden_origin` |
| malformed JSON | 400 `malformed_json` |
| Content-Type 違い | 400 `invalid_content_type` |
| 鍵が短い | 400 `invalid_idempotency_key` |
| body が配列 | 400 `invalid_body` |
| commit / release に不正 UUID | 400 `invalid_reservation_id` |
| `GET /api/quota/reserve` | 405 `method_not_allowed` |

全 quota レスポンスで `Cache-Control: no-store` と `Vary: Cookie` を確認。
5xx は 1 件も出ていない。レスポンスに secret / cookie / user_id の漏洩なし。
処理順（Origin → body → session）が本番で実証された。

### STEP 4C — production E2E（PASS）

plan `free` / status `active`（= quota 対象）で実施。

| 手順 | 結果 |
|---|---|
| 実ログイン | `/api/auth/me` 200 |
| Calendar 認可 | events API が 2 カレンダー分呼べる状態 |
| 成功検索 #1 | reserve 200 → events 200×2 → **commit 200** / release 0 |
| 非 401 の Calendar 失敗 | events のみ遮断 → **release 200** / commit 0 |
| 成功検索 #2 | reserve 200 → events 200×2 → **commit 200** |
| 成功検索 #3 | reserve 200 → events 200×2 → **commit 200** |
| 4 回目相当 | reserve 200 + **`limit_reached`** / **events API 0 回** / commit・release 0 |
| reload | quota API **0 回**（追加消費なし） |
| logout | `/api/auth/me` 401 |
| logout 後 reload | 401 / body は `{authenticated}` のみ |

**E2E 後の DB 実測**

```
quota_reservations : 4 行（committed 3 + released 1）
weekly_usage       : 1 行
sessions           : 0 行（logout がサーバー側セッションを削除した証拠）
users / subscriptions : 変化なし
```

**実 quota 消費は 3 回。** 失敗検索 1 回は released となり used に数えられていない。
`used = 3` / `remaining = 0` は
「4 回目に上限メッセージが出たこと」と「committed 3 + released 1 の行構成」から確認したもので、
**API レスポンス本文として直接取得したわけではない**（下記の制約による）。

### STEP 4C の検証で使った手法と、その限界

- **失敗注入**: DevTools の Request Blocking は使えないため、ページ内で
  `window.fetch` を一時的に差し替え、URL に `/calendars/` と `/events?` の
  両方を含むリクエストだけを `TypeError('Failed to fetch')` で失敗させた。
  `calendarList` と `/api/quota/*` は素通し。401 は人工的に発生させていない。
  復元は `try/finally` で保証し、復元後に native 関数であることを検証した。
- **screenshot は最後まで取得できなかった**（`viewport 0x0` /
  `Page.captureScreenshot` の CDP タイムアウト）。そのため画面クリックではなく
  ページ内の `startSearch()` を直接呼んだ。ボタンの `onclick` が呼ぶ関数と同一だが、
  **ボタンの見た目の状態変化・スワイプ操作は視覚的に未確認**。
- **レスポンス本文は読めない**。`read_network_requests` はステータスコードのみを返す。
  本文を読むには観測用に `fetch` を差し替える必要があり、承認範囲外なので行っていない。

---

## STEP 5 の実績（5A 完了・5B〜5F 保留）

**cleanup phase は「設計確定・実装保留」です。**
STEP 5A の本番実測で削除対象が 0 件だったため、機構はまだ作っていません。
次のセッションで STEP 5A をやり直さないでください。

### 確定した cleanup 方針（製品判断として確定済み。再検討しないこと）

| 項目 | 確定内容 |
|---|---|
| 保持期間 | **8 週間** |
| 削除対象 | **`quota_reservations` のみ** |
| `weekly_usage` | **削除しない**（過去週の `search_count` を利用実績として残す） |
| 判定基準 | **`week_start` のみ**。`state` では選別しない |
| 削除述語 | `week_start < (public.jst_week_start() - (8 * 7))` ← **DB 側で算出** |
| 削除方法 | **`quota_reservations` 単独の DELETE**（親 `weekly_usage` に触れない） |
| 実行方式 | 当面 **Supabase SQL Editor で手動**。**pg_cron は未導入** |
| cron migration | **作らない**（行数が育ってから再検討） |

週の基準は必ず `public.jst_week_start()` を使い、クライアントの時計は使いません
（既存 RPC と同じ規律）。

### なぜ `state` で選別してはいけないか

**現在週は `state` を問わず全行を残す**のが唯一の安全な規則です。
`state` で分岐すると、次の 3 つのいずれかを踏みます。

1. **used の返金** — used は行数から導出されるため、現在週の `pending` /
   `committed` を 1 行消すと、その利用者は即座に 1 回分検索できるようになる
2. **release budget の復活** — `release` は同一週の `state='released'` を COUNT して
   予算判定する。現在週の `released` を消すと返金枠が復活し、`3 + 3 = 6` の上界が
   壊れる（無限返金の入口）
3. **idempotency replay の破壊** — UNIQUE は `(user_id, week_start, idempotency_key)`。
   確定済みの行を消すと同じ鍵が再利用可能になり、本来 `already_settled` を返すべき
   再送が**新しい予約の発行**に化ける

`week_start` だけで判定すれば、この 3 つは構造的に発生しません。

### lazy reclaim と cleanup の関係（STEP 5A の監査で判明）

`reserve` の Step 3（lazy reclaim）は **`v_week_start`（現在週）に限定**されています。

したがって **過去週の期限切れ `pending` は永久に回収されません。**
週が変わった瞬間に「誰も触らない孤児 pending」として残り続けます。

- **cleanup は、過去週の孤児 pending を除去できる唯一の機構**です
- ただし `committed('expired')` へ**変換する必要はありません**。過去週の used は
  誰も読まないため、UPDATE は無駄な書き込みとロックを増やすだけです
- **delete-only** とすること

### 週境界の in-flight について

日曜 23:59:59 JST に reserve → 月曜 00:00:01 JST に commit、という経路があります。
`commit` / `release` は予約行の `week_start` を先読みするため、**前週の行が生きている
必要**があります。必要な猶予は TTL（120 秒）+ リクエスト寿命で数分オーダーであり、
8 週保持なら自動的に満たされます。

### `weekly_usage.search_count` との整合（承認済みの仕様）

過去週の `quota_reservations` だけを消すと、その週の `search_count` は
「行が 0 件なのに 3 のまま」という**意図的に stale なキャッシュ**になります。

これは壊れではありません。

- `search_count` は既に COMMENT で「権威ではない / これを読んで上限判定しないこと」と明記済み
- 過去週の `search_count` を読むコードは**存在しない**（3 RPC はすべて自分の週しか触らない）
- 0 へ書き戻すと `weekly_usage` 行をロックする必要が生じ、cleanup が現在週と同じ
  テーブルに触ることになる（避けたい）
- `search_count` は**その週の消費実績を残す唯一の集計レコード**であり、潰すのは監査上の損失

### STEP 5A 本番実測（2026-09-04 / Supabase SQL Editor・読み取り専用）

| 項目 | 実測値 |
|---|---|
| `quota_reservations` 総行数 | **4** |
| committed / released / pending | **3 / 1 / 0** |
| current week（JST 月曜） | **2026-08-31** |
| 過去週の行 | **0** |
| 8 週ルールでの cleanup 対象 | **0** |
| orphan pending（過去週の期限切れ pending） | **0** |
| `weekly_usage` | **1 行** |
| `search_count` と導出 used の不一致（cache drift） | **0** |
| 親 `weekly_usage` を持たない `quota_reservations` | **0** |

STEP 4C の E2E 記録（committed 3 + released 1）と**完全に一致**しています。

**cache drift 0 と親なし 0 は、「used の権威は `quota_reservations` であり、
`search_count` がそれに追随する」という設計の中核が本番で成立していることの
直接的な証拠**です（STEP 4C では行構成からの推定に留まっていました）。

実行した SQL は SELECT のみ。`user_id` / `reservation_id` / `idempotency_key` /
email / token は一切出力していません（すべて集計値と週・state・reason のみ）。

### STEP 5B〜5F（保留中・着手条件つき）

| STEP | 内容 | 状態 |
|---|---|---|
| 5A | 本番実測 | **完了**（上記） |
| 5B | 保持週数・実行方式の確定 | **完了**（上記の表） |
| 5C | migration 作成（cleanup 関数）+ 使い捨て PG コンテナ検証 | **保留** |
| 5D | 本番 migration 適用 | **保留** |
| 5E | cleanup の初回実行 | **保留** |
| 5F | pg_cron スケジュール登録 | **保留** |

**着手条件:** 8 週より古い行が実際に発生した時点、または総行数が数千行を超えた時点。
それまでは SQL Editor から手動で確認・削除できます。

### 保留中に決める必要がある事項

- `cron.schedule` を migration に入れるか SQL Editor で行うか（後者は構成 drift になる）
- pg_cron の有効化には **Dashboard → Database → Extensions での操作**が要る可能性が高い
  （`CREATE EXTENSION` は superuser 権限が必要で、`db push` の一時ログインロールでは
  通らない可能性がある）
- `week_start` を先頭に持つ索引を足すか
  （現状その索引は無く、`week_start` 単独の絞り込みは seq scan になる。
  `CREATE INDEX CONCURRENTLY` は migration のトランザクション内では実行できない）
- `cron.job_run_details` の掃除（pg_cron を入れると**新たな増え続ける表**が生まれる）
- `sessions` の掃除（`20260901041257` にも同一の TODO があり、同じ機構で解決できる）

---

## STEP 3 の成果物（完了・commit `db5a453`）

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
- **本番は稼働中。DB・API・frontend のいずれに触れる場合も実利用者への影響を前提にする**
- **明示指示なしで本番 DB へ migration を適用しない**
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
| STEP 1 migration | **完了** | `248240c` | **適用済み** | — | 20260903015535 を新規作成（866 行） |
| STEP 2 API + tests | **完了** | `248240c` | — | **済** | quota API 3 本 + helper 2 本 + テスト 5 本 |
| STEP 3 frontend | **完了** | `db5a453` | — | **済** | index.html + frontend テスト 41 件 |
| STEP 4 本番適用・E2E | **完了** | （コード変更なし） | **適用済み** | `4ac2338e` | 4A 22/22 PASS / 4B safe probe PASS / 4C E2E PASS |
| STEP 5A cleanup 実測 | **完了** | （コード変更なし） | — | — | 本番実測 PASS。cleanup 対象 0 件のため 5B〜5F は保留 |

**4 STEP すべて完了。quota reservation は本番稼働中。**
**cleanup（STEP 5）は設計確定・実装保留。**

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
  → **STEP 4C で実機 E2E を実施し PASS**（ただし screenshot が取れず視覚確認は未実施）

STEP 4 の検証結果:

- 4A: SQL Editor の読み取り専用クエリ **22/22 PASS**
- 4B: safe probe 12 項目すべて期待どおり。5xx ゼロ。secret 漏洩なし
- 4C: production E2E **PASS**。実 quota 消費 3 回、
  `quota_reservations` は committed 3 + released 1 の 4 行
- `npm test` : **378 / 378 PASS**（STEP 4 でコードは変更していないため不変）

STEP 5A の検証結果:

- Supabase SQL Editor の読み取り専用クエリ（単一 SELECT・集計のみ）で本番を実測
- cleanup 対象 **0 件** / orphan pending **0 件** / cache drift **0 件** / 親なし QR **0 件**
- `npm test` : **378 / 378 PASS**（STEP 5A でコードは変更していないため不変）
- **コード変更・migration 作成・DB 変更なし。読み取りのみ**

---

## 未解決事項

1. **ハンドオフの配置は解決済み。**
   `.gitignore:2` に `docs/` があるため `docs/handoffs/CURRENT.md` は commit されません。
   そのため **ルート直下の本ファイル `HANDOFF_QUOTA_RESERVATION.md` を正式な参照先**とし、
   リポジトリに追跡させています（既存の `HANDOFF_CHROME_EXTENSION.md` と同じ慣習）。
   `docs/handoffs/CURRENT.md` はローカル控えとして残していますが、**内容が食い違った場合は
   本ファイルを正とします。**

2. **【解決済み】migration 適用手順は `supabase db push --linked --skip-vault` で確立しました。**
   事前に `--dry-run` で対象を確認してから適用します。
   ただし **`db dump` と `db diff` は認証エラーで使えません**（pooler 認証情報が
   `EAUTHQUERY`、一時ログインロールが `password authentication failed`）。
   適用後の schema 詳細確認は **SQL Editor の読み取り専用クエリ**を使ってください。
   再試行しても直らないので、時間を使わないこと。

3. **【解決済み】body パースは `_lib/request-body.js` に実装しました。**
   Content-Type 確認・サイズ上限 1KB（Content-Length と実測の二重チェック）・
   `JSON.parse` の try-catch・型検証・`idempotency_key` と UUID の検証を
   まとめています。20 件のテストで固定済み。

4. **並行性と週境界は単体テストで検証できません。**
   Node のテストは RPC の契約（引数・戻り値・呼び出し回数）しか検証できず、行ロックによる直列化と `jst_week_start()` の週境界は Postgres 側の責務です。`pgTAP` は未導入。
   → 使い捨て PG 15.18 / 17.11 コンテナで **並行 8 本の直列化**（異なる鍵で
   ちょうど 3 件 allowed、同一鍵で 1 件作成 + 7 件再利用）は確認済み。
   **本番での並行実行は未検証**（E2E は逐次実行）。

5. **【方針確定・実装保留】`quota_reservations` の行は増え続けます。**
   v1 は lazy reclaim のみで、行の削除は行いません。

   **STEP 5A で cleanup 方針を確定しました**（保持 8 週 / `quota_reservations` 単独
   DELETE / `weekly_usage` は削除しない / `week_start` のみで判定 / pg_cron は未導入で
   当面 SQL Editor 手動）。詳細は「STEP 5 の実績」節を参照。

   **ただし実装は保留です。** STEP 5A の本番実測で 8 週より古い行が **0 件**だったため、
   機構を作っても削除するものがありません。

   行数の上界は **1 ユーザー・1 週あたり最大 6 行**（committed 3 + released 3。
   `RELEASE_BUDGET = 3` がこの上界を保証する）。Pro は RPC を呼ばないため 0 行。

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

15. **【一部解決】frontend テストは vm 上の DOM スタブです。**
    実ブラウザでの動作（レイアウト、スワイプ、PWA の Service Worker）は
    再現していません。STEP 4C の実機 E2E で以下は確認できました。
    - ✅ Free で 3 回検索したあと 4 回目に上限表示が出る
    - ✅ 検索失敗時に release され、回数が戻る（committed 3 + released 1）
    - ❌ Calendar の再認可フローは未確認（下記 18）
    - ❌ Pro（web_pro / all_pro）の挙動は未確認
      （テストアカウントが Free のみのため。frontend テストでは固定済み）

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

13. **【解決済み】API から実 DB への疎通は STEP 4C で検証されました。**
    実 E2E で reserve / commit / release がすべて 200 を返し、
    `quota_reservations` に想定どおりの行（committed 3 + released 1）が
    作られたため、引数名の綴りも PostgREST の TABLE 戻り値の扱いも正しいことが
    確認できています。

14. **Pro ユーザーが reserve 後に Free へ落ちた場合、予約は宙に浮きます。**
    Free で reserve → Pro へ昇格 → commit の順になると、commit は
    `quota_enforced:false` を返して RPC を呼ばないため、pending の予約が
    残り TTL 切れで `committed('expired')` になります。
    その週の used を 1 消費しますが、Pro の間は quota 判定を通らないので
    実害はありません（受容済み）。

12. **【訂正済み】`quota_reservations` の FK 先を `weekly_usage` にしたため、
    `weekly_usage` の行は予約が残っている限り削除できません。**

    ⚠ **旧記述「`quota_reservations` → `weekly_usage` の順に消す」は誤りです。**
    同一トランザクションで子 → 親の順に DELETE すると、確立済みのロック順
    （`weekly_usage` → `quota_reservations`）を**逆行**します。
    RPC が `weekly_usage` を掴んで `quota_reservations` を待つ一方、cleanup が
    `quota_reservations` を掴んで `weekly_usage` を待つ形になり、
    理論上デッドロックします。

    安全なのは次の 2 つだけです。

    - **(a) `quota_reservations` 単独の DELETE**（親に触れない）
      子行の DELETE は FK トリガを起こさず、親行をロックしません。
      ロックが 1 テーブルに閉じるため、ロック順の問題が構造的に発生しません。
    - (b) `weekly_usage` を DELETE して CASCADE に任せる（親 → 子 = 正順）

    **確定方針は (a)。** `weekly_usage` は削除しないため (b) は使いません（項目 5 を参照）。

17. **`goToNextWeek`（翌週検索）は production で未確認です。**
    STEP 4C の 10 手順に含まれていなかったため実機では通していません。
    frontend テストでは以下を固定済み:
    reserve 1 回 / 成功時 commit / 失敗時 release / 上限時は Calendar API 0 回 /
    検索試行ごとに新しい鍵。
    quota を 1 回消費するので、確認するなら週が変わってからのほうが安全です。

18. **Calendar 401（自然発生）の経路は production で未確認です。**
    STEP 4C では「401 を人工的に発生させない」制約のもとで実施したため、
    access token 失効時の
    「release → 既存の再認可フローへ」は実機で通っていません。
    frontend テストでは
    「401 があれば authExpired=true / success=false」
    「1 件 2xx + 1 件 401 でも release して commit しない」
    を固定済みです。

19. **screenshot が取得できない環境でした。**
    `viewport 0x0` と `Page.captureScreenshot` の CDP タイムアウトにより、
    STEP 4C は画面クリックではなくページ内の `startSearch()` を直接呼んで実施しました
    （ボタンの `onclick` が呼ぶ関数と同一）。
    **ボタンの見た目の状態変化・スワイプ操作・レイアウトは視覚的に未確認**です。
    次に実機確認する際は、先に Chrome ウィンドウが前面に表示されていることを
    確かめてください。

20. **quota API のレスポンス本文を実機で読めていません。**
    `read_network_requests` はステータスコードのみを返します。
    `used` / `remaining` の実値は
    「4 回目に上限メッセージが出たこと」と「committed 3 + released 1 の行構成」から
    確認したもので、**API レスポンス本文として直接取得したわけではありません**。
    数値で確定させたい場合は SQL Editor で
    `quota_reservations` を state 別に集計してください。

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

*最終更新: STEP 5A 完了時（CHECKPOINT: STEP 4 完了・本番稼働中 / STEP 5A 完了・cleanup 実装保留）*
*正式な参照先: リポジトリルートの `HANDOFF_QUOTA_RESERVATION.md`*

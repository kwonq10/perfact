# DEPLOYMENT.md

スキマの本番反映の仕組み、誤 deploy を防ぐルール、rollback の方針をまとめます。

---

## 1. 仕組み

| 項目 | 値 |
|---|---|
| Hosting | Cloudflare Pages |
| Project | `sukima-web` |
| Production branch | `main` |
| Build command | なし |
| Build output | `public/` |
| Functions | リポジトリルートの `functions/` を自動検出 |
| Production domains | https://sukimacalendar.com （www は apex へ 308） |

**`main` に push すると、それだけで本番へ自動 deploy されます。**
`main` への push は、すなわち本番リリースです。

- `main` 以外のブランチへの push は preview deploy になります。
  preview には secret が設定されていないため、本番と同じ動作にはなりません。
- `wrangler pages deploy` による手動 deploy は使いません（Git 連携に一本化）。
- Netlify は使っていません（`netlify.toml` は残骸です）。

---

## 2. push 前のチェック（必須）

1. `git status` / `git diff` で変更対象を確認する
2. `npm test` が全件 PASS であること
3. `package.json` / `package-lock.json` に意図しない変更がないこと
4. secrets・`.dev.vars`・個人情報が差分に含まれていないこと
5. AGENTS.md の禁止事項（OAuth Client ID・SCOPES・privacy.html・sw.js など）に触れていないこと
6. migration を含む場合は、本番 DB への適用順序（コードより先か後か）を決めておくこと

---

## 3. 明示承認ルール

- **commit・push・deploy・本番 DB への migration 適用は、いずれもユーザーの明示承認が必要です。**
  AI エージェントは、承認を得るまで実行しません。
- 承認は操作ごとに取ります。過去の承認を次の push に流用しません。
- 承認を求めるときは、push 先ブランチ、コミット一覧（`git log origin/main..HEAD --oneline`）、
  テスト結果を示します。
- 作業は原則として feature ブランチまたは worktree で行い、`main` への反映は fast-forward で行います。

---

## 4. 反映後の確認

- Cloudflare Pages の deployment 一覧で、新しい Production deployment の source commit が push したコミットと一致するか確認する。
- `wrangler pages deployment list` には success/failure の表示が出ないため、**実際に配信されている内容で判定します**
  （トップページが新しいコードを返すか、変更した API が仕様どおり応答するか）。
- 反映した deployment ID と source commit を [PROJECT_STATUS.md](PROJECT_STATUS.md) に記録します。

---

## 5. rollback の基本方針

1. **まず直前の正常な Production deployment に戻す。** Cloudflare Pages の deployment 履歴から
   「Rollback to this deployment」を使います。コードを直すより速く、Git 履歴も変わりません。
   - 戻し先は [PROJECT_STATUS.md](PROJECT_STATUS.md) の「直前の正常 deployment」を参照。
   - Cloudflare の操作は承認制です。
2. その後、Git 側で `git revert` のコミットを作り、承認を得て `main` に push します。
   - `main` で `git reset` / force push はしません。
3. migration を含む変更は、ダッシュボードの rollback では DB が戻りません。
   DB を戻す必要がある場合は、戻し用 migration を別途用意し、承認を得てから適用します。
4. 原因と、戻した deployment ID を記録します。

---

## 6. secrets の管理

- 本番の環境変数は **Cloudflare Pages の secret** として登録し、Git では管理しません。
- 変数名の一覧は [AGENTS.md](AGENTS.md) と `.dev.vars.example` にあります。値はどこにも書きません。
- secret の追加・変更・削除は Cloudflare の操作なので承認制です。
- secret を変更したら、反映のための再 deploy が必要かどうかを確認します。

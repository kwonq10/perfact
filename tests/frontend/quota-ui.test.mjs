// =========================================================
// public/index.html の quota 残数表示 / timezone 同期テスト
//
//   実際の inline script を vm へ読み込み、
//   syncTimezone() / refreshQuotaStatus() / renderQuotaInfo() を直接呼ぶ。
//   fetch はすべてスタブ。ネットワークへは出ない。
//   本番の secret / Cookie 実値は一切扱わない。
// =========================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { brokenJsonResponse, jsonResponse, loadPage, makeFetch } from './page-harness.mjs';

const TZ_URL = '/api/user/timezone';
const STATUS_URL = '/api/quota/status';

function statusBody({ unlimited = false, used = 1, remaining = 2, limit = 3,
                      week_start = '2036-10-06',
                      next_reset_at = '2036-10-13T02:00:00+00:00' } = {}) {
  if (unlimited) {
    return {
      unlimited: true, limit: null, used: null,
      remaining: null, week_start: null, next_reset_at: null,
    };
  }
  return { unlimited: false, limit, used, remaining, week_start, next_reset_at };
}

const asFn = (v, fallback) => (typeof v === 'function' ? v : () => (v === undefined ? fallback() : v));

/**
 * ページを読み込む。
 * authenticated=true なら sukimaAuthenticated を立てた状態にする。
 */
function setup(opts = {}) {
  const tz = asFn(opts.tz, () => jsonResponse(200, { ok: true, display_timezone: 'Asia/Tokyo' }));
  const status = asFn(opts.status, () => jsonResponse(200, statusBody()));

  const fetchImpl = makeFetch([
    [(u) => u.includes(TZ_URL), tz],
    [(u) => u.includes(STATUS_URL), status],
    [(u) => u.includes('/api/auth/me'), () => jsonResponse(401, { authenticated: false })],
  ]);

  const page = loadPage({ fetchImpl });
  if (opts.authenticated !== false) {
    page.run('sukimaAuthenticated = true;');
  }
  if (opts.lang) page.run(`currentLang = ${JSON.stringify(opts.lang)};`);
  return { page, fetchImpl };
}

const tzCalls = (f) => f.calls.filter((c) => c.url.includes(TZ_URL));
const statusCalls = (f) => f.calls.filter((c) => c.url.includes(STATUS_URL));
const quotaEl = (page) => page.el('quotaInfo');

// =========================================================
// 1. 未認証
// =========================================================

test('未認証では timezone も status も呼ばない', async () => {
  const { page, fetchImpl } = setup({ authenticated: false });
  await page.call('syncQuotaContext');
  assert.equal(tzCalls(fetchImpl).length, 0);
  assert.equal(statusCalls(fetchImpl).length, 0);
});

test('未認証では残数 UI を隠す', async () => {
  const { page } = setup({ authenticated: false });
  await page.call('refreshQuotaStatus');
  assert.equal(quotaEl(page).style.display, 'none');
  assert.equal(quotaEl(page).textContent, '');
});

// =========================================================
// 2. timezone 同期
// =========================================================

test('認証後は timezone を POST する', async () => {
  const { page, fetchImpl } = setup();
  await page.call('syncTimezone');
  const calls = tzCalls(fetchImpl);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(typeof body.timezone, 'string');
  assert.ok(body.timezone.length > 0);
  assert.deepEqual(Object.keys(body), ['timezone'], 'timezone 以外を送らない');
});

test('同じ session 内で同じ timezone を繰り返し送らない', async () => {
  const { page, fetchImpl } = setup();
  await page.call('syncTimezone');
  await page.call('syncTimezone');
  await page.call('syncTimezone');
  assert.equal(tzCalls(fetchImpl).length, 1, '2 回目以降は送らない');
});

test('timezone が変わったら再送する', async () => {
  const { page, fetchImpl } = setup();
  await page.call('syncTimezone');
  assert.equal(tzCalls(fetchImpl).length, 1);
  // 送信記録を別の値にすると「変わった」とみなされる
  page.run(`sessionStorage.setItem('sukima_tz_synced', 'America/New_York');`);
  await page.call('syncTimezone');
  assert.equal(tzCalls(fetchImpl).length, 2);
});

test('timezone を取得できなければ送らず、例外にもしない', async () => {
  const { page, fetchImpl } = setup();
  page.run('detectBrowserTimezone = () => null;');
  const sent = await page.call('syncTimezone');
  assert.equal(sent, false);
  assert.equal(tzCalls(fetchImpl).length, 0);
});

test('timezone POST が失敗しても例外にせず、記録も残さない', async () => {
  for (const resp of [() => jsonResponse(502, { error: 'database_unavailable' }),
                      () => { throw new TypeError('network'); }]) {
    const { page, fetchImpl } = setup({ tz: resp });
    const sent = await page.call('syncTimezone');
    assert.equal(sent, false);
    // 記録されていないので次回また送る
    await page.call('syncTimezone');
    assert.equal(tzCalls(fetchImpl).length, 2, '失敗時は再送する');
  }
});

test('timezone POST が失敗しても status 取得は続く', async () => {
  const { page, fetchImpl } = setup({ tz: () => jsonResponse(502, { error: 'x' }) });
  await page.call('syncQuotaContext');
  assert.equal(statusCalls(fetchImpl).length, 1, 'status は呼ばれる');
});

test('timezone 失敗のログに内部詳細を出さない', async () => {
  const { page } = setup({ tz: () => jsonResponse(502, { error: 'secret_detail' }) });
  await page.call('syncTimezone');
  const joined = page.warnings.join('\n');
  assert.equal(joined.includes('secret_detail'), false);
  assert.ok(joined.includes('[timezone]'));
});

// =========================================================
// 3. 残数表示
// =========================================================

test('remaining = 3 / 2 / 1 をそれぞれ表示する', async () => {
  for (const n of [3, 2, 1]) {
    const { page } = setup({ status: () => jsonResponse(200, statusBody({ remaining: n, used: 3 - n })) });
    await page.call('refreshQuotaStatus');
    const el = quotaEl(page);
    assert.notEqual(el.style.display, 'none', 'remaining=' + n);
    assert.equal(el.textContent, '今週あと' + n + '回');
    assert.equal(el.classList.contains('is-exhausted'), false);
  }
});

test('remaining = 0 は使い切り表示へ切り替わる', async () => {
  const { page } = setup({ status: () => jsonResponse(200, statusBody({ remaining: 0, used: 3 })) });
  await page.call('refreshQuotaStatus');
  const el = quotaEl(page);
  assert.notEqual(el.style.display, 'none');
  assert.equal(el.textContent, '今週の無料検索回数を使い切りました');
  assert.equal(el.classList.contains('is-exhausted'), true, '強調表示になる');
});

test('次回リセットは remaining = 0 のときだけ出す', async () => {
  // remaining > 0 では補足行を作らない
  for (const n of [3, 2, 1]) {
    const { page } = setup({ status: () => jsonResponse(200, statusBody({ remaining: n })) });
    await page.call('refreshQuotaStatus');
    assert.equal(quotaEl(page).children.length, 0, 'remaining=' + n + ' で補足行を作らない');
  }
  // remaining = 0 でだけ補足行が付く
  const { page } = setup({ status: () => jsonResponse(200, statusBody({ remaining: 0 })) });
  await page.call('refreshQuotaStatus');
  const sub = quotaEl(page).children[0];
  assert.ok(sub, 'remaining=0 では補足行を作る');
  assert.equal(sub.className, 'quota-sub');
  assert.ok(sub.textContent.includes('Web Proなら検索無制限'));
  assert.ok(sub.textContent.includes('次回リセット:'));
});

test('next_reset_at を再計算せず、その瞬間をブラウザ locale で整形する', async () => {
  const iso = '2036-10-14T02:00:00+00:00';   // 月曜 00:00 ではない時刻
  const { page } = setup({
    status: () => jsonResponse(200, statusBody({ remaining: 0, next_reset_at: iso })),
  });
  await page.call('refreshQuotaStatus');
  const expected = new Date(iso).toLocaleString('ja-JP', {
    month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  const sub = quotaEl(page).children[0];
  assert.ok(sub.textContent.includes(expected),
    '期待: ' + expected + ' / 実際: ' + sub.textContent);
  // 月曜へ丸めたり +7 日したりしていないこと
  assert.equal(page.call('formatNextReset', iso), expected);
});

test('next_reset_at が壊れていても落ちず、補足は Pro 訴求だけになる', async () => {
  const { page } = setup({
    status: () => jsonResponse(200, statusBody({ remaining: 0, next_reset_at: 'not-a-date' })),
  });
  await page.call('refreshQuotaStatus');
  const sub = quotaEl(page).children[0];
  assert.equal(sub.textContent, 'Web Proなら検索無制限');
  assert.equal(page.call('formatNextReset', 'not-a-date'), null);
});

// =========================================================
// 4. Pro / 障害時
// =========================================================

test('unlimited = true なら残数 UI を出さない', async () => {
  const { page } = setup({ status: () => jsonResponse(200, statusBody({ unlimited: true })) });
  await page.call('refreshQuotaStatus');
  assert.equal(quotaEl(page).style.display, 'none');
  assert.equal(quotaEl(page).textContent, '');
});

test('status 取得失敗では 0 回扱いにも Pro 扱いにもせず、表示を隠す', async () => {
  const cases = [
    () => jsonResponse(500, { error: 'internal_error' }),
    () => jsonResponse(502, { error: 'database_unavailable' }),
    () => brokenJsonResponse(200),
    () => { throw new TypeError('network'); },
    () => jsonResponse(200, { unlimited: 'yes' }),
    () => jsonResponse(200, { unlimited: false, remaining: '2' }),
    () => jsonResponse(200, { unlimited: false, remaining: -1, used: 0, limit: 3,
                              week_start: 'x', next_reset_at: 'y' }),
  ];
  for (const status of cases) {
    const { page } = setup({ status });
    // まず一度成功させて表示を出す
    page.run('quotaStatus = { unlimited: false, limit: 3, used: 1, remaining: 2, week_start: "x", next_reset_at: "y" };');
    page.call('renderQuotaInfo');
    assert.notEqual(quotaEl(page).style.display, 'none');

    const out = await page.call('refreshQuotaStatus');
    assert.equal(out, null);
    assert.equal(page.run('quotaStatus'), null, '不明なら null に倒す');
    assert.equal(quotaEl(page).style.display, 'none', '表示を隠す');
  }
});

test('status が 401 ならログイン状態を落として UI を隠す', async () => {
  const { page } = setup({ status: () => jsonResponse(401, { error: 'unauthenticated' }) });
  await page.call('refreshQuotaStatus');
  assert.equal(page.run('sukimaAuthenticated'), false);
  assert.equal(page.run('quotaStatus'), null);
  assert.equal(quotaEl(page).style.display, 'none');
});

// =========================================================
// 5. ログイン / ログアウト
// =========================================================

test('syncQuotaContext は timezone -> status の順で同期する', async () => {
  const { page, fetchImpl } = setup();
  await page.call('syncQuotaContext');
  const order = fetchImpl.calls
    .filter((c) => c.url.includes(TZ_URL) || c.url.includes(STATUS_URL))
    .map((c) => (c.url.includes(TZ_URL) ? 'tz' : 'status'));
  assert.deepEqual(order, ['tz', 'status']);
});

test('logout で残数 UI と timezone 送信記録を捨てる', async () => {
  const { page, fetchImpl } = setup();
  await page.call('syncQuotaContext');
  assert.notEqual(quotaEl(page).style.display, 'none');
  assert.equal(page.run(`sessionStorage.getItem('sukima_tz_synced')`) !== null, true);

  // logout 本体は他の副作用が多いので、状態のクリア部分だけを検証する。
  page.run('sukimaAuthenticated = false; quotaStatus = null;');
  page.call('clearTimezoneSyncMark');
  page.call('renderQuotaInfo');

  assert.equal(page.run('quotaStatus'), null);
  assert.equal(page.run(`sessionStorage.getItem('sukima_tz_synced')`), null,
    '別アカウントで必ず送り直させる');
  assert.equal(quotaEl(page).style.display, 'none');
});

test('別アカウントへ切り替えた後は timezone を送り直す', async () => {
  const { page, fetchImpl } = setup();
  await page.call('syncTimezone');
  assert.equal(tzCalls(fetchImpl).length, 1);

  // logout 相当
  page.call('clearTimezoneSyncMark');
  // 別アカウントでログイン相当
  await page.call('syncTimezone');
  assert.equal(tzCalls(fetchImpl).length, 2, '記録が消えているので再送する');
});

// =========================================================
// 6. i18n
// =========================================================

test('ja の文言', async () => {
  const { page } = setup({ lang: 'ja' });
  assert.equal(page.call('t', 'quotaRemaining', 3), '今週あと3回');
  assert.equal(page.call('t', 'quotaRemaining', 1), '今週あと1回');
  assert.equal(page.call('t', 'quotaExhausted'), '今週の無料検索回数を使い切りました');
  assert.equal(page.call('t', 'quotaProPitch'), 'Web Proなら検索無制限');
  assert.equal(page.call('t', 'quotaNextReset', '9月15日 2:00'), '次回リセット: 9月15日 2:00');
});

test('en の文言（単数 / 複数を出し分ける）', async () => {
  const { page } = setup({ lang: 'en' });
  assert.equal(page.call('t', 'quotaRemaining', 3), '3 free searches left this week');
  assert.equal(page.call('t', 'quotaRemaining', 2), '2 free searches left this week');
  assert.equal(page.call('t', 'quotaRemaining', 1), '1 free search left this week');
  assert.equal(page.call('t', 'quotaExhausted'), "You've used all your free searches this week");
  assert.equal(page.call('t', 'quotaProPitch'), 'Unlimited searches with Web Pro');
  assert.equal(page.call('t', 'quotaNextReset', 'Sep 15, 2:00 AM'), 'Resets: Sep 15, 2:00 AM');
});

test('en モードでも remaining = 0 の表示が組み立つ', async () => {
  const { page } = setup({
    lang: 'en',
    status: () => jsonResponse(200, statusBody({ remaining: 0, used: 3 })),
  });
  await page.call('refreshQuotaStatus');
  const el = quotaEl(page);
  assert.equal(el.textContent, "You've used all your free searches this week");
  assert.ok(el.children[0].textContent.includes('Unlimited searches with Web Pro'));
  assert.ok(el.children[0].textContent.includes('Resets:'));
});

test('言語を切り替えると表示し直される（数値は再計算しない）', async () => {
  const { page } = setup({ status: () => jsonResponse(200, statusBody({ remaining: 2 })) });
  await page.call('refreshQuotaStatus');
  assert.equal(quotaEl(page).textContent, '今週あと2回');

  page.run(`currentLang = 'en';`);
  page.call('renderQuotaInfo');
  assert.equal(quotaEl(page).textContent, '2 free searches left this week');
  // quotaStatus は書き換わっていない
  assert.equal(page.run('quotaStatus.remaining'), 2);
});

// =========================================================
// 7. client 側で残数を計算しないこと
// =========================================================

test('remaining はサーバーの値をそのまま使い、加減算しない', async () => {
  const { page } = setup({ status: () => jsonResponse(200, statusBody({ remaining: 2, used: 1 })) });
  await page.call('refreshQuotaStatus');
  assert.equal(page.run('quotaStatus.remaining'), 2);
  assert.equal(page.run('quotaStatus.used'), 1);

  // サーバーが 0 を返せばそのまま 0 になる（client が 1 を引いた結果ではない）
  page.run('quotaStatus = { unlimited: false, limit: 3, used: 3, remaining: 0, week_start: "w", next_reset_at: "2036-10-13T02:00:00+00:00" };');
  page.call('renderQuotaInfo');
  assert.equal(quotaEl(page).classList.contains('is-exhausted'), true);
});

test('inline script に remaining の加減算が書かれていない', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');
  for (const bad of ['remaining -= ', 'remaining--', 'remaining - 1',
                     'remaining + 1', 'remaining++', 'used += ']) {
    assert.equal(src.includes(bad), false, bad + ' が書かれている');
  }
});

// =========================================================
// 8. 検索フローとの連携（runGuardedSearch 経由）
// =========================================================

/** runGuardedSearch を直接動かすための最小スタブを差し込む。 */
function guardedSetup(opts = {}) {
  const { page, fetchImpl } = setup(opts);
  page.run(`
    __calls = [];
    reserveQuota = async () => (${JSON.stringify(opts.reservation ?? {
      proceed: true, enforced: true, reservationId: 'r-1', message: null,
    })});
    fetchAndCalc = async () => { __calls.push('search'); return ${JSON.stringify(opts.searchResult ?? { success: true })}; };
    commitQuota = async () => { __calls.push('commit'); return true; };
    releaseQuota = async () => { __calls.push('release'); return true; };
  `);
  return { page, fetchImpl };
}

test('検索成功 -> commit の後に status を取り直す', async () => {
  const { page, fetchImpl } = guardedSetup();
  await page.call('runGuardedSearch');
  assert.deepEqual(JSON.parse(page.run('JSON.stringify(__calls)')), ['search', 'commit']);
  assert.equal(statusCalls(fetchImpl).length, 1, 'commit 後に 1 回だけ');
  assert.equal(statusCalls(fetchImpl)[0].method, 'GET');
});

test('検索失敗 -> release の後にも status を取り直す', async () => {
  const { page, fetchImpl } = guardedSetup({ searchResult: { success: false } });
  await page.call('runGuardedSearch');
  assert.deepEqual(JSON.parse(page.run('JSON.stringify(__calls)')), ['search', 'release']);
  assert.equal(statusCalls(fetchImpl).length, 1);
});

test('Pro（予約 ID なし）では status を取り直さない', async () => {
  const { page, fetchImpl } = guardedSetup({
    reservation: { proceed: true, enforced: false, reservationId: null, message: null },
  });
  await page.call('runGuardedSearch');
  assert.deepEqual(JSON.parse(page.run('JSON.stringify(__calls)')), ['search']);
  assert.equal(statusCalls(fetchImpl).length, 0, 'commit / release が無いので不要');
});

test('quota で止められたら status を取り直して表示を同期する', async () => {
  const { page, fetchImpl } = guardedSetup({
    reservation: { proceed: false, enforced: true, reservationId: null, message: '上限' },
    status: () => jsonResponse(200, statusBody({ remaining: 0, used: 3 })),
  });
  const out = await page.call('runGuardedSearch');
  assert.equal(out.blocked, true);
  assert.deepEqual(JSON.parse(page.run('JSON.stringify(__calls)')), [], '検索は実行しない');
  assert.equal(statusCalls(fetchImpl).length, 1);
  assert.equal(quotaEl(page).classList.contains('is-exhausted'), true);
});

test('定期 polling をしない（明示的に呼んだ回数だけ status を叩く）', async () => {
  const { page, fetchImpl } = guardedSetup();
  await page.call('runGuardedSearch');
  const after = statusCalls(fetchImpl).length;
  // 何もしなければ増えない
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(statusCalls(fetchImpl).length, after, 'polling していない');
});

test('status 取得が失敗しても検索フローは完了する', async () => {
  const { page, fetchImpl } = guardedSetup({ status: () => jsonResponse(502, { error: 'x' }) });
  const out = await page.call('runGuardedSearch');
  assert.equal(out.searched, true);
  assert.equal(out.blocked, false);
  assert.deepEqual(JSON.parse(page.run('JSON.stringify(__calls)')), ['search', 'commit']);
  assert.equal(quotaEl(page).style.display, 'none', '表示は隠すだけ');
});

// =========================================================
// 9. DOM / レイアウト
// =========================================================

test('quotaInfo は検索ボタンの直後にあり、既定で非表示', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');
  const btn = src.indexOf('id="searchBtn"');
  const info = src.indexOf('id="quotaInfo"');
  const login = src.indexOf('id="loginInfo"');
  assert.ok(btn > 0 && info > btn, '検索ボタンより後ろにある');
  assert.ok(info < login, 'loginInfo より前にある');
  assert.ok(src.includes('<p class="quota-info" id="quotaInfo" style="display:none;">'),
    '既定で非表示');
});

test('表示 / 非表示を繰り返しても要素が壊れない', async () => {
  const { page } = setup({ status: () => jsonResponse(200, statusBody({ remaining: 0 })) });
  for (let i = 0; i < 3; i += 1) {
    await page.call('refreshQuotaStatus');
    assert.equal(quotaEl(page).classList.contains('is-exhausted'), true);
    page.run('sukimaAuthenticated = false;');
    page.call('renderQuotaInfo');
    assert.equal(quotaEl(page).style.display, 'none');
    assert.equal(quotaEl(page).classList.contains('is-exhausted'), false, '強調が残らない');
    page.run('sukimaAuthenticated = true;');
  }
});

test('存在しない /pricing へのリンクを作らない', async () => {
  const { page } = setup({ status: () => jsonResponse(200, statusBody({ remaining: 0 })) });
  await page.call('refreshQuotaStatus');
  const html = quotaEl(page).innerHTML || '';
  assert.equal(html.includes('href'), false, 'リンクを作らない');
  const sub = quotaEl(page).children[0];
  assert.equal(sub.textContent.includes('/pricing'), false);
});

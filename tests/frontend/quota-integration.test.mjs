// =========================================================
// public/index.html の quota 連携テスト
//
//   実際の inline script を vm へ読み込んで
//   startSearch() / goToNextWeek() / fetchAndCalc() を直接呼ぶ。
//   fetch はすべてスタブ。ネットワークへは出ない。
//   本番の secret / Cookie 実値は一切扱わない。
// =========================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  brokenJsonResponse,
  jsonResponse,
  loadPage,
  makeFetch,
} from './page-harness.mjs';

const RESERVATION_ID = 'c9f17da8-e426-46b9-ac84-b1b6159fc53c';

// buildDailyResults() は今日より前へ丸めるため、必ず未来日を使う。
const START = '2036-10-06';
const END = '2036-10-12';
const NEXT_START = '2036-10-13';

const RESERVE_OK = {
  quota_enforced: true, allowed: true, code: 'ok', reused: false,
  reservation_id: RESERVATION_ID, week_start: '2036-10-06',
  used: 1, remaining: 2, expires_at: '2036-10-06T00:02:00.000Z',
};
const RESERVE_UNLIMITED = {
  quota_enforced: false, allowed: true, code: 'unlimited', reused: false,
  reservation_id: null, week_start: null, used: null, remaining: null, expires_at: null,
};
function reserveDenied(code) {
  return {
    quota_enforced: true, allowed: false, code, reused: false,
    reservation_id: null, week_start: '2036-10-06', used: 3, remaining: 0, expires_at: null,
  };
}
const COMMIT_OK = { quota_enforced: true, ok: true, code: 'ok', state: 'committed', used: 1 };
const RELEASE_OK = { quota_enforced: true, ok: true, code: 'ok', state: 'released', used: 0 };

const asFn = (v, fallback) => (typeof v === 'function' ? v : () => (v === undefined ? fallback() : v));

/**
 * ページを読み込み、ログイン済み・Calendar 認可済みの状態にする。
 *
 * calMode:
 *   'select'（既定） calendarList を埋めて calIds=['primary']（events 1 回）
 *   'all'            calendarList API から 2 件取得（events 2 回）
 */
function setup(opts = {}) {
  const reserve = asFn(opts.reserve, () => jsonResponse(200, RESERVE_OK));
  const commit = asFn(opts.commit, () => jsonResponse(200, COMMIT_OK));
  const release = asFn(opts.release, () => jsonResponse(200, RELEASE_OK));
  const calendarList = asFn(opts.calendarList, () => jsonResponse(200, { items: [{ id: 'cal-a' }, { id: 'cal-b' }] }));
  const events = asFn(opts.events, () => jsonResponse(200, { items: [] }));

  const fetchImpl = makeFetch([
    [(u) => u.includes('/api/quota/reserve'), reserve],
    [(u) => u.includes('/api/quota/commit'), commit],
    [(u) => u.includes('/api/quota/release'), release],
    [(u) => u.includes('/users/me/calendarList'), calendarList],
    [(u) => u.includes('/events?'), events],
  ]);

  const page = loadPage({ fetchImpl });
  page.run("sukimaAuthenticated = true; accessToken = 'test-token'; tokenClient = { requestAccessToken() {} };");
  if (opts.calMode === 'all') {
    page.run("calMode = 'all';");
  } else {
    page.run("calMode = 'select'; calendarList = [{ id: 'primary' }];");
  }
  page.el('startDate').value = opts.startDate || START;
  page.el('endDate').value = opts.endDate || END;
  page.el('duration').value = '60';
  return { page, fetchImpl };
}

/** vm コンテキストの戻り値は別レルムのため、フィールドごとに比較する。 */
function assertResult(r, success, authExpired, msg) {
  assert.equal(r.success, success, (msg || '') + ' success');
  assert.equal(r.authExpired, authExpired, (msg || '') + ' authExpired');
}

/** URL からカレンダー ID を取り出す。 */
function calIdOf(url) {
  const m = url.match(/\/calendars\/([^/]+)\/events/);
  return m ? decodeURIComponent(m[1]) : null;
}

// =========================================================
// fetchAndCalc: 検索成功の判定
// =========================================================

test('fetchAndCalc: events が全て 2xx なら success=true', async () => {
  const { page, fetchImpl } = setup({ calMode: 'all' });
  const r = await page.call('fetchAndCalc');
  assertResult(r, true, false);
  assert.equal(fetchImpl.eventsCalls().length, 2);
});

test('fetchAndCalc: 一部 2xx・401 なし なら success=true', async () => {
  const { page, fetchImpl } = setup({
    calMode: 'all',
    events: (u) => (calIdOf(u) === 'cal-a'
      ? jsonResponse(200, { items: [] })
      : jsonResponse(403, { error: 'forbidden' })),
  });
  const r = await page.call('fetchAndCalc');
  assertResult(r, true, false);
  assert.equal(fetchImpl.eventsCalls().length, 2);
});

test('fetchAndCalc: events が全滅なら success=false（終日空きにしない）', async () => {
  const { page } = setup({ calMode: 'all', events: () => jsonResponse(500, { error: 'boom' }) });
  const r = await page.call('fetchAndCalc');
  assertResult(r, false, false);
  const html = page.el('resultContent').innerHTML;
  assert.ok(html.includes('カレンダーを取得できませんでした'), '失敗を表示する: ' + html);
});

test('fetchAndCalc: events が network error でも success=false', async () => {
  const { page } = setup({
    calMode: 'all',
    events: () => { throw new TypeError('Failed to fetch'); },
  });
  const r = await page.call('fetchAndCalc');
  assertResult(r, false, false);
});

test('fetchAndCalc: 401 があれば authExpired=true / success=false', async () => {
  const { page } = setup({ calMode: 'all', events: () => jsonResponse(401, { error: 'unauthorized' }) });
  const r = await page.call('fetchAndCalc');
  assertResult(r, false, true);
});

test('fetchAndCalc: 1件 2xx + 1件 401 は 401 を優先する', async () => {
  const { page } = setup({
    calMode: 'all',
    events: (u) => (calIdOf(u) === 'cal-a'
      ? jsonResponse(200, { items: [] })
      : jsonResponse(401, { error: 'unauthorized' })),
  });
  const r = await page.call('fetchAndCalc');
  assert.equal(r.authExpired, true, '401 を優先する');
  assert.equal(r.success, false, '2xx が 1 件あっても成功にしない');
});

test('fetchAndCalc: calendarList だけ 200 で events 全滅なら success=false', async () => {
  const { page, fetchImpl } = setup({
    calMode: 'all',
    calendarList: () => jsonResponse(200, { items: [{ id: 'cal-a' }, { id: 'cal-b' }] }),
    events: () => jsonResponse(500, { error: 'boom' }),
  });
  const r = await page.call('fetchAndCalc');
  assert.equal(r.success, false, 'calendarList の成功を検索成功に数えない');
  assert.equal(fetchImpl.calls.filter((c) => c.url.includes('calendarList')).length, 1);
});

test('fetchAndCalc: 未ログインなら Calendar API を呼ばず success=false', async () => {
  const { page, fetchImpl } = setup();
  page.run('sukimaAuthenticated = false;');
  const r = await page.call('fetchAndCalc');
  assertResult(r, false, false);
  assert.equal(fetchImpl.eventsCalls().length, 0);
});

// =========================================================
// startSearch: quota を消費する検索の入口その 1
// =========================================================

test('startSearch: reserve allowed → Calendar 検索 → commit', async () => {
  const { page, fetchImpl } = setup();
  await page.call('startSearch');

  assert.equal(fetchImpl.quotaCalls('reserve').length, 1);
  assert.equal(fetchImpl.eventsCalls().length, 1);
  assert.equal(fetchImpl.quotaCalls('commit').length, 1, 'commit する');
  assert.equal(fetchImpl.quotaCalls('release').length, 0, 'release しない');

  const body = JSON.parse(fetchImpl.quotaCalls('commit')[0].init.body);
  assert.equal(body.reservation_id, RESERVATION_ID, 'reserve が返した ID を使う');
});

test('startSearch: reserve は POST / JSON / idempotency_key のみを送る', async () => {
  const { page, fetchImpl } = setup();
  await page.call('startSearch');

  const call = fetchImpl.quotaCalls('reserve')[0];
  assert.equal(call.method, 'POST');
  assert.equal(call.init.credentials, 'same-origin');
  assert.equal(call.init.headers['Content-Type'], 'application/json');
  const body = JSON.parse(call.init.body);
  assert.deepEqual(Object.keys(body), ['idempotency_key'], 'user_id を送らない');
  assert.equal(typeof body.idempotency_key, 'string');
  assert.ok(body.idempotency_key.length >= 8, '8 文字以上');
  assert.equal(/\s/.test(body.idempotency_key), false, '空白を含まない');
});

test('startSearch: limit_reached なら Calendar API を呼ばず commit / release もしない', async () => {
  const { page, fetchImpl } = setup({ reserve: () => jsonResponse(200, reserveDenied('limit_reached')) });
  await page.call('startSearch');

  assert.equal(fetchImpl.eventsCalls().length, 0, 'Calendar API を呼ばない');
  assert.equal(fetchImpl.quotaCalls('commit').length, 0);
  assert.equal(fetchImpl.quotaCalls('release').length, 0);
  assert.equal(page.el('statusForm').textContent, '今週の無料検索回数（3回）を使い切りました。');
});

test('startSearch: already_settled は limit_reached と別の表示にする', async () => {
  const { page, fetchImpl } = setup({ reserve: () => jsonResponse(200, reserveDenied('already_settled')) });
  await page.call('startSearch');

  assert.equal(fetchImpl.eventsCalls().length, 0, 'Calendar API を呼ばない');
  const msg = page.el('statusForm').textContent;
  assert.equal(msg, '検索を開始できませんでした。もう一度お試しください。');
  assert.notEqual(msg, '今週の無料検索回数（3回）を使い切りました。', '上限表示に丸めない');
});

test('startSearch: 未知の code なら安全に中止して汎用エラーを出す', async () => {
  const { page, fetchImpl } = setup({ reserve: () => jsonResponse(200, reserveDenied('some_future_code')) });
  await page.call('startSearch');

  assert.equal(fetchImpl.eventsCalls().length, 0);
  assert.equal(page.el('statusForm').textContent, '検索を開始できませんでした。時間をおいてお試しください。');
});

test('startSearch: reserve が 5xx なら Calendar API を呼ばない（quota を迂回しない）', async () => {
  const { page, fetchImpl } = setup({ reserve: () => jsonResponse(502, { error: 'database_unavailable' }) });
  await page.call('startSearch');

  assert.equal(fetchImpl.eventsCalls().length, 0);
  assert.equal(fetchImpl.quotaCalls('commit').length, 0);
  assert.equal(page.el('statusForm').textContent, '検索を開始できませんでした。時間をおいてお試しください。');
});

test('startSearch: reserve が 401 ならログイン案内へ倒す', async () => {
  const { page, fetchImpl } = setup({ reserve: () => jsonResponse(401, { error: 'unauthenticated' }) });
  await page.call('startSearch');

  assert.equal(fetchImpl.eventsCalls().length, 0);
  assert.equal(page.run('sukimaAuthenticated'), false, 'セッション切れを反映する');
  assert.equal(page.el('statusForm').textContent, 'まずGoogleでログインしてください');
});

test('startSearch: reserve の応答が壊れていたら中止する', async () => {
  const { page, fetchImpl } = setup({ reserve: () => brokenJsonResponse(200) });
  await page.call('startSearch');
  assert.equal(fetchImpl.eventsCalls().length, 0);
});

test('startSearch: allowed なのに reservation_id が無ければ中止する', async () => {
  const { page, fetchImpl } = setup({
    reserve: () => jsonResponse(200, { quota_enforced: true, allowed: true, code: 'ok', reservation_id: null }),
  });
  await page.call('startSearch');
  assert.equal(fetchImpl.eventsCalls().length, 0, '確定も返却もできない予約で検索しない');
});

test('startSearch: unlimited なら検索し commit / release を呼ばない', async () => {
  const { page, fetchImpl } = setup({ reserve: () => jsonResponse(200, RESERVE_UNLIMITED) });
  await page.call('startSearch');

  assert.equal(fetchImpl.eventsCalls().length, 1, 'Calendar 検索は行う');
  assert.equal(fetchImpl.quotaCalls('commit').length, 0, 'Pro は commit しない');
  assert.equal(fetchImpl.quotaCalls('release').length, 0, 'Pro は release しない');
});

test('startSearch: Calendar 全失敗なら release して commit しない', async () => {
  const { page, fetchImpl } = setup({ calMode: 'all', events: () => jsonResponse(500, { error: 'boom' }) });
  await page.call('startSearch');

  assert.equal(fetchImpl.quotaCalls('release').length, 1);
  assert.equal(fetchImpl.quotaCalls('commit').length, 0);
  const body = JSON.parse(fetchImpl.quotaCalls('release')[0].init.body);
  assert.equal(body.reservation_id, RESERVATION_ID);
});

test('startSearch: Calendar 401 なら release して commit しない', async () => {
  const { page, fetchImpl } = setup({ calMode: 'all', events: () => jsonResponse(401, { error: 'unauthorized' }) });
  await page.call('startSearch');

  assert.equal(fetchImpl.quotaCalls('release').length, 1);
  assert.equal(fetchImpl.quotaCalls('commit').length, 0);
});

test('startSearch: 1件 2xx + 1件 401 でも release して commit しない', async () => {
  const { page, fetchImpl } = setup({
    calMode: 'all',
    events: (u) => (calIdOf(u) === 'cal-a'
      ? jsonResponse(200, { items: [] })
      : jsonResponse(401, { error: 'unauthorized' })),
  });
  await page.call('startSearch');

  assert.equal(fetchImpl.quotaCalls('release').length, 1, '401 優先なので返却する');
  assert.equal(fetchImpl.quotaCalls('commit').length, 0);
});

test('startSearch: commit が失敗しても検索結果を捨てない（best effort）', async () => {
  const { page, fetchImpl } = setup({ commit: () => jsonResponse(502, { error: 'database_unavailable' }) });
  await page.call('startSearch');

  assert.equal(fetchImpl.quotaCalls('commit').length, 1);
  assert.equal(page.run('currentDailyResults.length > 0'), true, '結果を保持する');
  assert.ok(page.warnings.some((w) => w.includes('[quota] commit')), '警告は出す');
});

test('startSearch: release が失敗しても元の失敗表示を差し替えない（best effort）', async () => {
  const { page, fetchImpl } = setup({
    calMode: 'all',
    events: () => jsonResponse(500, { error: 'boom' }),
    release: () => jsonResponse(502, { error: 'database_unavailable' }),
  });
  await page.call('startSearch');

  assert.equal(fetchImpl.quotaCalls('release').length, 1);
  assert.ok(page.el('resultContent').innerHTML.includes('カレンダーを取得できませんでした'));
});

test('startSearch: 未ログインなら reserve すら呼ばない', async () => {
  const { page, fetchImpl } = setup();
  page.run('sukimaAuthenticated = false; sukimaSessionCheckFailed = false;');
  await page.call('startSearch');
  assert.equal(fetchImpl.quotaCalls('reserve').length, 0);
  assert.equal(fetchImpl.eventsCalls().length, 0);
});

test('startSearch: 日付が不正なら reserve を呼ばない', async () => {
  const { page, fetchImpl } = setup();
  page.el('startDate').value = END;
  page.el('endDate').value = START;
  await page.call('startSearch');
  assert.equal(fetchImpl.quotaCalls('reserve').length, 0);
});

test('startSearch: quota のログに secret / cookie / user_id を出さない', async () => {
  const { page } = setup({ reserve: () => jsonResponse(502, { error: 'database_unavailable' }) });
  await page.call('startSearch');
  const dump = page.warnings.concat(page.errors).join('\n');
  for (const s of ['test-token', RESERVATION_ID, 'sukima_session', 'sb_secret']) {
    assert.equal(dump.includes(s), false, s + ' を出さない: ' + dump);
  }
});

// =========================================================
// goToNextWeek: quota を消費する検索の入口その 2
// =========================================================

/** 先に 1 回検索して結果がある状態にする。 */
async function searchOnce(page) {
  await page.call('startSearch');
}

test('goToNextWeek: reserve を 1 回だけ呼び、成功したら commit する', async () => {
  const { page, fetchImpl } = setup();
  await searchOnce(page);
  const before = { reserve: fetchImpl.quotaCalls('reserve').length, commit: fetchImpl.quotaCalls('commit').length };

  await page.call('goToNextWeek');

  assert.equal(fetchImpl.quotaCalls('reserve').length - before.reserve, 1, 'reserve は 1 回');
  assert.equal(fetchImpl.quotaCalls('commit').length - before.commit, 1, '成功したら commit');
  assert.equal(page.el('startDate').value, NEXT_START, '翌週へ進む');
});

test('goToNextWeek: 検索試行ごとに新しい idempotency_key を使う', async () => {
  const { page, fetchImpl } = setup();
  await searchOnce(page);
  await page.call('goToNextWeek');
  await page.call('goToNextWeek');

  const keys = fetchImpl.quotaCalls('reserve').map((c) => JSON.parse(c.init.body).idempotency_key);
  assert.equal(keys.length, 3, 'startSearch 1 + goToNextWeek 2');
  assert.equal(new Set(keys).size, 3, 'すべて異なる鍵: ' + keys.join(', '));
});

test('goToNextWeek: Calendar 失敗なら release して巻き戻す', async () => {
  let failNext = false;
  const { page, fetchImpl } = setup({
    calMode: 'all',
    events: () => (failNext ? jsonResponse(500, { error: 'boom' }) : jsonResponse(200, { items: [] })),
  });
  await searchOnce(page);
  const before = fetchImpl.quotaCalls('release').length;

  failNext = true;
  await page.call('goToNextWeek');

  assert.equal(fetchImpl.quotaCalls('release').length - before, 1, 'release する');
  assert.equal(page.el('startDate').value, START, '日付を巻き戻す');
  assert.equal(page.el('toast').textContent, '翌週の検索に失敗しました');
});

test('goToNextWeek: Calendar 401 なら release して commit しない', async () => {
  let expire = false;
  const { page, fetchImpl } = setup({
    calMode: 'all',
    events: () => (expire ? jsonResponse(401, { error: 'unauthorized' }) : jsonResponse(200, { items: [] })),
  });
  await searchOnce(page);
  const before = { release: fetchImpl.quotaCalls('release').length, commit: fetchImpl.quotaCalls('commit').length };

  expire = true;
  await page.call('goToNextWeek');

  assert.equal(fetchImpl.quotaCalls('release').length - before.release, 1);
  assert.equal(fetchImpl.quotaCalls('commit').length - before.commit, 0);
});

test('goToNextWeek: quota 上限なら Calendar API を呼ばず上限表示を出す', async () => {
  let limited = false;
  const { page, fetchImpl } = setup({
    reserve: () => (limited
      ? jsonResponse(200, reserveDenied('limit_reached'))
      : jsonResponse(200, RESERVE_OK)),
  });
  await searchOnce(page);
  const before = fetchImpl.eventsCalls().length;

  limited = true;
  await page.call('goToNextWeek');

  assert.equal(fetchImpl.eventsCalls().length - before, 0, 'Calendar API を呼ばない');
  assert.equal(page.el('toast').textContent, '今週の無料検索回数（3回）を使い切りました。',
    'nextWeekFail で上書きしない');
  assert.equal(page.el('startDate').value, START, '日付を巻き戻す');
});

test('goToNextWeek: unlimited なら commit / release を呼ばない', async () => {
  const { page, fetchImpl } = setup({ reserve: () => jsonResponse(200, RESERVE_UNLIMITED) });
  await searchOnce(page);
  await page.call('goToNextWeek');

  assert.equal(fetchImpl.quotaCalls('commit').length, 0);
  assert.equal(fetchImpl.quotaCalls('release').length, 0);
  assert.equal(page.el('startDate').value, NEXT_START);
});

test('goToNextWeek: 未ログインなら reserve を呼ばない', async () => {
  const { page, fetchImpl } = setup();
  await searchOnce(page);
  const before = fetchImpl.quotaCalls('reserve').length;

  page.run('sukimaAuthenticated = false;');
  await page.call('goToNextWeek');

  assert.equal(fetchImpl.quotaCalls('reserve').length - before, 0);
});

// =========================================================
// UI / 二重実行防止
// =========================================================

test('英語モードでも quota 上限メッセージが出る', async () => {
  const { page } = setup({ reserve: () => jsonResponse(200, reserveDenied('limit_reached')) });
  page.run("currentLang = 'en';");
  await page.call('startSearch');
  assert.equal(page.el('statusForm').textContent, 'You have used all 3 free searches for this week.');
});

test('検索ボタンは quota で止めた後も戻る', async () => {
  const { page } = setup({ reserve: () => jsonResponse(200, reserveDenied('limit_reached')) });
  await page.call('startSearch');
  assert.equal(page.el('searchBtn').disabled, false, 'ボタンを押せる状態へ戻す');
});

test('検索ボタンは検索成功後も戻る', async () => {
  const { page } = setup();
  await page.call('startSearch');
  assert.equal(page.el('searchBtn').disabled, false);
});

test('reserve 中に startSearch を再入しても reserve は 1 回だけ', async () => {
  const { page, fetchImpl } = setup();
  const p1 = page.call('startSearch');
  const p2 = page.call('startSearch');
  await Promise.all([p1, p2]);

  assert.equal(fetchImpl.quotaCalls('reserve').length, 1, '二重に予約しない');
  assert.equal(fetchImpl.eventsCalls().length, 1);
});

test('goToNextWeek の連打でも reserve は 1 回だけ', async () => {
  const { page, fetchImpl } = setup();
  await searchOnce(page);
  const before = fetchImpl.quotaCalls('reserve').length;

  const p1 = page.call('goToNextWeek');
  const p2 = page.call('goToNextWeek');
  await Promise.all([p1, p2]);

  assert.equal(fetchImpl.quotaCalls('reserve').length - before, 1, '二重に予約しない');
});

test('検索中は startSearch から goToNextWeek へ割り込めない', async () => {
  const { page, fetchImpl } = setup();
  const p1 = page.call('startSearch');
  const p2 = page.call('goToNextWeek');
  await Promise.all([p1, p2]);

  assert.equal(fetchImpl.quotaCalls('reserve').length, 1);
});

// =========================================================
// quota を消費しない操作（回帰）
// =========================================================

test('日付移動・再描画・view 切替・カレンダー一覧取得は quota を消費しない', async () => {
  const { page, fetchImpl } = setup();
  await searchOnce(page);
  const before = fetchImpl.quotaCalls('reserve').length;

  page.call('showNextDay');
  page.call('showPreviousDay');
  page.call('renderCurrentDay');
  page.call('showSearch');
  page.call('applyLang');
  await page.call('loadCalendarList');

  assert.equal(fetchImpl.quotaCalls('reserve').length - before, 0, 'reserve を呼ばない');
  assert.equal(fetchImpl.quotaCalls('commit').length, 1, 'startSearch の 1 回だけ');
  assert.equal(fetchImpl.quotaCalls('release').length, 0);
});

test('quota API は reserve / commit / release の 3 つ以外を呼ばない', async () => {
  const { page, fetchImpl } = setup();
  await searchOnce(page);
  const paths = fetchImpl.calls
    .filter((c) => c.url.includes('/api/'))
    .map((c) => new URL(c.url, 'https://sukimacalendar.com').pathname);
  for (const p of paths) {
    assert.ok(['/api/quota/reserve', '/api/quota/commit', '/api/quota/release'].includes(p), p);
  }
});

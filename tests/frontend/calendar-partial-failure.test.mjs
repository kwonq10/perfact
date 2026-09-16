// =========================================================
// public/index.html の「一部カレンダーだけ取得に失敗した」ときの扱い
//
//   実際の inline script を vm へ読み込み fetchAndCalc() を直接呼ぶ。
//   fetch はすべてスタブ。Google へも本番 DB へも出ない。
//
//   取りこぼしたカレンダーの予定を無視して空き時間を計算すると、
//   実際は埋まっている時間を「空いています」として出してしまう。
//   その結果はコピーされて人に送られるため、黙って出さない。
//
//   403 は「そのカレンダーの予定を見る権限が無い」= 元々読めないので無視する。
//   429 / 5xx / 通信エラーは「読めるはずのものが取れなかった」= 取りこぼし。
// =========================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { jsonResponse, loadPage, makeFetch } from './page-harness.mjs';

const START = '2036-10-06';
const END = '2036-10-06';

/** 10/6 の h1 時 - h2 時に予定が入っている events 応答。 */
const busyBody = (h1, h2) => ({
  items: [{
    start: { dateTime: new Date(2036, 9, 6, h1, 0).toISOString() },
    end: { dateTime: new Date(2036, 9, 6, h2, 0).toISOString() },
  }],
});

/**
 * 2 つのカレンダーを見に行くページを作る。
 * events は呼ばれた順に responders[i] を返す。
 */
function setup(responders, { calendars = ['cal-a', 'cal-b'] } = {}) {
  let n = 0;
  const fetchImpl = makeFetch([
    [(u) => u.includes('/users/me/calendarList'),
      () => jsonResponse(200, { items: calendars.map((id) => ({ id, accessRole: 'owner' })) })],
    [(u) => u.includes('/events?'), () => {
      const r = responders[Math.min(n, responders.length - 1)];
      n += 1;
      return r();
    }],
  ]);

  const page = loadPage({ fetchImpl });
  page.context.google = {
    accounts: {
      id: { initialize() {}, renderButton() {}, disableAutoSelect() {} },
      oauth2: { initTokenClient: () => ({ requestAccessToken() {} }) },
    },
  };
  page.run("sukimaAuthenticated = true; accessToken = 'test-token'; calMode = 'all';");
  page.run('tokenClient = { requestAccessToken() { __reauth.push(1); } };');
  const reauth = [];
  page.context.__reauth = reauth;
  page.context.localStorage.setItem('gtoken', 'test-token');
  page.context.localStorage.setItem('gtoken_expiry', String(Date.now() + 3500 * 1000));
  page.el('startDate').value = START;
  page.el('endDate').value = END;
  page.el('duration').value = '60';
  page.el('loginBtn').style.display = 'none';
  page.run('currentSlots = []; currentDailyResults = [];');
  return { page, fetchImpl, reauth };
}

const ok = (h1 = 13, h2 = 14) => () => jsonResponse(200, busyBody(h1, h2));
const empty = () => jsonResponse(200, { items: [] });
const status = (code) => () => jsonResponse(code, { error: { code, message: 'x' } });
const boom = () => { throw new Error('network down'); };

const count = (v) => Array.from(v).length;
const shape = (slots) => Array.from(slots, (s) =>
  `${String(s.start.getHours()).padStart(2, '0')}:00-${String(s.end.getHours()).padStart(2, '0')}:00`).join(', ');

const partialMsg = (page) => page.call('t', 'calendarPartialFailed');

/** 結果が作られていないこと。 */
function assertNoResult(page, label) {
  assert.equal(count(page.run('currentSlots')), 0, `${label}: 不完全な空き時間を作っている`);
  assert.equal(count(page.run('currentDailyResults')), 0, `${label}: 不完全なカードを作っている`);
}

// ---------------------------------------------------------
// 403 は無視してよい
// ---------------------------------------------------------

test('1 件成功 + 1 件 403 は成功。成功したカレンダーの予定で結果を出す', async () => {
  const { page } = setup([status(403), ok(13, 14)]);
  const r = await page.call('fetchAndCalc');

  assert.equal(r.success, true);
  assert.equal(shape(page.run('currentSlots')), '09:00-13:00, 14:00-22:00');
  assert.equal(count(page.run('currentDailyResults')), 1);
});

test('403 が先でも後でも成功扱いは変わらない', async () => {
  const { page } = setup([ok(13, 14), status(403)]);
  const r = await page.call('fetchAndCalc');

  assert.equal(r.success, true);
  assert.equal(shape(page.run('currentSlots')), '09:00-13:00, 14:00-22:00');
});

test('全件 403 は 2xx が 1 件も無いので従来どおり失敗（結果を作らない）', async () => {
  const { page } = setup([status(403), status(403)]);
  const r = await page.call('fetchAndCalc');

  assert.equal(r.success, false);
  assert.equal(r.authExpired, false);
  assert.equal(page.el('statusForm').textContent, page.call('t', 'calendarFetchFailed'),
    '全滅時は従来どおりの案内');
  assertNoResult(page, '全件 403');
});

// ---------------------------------------------------------
// 429 / 5xx / 通信エラーは取りこぼし
// ---------------------------------------------------------

for (const [name, responder] of [
  ['429', status(429)],
  ['500', status(500)],
  ['503', status(503)],
  ['通信エラー', boom],
]) {
  test(`1 件成功 + 1 件 ${name} は結果を出さず警告を出す`, async () => {
    const { page } = setup([responder, ok(13, 14)]);
    const r = await page.call('fetchAndCalc');

    assert.equal(r.success, false, `${name}: 不完全な結果を成功にしてはいけない`);
    assert.equal(r.authExpired, false, `${name}: 認可の問題ではない`);
    assert.equal(page.el('statusForm').textContent, partialMsg(page), `${name}: 取りこぼしの案内を出す`);
    assertNoResult(page, name);
  });

  test(`1 件成功 + 1 件 ${name} は順序が逆でも結果を出さない`, async () => {
    const { page } = setup([ok(13, 14), responder]);
    const r = await page.call('fetchAndCalc');

    assert.equal(r.success, false);
    assert.equal(page.el('statusForm').textContent, partialMsg(page));
    assertNoResult(page, name);
  });
}

test('取りこぼし時は画面にも取りこぼしの案内を出す', async () => {
  const { page } = setup([status(429), ok(13, 14)]);
  await page.call('fetchAndCalc');

  const html = page.el('resultContent').innerHTML;
  assert.ok(html.includes(partialMsg(page)), '結果欄に案内が出ていない');
});

test('取りこぼしの案内は全滅時の案内と別の文言', async () => {
  const { page } = setup([status(429), ok()]);
  assert.notEqual(page.call('t', 'calendarPartialFailed'), page.call('t', 'calendarFetchFailed'));
});

test('取りこぼし時は再連携を促さない（認可の問題ではない）', async () => {
  const { page, reauth } = setup([status(429), ok(13, 14)]);
  await page.call('fetchAndCalc');

  assert.equal(page.run('accessToken'), 'test-token', 'token を捨てない');
  assert.equal(page.context.localStorage.getItem('gtoken'), 'test-token');
  assert.equal(page.el('loginBtn').style.display, 'none', '連携ボタンを出さない');
  assert.deepEqual(reauth, [], '認可ポップアップを開かない');
});

test('全件 429 は従来どおり「全滅」の案内（取りこぼし案内で上書きしない）', async () => {
  const { page } = setup([status(429), status(429)]);
  const r = await page.call('fetchAndCalc');

  assert.equal(r.success, false);
  assert.equal(page.el('statusForm').textContent, page.call('t', 'calendarFetchFailed'));
  assertNoResult(page, '全件 429');
});

test('全件 通信エラー も従来どおり「全滅」の案内', async () => {
  const { page } = setup([boom, boom]);
  const r = await page.call('fetchAndCalc');

  assert.equal(r.success, false);
  assert.equal(page.el('statusForm').textContent, page.call('t', 'calendarFetchFailed'));
  assertNoResult(page, '全件 通信エラー');
});

test('403 と 429 が混ざったら取りこぼし扱い', async () => {
  const { page } = setup([ok(13, 14), status(403), status(429)], { calendars: ['a', 'b', 'c'] });
  const r = await page.call('fetchAndCalc');

  assert.equal(r.success, false);
  assert.equal(page.el('statusForm').textContent, partialMsg(page));
  assertNoResult(page, '403 + 429');
});

// ---------------------------------------------------------
// 既存動作を壊していないこと
// ---------------------------------------------------------

test('全件 2xx は従来どおり結果を出す', async () => {
  const { page } = setup([ok(13, 14), empty]);
  const r = await page.call('fetchAndCalc');

  assert.equal(r.success, true);
  assert.equal(r.authExpired, false);
  assert.equal(shape(page.run('currentSlots')), '09:00-13:00, 14:00-22:00');
  assert.equal(page.el('statusForm').textContent, '', '余計な警告を出さない');
});

test('全件 2xx で予定が無ければ終日空き 1 枠', async () => {
  const { page } = setup([empty, empty]);
  const r = await page.call('fetchAndCalc');

  assert.equal(r.success, true);
  assert.equal(shape(page.run('currentSlots')), '09:00-22:00');
});

test('複数カレンダーの予定はすべて反映される', async () => {
  const { page } = setup([ok(10, 11), ok(15, 16)]);
  const r = await page.call('fetchAndCalc');

  assert.equal(r.success, true);
  assert.equal(shape(page.run('currentSlots')), '09:00-10:00, 11:00-15:00, 16:00-22:00');
});

// ---------------------------------------------------------
// H-1（401 の復帰導線）を壊していないこと
// ---------------------------------------------------------

test('401 は取りこぼし判定より前に処理され、H-1 の復帰状態になる', async () => {
  const { page, reauth } = setup([status(429), status(401)]);
  const r = await page.call('fetchAndCalc');

  assert.equal(r.success, false);
  assert.equal(r.authExpired, true, '401 が最優先');
  assert.equal(page.run('accessToken'), null, 'token を破棄する');
  assert.equal(page.context.localStorage.getItem('gtoken'), null);
  assert.equal(page.run('sukimaAuthenticated'), true, 'サーバーセッションは落とさない');
  assert.notEqual(page.el('loginBtn').style.display, 'none', '連携ボタンを再表示する');
  assert.equal(page.call('getAuthState'), 'B');
  assert.deepEqual(reauth, [], '認可ポップアップを自動で開かない');
  assert.equal(page.el('statusForm').textContent, page.call('t', 'sessionExpired'),
    '取りこぼしの案内で上書きしない');
});

test('401 のみでも H-1 の挙動は変わらない', async () => {
  const { page, reauth } = setup([status(401)]);
  const r = await page.call('fetchAndCalc');

  assert.equal(r.authExpired, true);
  assert.equal(page.run('accessToken'), null);
  assert.notEqual(page.el('loginBtn').style.display, 'none');
  assert.deepEqual(reauth, []);
});

// ---------------------------------------------------------
// 文言
// ---------------------------------------------------------

test('取りこぼしの案内は ja / en とも用意されている', () => {
  const { page } = setup([empty]);

  page.run("currentLang = 'ja';");
  const ja = page.call('t', 'calendarPartialFailed');
  assert.equal(ja, '一部のカレンダーを取得できませんでした。時間をおいて再度お試しください。');

  page.run("currentLang = 'en';");
  const en = page.call('t', 'calendarPartialFailed');
  assert.ok(en.length > 0);
  assert.ok(!/[ぁ-んァ-ン一-龠]/.test(en), '英語の文言に日本語が混ざっている');
});

test('英語表示でも取りこぼし時は英語の案内を出す', async () => {
  const { page } = setup([status(500), ok(13, 14)]);
  page.run("currentLang = 'en';");
  await page.call('fetchAndCalc');

  assert.equal(page.el('statusForm').textContent, page.call('t', 'calendarPartialFailed'));
  assert.ok(!/[ぁ-んァ-ン一-龠]/.test(page.el('statusForm').textContent));
});

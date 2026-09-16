// =========================================================
// public/index.html の Calendar 認可まわりテスト
//
//   実際の inline script を vm へ読み込み、
//   fetchAndCalc() / doLogin() / updateAuthUi() を直接呼ぶ。
//   fetch と google.accounts はすべてスタブ。
//   Google へも本番 DB へも出ない。
//
//   主眼は Calendar API が 401 を返したあとの復帰導線。
//   token を捨てるだけで画面を戻さないと、利用者から見て
//  「再連携する手段が無い」状態になる。
//
//   また、events API を await した後に認可ポップアップを開くと
//   user activation が切れていてブラウザにブロックされる。
//   401 経路では自動で開かず、利用者のクリックを待つ。
// =========================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { jsonResponse, loadPage, makeFetch } from './page-harness.mjs';

const START = '2036-10-06';
const END = '2036-10-06';

const UNLIMITED = {
  quota_enforced: false, allowed: true, code: 'unlimited', reused: false,
  reservation_id: null, week_start: null, used: null, remaining: null, expires_at: null,
};

/**
 * ログイン済み・Calendar 認可済みのページを作る。
 *
 * 戻り値の reauth には、認可ポップアップ（requestAccessToken）が
 * 呼ばれた回数が積まれる。
 */
function setup({ events, calendarList } = {}) {
  const fetchImpl = makeFetch([
    [(u) => u.includes('/api/quota/reserve'), () => jsonResponse(200, UNLIMITED)],
    [(u) => u.includes('/api/quota/'), () => jsonResponse(200, { quota_enforced: false, ok: true, code: 'ok' })],
    [(u) => u.includes('/users/me/calendarList'),
      calendarList || (() => jsonResponse(200, { items: [{ id: 'primary' }] }))],
    [(u) => u.includes('/events?'), events || (() => jsonResponse(200, { items: [] }))],
  ]);

  const page = loadPage({ fetchImpl });
  const reauth = [];
  page.context.__reauth = reauth;
  // google.accounts.oauth2 のスタブ。initTokenClient も呼べるようにしておく。
  page.context.google = {
    accounts: {
      id: { initialize() {}, renderButton() {}, disableAutoSelect() {} },
      oauth2: {
        initTokenClient: () => ({ requestAccessToken() { reauth.push('init'); } }),
        revoke() {},
      },
    },
  };
  page.run("sukimaAuthenticated = true; accessToken = 'test-token';");
  page.run("tokenClient = { requestAccessToken() { __reauth.push('existing'); } };");
  page.run("calMode = 'select'; calendarList = [{ id: 'primary' }];");
  page.context.localStorage.setItem('gtoken', 'test-token');
  page.context.localStorage.setItem('gtoken_expiry', String(Date.now() + 3500 * 1000));
  page.el('startDate').value = START;
  page.el('endDate').value = END;
  page.el('duration').value = '60';
  // #loginBtn は index.html では inline style で隠されている。同じ初期値にする。
  page.el('loginBtn').style.display = 'none';
  // 認可済み（状態 A）の見た目にそろえておく。
  page.call('updateAuthUi');
  return { page, fetchImpl, reauth };
}

const unauthorized = () => jsonResponse(401, { error: { code: 401, message: 'Invalid Credentials' } });
const display = (page, id) => page.el(id).style.display;

// ---------------------------------------------------------
// 前提: 401 の前は認可済みの表示になっている
// ---------------------------------------------------------

test('前提: 認可済みなら検索フォームが出て、連携ボタンは隠れている', () => {
  const { page } = setup();
  assert.equal(display(page, 'formSection'), 'block');
  assert.equal(display(page, 'loginSection'), 'none');
  assert.equal(display(page, 'loginBtn'), 'none');
});

// ---------------------------------------------------------
// Calendar 401: token の破棄
// ---------------------------------------------------------

test('Calendar 401 で accessToken を破棄する', async () => {
  const { page } = setup({ events: unauthorized });
  const r = await page.call('fetchAndCalc');

  assert.equal(r.success, false);
  assert.equal(r.authExpired, true);
  assert.equal(page.run('accessToken'), null);
});

test('Calendar 401 で保存済みの token と有効期限を消す', async () => {
  const { page } = setup({ events: unauthorized });
  await page.call('fetchAndCalc');

  assert.equal(page.context.localStorage.getItem('gtoken'), null);
  assert.equal(page.context.localStorage.getItem('gtoken_expiry'), null);
});

test('Calendar 401 でも Sukima のサーバーセッションは落とさない', async () => {
  const { page, fetchImpl } = setup({ events: unauthorized });
  await page.call('fetchAndCalc');

  assert.equal(page.run('sukimaAuthenticated'), true, 'Calendar の失効で本人確認まで落とさない');
  assert.equal(fetchImpl.calls.filter((c) => c.url.includes('/api/auth/logout')).length, 0,
    'logout API を呼ばない');
});

// ---------------------------------------------------------
// Calendar 401: 復帰導線（今回の修正の本体）
// ---------------------------------------------------------

test('Calendar 401 のあと「Googleカレンダーと連携」ボタンが再表示される', async () => {
  const { page } = setup({ events: unauthorized });
  await page.call('fetchAndCalc');

  assert.notEqual(display(page, 'loginBtn'), 'none', '連携ボタンが隠れたままだと再連携できない');
  assert.equal(display(page, 'loginSection'), 'block');
  assert.equal(display(page, 'formSection'), 'none');
});

test('Calendar 401 のあとは状態 B（本人確認済み・Calendar 未認可）になる', async () => {
  const { page } = setup({ events: unauthorized });
  await page.call('fetchAndCalc');

  assert.equal(page.call('getAuthState'), 'B');
});

test('Calendar 401 では認可ポップアップを自動で開かない', async () => {
  // await の後に開くと user activation が切れていてブロックされる。
  const { page, reauth } = setup({ events: unauthorized });
  await page.call('fetchAndCalc');

  assert.deepEqual(reauth, [], 'requestAccessToken を自動実行してはいけない');
});

test('Calendar 401 のあと失効の案内を出す', async () => {
  const { page } = setup({ events: unauthorized });
  await page.call('fetchAndCalc');

  assert.equal(page.el('statusForm').textContent, page.call('t', 'sessionExpired'));
});

test('Calendar 401 では残りのカレンダーを見に行かない', async () => {
  const fetchImpl = makeFetch([
    [(u) => u.includes('/users/me/calendarList'),
      () => jsonResponse(200, { items: [{ id: 'cal-a' }, { id: 'cal-b' }, { id: 'cal-c' }] })],
    [(u) => u.includes('/events?'), unauthorized],
  ]);
  const page = loadPage({ fetchImpl });
  page.context.google = { accounts: { id: {}, oauth2: { initTokenClient: () => ({ requestAccessToken() {} }) } } };
  page.run("sukimaAuthenticated = true; accessToken = 'test-token'; calMode = 'all';");
  page.run('tokenClient = { requestAccessToken() {} };');
  page.el('startDate').value = START;
  page.el('endDate').value = END;
  page.el('duration').value = '60';

  await page.call('fetchAndCalc');
  assert.equal(fetchImpl.eventsCalls().length, 1, '401 を受けた時点で打ち切る');
});

// ---------------------------------------------------------
// 401 のあと、利用者のクリックで通常の認可フローへ進める
// ---------------------------------------------------------

test('401 のあとに連携ボタンを押すと認可フローへ進む', async () => {
  const { page, reauth } = setup({ events: unauthorized });
  await page.call('fetchAndCalc');
  assert.deepEqual(reauth, [], '前提: 自動では開いていない');

  // 利用者のクリック相当。
  page.call('doLogin');
  assert.equal(reauth.length, 1, 'クリックしたときは認可へ進む');
});

test('401 で tokenClient を捨てても、クリック時に作り直して認可へ進める', async () => {
  const { page, reauth } = setup({ events: unauthorized });
  page.run('tokenClient = undefined;');
  await page.call('fetchAndCalc');

  page.call('doLogin');
  assert.deepEqual(reauth, ['init'], 'initTokenClient から作り直して認可を要求する');
});

test('本人確認が済んでいなければ、連携ボタンを押しても Calendar 認可は始めない', () => {
  const { page, reauth } = setup();
  page.run('sukimaAuthenticated = false;');

  page.call('doLogin');
  assert.deepEqual(reauth, [], 'Calendar の認可より本人確認が先');
});

// ---------------------------------------------------------
// 401 以外の既存動作を壊していないこと
// ---------------------------------------------------------

test('検索成功時は画面も認可状態もそのまま', async () => {
  const { page, reauth } = setup({
    events: () => jsonResponse(200, { items: [] }),
  });
  const r = await page.call('fetchAndCalc');

  assert.equal(r.success, true);
  assert.equal(r.authExpired, false);
  assert.equal(page.run('accessToken'), 'test-token', 'token を捨てない');
  assert.equal(page.context.localStorage.getItem('gtoken'), 'test-token');
  assert.equal(display(page, 'loginBtn'), 'none', '連携ボタンを出さない');
  assert.deepEqual(reauth, [], '認可ポップアップを開かない');
});

test('Calendar が全滅（5xx）でも token は捨てず、連携ボタンも出さない', async () => {
  const { page, reauth } = setup({ events: () => jsonResponse(500, { error: 'boom' }) });
  const r = await page.call('fetchAndCalc');

  assert.equal(r.success, false);
  assert.equal(r.authExpired, false, '認可の問題ではない');
  assert.equal(page.run('accessToken'), 'test-token', '一時障害で認可を捨てない');
  assert.equal(page.context.localStorage.getItem('gtoken'), 'test-token');
  assert.equal(display(page, 'loginBtn'), 'none');
  assert.deepEqual(reauth, []);
});

test('未ログインなら Calendar API を呼ばず、認可ポップアップも開かない', async () => {
  const { page, fetchImpl, reauth } = setup();
  page.run('sukimaAuthenticated = false;');

  const r = await page.call('fetchAndCalc');
  assert.equal(r.success, false);
  assert.equal(fetchImpl.eventsCalls().length, 0);
  assert.deepEqual(reauth, []);
});

// ---------------------------------------------------------
// 実装の作り（回帰防止）
// ---------------------------------------------------------

test('401 経路は updateAuthUi を呼び、requestAccessToken を直接呼ばない', () => {
  const page = loadPage({ fetchImpl: async () => jsonResponse(200, {}) });
  const src = String(page.context.fetchAndCalc);
  const block = src.slice(src.indexOf('calRes.status === 401'), src.indexOf('authExpired: calendarAuthExpired'));

  assert.ok(block.includes('updateAuthUi('), '401 経路で画面状態を戻していない');
  assert.ok(!block.includes('requestAccessToken('),
    '401 経路で認可ポップアップを自動実行している（user activation が切れてブロックされる）');
});

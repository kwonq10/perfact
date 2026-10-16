// =========================================================
// public/index.html の Google ログイン（1 回の Google 操作）テスト
//
//   本人確認（Sukima サーバーセッション）と Calendar 閲覧の許可を、
//   google.accounts.oauth2.initTokenClient の 1 回のポップアップでまとめて行う。
//   access token はサーバー（/api/auth/google-session）が検証してから使う。
//
//   実際の inline script を vm へ読み込み、google.accounts.oauth2 はスタブにする。
//   initTokenClient に渡された callback / error_callback をテストから直接呼ぶ。
//   fetch はすべてスタブ。Google へも本番 DB へも出ない。
// =========================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { jsonResponse, loadPage, makeFetch } from './page-harness.mjs';

const CAL_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events.readonly',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
];
const FULL_SCOPE = ['openid', ...CAL_SCOPES].join(' ');
const TOKEN = 'ya29.dummy-access-token-for-tests';

const SESSION_OK = { plan_id: 'free', status: 'active', calendar_scopes_granted: true };
const ME_OK = {
  authenticated: true, plan_id: 'free', status: 'active',
  entitlement: { web: false, extension: false },
  current_period_end: null, cancel_at_period_end: false, currency: null,
  price_phase: null, amount: null, tax_behavior: null, next_phase_amount: null, grace_until: null,
};

const flush = async () => { for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0)); };

/**
 * ページを作る。
 *   state:   'D'（既定）/ 'B' / 'A'
 *   session: '/api/auth/google-session' の応答を返す関数
 *   me:      '/api/auth/me' の応答を返す関数
 *   hasGrantedAllScopes: GIS の判定関数の差し替え（省略時は scope 文字列で判定）
 */
function setup({ state = 'D', session, me, hasGrantedAllScopes } = {}) {
  const fetchImpl = makeFetch([
    [(u) => u.includes('/api/auth/google-session'), session || (() => jsonResponse(200, SESSION_OK))],
    [(u) => u.includes('/api/auth/me'), me || (() => jsonResponse(200, ME_OK))],
    [(u) => u.includes('/api/user/timezone'), () => jsonResponse(200, { ok: true })],
    [(u) => u.includes('/api/quota/status'), () => jsonResponse(200, { quota_enforced: false })],
    [(u) => u.includes('/users/me/calendarList'), () => jsonResponse(200, { items: [{ id: 'primary' }] })],
  ]);
  const page = loadPage({ fetchImpl });

  const gis = { config: null, requests: [], idCalls: 0 };
  const oauth2 = {
    initTokenClient(cfg) {
      gis.config = cfg;
      return { requestAccessToken(overrides) { gis.requests.push(overrides || {}); } };
    },
    revoke() {},
  };
  if (hasGrantedAllScopes) oauth2.hasGrantedAllScopes = hasGrantedAllScopes;
  page.context.google = {
    accounts: {
      // google.accounts.id は使わないはず。呼ばれたら数える。
      id: new Proxy({}, { get() { return () => { gis.idCalls += 1; }; } }),
      oauth2,
    },
  };

  if (state === 'A') {
    page.run("sukimaAuthenticated = true; accessToken = 'existing-token';");
  } else if (state === 'B') {
    page.run('sukimaAuthenticated = true; accessToken = null;');
  }
  page.el('loginBtn').style.display = 'none';
  page.call('updateAuthUi');
  return { page, fetchImpl, gis };
}

/** Google の callback（成功）を模す。 */
function grant(gis, overrides = {}) {
  return gis.config.callback({ access_token: TOKEN, expires_in: 3599, scope: FULL_SCOPE, ...overrides });
}

const sessionCalls = (fetchImpl) => fetchImpl.calls.filter((c) => c.url.includes('/api/auth/google-session'));
const display = (page, id) => page.el(id).style.display;

// ---------------------------------------------------------
// 1. 未ログイン・Calendar 未連携 → Google 操作 1 回で完了
// ---------------------------------------------------------

test('1: 状態 D では Google ボタンは 1 つだけで、文言は「ログインしてカレンダーを連携」', () => {
  const { page } = setup();
  assert.equal(page.call('getAuthState'), 'D');
  assert.equal(display(page, 'loginSection'), 'block');
  assert.equal(display(page, 'loginBtn'), '');
  assert.equal(page.el('loginBtn').textContent, page.call('t', 'signInWithGoogleBtn'));
  assert.equal(display(page, 'formSection'), 'none');
});

test('1: クリック 1 回で Google の画面を同期的に 1 回だけ開く（アカウント選択あり）', () => {
  const { page, gis } = setup();
  page.call('doLogin');
  // await を挟まずに開いていること（user activation を失わない）。
  assert.equal(gis.requests.length, 1);
  assert.equal(gis.requests[0].prompt, 'select_account');
  assert.equal(page.el('status').textContent, page.call('t', 'googleSignInPending'));
});

test('1: Token Client は openid と Calendar の scope だけをまとめて要求する（email は要求しない）', () => {
  const { page, gis } = setup();
  page.call('doLogin');
  const scopes = gis.config.scope.split(' ');
  assert.deepEqual([...scopes].sort(), ['openid', ...CAL_SCOPES].sort(), '最小 scope');
  assert.ok(!scopes.includes('email') && !scopes.includes('profile'), 'メールアドレスを取得しない');
  assert.equal(typeof gis.config.callback, 'function');
  assert.equal(typeof gis.config.error_callback, 'function', 'キャンセルを受け取れる');
});

test('1: 承認 → サーバー検証 → Sukima ログイン済み + Calendar 利用可能（状態 A）', async () => {
  const { page, fetchImpl, gis } = setup();
  page.call('doLogin');
  await grant(gis);
  await flush();

  const calls = sessionCalls(fetchImpl);
  assert.equal(calls.length, 1, 'セッション作成は 1 回');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer ' + TOKEN);
  assert.equal(fetchImpl.calls.filter((c) => c.url.includes('/api/auth/session')).length, 0,
    '旧 ID Token 経路は使わない');
  assert.equal(page.run('sukimaAuthenticated'), true);
  assert.equal(page.run('accessToken'), TOKEN);
  assert.equal(page.context.localStorage.getItem('gtoken'), TOKEN);
  assert.ok(Number(page.context.localStorage.getItem('gtoken_expiry')) > Date.now());
  assert.equal(page.call('getAuthState'), 'A');
  assert.equal(display(page, 'formSection'), 'block');
  assert.equal(display(page, 'loginSection'), 'none');
  assert.equal(gis.requests.length, 1, '2 回目の Google 画面を開かない');
  assert.equal(gis.idCalls, 0, 'google.accounts.id は使わない');
});

test('1: access token は google-session 以外の Sukima API へ送らない', async () => {
  const { page, fetchImpl, gis } = setup();
  page.call('doLogin');
  await grant(gis);
  await flush();
  const leaked = fetchImpl.calls.filter((c) => c.url.startsWith('/api/')
    && !c.url.includes('/api/auth/google-session')
    && JSON.stringify(c.init || {}).includes(TOKEN));
  assert.deepEqual(leaked, []);
});

// ---------------------------------------------------------
// 2. セッションあり + Calendar token あり → Google UI を出さない
// ---------------------------------------------------------

test('2: 状態 A では Google ボタンを出さず、Google の画面も開かない', async () => {
  const { page, gis } = setup({ state: 'A' });
  assert.equal(display(page, 'loginBtn'), 'none');
  assert.equal(display(page, 'formSection'), 'block');
  await flush();
  assert.equal(gis.requests.length, 0);
});

// ---------------------------------------------------------
// 3. セッションあり + Calendar token なし → 二重ログインにしない
// ---------------------------------------------------------

test('3: 状態 B は同じ 1 つのボタンで、文言は「カレンダーと連携」', () => {
  const { page } = setup({ state: 'B' });
  assert.equal(display(page, 'loginBtn'), '');
  assert.equal(page.el('loginBtn').textContent, page.call('t', 'connectCalendarBtn'));
  assert.equal(display(page, 'accountSection'), '', 'ログアウト・削除の導線は残す');
});

test('3: 状態 B ではクリック 1 回 = Google の画面 1 回で、アカウント選択を省く（prompt: \'\'）', async () => {
  const { page, fetchImpl, gis } = setup({ state: 'B' });
  page.call('doLogin');
  assert.equal(gis.requests.length, 1);
  assert.equal(gis.requests[0].prompt, '');
  await grant(gis);
  await flush();
  assert.equal(page.call('getAuthState'), 'A');
  assert.equal(sessionCalls(fetchImpl).length, 1, '選んだアカウントでセッションを作り直す');
  assert.equal(gis.requests.length, 1, '追加の Google 画面は開かない');
});

test('3: 別アカウントで入り直した場合に前の契約表示（entitlement）を引き継がない', async () => {
  const { page, gis } = setup({ state: 'B' });
  page.run('sukimaEntitlement = { web: true, extension: false };');
  page.call('doLogin');
  await grant(gis);
  await flush();
  // セッションを作り直したら /api/auth/me の値で取り直す。
  assert.deepEqual(JSON.parse(JSON.stringify(page.run('sukimaEntitlement'))), { web: false, extension: false });
});

// ---------------------------------------------------------
// 4 / 5. 不正・期限切れ・別 client_id の token → セッションを作らない
// ---------------------------------------------------------

test('4: サーバーが 401（不正・期限切れ・別 client_id）なら未ログインのまま、token も保存しない', async () => {
  const { page, gis } = setup({ session: () => jsonResponse(401, { error: 'invalid_token' }) });
  page.call('doLogin');
  await grant(gis);
  await flush();
  assert.equal(page.run('sukimaAuthenticated'), false);
  assert.equal(page.run('accessToken'), null, '本人確認が通らない token は Calendar にも使わない');
  assert.equal(page.context.localStorage.getItem('gtoken'), null);
  assert.equal(page.call('getAuthState'), 'D');
  assert.equal(page.el('status').textContent, page.call('t', 'signInFailed'));
  assert.equal(display(page, 'loginBtn'), '', '再試行できる');
});

test('4: サーバー障害（5xx）・通信失敗でも token を保存せず、理由を出す', async () => {
  for (const [respond, key] of [
    [() => jsonResponse(503, { error: 'verification_unavailable' }), 'authServiceError'],
    [async () => { throw new TypeError('Failed to fetch'); }, 'sessionCheckFailed'],
  ]) {
    const { page, gis } = setup({ session: respond });
    page.call('doLogin');
    await grant(gis);
    await flush();
    assert.equal(page.run('sukimaAuthenticated'), false);
    assert.equal(page.run('accessToken'), null);
    assert.equal(page.el('status').textContent, page.call('t', key));
  }
});

test('4: Google が error を返したら送信しない', async () => {
  const { page, fetchImpl, gis } = setup();
  page.call('doLogin');
  await gis.config.callback({ error: 'access_denied' });
  await flush();
  assert.equal(sessionCalls(fetchImpl).length, 0);
  assert.equal(page.el('status').textContent, page.call('t', 'loginFailed'));
});

// ---------------------------------------------------------
// 6. 必要 scope 不足 → Calendar 連携成功扱いにしない
// ---------------------------------------------------------

test('6: サーバーが calendar_scopes_granted: false なら状態 B（token は保存しない）', async () => {
  const { page, gis } = setup({
    session: () => jsonResponse(200, { ...SESSION_OK, calendar_scopes_granted: false }),
  });
  page.call('doLogin');
  await grant(gis, { scope: 'openid' });
  await flush();
  assert.equal(page.run('sukimaAuthenticated'), true, '本人確認は済んでいる');
  assert.equal(page.run('accessToken'), null);
  assert.equal(page.context.localStorage.getItem('gtoken'), null);
  assert.equal(page.call('getAuthState'), 'B');
  assert.equal(page.el('status').textContent, page.call('t', 'calendarScopeMissing'));
  assert.equal(display(page, 'formSection'), 'none');
});

test('6: サーバーが付与済みと言っても、GIS の判定で不足なら連携成功扱いにしない', async () => {
  const { page, gis } = setup({ hasGrantedAllScopes: () => false });
  page.call('doLogin');
  await grant(gis);
  await flush();
  assert.equal(page.run('accessToken'), null);
  assert.equal(page.call('getAuthState'), 'B');
});

test('6: GIS の hasGrantedAllScopes に Calendar の scope を渡している', async () => {
  const seen = [];
  const { gis, page } = setup({ hasGrantedAllScopes: (resp, ...scopes) => { seen.push(scopes); return true; } });
  page.call('doLogin');
  await grant(gis);
  await flush();
  assert.deepEqual(seen[0], CAL_SCOPES);
});

// ---------------------------------------------------------
// 7. キャンセル → UI が壊れない
// ---------------------------------------------------------

test('7: ポップアップを閉じたら案内を出し、状態は変えず、ボタンは押し直せる', () => {
  const { page, fetchImpl, gis } = setup();
  page.el('searchBtn').disabled = true;
  page.call('doLogin');
  gis.config.error_callback({ type: 'popup_closed' });
  assert.equal(page.el('status').textContent, page.call('t', 'googleSignInNotCompleted'));
  assert.equal(page.call('getAuthState'), 'D');
  assert.equal(display(page, 'loginBtn'), '');
  assert.equal(page.el('searchBtn').disabled, false);
  assert.equal(sessionCalls(fetchImpl).length, 0);
  page.call('doLogin');
  assert.equal(gis.requests.length, 2, 'もう一度押せば開き直せる');
});

test('7: ポップアップを開けなかったら許可を促す案内を出す', () => {
  const { page, gis } = setup();
  page.call('doLogin');
  gis.config.error_callback({ type: 'popup_failed_to_open' });
  assert.equal(page.el('status').textContent, page.call('t', 'googlePopupFailed'));
});

test('7: 状態 B でキャンセルしても本人確認は落とさない', () => {
  const { page, gis } = setup({ state: 'B' });
  page.call('doLogin');
  gis.config.error_callback({ type: 'popup_closed' });
  assert.equal(page.run('sukimaAuthenticated'), true);
  assert.equal(page.call('getAuthState'), 'B');
});

// ---------------------------------------------------------
// 二重発火の防止
// ---------------------------------------------------------

test('セッション作成中に 2 回目の callback が来ても送信は 1 回だけ', async () => {
  let release;
  const { page, fetchImpl, gis } = setup({
    session: () => new Promise((r) => { release = () => r(jsonResponse(200, SESSION_OK)); }),
  });
  page.call('doLogin');
  const first = grant(gis);
  await Promise.resolve();
  await grant(gis);
  assert.equal(page.el('status').textContent, page.call('t', 'signInInProgress'));
  release();
  await first;
  await flush();
  assert.equal(sessionCalls(fetchImpl).length, 1);
});

test('処理中にボタンを押しても Google の画面を開かず「ログイン処理中」を出す', () => {
  const { page, gis } = setup();
  page.run('sukimaAuthBusy = true;');
  page.call('doLogin');
  assert.equal(gis.requests.length, 0);
  assert.equal(page.el('status').textContent, page.call('t', 'signInInProgress'));
});

// ---------------------------------------------------------
// 8. 既存セッション復元（Cookie のみ。Google UI は出さない）
// ---------------------------------------------------------

test('8: /api/auth/me 200 + 保存済み Calendar token で状態 A に戻り、Google の画面は開かない', async () => {
  const { page, gis } = setup();
  page.run("accessToken = 'restored-token';");
  const r = await page.call('restoreSukimaSession');
  page.call('updateAuthUi');
  assert.equal(r, 'authenticated');
  assert.equal(page.call('getAuthState'), 'A');
  assert.equal(gis.requests.length, 0);
});

test('8: /api/auth/me 200 で Calendar token が無ければ状態 B（自動で Google を開かない）', async () => {
  const { page, gis } = setup();
  await page.call('restoreSukimaSession');
  page.call('updateAuthUi');
  assert.equal(page.call('getAuthState'), 'B');
  assert.equal(page.el('loginBtn').textContent, page.call('t', 'connectCalendarBtn'));
  assert.equal(gis.requests.length, 0);
});

test('8: /api/auth/me 401 なら状態 D のまま、Google の画面は開かない', async () => {
  const { page, gis } = setup({ me: () => jsonResponse(401, { error: 'unauthenticated' }) });
  const r = await page.call('restoreSukimaSession');
  page.call('updateAuthUi');
  assert.equal(r, 'unauthenticated');
  assert.equal(page.call('getAuthState'), 'D');
  assert.equal(gis.requests.length, 0);
});

// ---------------------------------------------------------
// 言語と作り（回帰防止）
// ---------------------------------------------------------

test('英語表示では英語の文言になる', () => {
  const { page } = setup();
  page.run("currentLang = 'en';");
  page.call('updateAuthUi');
  assert.equal(page.el('loginBtn').textContent, 'Sign in with Google and connect Calendar');
});

test('新しい文言は ja / en の両方にある', () => {
  const { page } = setup();
  for (const lang of ['ja', 'en']) {
    page.run('currentLang = ' + JSON.stringify(lang) + ';');
    for (const key of ['signInWithGoogleBtn', 'connectCalendarBtn', 'calendarScopeMissing', 'googlePopupFailed']) {
      const v = page.call('t', key);
      assert.ok(typeof v === 'string' && v.length > 0 && v !== key, lang + ':' + key);
    }
  }
});

test('markup: Google 系のボタンは #loginBtn の 1 つだけ（旧 #gsiButton は無い）', () => {
  const html = fs.readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');
  assert.ok(!html.includes('id="gsiButton"'));
  assert.ok(!html.includes('google.accounts.id'), 'google.accounts.id を使わない');
  assert.equal((html.match(/id="loginBtn"/g) || []).length, 1);
});

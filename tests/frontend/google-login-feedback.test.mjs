// =========================================================
// public/index.html の Google ログイン（本人確認）案内テスト
//
//   実際の inline script を vm へ読み込み、google.accounts.id はスタブにする。
//   renderButton に渡された click_listener と initialize に渡された callback を
//   テストから直接呼び、「無言で戻る／反応しない」経路が無いことを確かめる。
//
//   popup 方式では「閉じられた」を受け取れないため、
//   時間切れは案内文を変えるだけで、認証状態・session・Calendar token には触れない。
//   fetch はすべてスタブ。Google へも本番 DB へも出ない。
// =========================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { jsonResponse, loadPage, makeFetch } from './page-harness.mjs';

const SESSION_OK = { plan_id: 'free', status: 'active' };
const ME_OK = {
  authenticated: true, plan_id: 'free', status: 'active',
  entitlement: { web: false, extension: false },
  current_period_end: null, cancel_at_period_end: false, currency: null,
  price_phase: null, amount: null, tax_behavior: null, next_phase_amount: null, grace_until: null,
};

/**
 * 状態 D（未ログイン・Calendar 未連携）のページを作り、GIS を初期化する。
 *
 *   session: '/api/auth/session' の応答を返す関数（省略時は 200）
 */
function setup({ session } = {}) {
  const fetchImpl = makeFetch([
    [(u) => u.includes('/api/auth/session'), session || (() => jsonResponse(200, SESSION_OK))],
    [(u) => u.includes('/api/auth/me'), () => jsonResponse(200, ME_OK)],
    [(u) => u.includes('/api/user/timezone'), () => jsonResponse(200, { ok: true })],
    [(u) => u.includes('/api/quota/status'), () => jsonResponse(200, { quota_enforced: false })],
  ]);
  const page = loadPage({ fetchImpl });

  const gis = { initConfig: null, buttonConfigs: [], tokenRequests: 0 };
  page.context.google = {
    accounts: {
      id: {
        initialize(cfg) { gis.initConfig = cfg; },
        renderButton(host, cfg) { gis.buttonConfigs.push(cfg); },
        disableAutoSelect() {},
        prompt() {},
      },
      oauth2: {
        initTokenClient: () => ({ requestAccessToken() { gis.tokenRequests += 1; } }),
        revoke() {},
      },
    },
  };

  // setTimeout は差し替え、案内の切り替えをテストから任意の時点で起こせるようにする。
  const timers = [];
  const realSetTimeout = page.context.setTimeout;
  page.context.setTimeout = (fn, ms, ...args) => {
    if (ms === page.run('GSI_PENDING_HINT_MS')) {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    }
    return realSetTimeout(fn, ms, ...args);
  };
  const realClearTimeout = page.context.clearTimeout;
  page.context.clearTimeout = (h) => {
    if (h && typeof h === 'object' && 'cleared' in h) { h.cleared = true; return; }
    return realClearTimeout(h);
  };
  const firePendingTimers = () => {
    for (const tm of timers) if (!tm.cleared) { tm.cleared = true; tm.fn(); }
  };

  page.el('loginBtn').style.display = 'none';
  assert.equal(page.call('initGoogleIdentityNow'), true);
  page.call('updateAuthUi');

  const button = () => gis.buttonConfigs[gis.buttonConfigs.length - 1];
  return { page, fetchImpl, gis, button, timers, firePendingTimers };
}

const status = (page) => page.el('status').textContent;
const tr = (page, key) => page.call('t', key);
const sessionCalls = (fetchImpl) => fetchImpl.calls.filter((c) => c.url.includes('/api/auth/session'));
/** fetch の後続（timezone / quota / me）まで含めて落ち着くのを待つ。 */
const settle = () => new Promise((r) => setTimeout(r, 20));

// ---------------------------------------------------------
// 設定
// ---------------------------------------------------------

test('renderButton に click_listener を渡している（popup 方式のまま）', () => {
  const { page, gis, button } = setup();
  assert.equal(typeof button().click_listener, 'function');
  assert.equal(button().click_listener, page.context.handleGoogleIdentityButtonClick);
  // redirect 方式へは変えていない
  assert.equal(button().ux_mode, undefined);
  assert.equal(button().login_uri, undefined);
  assert.equal(gis.initConfig.ux_mode, undefined);
  assert.equal(gis.initConfig.login_uri, undefined);
  assert.equal(gis.initConfig.callback, page.context.handleGoogleIdentityCredential);
});

// ---------------------------------------------------------
// A. Google ボタン押下 → 案内表示
// ---------------------------------------------------------

test('A: Google ボタンを押すと「Google 画面で操作を完了してください」を表示する', () => {
  const { page, fetchImpl, button } = setup();
  button().click_listener();

  assert.equal(status(page), tr(page, 'googleSignInPending'));
  // 表示だけ。認証状態は変えず、通信もしない
  assert.equal(page.call('getAuthState'), 'D');
  assert.equal(fetchImpl.calls.length, 0);
  assert.notEqual(page.el('gsiButton').style.display, 'none');
});

test('A: 英語表示では英語の案内になる', () => {
  const { page, button } = setup();
  page.run("currentLang = 'en';");
  button().click_listener();
  assert.equal(status(page), 'Please finish signing in on the Google screen.');
});

test('A: callback が来ないまま時間が経つと「完了していません」へ変わるが、状態は変えない', () => {
  const { page, fetchImpl, button, timers, firePendingTimers } = setup();
  page.context.localStorage.setItem('gtoken', 'keep-me');
  button().click_listener();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 30000);

  firePendingTimers();

  assert.equal(status(page), tr(page, 'googleSignInNotCompleted'));
  // 失敗と断定しない: 自動 logout / 再試行 / session 削除 / Calendar token 操作をしない
  assert.equal(page.call('getAuthState'), 'D');
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(page.context.localStorage.getItem('gtoken'), 'keep-me');
  // Google ボタンは再度押せるまま
  assert.notEqual(page.el('gsiButton').style.display, 'none');
});

test('A: 押し直すと案内を出し直し、前のタイマーは捨てる', () => {
  const { page, button, timers } = setup();
  button().click_listener();
  button().click_listener();
  assert.equal(timers.length, 2);
  assert.equal(timers[0].cleared, true);
  assert.equal(timers[1].cleared, false);
  assert.equal(status(page), tr(page, 'googleSignInPending'));
});

// ---------------------------------------------------------
// B. credential callback 到達 → 案内解除 → ログイン処理表示
// ---------------------------------------------------------

test('B: callback が来たら待ちの案内を解除し「ログインしています...」へ進む', async () => {
  let release;
  const pending = new Promise((r) => { release = r; });
  const { page, fetchImpl, gis, button, timers } = setup({
    session: () => pending.then(() => jsonResponse(200, SESSION_OK)),
  });
  button().click_listener();

  gis.initConfig.callback({ credential: 'header.payload.sig' });

  assert.equal(status(page), tr(page, 'signingIn'));
  assert.equal(page.run('gsiSignInPending'), false);
  assert.equal(timers[0].cleared, true);
  assert.equal(sessionCalls(fetchImpl).length, 1);

  release();
  await settle();
});

test('B: callback 後にタイマーが走っても案内を上書きしない', async () => {
  const { page, gis, button, timers } = setup();
  button().click_listener();
  const timer = timers[0];
  gis.initConfig.callback({ credential: 'header.payload.sig' });
  await settle();

  // clearTimeout 済みだが、仮に発火しても待ち状態ではないので何もしない
  timer.fn();
  assert.equal(status(page), '');
  assert.equal(page.call('getAuthState'), 'B');
});

// ---------------------------------------------------------
// C. sukimaAuthBusy 中の callback → 追加送信しない・処理中を表示
// ---------------------------------------------------------

test('C: busy 中に callback が来ても session を追加送信せず「ログイン処理中」を表示する', () => {
  const { page, fetchImpl, gis } = setup();
  page.run('sukimaAuthBusy = true;');

  gis.initConfig.callback({ credential: 'header.payload.sig' });

  assert.equal(sessionCalls(fetchImpl).length, 0);
  assert.equal(status(page), tr(page, 'signInInProgress'));
  assert.equal(page.call('getAuthState'), 'D');
});

test('C: 1 回目の session 待ちの間に 2 回目の callback が来ても fetch は 1 回だけ', async () => {
  let release;
  const pending = new Promise((r) => { release = r; });
  const { page, fetchImpl, gis } = setup({
    session: () => pending.then(() => jsonResponse(200, SESSION_OK)),
  });

  gis.initConfig.callback({ credential: 'first.token.sig' });
  gis.initConfig.callback({ credential: 'second.token.sig' });

  assert.equal(sessionCalls(fetchImpl).length, 1);
  assert.equal(status(page), tr(page, 'signInInProgress'));

  release();
  await settle();
  assert.equal(sessionCalls(fetchImpl).length, 1);
  assert.equal(page.call('getAuthState'), 'B');
  assert.equal(page.run('sukimaAuthBusy'), false);
});

test('C: busy 中に Google ボタンを押すと「ログイン処理中」を表示し、待ちの案内は始めない', () => {
  const { page, button, timers } = setup();
  page.run('sukimaAuthBusy = true;');
  button().click_listener();
  assert.equal(status(page), tr(page, 'signInInProgress'));
  assert.equal(timers.length, 0);
  assert.equal(page.run('gsiSignInPending'), false);
});

// ---------------------------------------------------------
// D. 通常成功 → 既存どおり状態 B
// ---------------------------------------------------------

test('D: ボタン押下 → callback → session 200 で状態 B（Calendar 連携ボタン表示）', async () => {
  const { page, fetchImpl, gis, button } = setup();
  button().click_listener();
  gis.initConfig.callback({ credential: 'header.payload.sig' });
  await settle();

  assert.equal(page.call('getAuthState'), 'B');
  assert.equal(status(page), '');
  assert.equal(page.el('gsiButton').style.display, 'none');
  assert.equal(page.el('loginBtn').style.display, '');
  assert.equal(page.run('sukimaAuthBusy'), false);

  const s = sessionCalls(fetchImpl);
  assert.equal(s.length, 1);
  assert.equal(s[0].method, 'POST');
  assert.equal(s[0].init.headers.Authorization, 'Bearer header.payload.sig');
});

// ---------------------------------------------------------
// E. credential 無し → 既存のエラー表示
// ---------------------------------------------------------

test('E: credential が無ければ既存の「ログインできませんでした」を表示し、送信しない', () => {
  for (const response of [undefined, {}, { credential: '' }, { credential: 123 }]) {
    const { page, fetchImpl, gis, button } = setup();
    button().click_listener();
    gis.initConfig.callback(response);
    assert.equal(status(page), tr(page, 'signInFailed'));
    assert.equal(page.run('gsiSignInPending'), false);
    assert.equal(fetchImpl.calls.length, 0);
    assert.equal(page.call('getAuthState'), 'D');
  }
});

test('E: session が 401 なら既存どおり「ログインできませんでした」で状態 D のまま', async () => {
  const { page, gis } = setup({ session: () => jsonResponse(401, { error: 'invalid_token' }) });
  gis.initConfig.callback({ credential: 'header.payload.sig' });
  await settle();
  assert.equal(status(page), tr(page, 'signInFailed'));
  assert.equal(page.call('getAuthState'), 'D');
  assert.equal(page.run('sukimaAuthBusy'), false);
});

// ---------------------------------------------------------
// F. Calendar OAuth と通常経路が壊れていない
// ---------------------------------------------------------

test('F: ログイン成功後、Calendar 連携は利用者のクリックでだけ開く（自動では開かない）', async () => {
  const { page, gis, button } = setup();
  button().click_listener();
  gis.initConfig.callback({ credential: 'header.payload.sig' });
  await settle();
  assert.equal(gis.tokenRequests, 0);

  page.call('doLogin');
  assert.equal(gis.tokenRequests, 1);
});

test('F: Google ボタンの押下・時間切れは Calendar 認可を要求しない', () => {
  const { gis, button, firePendingTimers } = setup();
  button().click_listener();
  firePendingTimers();
  assert.equal(gis.tokenRequests, 0);
});

test('F: ログアウト後に描き直したボタンにも click_listener が付く', async () => {
  const { page, gis, button } = setup();
  gis.initConfig.callback({ credential: 'header.payload.sig' });
  await settle();
  const before = gis.buttonConfigs.length;
  page.call('renderGoogleIdentityButton');
  assert.equal(gis.buttonConfigs.length, before + 1);
  assert.equal(typeof button().click_listener, 'function');
});

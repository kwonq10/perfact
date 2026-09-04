// =========================================================
// /api/ext/link/{start,issue} の単体テスト
//
//   - Supabase RPC / session はすべてスタブ。ネットワークへは出ない。
//   - 本番の secret / 拡張機能 ID はフィクスチャに保存しない（ダミーを使う）。
// =========================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRedirectUri, handleLinkStart } from '../ext/link/start.js';
import { handleLinkIssue } from '../ext/link/issue.js';
import { SESSION_COOKIE_NAME, SESSION_RESULT } from '../_lib/session.js';

const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';
const OTHER_EXT_ID = 'ponmlkjihgfedcbaponmlkjihgfedcba';

const ENV = {
  SUPABASE_URL: 'https://example-project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_dummy_for_tests_only',
  EXTENSION_IDS: EXT_ID,
};

const quiet = { error() {}, warn() {}, log() {} };

/** 本番の canonical host。_lib/origin.js の既定 allowlist と同じ値。 */
const ORIGIN = 'https://sukimacalendar.com';

const USER_ID = '11111111-2222-3333-4444-555555555555';
const STATE = 'abcdef0123456789';
const TOKEN = 'dummy_session_token_value';

function validContext(over = {}) {
  return { user_id: USER_ID, plan_id: 'free', status: 'active', ...over };
}

function stubSession(result = { status: SESSION_RESULT.VALID, context: validContext() }) {
  const calls = [];
  const fn = async (...a) => { calls.push(a); return result; };
  fn.calls = calls;
  return fn;
}

// =========================================================
// /api/ext/link/start
// =========================================================

function startReq({ extId = EXT_ID, state = STATE, method = 'GET' } = {}) {
  const url = new URL('https://sukimacalendar.com/api/ext/link/start');
  if (extId !== null) url.searchParams.set('ext_id', extId);
  if (state !== null) url.searchParams.set('state', state);
  return new Request(url.toString(), {
    method,
    headers: { cookie: `${SESSION_COOKIE_NAME}=dummytoken` },
  });
}

test('start: buildRedirectUri は許可済み ID から組み立てる', () => {
  assert.equal(buildRedirectUri(EXT_ID), `https://${EXT_ID}.chromiumapp.org/link`);
});

test('start: ログイン済みなら確認ページを返す', async () => {
  const res = await handleLinkStart(startReq(), ENV, { logger: quiet, session: stubSession() });
  const body = await res.text();

  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('vary'), 'Cookie');
  assert.match(body, /data-state="ready"/);
  assert.match(body, /連携する/);
  assert.equal(body.includes(buildRedirectUri(EXT_ID)), true, 'リダイレクト先が埋め込まれる');
  assert.equal(body.includes(STATE), true, 'state が埋め込まれる');
});

test('start: 確認ページは自動送信しない（クリックが必須）', async () => {
  const res = await handleLinkStart(startReq(), ENV, { logger: quiet, session: stubSession() });
  const body = await res.text();

  assert.equal(body.includes('addEventListener(\'click\''), true, 'クリックで発火する');
  assert.equal(/\.click\(\)/.test(body), false, '自動クリックしてはいけない');
  assert.equal(/DOMContentLoaded[\s\S]{0,200}fetch\(/.test(body), false, '自動送信してはいけない');
});

test('start: CSP と nonce が付く', async () => {
  const res = await handleLinkStart(startReq(), ENV, { logger: quiet, session: stubSession() });
  const csp = res.headers.get('content-security-policy');

  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'nonce-/);
  assert.equal(csp.includes("'unsafe-inline'"), false, 'unsafe-inline を許可しない');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
});

test('start: 未ログインならログイン案内を返す（発行はしない）', async () => {
  const session = stubSession({ status: SESSION_RESULT.UNAUTHENTICATED, reason: 'no_cookie' });
  const res = await handleLinkStart(startReq(), ENV, { logger: quiet, session });
  const body = await res.text();

  assert.equal(res.status, 200);
  assert.match(body, /data-state="needs_login"/);
  assert.equal(body.includes('/api/ext/link/issue'), false, '発行用のスクリプトを出さない');
});

test('start: 許可されていない拡張機能 ID は 400', async () => {
  const res = await handleLinkStart(
    startReq({ extId: OTHER_EXT_ID }), ENV, { logger: quiet, session: stubSession() },
  );
  const body = await res.text();

  assert.equal(res.status, 400);
  assert.match(body, /data-state="invalid_extension"/);
});

test('start: EXTENSION_IDS 未設定なら誰も連携できない', async () => {
  const res = await handleLinkStart(startReq(), {}, { logger: quiet, session: stubSession() });
  assert.equal(res.status, 400);
});

test('start: state の形式が不正なら 400（埋め込まない）', async () => {
  const bad = [
    'short',
    '<script>alert(1)</script>',
    'a'.repeat(129),
    'has space',
    '"onload="x',
  ];
  for (const state of bad) {
    const res = await handleLinkStart(
      startReq({ state }), ENV, { logger: quiet, session: stubSession() },
    );
    const body = await res.text();
    assert.equal(res.status, 400, state);
    assert.equal(body.includes(state), false, 'state を出力してはいけない: ' + state);
  }
});

test('start: state が無ければ 400', async () => {
  const res = await handleLinkStart(
    startReq({ state: null }), ENV, { logger: quiet, session: stubSession() },
  );
  assert.equal(res.status, 400);
});

test('start: GET 以外は 405', async () => {
  const res = await handleLinkStart(
    startReq({ method: 'POST' }), ENV, { logger: quiet, session: stubSession() },
  );
  assert.equal(res.status, 405);
});

test('start: セッション確認に失敗したら 503（発行しない）', async () => {
  const session = stubSession({ status: SESSION_RESULT.UNAVAILABLE, reason: 'unavailable' });
  const res = await handleLinkStart(startReq(), ENV, { logger: quiet, session });
  assert.equal(res.status, 503);
});

test('start: 拡張 origin 向けの CORS ヘッダは付けない', async () => {
  const res = await handleLinkStart(startReq(), ENV, { logger: quiet, session: stubSession() });
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

// =========================================================
// /api/ext/link/issue
// =========================================================

function issueReq({
  method = 'POST',
  body = JSON.stringify({ extension_id: EXT_ID }),
  origin = ORIGIN,
  contentType = 'application/json',
  cookie = `${SESSION_COOKIE_NAME}=dummytoken`,
} = {}) {
  const headers = {};
  if (origin !== null) headers.origin = origin;
  if (contentType !== null) headers['content-type'] = contentType;
  if (cookie !== null) headers.cookie = cookie;
  const init = { method, headers };
  if (method !== 'GET' && body !== null) init.body = body;
  return new Request('https://sukimacalendar.com/api/ext/link/issue', init);
}

function stubIssue(result = {
  ok: true,
  token: TOKEN,
  row: { plan_id: 'free', status: 'active', idle_expires_at: '2026-10-01T00:00:00Z' },
}) {
  const calls = [];
  const fn = async (...a) => { calls.push(a); return result; };
  fn.calls = calls;
  return fn;
}

function issueDeps(over = {}) {
  return { logger: quiet, session: stubSession(), issue: stubIssue(), ...over };
}

test('issue: 正常系はトークンと plan を返す', async () => {
  const issue = stubIssue();
  const res = await handleLinkIssue(issueReq(), ENV, issueDeps({ issue }));
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.session_token, TOKEN);
  assert.equal(body.plan_id, 'free');
  assert.equal(body.status, 'active');
  assert.equal(body.expires_at, '2026-10-01T00:00:00Z');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('vary'), 'Cookie');

  // user_id はセッションから取り、レスポンスには出さない
  assert.equal(issue.calls[0][1], USER_ID);
  assert.equal(JSON.stringify(body).includes(USER_ID), false, 'user_id を返してはいけない');
});

test('issue: 既存の Web allowlist で Origin を検証する', async () => {
  for (const origin of ['https://evil.example', 'chrome-extension://' + EXT_ID, null]) {
    const res = await handleLinkIssue(issueReq({ origin }), ENV, issueDeps());
    assert.equal(res.status, 403, String(origin));
    assert.deepEqual(await res.json(), { error: 'forbidden_origin' });
  }
});

test('issue: 拡張向け CORS ヘッダは付けない', async () => {
  const res = await handleLinkIssue(issueReq(), ENV, issueDeps());
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('issue: POST 以外は 405', async () => {
  const res = await handleLinkIssue(issueReq({ method: 'GET' }), ENV, issueDeps());
  assert.equal(res.status, 405);
});

test('issue: 許可されていない拡張機能 ID は 400（発行しない）', async () => {
  const issue = stubIssue();
  const res = await handleLinkIssue(
    issueReq({ body: JSON.stringify({ extension_id: OTHER_EXT_ID }) }),
    ENV,
    issueDeps({ issue }),
  );

  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'invalid_extension_id' });
  assert.equal(issue.calls.length, 0);
});

test('issue: body が不正なら 400 系（発行しない）', async () => {
  const cases = [
    [issueReq({ contentType: 'text/plain' }), 400, 'invalid_content_type'],
    [issueReq({ body: '{' }), 400, 'malformed_json'],
    [issueReq({ body: '[]' }), 400, 'invalid_body'],
    [issueReq({ body: JSON.stringify({}) }), 400, 'invalid_extension_id'],
  ];
  for (const [request, status, code] of cases) {
    const issue = stubIssue();
    const res = await handleLinkIssue(request, ENV, issueDeps({ issue }));
    assert.equal(res.status, status, code);
    assert.deepEqual(await res.json(), { error: code });
    assert.equal(issue.calls.length, 0);
  }
});

test('issue: 未ログインは 401 で Cookie を消す', async () => {
  const issue = stubIssue();
  const session = stubSession({ status: SESSION_RESULT.UNAUTHENTICATED, reason: 'no_cookie' });
  const res = await handleLinkIssue(issueReq(), ENV, issueDeps({ session, issue }));

  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: 'unauthenticated' });
  assert.match(res.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal(issue.calls.length, 0);
});

test('issue: セッションのデータ異常は 401 に丸めない', async () => {
  const session = stubSession({ status: SESSION_RESULT.DATA_ERROR, reason: 'missing_subscription' });
  const res = await handleLinkIssue(issueReq(), ENV, issueDeps({ session }));
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: 'internal_error' });
});

test('issue: Supabase 到達不能は 502', async () => {
  const session = stubSession({ status: SESSION_RESULT.UNAVAILABLE, reason: 'unavailable' });
  const res = await handleLinkIssue(issueReq(), ENV, issueDeps({ session }));
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: 'database_unavailable' });
});

test('issue: 発行失敗をステータスへ写す', async () => {
  const cases = [
    ['database_unavailable', 502],
    ['server_misconfigured', 500],
    ['internal_error', 500],
    ['user_not_found', 500],
  ];
  for (const [code, status] of cases) {
    const issue = stubIssue({ ok: false, code });
    const res = await handleLinkIssue(issueReq(), ENV, issueDeps({ issue }));
    assert.equal(res.status, status, code);
    assert.deepEqual(await res.json(), { error: code });
  }
});

test('issue: 処理順は method -> Origin -> body -> session', async () => {
  // Origin が不正なら session を引かない
  const session = stubSession();
  await handleLinkIssue(issueReq({ origin: 'https://evil.example' }), ENV, issueDeps({ session }));
  assert.equal(session.calls.length, 0, 'Origin 不正で session を触らない');

  // body が不正でも session を引かない
  const session2 = stubSession();
  await handleLinkIssue(issueReq({ body: '{' }), ENV, issueDeps({ session: session2 }));
  assert.equal(session2.calls.length, 0, 'body 不正で session を触らない');
});

// =========================================================
// POST /api/auth/google-session と access token 検証の単体テスト
//
//   - 実 Google へは出ない。tokeninfo は fetch スタブで差し替える。
//   - 本番の client_id / secret はフィクスチャに保存しない。
//   - Supabase RPC はすべてスタブ。
// =========================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { handleGoogleSession } from '../auth/google-session.js';
import {
  CALENDAR_SCOPES,
  GOOGLE_TOKENINFO_URL,
  TokenVerificationError,
  validateTokenInfo,
  verifyGoogleAccessToken,
} from '../_lib/verifyGoogleAccessToken.js';
import { SESSION_COOKIE_NAME } from '../_lib/session.js';

// --- テスト用のダミー設定（本番値ではない） ---
const AUD = 'test-web-client.apps.googleusercontent.com';
const EXT_AUD = 'test-extension-client.apps.googleusercontent.com';
const OTHER_AUD = 'someone-else.apps.googleusercontent.com';
const ENV = {
  GOOGLE_CLIENT_IDS: AUD + ',' + EXT_AUD,
  SUPABASE_URL: 'https://example-project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_dummy_for_tests_only',
};
const IDLE = '2026-10-01T00:00:00Z';
const ABS = '2026-11-30T00:00:00Z';
const NOW = new Date('2026-09-01T00:00:00Z');
const ACCESS_TOKEN = 'ya29.test-access-token_ABC-123';
const FULL_SCOPE = ['openid', ...CALENDAR_SCOPES].join(' ');

const quiet = { error() {}, warn() {}, log() {} };
function recorder() {
  const lines = [];
  const push = (...a) => lines.push(a.map(String).join(' '));
  return { error: push, warn: push, log: push, lines };
}

/** tokeninfo の正常応答（overrides で上書き、undefined で削除）。 */
function tokenInfo(overrides = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  const base = {
    azp: AUD,
    aud: AUD,
    sub: '1234567890',
    scope: FULL_SCOPE,
    exp: String(nowSec + 3000),
    expires_in: '3000',
    email: 'tester@example.com',
    email_verified: 'true',
    access_type: 'online',
    ...overrides,
  };
  for (const k of Object.keys(base)) if (base[k] === undefined) delete base[k];
  return base;
}

/** tokeninfo の fetch スタブ。呼び出しを記録する。 */
function tokeninfoFetch(respond) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    return respond(url, init);
  };
  fn.calls = calls;
  return fn;
}
const jsonRes = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});

function okRpc() {
  const calls = [];
  const fn = async (name, args) => {
    calls.push({ name, args });
    return [{ plan_id: 'free', status: 'active', idle_expires_at: IDLE, absolute_expires_at: ABS }];
  };
  fn.calls = calls;
  return fn;
}

function req(method, headers = {}) {
  return new Request('https://example.com/api/auth/google-session', { method, headers });
}
const bearer = (t = ACCESS_TOKEN) => ({ authorization: 'Bearer ' + t });

/** 実際の verifyGoogleAccessToken を通し、tokeninfo だけを差し替える deps。 */
function depsWith(info, { status = 200, rpc = okRpc(), logger = quiet } = {}) {
  const fetchImpl = tokeninfoFetch(() => jsonRes(status, info));
  return {
    fetchImpl,
    rpc,
    deps: {
      verifyToken: (t, o) => verifyGoogleAccessToken(t, { ...o, fetchImpl }),
      rpc,
      logger,
      now: NOW,
      generateToken: () => 'A'.repeat(43),
    },
  };
}

// =========================================================
// validateTokenInfo（純粋関数）
// =========================================================

test('validateTokenInfo: 正常な tokeninfo から sub / email / Calendar 付与を得る', () => {
  const r = validateTokenInfo(tokenInfo(), { audiences: [AUD] });
  assert.deepEqual(r, { sub: '1234567890', email: 'tester@example.com', calendarGranted: true });
});

test('validateTokenInfo: 異なる client_id 向けの token は拒否する', () => {
  assert.throws(() => validateTokenInfo(tokenInfo({ aud: OTHER_AUD, azp: OTHER_AUD }), { audiences: [AUD] }),
    (e) => e instanceof TokenVerificationError && e.code === 'audience_mismatch');
});

test('validateTokenInfo: aud が無い token は拒否する', () => {
  assert.throws(() => validateTokenInfo(tokenInfo({ aud: undefined }), { audiences: [AUD] }),
    (e) => e.code === 'audience_mismatch');
});

test('validateTokenInfo: azp が aud と違えば拒否する', () => {
  assert.throws(() => validateTokenInfo(tokenInfo({ azp: OTHER_AUD }), { audiences: [AUD] }),
    (e) => e.code === 'audience_mismatch');
});

test('validateTokenInfo: 期限切れ（exp が過去）は拒否する', () => {
  const nowSec = Math.floor(Date.now() / 1000);
  assert.throws(() => validateTokenInfo(tokenInfo({ exp: String(nowSec - 1) }), { audiences: [AUD] }),
    (e) => e.code === 'token_expired');
});

test('validateTokenInfo: exp が無い／数値でなければ拒否する', () => {
  assert.throws(() => validateTokenInfo(tokenInfo({ exp: undefined }), { audiences: [AUD] }),
    (e) => e.code === 'token_expired');
  assert.throws(() => validateTokenInfo(tokenInfo({ exp: 'soon' }), { audiences: [AUD] }),
    (e) => e.code === 'token_expired');
});

test('validateTokenInfo: expires_in が 0 以下なら拒否する', () => {
  assert.throws(() => validateTokenInfo(tokenInfo({ expires_in: '0' }), { audiences: [AUD] }),
    (e) => e.code === 'token_expired');
});

test('validateTokenInfo: sub が無ければ拒否する', () => {
  assert.throws(() => validateTokenInfo(tokenInfo({ sub: undefined }), { audiences: [AUD] }),
    (e) => e.code === 'missing_subject');
  assert.throws(() => validateTokenInfo(tokenInfo({ sub: '' }), { audiences: [AUD] }),
    (e) => e.code === 'missing_subject');
});

test('validateTokenInfo: openid scope が無い token は本人確認に使わない', () => {
  assert.throws(() => validateTokenInfo(tokenInfo({ scope: CALENDAR_SCOPES.join(' ') }), { audiences: [AUD] }),
    (e) => e.code === 'insufficient_scope');
});

test('validateTokenInfo: Calendar scope が欠けると calendarGranted は false', () => {
  for (const missing of CALENDAR_SCOPES) {
    const scope = FULL_SCOPE.split(' ').filter((s) => s !== missing).join(' ');
    const r = validateTokenInfo(tokenInfo({ scope }), { audiences: [AUD] });
    assert.equal(r.calendarGranted, false, missing + ' が無いのに付与扱いになっている');
  }
});

test('validateTokenInfo: email は email_verified のときだけ使う', () => {
  assert.equal(validateTokenInfo(tokenInfo({ email_verified: 'false' }), { audiences: [AUD] }).email, null);
  assert.equal(validateTokenInfo(tokenInfo({ email_verified: undefined }), { audiences: [AUD] }).email, null);
});

test('validateTokenInfo: 許可リストが空なら設定エラー', () => {
  assert.throws(() => validateTokenInfo(tokenInfo(), { audiences: [] }),
    (e) => e.code === 'server_misconfigured');
});

// =========================================================
// verifyGoogleAccessToken（tokeninfo 呼び出し）
// =========================================================

test('verify: tokeninfo へ POST し、token を URL に載せない', async () => {
  const fetchImpl = tokeninfoFetch(() => jsonRes(200, tokenInfo()));
  await verifyGoogleAccessToken(ACCESS_TOKEN, { audiences: [AUD], fetchImpl });

  assert.equal(fetchImpl.calls.length, 1);
  const { url, init } = fetchImpl.calls[0];
  assert.equal(url, GOOGLE_TOKENINFO_URL);
  assert.ok(!url.includes(ACCESS_TOKEN), 'token が URL に載っている');
  assert.equal(init.method, 'POST');
  assert.equal(new URLSearchParams(init.body).get('access_token'), ACCESS_TOKEN);
});

test('verify: Google が 400（無効・期限切れ）を返したら invalid_token', async () => {
  const fetchImpl = tokeninfoFetch(() => jsonRes(400, { error: 'invalid_token' }));
  await assert.rejects(verifyGoogleAccessToken(ACCESS_TOKEN, { audiences: [AUD], fetchImpl }),
    (e) => e.code === 'invalid_token');
});

test('verify: Google が 5xx なら verification_unavailable', async () => {
  const fetchImpl = tokeninfoFetch(() => jsonRes(503, {}));
  await assert.rejects(verifyGoogleAccessToken(ACCESS_TOKEN, { audiences: [AUD], fetchImpl }),
    (e) => e.code === 'verification_unavailable');
});

test('verify: 通信失敗なら verification_unavailable', async () => {
  const fetchImpl = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(verifyGoogleAccessToken(ACCESS_TOKEN, { audiences: [AUD], fetchImpl }),
    (e) => e.code === 'verification_unavailable');
});

test('verify: 形式が明らかに不正な token は Google へ問い合わせない', async () => {
  const fetchImpl = tokeninfoFetch(() => jsonRes(200, tokenInfo()));
  for (const bad of ['has space', 'a&b=c', 'x'.repeat(5000)]) {
    await assert.rejects(verifyGoogleAccessToken(bad, { audiences: [AUD], fetchImpl }),
      (e) => e.code === 'malformed_token');
  }
  assert.equal(fetchImpl.calls.length, 0);
});

// =========================================================
// handleGoogleSession
// =========================================================

test('GET は 405', async () => {
  const res = await handleGoogleSession(req('GET'), ENV, { logger: quiet });
  assert.equal(res.status, 405);
});

test('Authorization が無ければ 400 missing_token', async () => {
  const res = await handleGoogleSession(req('POST'), ENV, { logger: quiet });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'missing_token' });
});

test('GOOGLE_CLIENT_IDS が未設定なら 500 で、Google へも DB へも行かない', async () => {
  const { deps, fetchImpl, rpc } = depsWith(tokenInfo());
  const res = await handleGoogleSession(req('POST', bearer()), { ...ENV, GOOGLE_CLIENT_IDS: '' }, deps);
  assert.equal(res.status, 500);
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(rpc.calls.length, 0);
});

test('正常系: 検証済み sub でセッションを発行し、__Host- Cookie を返す', async () => {
  const { deps, rpc } = depsWith(tokenInfo());
  const res = await handleGoogleSession(req('POST', bearer()), ENV, deps);

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { calendar_scopes_granted: true, plan_id: 'free', status: 'active' });
  const cookie = res.headers.get('set-cookie');
  assert.ok(cookie && cookie.startsWith(SESSION_COOKIE_NAME + '='), 'Cookie 名が既存と同じ');
  assert.ok(/HttpOnly/i.test(cookie) && /Secure/i.test(cookie) && /SameSite=Lax/i.test(cookie));
  assert.equal(rpc.calls.length, 1);
  assert.equal(rpc.calls[0].name, 'upsert_user_and_create_session', '既存と同じ RPC を使う');
  assert.equal(rpc.calls[0].args.p_google_sub, '1234567890');
  assert.equal(rpc.calls[0].args.p_email, 'tester@example.com');
});

test('openid だけの token（email が返らない）でも正常にセッションを作り、email は null で渡す', async () => {
  const { deps, rpc } = depsWith(tokenInfo({ email: undefined, email_verified: undefined }));
  const res = await handleGoogleSession(req('POST', bearer()), ENV, deps);
  assert.equal(res.status, 200);
  assert.equal(rpc.calls[0].args.p_google_sub, '1234567890');
  assert.equal(rpc.calls[0].args.p_email, null);
});

test('正常系: 応答にも Cookie にも access token / sub / email を含めない', async () => {
  const { deps } = depsWith(tokenInfo());
  const res = await handleGoogleSession(req('POST', bearer()), ENV, deps);
  const text = await res.text();
  const cookie = res.headers.get('set-cookie');
  for (const secret of [ACCESS_TOKEN, '1234567890', 'tester@example.com']) {
    assert.ok(!text.includes(secret), secret + ' が応答に含まれる');
    assert.ok(!cookie.includes(secret), secret + ' が Cookie に含まれる');
  }
});

test('不正／期限切れの Google token ではセッションを作らない（401）', async () => {
  const { deps, rpc } = depsWith({ error: 'invalid_token' }, { status: 400 });
  const res = await handleGoogleSession(req('POST', bearer()), ENV, deps);
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: 'invalid_token' });
  assert.equal(res.headers.get('set-cookie'), null);
  assert.equal(rpc.calls.length, 0);
});

test('tokeninfo が期限切れ相当（exp が過去）を返してもセッションを作らない', async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const { deps, rpc } = depsWith(tokenInfo({ exp: String(nowSec - 10), expires_in: '0' }));
  const res = await handleGoogleSession(req('POST', bearer()), ENV, deps);
  assert.equal(res.status, 401);
  assert.equal(rpc.calls.length, 0);
});

test('異なる client_id 向けの token は拒否する（401・セッションなし）', async () => {
  const { deps, rpc } = depsWith(tokenInfo({ aud: OTHER_AUD, azp: OTHER_AUD }));
  const res = await handleGoogleSession(req('POST', bearer()), ENV, deps);
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('set-cookie'), null);
  assert.equal(rpc.calls.length, 0);
});

test('openid scope が無い token ではセッションを作らない', async () => {
  const { deps, rpc } = depsWith(tokenInfo({ scope: CALENDAR_SCOPES.join(' ') }));
  const res = await handleGoogleSession(req('POST', bearer()), ENV, deps);
  assert.equal(res.status, 401);
  assert.equal(rpc.calls.length, 0);
});

test('Calendar scope 不足: 本人確認は通るが calendar_scopes_granted は false', async () => {
  const scope = 'openid';
  const { deps, rpc } = depsWith(tokenInfo({ scope }));
  const res = await handleGoogleSession(req('POST', bearer()), ENV, deps);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).calendar_scopes_granted, false);
  assert.equal(rpc.calls.length, 1);
});

test('Google 側の障害は 503 で、セッションを作らない', async () => {
  const { deps, rpc } = depsWith({}, { status: 500 });
  const res = await handleGoogleSession(req('POST', bearer()), ENV, deps);
  assert.equal(res.status, 503);
  assert.equal(rpc.calls.length, 0);
});

test('検証失敗のログに token 本体を出さない', async () => {
  const logger = recorder();
  const { deps } = depsWith(tokenInfo({ aud: OTHER_AUD, azp: OTHER_AUD }), { logger });
  await handleGoogleSession(req('POST', bearer()), ENV, deps);
  assert.ok(logger.lines.length > 0);
  assert.ok(logger.lines.every((l) => !l.includes(ACCESS_TOKEN)));
});

test('GOOGLE_CLIENT_IDS に含まれる別の自社 client_id（拡張用）も既存の ID Token 経路と同じく許可される', async () => {
  // 既存の /api/auth/session と同じ許可リストを使う（設定の追加をしない）。
  const { deps } = depsWith(tokenInfo({ aud: EXT_AUD, azp: EXT_AUD }));
  const res = await handleGoogleSession(req('POST', bearer()), ENV, deps);
  assert.equal(res.status, 200);
});

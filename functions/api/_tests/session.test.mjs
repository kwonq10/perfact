// =========================================================
// /api/auth/session の単体テスト
//
//   - 実 Google の ID Token は使わない。テスト実行のたびに RSA 鍵ペアを生成し、
//     jose で署名した「本物と同じ構造の」トークンを作って検証まで通す。
//   - 本番の secret / Project URL / client_id はフィクスチャに一切保存しない。
//   - ネットワークへは出ない（JWKS は鍵リゾルバを注入して差し替える）。
// =========================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT, generateKeyPair, exportJWK } from 'jose';

import { handleSession } from '../auth/session.js';
import {
  TokenVerificationError,
  extractBearerToken,
  getAllowedAudiences,
  validateClaims,
  decodeJwtUnsafe,
  verifyGoogleIdToken,
  isVerificationUnavailable,
} from '../_lib/verifyGoogleIdToken.js';
import {
  SupabaseError,
  callRpc,
  getSupabaseConfig,
  buildHeaders,
  scrubKey,
  isTransportError,
} from '../_lib/supabase.js';

// --- テスト用のダミー設定（本番値ではない） ---
const AUD = 'test-client-id.apps.googleusercontent.com';
const OTHER_AUD = 'someone-else.apps.googleusercontent.com';
const ENV = {
  GOOGLE_CLIENT_IDS: AUD,
  SUPABASE_URL: 'https://example-project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_dummy_for_tests_only',
};

const keys = await generateKeyPair('RS256', { extractable: true });
const otherKeys = await generateKeyPair('RS256', { extractable: true });

/** テスト用の ID Token を作る。claims で任意のクレームを上書きできる。 */
async function makeToken(claims = {}, opts = {}) {
  const now = Math.floor(Date.now() / 1000);
  const base = {
    iss: 'https://accounts.google.com',
    aud: AUD,
    sub: '1234567890',
    email: 'tester@example.com',
    email_verified: true,
    iat: now,
    exp: now + 3600,
    ...claims,
  };
  for (const k of Object.keys(base)) if (base[k] === undefined) delete base[k];
  return new SignJWT(base)
    .setProtectedHeader({ alg: opts.alg ?? 'RS256' })
    .sign(opts.key ?? keys.privateKey);
}

function req(method, headers = {}) {
  return new Request('https://example.com/api/auth/session', { method, headers });
}

/** 常に成功する RPC スタブ */
function okRpc(rows = [{ plan_id: 'free', status: 'active' }]) {
  const calls = [];
  const fn = async (name, args, options) => {
    calls.push({ name, args, options });
    return rows;
  };
  fn.calls = calls;
  return fn;
}

/** ログを飲み込むロガー（テスト出力を汚さない） */
const quiet = { error() {}, warn() {}, log() {} };

/** 署名検証まで実際に通す verifyToken（JWKS の代わりにローカル公開鍵を注入） */
const realVerify = (idToken, options) =>
  verifyGoogleIdToken(idToken, { ...options, keyResolver: keys.publicKey });

async function body(res) {
  return JSON.parse(await res.text());
}

// =========================================================
// メソッド / トークン取り出し
// =========================================================

test('GET は 405 method_not_allowed', async () => {
  const res = await handleSession(req('GET'), ENV, { logger: quiet });
  assert.equal(res.status, 405);
  assert.deepEqual(await body(res), { error: 'method_not_allowed' });
});

test('DELETE も 405', async () => {
  const res = await handleSession(req('DELETE'), ENV, { logger: quiet });
  assert.equal(res.status, 405);
});

test('Authorization ヘッダなし → 400 missing_token', async () => {
  const res = await handleSession(req('POST'), ENV, { logger: quiet });
  assert.equal(res.status, 400);
  assert.deepEqual(await body(res), { error: 'missing_token' });
});

test('Bearer 以外のスキーム → 400 missing_token', async () => {
  const res = await handleSession(req('POST', { authorization: 'Basic abc' }), ENV, { logger: quiet });
  assert.equal(res.status, 400);
});

test('Bearer だけで値なし → 400 missing_token', async () => {
  const res = await handleSession(req('POST', { authorization: 'Bearer   ' }), ENV, { logger: quiet });
  assert.equal(res.status, 400);
});

test('extractBearerToken は大文字小文字を無視し前後空白を除く', () => {
  assert.equal(extractBearerToken('bearer  abc.def.ghi  '), 'abc.def.ghi');
  assert.equal(extractBearerToken('Bearer\tabc'), 'abc');
  assert.equal(extractBearerToken('abc'), null);
  assert.equal(extractBearerToken(null), null);
});

// =========================================================
// トークン不正系（すべて 401 invalid_token に丸める）
// =========================================================

test('malformed Bearer（JWT の形をしていない） → 401', async () => {
  const res = await handleSession(
    req('POST', { authorization: 'Bearer not-a-jwt' }), ENV,
    { verifyToken: realVerify, logger: quiet });
  assert.equal(res.status, 401);
  assert.deepEqual(await body(res), { error: 'invalid_token' });
});

test('セグメント数は合うが中身が壊れている → 401', async () => {
  const res = await handleSession(
    req('POST', { authorization: 'Bearer aaa.bbb.ccc' }), ENV,
    { verifyToken: realVerify, logger: quiet });
  assert.equal(res.status, 401);
});

test('別の鍵で署名された JWT → 401（署名検証失敗）', async () => {
  const token = await makeToken({}, { key: otherKeys.privateKey });
  const res = await handleSession(
    req('POST', { authorization: `Bearer ${token}` }), ENV,
    { verifyToken: realVerify, logger: quiet });
  assert.equal(res.status, 401);
});

test('alg=none → 401（unsupported_alg）', async () => {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned =
    `${enc({ alg: 'none', typ: 'JWT' })}.` +
    `${enc({ iss: 'https://accounts.google.com', aud: AUD, sub: 'x', exp: now + 3600 })}.` +
    'sig';
  const res = await handleSession(
    req('POST', { authorization: `Bearer ${unsigned}` }), ENV,
    { verifyToken: realVerify, logger: quiet });
  assert.equal(res.status, 401);
  await assert.rejects(
    () => verifyGoogleIdToken(unsigned, { audiences: [AUD], keyResolver: keys.publicKey }),
    (e) => e instanceof TokenVerificationError && e.code === 'unsupported_alg');
});

test('HS256 で署名 → 401（RS256 以外は拒否）', async () => {
  const secret = new Uint8Array(32).fill(7);
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    iss: 'https://accounts.google.com', aud: AUD, sub: 'x', iat: now, exp: now + 3600,
  }).setProtectedHeader({ alg: 'HS256' }).sign(secret);
  await assert.rejects(
    () => verifyGoogleIdToken(token, { audiences: [AUD], keyResolver: keys.publicKey }),
    (e) => e instanceof TokenVerificationError && e.code === 'unsupported_alg');
});

test('invalid issuer → 401', async () => {
  const token = await makeToken({ iss: 'https://evil.example.com' });
  const res = await handleSession(
    req('POST', { authorization: `Bearer ${token}` }), ENV,
    { verifyToken: realVerify, logger: quiet });
  assert.equal(res.status, 401);
});

test('invalid audience（他アプリ向けトークンの流用） → 401', async () => {
  const token = await makeToken({ aud: OTHER_AUD });
  const res = await handleSession(
    req('POST', { authorization: `Bearer ${token}` }), ENV,
    { verifyToken: realVerify, logger: quiet });
  assert.equal(res.status, 401);
});

test('expired token（skew 60秒を超える） → 401', async () => {
  const now = Math.floor(Date.now() / 1000);
  const token = await makeToken({ iat: now - 7200, exp: now - 3600 });
  const res = await handleSession(
    req('POST', { authorization: `Bearer ${token}` }), ENV,
    { verifyToken: realVerify, logger: quiet });
  assert.equal(res.status, 401);
});

test('missing sub → 401', async () => {
  const token = await makeToken({ sub: undefined });
  const res = await handleSession(
    req('POST', { authorization: `Bearer ${token}` }), ENV,
    { verifyToken: realVerify, logger: quiet });
  assert.equal(res.status, 401);
});

test('未来発行（iat が skew を超えて先） → 401', async () => {
  const now = Math.floor(Date.now() / 1000);
  const token = await makeToken({ iat: now + 3600, exp: now + 7200 });
  const res = await handleSession(
    req('POST', { authorization: `Bearer ${token}` }), ENV,
    { verifyToken: realVerify, logger: quiet });
  assert.equal(res.status, 401);
});

// =========================================================
// validateClaims の独立検証（多層防御が生きていること）
// =========================================================

test('validateClaims: iss / aud / exp / iat / sub をそれぞれ弾く', () => {
  const now = Math.floor(Date.now() / 1000);
  const ok = { iss: 'accounts.google.com', aud: AUD, sub: 's', iat: now, exp: now + 60 };
  const opts = { audiences: [AUD], nowSeconds: now };

  assert.deepEqual(validateClaims(ok, opts),
    { sub: 's', email: null, email_verified: false });

  const cases = [
    [{ ...ok, iss: 'x' }, 'invalid_issuer'],
    [{ ...ok, aud: OTHER_AUD }, 'audience_mismatch'],
    [{ ...ok, exp: undefined }, 'malformed_token'],
    [{ ...ok, exp: now - 3600 }, 'token_expired'],
    [{ ...ok, iat: now + 3600 }, 'token_not_yet_valid'],
    [{ ...ok, sub: '' }, 'missing_subject'],
  ];
  for (const [payload, code] of cases) {
    assert.throws(() => validateClaims(payload, opts),
      (e) => e instanceof TokenVerificationError && e.code === code, code);
  }
});

test('validateClaims: clock skew 60秒以内の期限切れは通す', () => {
  const now = Math.floor(Date.now() / 1000);
  const p = { iss: 'accounts.google.com', aud: AUD, sub: 's', iat: now - 100, exp: now - 30 };
  assert.equal(validateClaims(p, { audiences: [AUD], nowSeconds: now }).sub, 's');
});

test('validateClaims: audiences 未設定は server_misconfigured', () => {
  const now = Math.floor(Date.now() / 1000);
  assert.throws(
    () => validateClaims({ iss: 'accounts.google.com', aud: AUD, sub: 's', exp: now + 60 },
                         { audiences: [], nowSeconds: now }),
    (e) => e.code === 'server_misconfigured');
});

test('decodeJwtUnsafe: 空・セグメント不足を弾く', () => {
  assert.throws(() => decodeJwtUnsafe(''), (e) => e.code === 'missing_token');
  assert.throws(() => decodeJwtUnsafe('a.b'), (e) => e.code === 'malformed_token');
  assert.throws(() => decodeJwtUnsafe('a..c'), (e) => e.code === 'malformed_token');
});

// =========================================================
// 設定不足 / Supabase 障害
// =========================================================

test('GOOGLE_CLIENT_IDS 未設定 → 500 server_misconfigured', async () => {
  const token = await makeToken();
  const env = { ...ENV, GOOGLE_CLIENT_IDS: '' };
  const res = await handleSession(
    req('POST', { authorization: `Bearer ${token}` }), env,
    { verifyToken: realVerify, logger: quiet });
  assert.equal(res.status, 500);
  assert.deepEqual(await body(res), { error: 'server_misconfigured' });
});

test('getAllowedAudiences はカンマ区切りを分解し空要素を落とす', () => {
  assert.deepEqual(getAllowedAudiences({ GOOGLE_CLIENT_IDS: ' a , ,b ' }), ['a', 'b']);
  assert.deepEqual(getAllowedAudiences({}), []);
  assert.deepEqual(getAllowedAudiences(undefined), []);
});

test('SUPABASE_URL 未設定 → 500 server_misconfigured', async () => {
  const token = await makeToken();
  const env = { ...ENV, SUPABASE_URL: '' };
  const res = await handleSession(
    req('POST', { authorization: `Bearer ${token}` }), env,
    { verifyToken: realVerify, rpc: callRpc, logger: quiet });
  assert.equal(res.status, 500);
  assert.deepEqual(await body(res), { error: 'server_misconfigured' });
});

test('SUPABASE_SERVICE_ROLE_KEY 未設定 → 500 server_misconfigured', async () => {
  const token = await makeToken();
  const env = { ...ENV, SUPABASE_SERVICE_ROLE_KEY: '' };
  const res = await handleSession(
    req('POST', { authorization: `Bearer ${token}` }), env,
    { verifyToken: realVerify, rpc: callRpc, logger: quiet });
  assert.equal(res.status, 500);
});

test('publishable key が設定されている → 500 server_misconfigured', async () => {
  const token = await makeToken();
  const env = { ...ENV, SUPABASE_SERVICE_ROLE_KEY: 'sb_publishable_xxx' };
  const res = await handleSession(
    req('POST', { authorization: `Bearer ${token}` }), env,
    { verifyToken: realVerify, rpc: callRpc, logger: quiet });
  assert.equal(res.status, 500);
});

test('Supabase 到達不能 → 502 database_unavailable', async () => {
  const token = await makeToken();
  const rpc = async () => { throw new SupabaseError('unavailable', 'unreachable'); };
  const res = await handleSession(
    req('POST', { authorization: `Bearer ${token}` }), ENV,
    { verifyToken: realVerify, rpc, logger: quiet });
  assert.equal(res.status, 502);
  assert.deepEqual(await body(res), { error: 'database_unavailable' });
});

test('Supabase RPC がエラー応答 → 502 database_unavailable', async () => {
  const token = await makeToken();
  const rpc = async () => { throw new SupabaseError('request_failed', 'status=400'); };
  const res = await handleSession(
    req('POST', { authorization: `Bearer ${token}` }), ENV,
    { verifyToken: realVerify, rpc, logger: quiet });
  assert.equal(res.status, 502);
});

test('RPC の戻り値が想定外の形 → 502 database_unavailable', async () => {
  const token = await makeToken();
  for (const rows of [[], null, [{ plan_id: 'free' }], [{ status: 'active' }], 'x']) {
    const res = await handleSession(
      req('POST', { authorization: `Bearer ${token}` }), ENV,
      { verifyToken: realVerify, rpc: async () => rows, logger: quiet });
    assert.equal(res.status, 502, JSON.stringify(rows));
  }
});

test('想定外の例外（SupabaseError 以外） → 500 internal_error', async () => {
  const token = await makeToken();
  const rpc = async () => { throw new Error('boom'); };
  const res = await handleSession(
    req('POST', { authorization: `Bearer ${token}` }), ENV,
    { verifyToken: realVerify, rpc, logger: quiet });
  assert.equal(res.status, 500);
  assert.deepEqual(await body(res), { error: 'internal_error' });
});

test('検証不能（JWKS 取得失敗） → 503 verification_unavailable', async () => {
  const token = await makeToken();
  const verifyToken = async () => {
    throw new TokenVerificationError('verification_unavailable', 'jwks down');
  };
  const res = await handleSession(
    req('POST', { authorization: `Bearer ${token}` }), ENV,
    { verifyToken, logger: quiet });
  assert.equal(res.status, 503);
  assert.deepEqual(await body(res), { error: 'verification_unavailable' });
});

test('isVerificationUnavailable / isTransportError は Workers 由来の失敗を拾う', () => {
  assert.equal(isVerificationUnavailable({ code: 'ERR_JWKS_TIMEOUT' }), true);
  assert.equal(isVerificationUnavailable({ name: 'TimeoutError' }), true);
  assert.equal(isVerificationUnavailable(
    { name: 'TypeError', message: 'fetch failed' }), true);
  assert.equal(isVerificationUnavailable(
    { name: 'Error', message: 'signature verification failed' }), false);

  assert.equal(isTransportError({ name: 'AbortError' }), true);
  assert.equal(isTransportError({ name: 'TypeError', message: 'Failed to fetch' }), true);
  assert.equal(isTransportError({ name: 'Error', message: 'nope' }), false);
});

// =========================================================
// 正常系
// =========================================================

test('正常系: 200 で { plan_id, status } のみを返す', async () => {
  const token = await makeToken();
  const rpc = okRpc();
  const res = await handleSession(
    req('POST', { authorization: `Bearer ${token}` }), ENV,
    { verifyToken: realVerify, rpc, logger: quiet });

  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(res.headers.get('cache-control'), 'no-store');

  const payload = await body(res);
  assert.deepEqual(Object.keys(payload).sort(), ['plan_id', 'status']);
  assert.deepEqual(payload, { plan_id: 'free', status: 'active' });
});

test('正常系: レスポンスに user_id / google_sub / key を含めない', async () => {
  const token = await makeToken();
  const rpc = okRpc([{ plan_id: 'all_pro', status: 'active', user_id: 'leak-me' }]);
  const res = await handleSession(
    req('POST', { authorization: `Bearer ${token}` }), ENV,
    { verifyToken: realVerify, rpc, logger: quiet });
  const text = JSON.stringify(await body(res));
  for (const forbidden of ['user_id', 'leak-me', 'google_sub', '1234567890',
                           ENV.SUPABASE_SERVICE_ROLE_KEY, ENV.SUPABASE_URL]) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }
});

test('RPC には検証済み sub のみを渡す（クライアント入力は使わない）', async () => {
  const token = await makeToken({ sub: 'verified-sub-999', email: 'a@b.c' });
  const rpc = okRpc();
  await handleSession(
    new Request('https://example.com/api/auth/session', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ p_google_sub: 'ATTACKER', google_sub: 'ATTACKER' }),
    }), ENV, { verifyToken: realVerify, rpc, logger: quiet });

  assert.equal(rpc.calls.length, 1);
  assert.equal(rpc.calls[0].name, 'upsert_user_and_subscription');
  assert.deepEqual(rpc.calls[0].args,
    { p_google_sub: 'verified-sub-999', p_email: 'a@b.c' });
  assert.equal(rpc.calls[0].options.env, ENV);
});

test('email が無いトークンでは p_email = null', async () => {
  const token = await makeToken({ email: undefined });
  const rpc = okRpc();
  await handleSession(
    req('POST', { authorization: `Bearer ${token}` }), ENV,
    { verifyToken: realVerify, rpc, logger: quiet });
  assert.equal(rpc.calls[0].args.p_email, null);
});

// =========================================================
// supabase.js のユニット
// =========================================================

test('buildHeaders: sb_ 形式は apikey のみ / 旧 JWT は Authorization も付く', () => {
  const a = buildHeaders('sb_secret_x');
  assert.equal(a.apikey, 'sb_secret_x');
  assert.equal('Authorization' in a, false);

  const b = buildHeaders('eyJhbGciOi.dummy.jwt');
  assert.equal(b.Authorization, 'Bearer eyJhbGciOi.dummy.jwt');
});

test('scrubKey: メッセージに混入したキーを伏せる', () => {
  assert.equal(scrubKey('boom sb_secret_x boom', 'sb_secret_x'), 'boom <REDACTED> boom');
  assert.equal(scrubKey('safe', ''), 'safe');
});

test('getSupabaseConfig: 末尾スラッシュを除去する', () => {
  const { url } = getSupabaseConfig({ ...ENV, SUPABASE_URL: 'https://x.supabase.co///' });
  assert.equal(url, 'https://x.supabase.co');
});

test('getSupabaseConfig: env 未指定は not_configured', () => {
  assert.throws(() => getSupabaseConfig(undefined),
    (e) => e instanceof SupabaseError && e.code === 'not_configured');
});

test('callRpc: 正しい URL・ヘッダ・ボディで POST する', async () => {
  let captured = null;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return new Response(JSON.stringify([{ plan_id: 'free', status: 'active' }]),
      { status: 200 });
  };
  const rows = await callRpc('upsert_user_and_subscription',
    { p_google_sub: 's', p_email: null }, { env: ENV, fetchImpl });

  assert.deepEqual(rows, [{ plan_id: 'free', status: 'active' }]);
  assert.equal(captured.url,
    'https://example-project.supabase.co/rest/v1/rpc/upsert_user_and_subscription');
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers.apikey, ENV.SUPABASE_SERVICE_ROLE_KEY);
  assert.deepEqual(JSON.parse(captured.init.body), { p_google_sub: 's', p_email: null });
});

test('callRpc: 5xx は unavailable / 4xx は request_failed', async () => {
  const mk = (status) => async () => new Response('err', { status });
  await assert.rejects(
    () => callRpc('f', {}, { env: ENV, fetchImpl: mk(503) }),
    (e) => e instanceof SupabaseError && e.code === 'unavailable');
  await assert.rejects(
    () => callRpc('f', {}, { env: ENV, fetchImpl: mk(400) }),
    (e) => e instanceof SupabaseError && e.code === 'request_failed');
});

test('callRpc: エラー本文にキーが混じっても伏せられる', async () => {
  const fetchImpl = async () =>
    new Response('leaked ' + ENV.SUPABASE_SERVICE_ROLE_KEY, { status: 400 });
  await assert.rejects(
    () => callRpc('f', {}, { env: ENV, fetchImpl }),
    (e) => !e.message.includes(ENV.SUPABASE_SERVICE_ROLE_KEY)
           && e.message.includes('<REDACTED>'));
});

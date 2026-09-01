// =========================================================
// POST /api/auth/session の単体テスト
//
//   - 実 Google の ID Token は使わない。テスト実行のたびに RSA 鍵ペアを生成し、
//     jose で署名した「本物と同じ構造の」トークンを作って検証まで通す。
//   - 本番の secret / Project URL / client_id はフィクスチャに一切保存しない。
//   - ネットワークへは出ない（JWKS は鍵リゾルバを注入して差し替える）。
//   - Supabase RPC はすべてスタブに差し替える。
// =========================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT, generateKeyPair } from 'jose';

import { handleSession, isTokenHashCollision, MAX_SESSION_TOKEN_ATTEMPTS }
  from '../auth/session.js';
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
import { SESSION_COOKIE_NAME, hashSessionToken } from '../_lib/session.js';

// --- テスト用のダミー設定（本番値ではない） ---
const AUD = 'test-client-id.apps.googleusercontent.com';
const OTHER_AUD = 'someone-else.apps.googleusercontent.com';
const ENV = {
  GOOGLE_CLIENT_IDS: AUD,
  SUPABASE_URL: 'https://example-project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_dummy_for_tests_only',
};

const IDLE = '2026-10-01T00:00:00Z';
const ABS = '2026-11-30T00:00:00Z';
const NOW = new Date('2026-09-01T00:00:00Z');

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

/** 成功する RPC スタブ。呼び出しを記録する。 */
function okRpc(rows = [{ plan_id: 'free', status: 'active',
                         idle_expires_at: IDLE, absolute_expires_at: ABS }]) {
  const calls = [];
  const fn = async (name, args, options) => {
    calls.push({ name, args, options });
    return typeof rows === 'function' ? rows(calls.length) : rows;
  };
  fn.calls = calls;
  return fn;
}

/** ログを飲み込むロガー（テスト出力を汚さない）。出力内容も検査できる。 */
function recorder() {
  const lines = [];
  const push = (...a) => lines.push(a.map(String).join(' '));
  return { error: push, warn: push, log: push, lines };
}
const quiet = { error() {}, warn() {}, log() {} };

/** 署名検証まで実際に通す verifyToken（JWKS の代わりにローカル公開鍵を注入） */
const realVerify = (idToken, options) =>
  verifyGoogleIdToken(idToken, { ...options, keyResolver: keys.publicKey });

async function body(res) { return JSON.parse(await res.text()); }
function cookieOf(res) { return res.headers.get('set-cookie'); }
function attrs(c) { return c.split(';').map((s) => s.trim()); }

/** PostgREST の一意制約違反を模したエラー */
function uniqueViolation(hash = 'deadbeef') {
  return new SupabaseError('request_failed',
    'Supabase が status=409 を返しました: {"code":"23505","details":"Key (token_hash)=('
    + hash + ') already exists.","hint":null,"message":"duplicate key value violates '
    + 'unique constraint \\"sessions_pkey\\""}');
}

// =========================================================
// メソッド / トークン取り出し
// =========================================================

test('GET は 405 method_not_allowed', async () => {
  const res = await handleSession(req('GET'), ENV, { logger: quiet });
  assert.equal(res.status, 405);
  assert.deepEqual(await body(res), { error: 'method_not_allowed' });
  assert.equal(cookieOf(res), null);
});

test('DELETE も 405', async () => {
  assert.equal((await handleSession(req('DELETE'), ENV, { logger: quiet })).status, 405);
});

test('Authorization ヘッダなし → 400 missing_token', async () => {
  const res = await handleSession(req('POST'), ENV, { logger: quiet });
  assert.equal(res.status, 400);
  assert.deepEqual(await body(res), { error: 'missing_token' });
  assert.equal(cookieOf(res), null);
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
  assert.equal(cookieOf(res), null);
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

  assert.deepEqual(validateClaims(ok, opts), { sub: 's', email: null, email_verified: false });

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
  const res = await handleSession(
    req('POST', { authorization: `Bearer ${token}` }), { ...ENV, GOOGLE_CLIENT_IDS: '' },
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
  const res = await handleSession(
    req('POST', { authorization: `Bearer ${token}` }), { ...ENV, SUPABASE_URL: '' },
    { verifyToken: realVerify, rpc: callRpc, logger: quiet });
  assert.equal(res.status, 500);
  assert.deepEqual(await body(res), { error: 'server_misconfigured' });
});

test('SUPABASE_SERVICE_ROLE_KEY 未設定 → 500 server_misconfigured', async () => {
  const token = await makeToken();
  const res = await handleSession(
    req('POST', { authorization: `Bearer ${token}` }), { ...ENV, SUPABASE_SERVICE_ROLE_KEY: '' },
    { verifyToken: realVerify, rpc: callRpc, logger: quiet });
  assert.equal(res.status, 500);
});

test('publishable key が設定されている → 500 server_misconfigured', async () => {
  const token = await makeToken();
  const res = await handleSession(
    req('POST', { authorization: `Bearer ${token}` }), { ...ENV, SUPABASE_SERVICE_ROLE_KEY: 'sb_publishable_xxx' },
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
  assert.equal(cookieOf(res), null);
});

test('Supabase RPC がエラー応答 → 502 database_unavailable', async () => {
  const token = await makeToken();
  const rpc = async () => { throw new SupabaseError('request_failed', 'status=400'); };
  const res = await handleSession(
    req('POST', { authorization: `Bearer ${token}` }), ENV,
    { verifyToken: realVerify, rpc, logger: quiet });
  assert.equal(res.status, 502);
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
    req('POST', { authorization: `Bearer ${token}` }), ENV, { verifyToken, logger: quiet });
  assert.equal(res.status, 503);
  assert.deepEqual(await body(res), { error: 'verification_unavailable' });
});

test('isVerificationUnavailable / isTransportError は Workers 由来の失敗を拾う', () => {
  assert.equal(isVerificationUnavailable({ code: 'ERR_JWKS_TIMEOUT' }), true);
  assert.equal(isVerificationUnavailable({ name: 'TimeoutError' }), true);
  assert.equal(isVerificationUnavailable({ name: 'TypeError', message: 'fetch failed' }), true);
  assert.equal(isVerificationUnavailable({ name: 'Error', message: 'signature verification failed' }), false);

  assert.equal(isTransportError({ name: 'AbortError' }), true);
  assert.equal(isTransportError({ name: 'TypeError', message: 'Failed to fetch' }), true);
  assert.equal(isTransportError({ name: 'Error', message: 'nope' }), false);
});

// =========================================================
// RPC 呼び出し（新 RPC・引数・秘密値を送らないこと）
// =========================================================

test('呼ぶ RPC は upsert_user_and_create_session（旧 RPC を呼ばない）', async () => {
  const token = await makeToken();
  const rpc = okRpc();
  await handleSession(req('POST', { authorization: `Bearer ${token}` }), ENV,
    { verifyToken: realVerify, rpc, logger: quiet, now: NOW });

  assert.equal(rpc.calls.length, 1);
  assert.equal(rpc.calls[0].name, 'upsert_user_and_create_session');
  assert.equal(rpc.calls.map((c) => c.name).includes('upsert_user_and_subscription'), false);
});

test('RPC 引数は p_google_sub / p_token_hash / p_email のみ', async () => {
  const token = await makeToken({ sub: 'verified-sub-999', email: 'a@b.c' });
  const rpc = okRpc();
  await handleSession(req('POST', { authorization: `Bearer ${token}` }), ENV,
    { verifyToken: realVerify, rpc, logger: quiet, now: NOW });

  const args = rpc.calls[0].args;
  assert.deepEqual(Object.keys(args).sort(), ['p_email', 'p_google_sub', 'p_token_hash']);
  assert.equal(args.p_google_sub, 'verified-sub-999');
  assert.equal(args.p_email, 'a@b.c');
  assert.equal(rpc.calls[0].options.env, ENV);
});

test('email が無いトークンでは p_email = null（verified sub のみ）', async () => {
  const token = await makeToken({ email: undefined });
  const rpc = okRpc();
  await handleSession(req('POST', { authorization: `Bearer ${token}` }), ENV,
    { verifyToken: realVerify, rpc, logger: quiet, now: NOW });
  assert.equal(rpc.calls[0].args.p_email, null);
  assert.equal(rpc.calls[0].args.p_google_sub, '1234567890');
});

test('クライアント入力の google_sub を使わない（検証済み sub のみ）', async () => {
  const token = await makeToken({ sub: 'verified-sub-999' });
  const rpc = okRpc();
  await handleSession(
    new Request('https://example.com/api/auth/session', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ p_google_sub: 'ATTACKER', google_sub: 'ATTACKER' }),
    }), ENV, { verifyToken: realVerify, rpc, logger: quiet, now: NOW });
  assert.equal(rpc.calls[0].args.p_google_sub, 'verified-sub-999');
});

test('p_token_hash は小文字 hex 64文字', async () => {
  const token = await makeToken();
  const rpc = okRpc();
  await handleSession(req('POST', { authorization: `Bearer ${token}` }), ENV,
    { verifyToken: realVerify, rpc, logger: quiet, now: NOW });
  assert.match(rpc.calls[0].args.p_token_hash, /^[0-9a-f]{64}$/);
});

test('raw session token を RPC へ送らない（Cookie 値と一致しない）', async () => {
  const token = await makeToken();
  const rpc = okRpc();
  const res = await handleSession(req('POST', { authorization: `Bearer ${token}` }), ENV,
    { verifyToken: realVerify, rpc, logger: quiet, now: NOW });

  const raw = attrs(cookieOf(res))[0].slice(`${SESSION_COOKIE_NAME}=`.length);
  const sent = rpc.calls[0].args.p_token_hash;
  assert.notEqual(sent, raw);
  assert.equal(JSON.stringify(rpc.calls[0].args).includes(raw), false);
  assert.equal(sent, await hashSessionToken(raw));
});

test('Google ID Token を RPC へ送らない', async () => {
  const token = await makeToken();
  const rpc = okRpc();
  await handleSession(req('POST', { authorization: `Bearer ${token}` }), ENV,
    { verifyToken: realVerify, rpc, logger: quiet, now: NOW });
  assert.equal(JSON.stringify(rpc.calls[0].args).includes(token), false);
});

// =========================================================
// 正常系（レスポンスと Cookie）
// =========================================================

test('正常系: 200 で { plan_id, status } のみを返す', async () => {
  const token = await makeToken();
  const res = await handleSession(req('POST', { authorization: `Bearer ${token}` }), ENV,
    { verifyToken: realVerify, rpc: okRpc(), logger: quiet, now: NOW });

  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(res.headers.get('cache-control'), 'no-store');

  const payload = await body(res);
  assert.deepEqual(Object.keys(payload).sort(), ['plan_id', 'status']);
  assert.deepEqual(payload, { plan_id: 'free', status: 'active' });
});

test('正常系: Set-Cookie が付き Cookie 名と必須属性がそろう', async () => {
  const token = await makeToken();
  const res = await handleSession(req('POST', { authorization: `Bearer ${token}` }), ENV,
    { verifyToken: realVerify, rpc: okRpc(), logger: quiet, now: NOW });

  const c = cookieOf(res);
  assert.ok(c, 'Set-Cookie がある');
  const a = attrs(c);
  assert.ok(a[0].startsWith(`${SESSION_COOKIE_NAME}=`), a[0]);
  assert.ok(a.includes('HttpOnly'), 'HttpOnly');
  assert.ok(a.includes('Secure'), 'Secure');
  assert.ok(a.includes('SameSite=Lax'), 'SameSite=Lax');
  assert.ok(a.includes('Path=/'), 'Path=/');
});

test('正常系: Cookie に Domain を付けない', async () => {
  const token = await makeToken();
  const res = await handleSession(req('POST', { authorization: `Bearer ${token}` }), ENV,
    { verifyToken: realVerify, rpc: okRpc(), logger: quiet, now: NOW });
  assert.equal(/(^|;)\s*Domain\s*=/i.test(cookieOf(res)), false, cookieOf(res));
});

test('正常系: Max-Age は RPC の idle_expires_at から算出される', async () => {
  const token = await makeToken();
  const res = await handleSession(req('POST', { authorization: `Bearer ${token}` }), ENV,
    { verifyToken: realVerify, rpc: okRpc(), logger: quiet, now: NOW });
  assert.ok(attrs(cookieOf(res)).includes(`Max-Age=${30 * 24 * 3600}`), cookieOf(res));
});

test('正常系: Cookie 値は毎回異なる不透明トークン', async () => {
  const token = await makeToken();
  const seen = new Set();
  for (let i = 0; i < 20; i += 1) {
    const res = await handleSession(req('POST', { authorization: `Bearer ${token}` }), ENV,
      { verifyToken: realVerify, rpc: okRpc(), logger: quiet, now: NOW });
    seen.add(attrs(cookieOf(res))[0]);
  }
  assert.equal(seen.size, 20);
});

test('レスポンスに user_id / google_sub / email / token_hash が漏れない', async () => {
  const token = await makeToken({ sub: 'SUBSUB', email: 'leak@example.com' });
  const rpc = okRpc([{ plan_id: 'all_pro', status: 'active', idle_expires_at: IDLE,
                       absolute_expires_at: ABS, user_id: 'leak-me',
                       google_sub: 'SUBSUB', email: 'leak@example.com' }]);
  const res = await handleSession(req('POST', { authorization: `Bearer ${token}` }), ENV,
    { verifyToken: realVerify, rpc, logger: quiet, now: NOW });

  const text = JSON.stringify(await body(res));
  for (const f of ['user_id', 'leak-me', 'google_sub', 'SUBSUB', 'leak@example.com',
                   'idle_expires_at', 'absolute_expires_at', IDLE, ABS,
                   rpc.calls[0].args.p_token_hash, token,
                   ENV.SUPABASE_SERVICE_ROLE_KEY, ENV.SUPABASE_URL]) {
    assert.equal(text.includes(f), false, f);
  }
  const cookie = cookieOf(res);
  for (const f of ['leak-me', 'SUBSUB', 'leak@example.com',
                   rpc.calls[0].args.p_token_hash, token]) {
    assert.equal(cookie.includes(f), false, f);
  }
});

test('ログに ID Token / raw token / token hash を出さない', async () => {
  const token = await makeToken();
  const log = recorder();
  const rpc = okRpc();
  const res = await handleSession(req('POST', { authorization: `Bearer ${token}` }), ENV,
    { verifyToken: realVerify, rpc, logger: log, now: NOW });

  const raw = attrs(cookieOf(res))[0].slice(`${SESSION_COOKIE_NAME}=`.length);
  const all = log.lines.join('\n');
  assert.equal(all.includes(token), false, 'ID Token');
  assert.equal(all.includes(raw), false, 'raw session token');
  assert.equal(all.includes(rpc.calls[0].args.p_token_hash), false, 'token hash');
});

// =========================================================
// RPC 戻り値の異常（すべて fail closed で 5xx・詳細を返さない）
// =========================================================

test('RPC 0行 → 500 internal_error（Cookie を発行しない）', async () => {
  const token = await makeToken();
  const res = await handleSession(req('POST', { authorization: `Bearer ${token}` }), ENV,
    { verifyToken: realVerify, rpc: okRpc([]), logger: quiet, now: NOW });
  assert.equal(res.status, 500);
  assert.deepEqual(await body(res), { error: 'internal_error' });
  assert.equal(cookieOf(res), null);
});

test('RPC 複数行 → 500', async () => {
  const row = { plan_id: 'free', status: 'active', idle_expires_at: IDLE, absolute_expires_at: ABS };
  const token = await makeToken();
  const res = await handleSession(req('POST', { authorization: `Bearer ${token}` }), ENV,
    { verifyToken: realVerify, rpc: okRpc([row, row]), logger: quiet, now: NOW });
  assert.equal(res.status, 500);
  assert.equal(cookieOf(res), null);
});

test('必須フィールド欠落は 500（plan_id / status / idle / absolute）', async () => {
  const token = await makeToken();
  const base = { plan_id: 'free', status: 'active', idle_expires_at: IDLE, absolute_expires_at: ABS };
  const bad = [
    { ...base, plan_id: null },
    { ...base, status: null },
    { ...base, idle_expires_at: null },
    { ...base, absolute_expires_at: null },
    { ...base, plan_id: undefined },
    { ...base, idle_expires_at: undefined },
  ];
  for (const row of bad) {
    const res = await handleSession(req('POST', { authorization: `Bearer ${token}` }), ENV,
      { verifyToken: realVerify, rpc: okRpc([row]), logger: quiet, now: NOW });
    assert.equal(res.status, 500, JSON.stringify(row));
    assert.equal(cookieOf(res), null);
  }
});

test('配列でない戻り値 / null / undefined → 500', async () => {
  const token = await makeToken();
  // okRpc の既定値にフォールバックさせないよう、スタブを直接組み立てる
  for (const rows of [null, undefined, 'x', 42, { plan_id: 'free' }]) {
    const rpc = async () => rows;
    const res = await handleSession(req('POST', { authorization: `Bearer ${token}` }), ENV,
      { verifyToken: realVerify, rpc, logger: quiet, now: NOW });
    assert.equal(res.status, 500, String(rows));
    assert.equal(cookieOf(res), null);
  }
});

test('idle_expires_at が日時として不正 → 500（Cookie を作れない）', async () => {
  const token = await makeToken();
  const res = await handleSession(req('POST', { authorization: `Bearer ${token}` }), ENV,
    { verifyToken: realVerify, logger: quiet, now: NOW,
      rpc: okRpc([{ plan_id: 'free', status: 'active',
                    idle_expires_at: 'not-a-date', absolute_expires_at: ABS }]) });
  assert.equal(res.status, 500);
  assert.equal(cookieOf(res), null);
});

// =========================================================
// session token 衝突時の限定 retry
// =========================================================

test('isTokenHashCollision: 23505 かつ sessions のトークン制約のみ true', () => {
  assert.equal(isTokenHashCollision(uniqueViolation()), true);

  assert.equal(isTokenHashCollision(new SupabaseError('unavailable', 'unreachable')), false);
  assert.equal(isTokenHashCollision(new SupabaseError('not_configured', 'no url')), false);
  assert.equal(isTokenHashCollision(new SupabaseError('request_failed', 'status=400')), false);
  assert.equal(isTokenHashCollision(new Error('boom')), false);
  assert.equal(isTokenHashCollision(null), false);

  const otherConstraint = new SupabaseError('request_failed',
    '{"code":"23505","message":"duplicate key value violates unique constraint users_google_sub_key"}');
  assert.equal(isTokenHashCollision(otherConstraint), false);

  const fiveXx = new SupabaseError('unavailable', '{"code":"23505","message":"sessions_pkey"}');
  assert.equal(isTokenHashCollision(fiveXx), false);
});

test('衝突したら新しい token / hash で張り直し、2回目で成功する', async () => {
  const token = await makeToken();
  const hashes = [];
  const rpc = async (name, args) => {
    hashes.push(args.p_token_hash);
    if (hashes.length === 1) throw uniqueViolation();
    return [{ plan_id: 'free', status: 'active', idle_expires_at: IDLE, absolute_expires_at: ABS }];
  };
  const res = await handleSession(req('POST', { authorization: `Bearer ${token}` }), ENV,
    { verifyToken: realVerify, rpc, logger: quiet, now: NOW });

  assert.equal(res.status, 200);
  assert.equal(hashes.length, 2);
  assert.notEqual(hashes[0], hashes[1]);
  assert.match(hashes[1], /^[0-9a-f]{64}$/);
});

test('衝突が続いたら最大 3 回で打ち切り 500', async () => {
  const token = await makeToken();
  let calls = 0;
  const rpc = async () => { calls += 1; throw uniqueViolation(); };
  const res = await handleSession(req('POST', { authorization: `Bearer ${token}` }), ENV,
    { verifyToken: realVerify, rpc, logger: quiet, now: NOW });

  assert.equal(calls, MAX_SESSION_TOKEN_ATTEMPTS);
  assert.equal(MAX_SESSION_TOKEN_ATTEMPTS, 3);
  assert.equal(res.status, 500);
  assert.deepEqual(await body(res), { error: 'internal_error' });
  assert.equal(cookieOf(res), null);
});

test('衝突以外の Supabase エラーは retry しない（1回で 502）', async () => {
  const token = await makeToken();
  let calls = 0;
  const rpc = async () => { calls += 1; throw new SupabaseError('unavailable', 'down'); };
  const res = await handleSession(req('POST', { authorization: `Bearer ${token}` }), ENV,
    { verifyToken: realVerify, rpc, logger: quiet, now: NOW });
  assert.equal(calls, 1);
  assert.equal(res.status, 502);
});

test('衝突時のログに token hash を出さない', async () => {
  const token = await makeToken();
  const log = recorder();
  const secretHash = 'a'.repeat(64);
  const rpc = async () => { throw uniqueViolation(secretHash); };
  await handleSession(req('POST', { authorization: `Bearer ${token}` }), ENV,
    { verifyToken: realVerify, rpc, logger: log, now: NOW });
  assert.equal(log.lines.join('\n').includes(secretHash), false);
});

// =========================================================
// supabase.js のユニット
// =========================================================

test('buildHeaders: sb_ 形式は apikey のみ / 旧 JWT は Authorization も付く', () => {
  const a = buildHeaders('sb_secret_x');
  assert.equal(a.apikey, 'sb_secret_x');
  assert.equal('Authorization' in a, false);
  assert.equal(buildHeaders('eyJhbGciOi.dummy.jwt').Authorization, 'Bearer eyJhbGciOi.dummy.jwt');
});

test('scrubKey: メッセージに混入したキーを伏せる', () => {
  assert.equal(scrubKey('boom sb_secret_x boom', 'sb_secret_x'), 'boom <REDACTED> boom');
  assert.equal(scrubKey('safe', ''), 'safe');
});

test('getSupabaseConfig: 末尾スラッシュを除去する', () => {
  assert.equal(getSupabaseConfig({ ...ENV, SUPABASE_URL: 'https://x.supabase.co///' }).url,
               'https://x.supabase.co');
});

test('getSupabaseConfig: env 未指定は not_configured', () => {
  assert.throws(() => getSupabaseConfig(undefined),
    (e) => e instanceof SupabaseError && e.code === 'not_configured');
});

test('callRpc: 正しい URL・ヘッダ・ボディで POST する', async () => {
  let captured = null;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return new Response(JSON.stringify([{ plan_id: 'free', status: 'active' }]), { status: 200 });
  };
  const rows = await callRpc('upsert_user_and_create_session',
    { p_google_sub: 's', p_token_hash: 'a'.repeat(64), p_email: null }, { env: ENV, fetchImpl });

  assert.deepEqual(rows, [{ plan_id: 'free', status: 'active' }]);
  assert.equal(captured.url,
    'https://example-project.supabase.co/rest/v1/rpc/upsert_user_and_create_session');
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers.apikey, ENV.SUPABASE_SERVICE_ROLE_KEY);
});

test('callRpc: 5xx は unavailable / 4xx は request_failed', async () => {
  const mk = (status) => async () => new Response('err', { status });
  await assert.rejects(() => callRpc('f', {}, { env: ENV, fetchImpl: mk(503) }),
    (e) => e instanceof SupabaseError && e.code === 'unavailable');
  await assert.rejects(() => callRpc('f', {}, { env: ENV, fetchImpl: mk(400) }),
    (e) => e instanceof SupabaseError && e.code === 'request_failed');
});

test('callRpc: エラー本文にキーが混じっても伏せられる', async () => {
  const fetchImpl = async () => new Response('leaked ' + ENV.SUPABASE_SERVICE_ROLE_KEY, { status: 400 });
  await assert.rejects(() => callRpc('f', {}, { env: ENV, fetchImpl }),
    (e) => !e.message.includes(ENV.SUPABASE_SERVICE_ROLE_KEY) && e.message.includes('<REDACTED>'));
});

// =========================================================
// functions/api/_lib/session.js の単体テスト
//
//   - 実 Supabase へは接続しない。RPC はすべてスタブに差し替える。
//   - 本番の secret / Project URL / token はフィクスチャに一切保存しない。
// =========================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  SESSION_COOKIE_NAME,
  SESSION_RESULT,
  SESSION_TOKEN_BYTES,
  buildClearSessionCookie,
  buildSessionCookie,
  generateSessionToken,
  getSessionContext,
  hashSessionToken,
  isServerError,
  isValidSession,
  parseSessionCookie,
  requireSession,
} from '../_lib/session.js';
import { SupabaseError } from '../_lib/supabase.js';

// --- テスト用のダミー設定（本番値ではない） ---
const ENV = {
  SUPABASE_URL: 'https://example-project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_dummy_for_tests_only',
};

const quiet = { error() {}, warn() {}, log() {} };

function reqWithCookie(cookie) {
  const headers = cookie === undefined ? {} : { cookie };
  return new Request('https://example.com/api/auth/me', { method: 'GET', headers });
}

/** 任意の行を返す RPC スタブ。呼び出し引数を記録する。 */
function stubRpc(rows) {
  const calls = [];
  const fn = async (name, args, options) => { calls.push({ name, args, options }); return rows; };
  fn.calls = calls;
  return fn;
}

const validRow = {
  user_id: '11111111-2222-3333-4444-555555555555',
  plan_id: 'free',
  status: 'active',
  idle_expires_at: '2026-10-01T00:00:00Z',
  absolute_expires_at: '2026-11-30T00:00:00Z',
};

// =========================================================
// generateSessionToken
// =========================================================

test('token は毎回異なる（1000本すべて一意）', () => {
  const seen = new Set();
  for (let i = 0; i < 1000; i += 1) seen.add(generateSessionToken());
  assert.equal(seen.size, 1000);
});

test('token は 32バイト相当の長さ（base64url 43文字）', () => {
  const t = generateSessionToken();
  assert.equal(SESSION_TOKEN_BYTES, 32);
  assert.equal(t.length, 43);   // ceil(32*4/3) = 43（パディングなし）
});

test('token は base64url 形式（+ / = を含まない）', () => {
  for (let i = 0; i < 200; i += 1) {
    const t = generateSessionToken();
    assert.match(t, /^[A-Za-z0-9_-]+$/, t);
    assert.equal(t.includes('+'), false);
    assert.equal(t.includes('/'), false);
    assert.equal(t.includes('='), false);
  }
});

// =========================================================
// hashSessionToken
// =========================================================

test('hash は小文字 hex 64文字', async () => {
  const h = await hashSessionToken(generateSessionToken());
  assert.match(h, /^[0-9a-f]{64}$/);
});

test('同一 token → 同一 hash', async () => {
  const t = generateSessionToken();
  assert.equal(await hashSessionToken(t), await hashSessionToken(t));
});

test('異なる token → 異なる hash', async () => {
  const a = await hashSessionToken(generateSessionToken());
  const b = await hashSessionToken(generateSessionToken());
  assert.notEqual(a, b);
});

test('hash は SHA-256 と一致する（node:crypto と突き合わせ）', async () => {
  const t = generateSessionToken();
  const expected = createHash('sha256').update(t, 'utf8').digest('hex');
  assert.equal(await hashSessionToken(t), expected);
});

test('不正入力は TypeError', async () => {
  for (const bad of ['', null, undefined, 123, {}, 'has space', 'has+plus', 'has/slash', 'pad==']) {
    await assert.rejects(() => hashSessionToken(bad), TypeError, String(bad));
  }
});

// =========================================================
// parseSessionCookie
// =========================================================

test('Cookie parse: セッション Cookie を取り出せる', () => {
  const t = generateSessionToken();
  assert.equal(parseSessionCookie(reqWithCookie(`${SESSION_COOKIE_NAME}=${t}`)), t);
});

test('Cookie parse: Cookie ヘッダなし → null', () => {
  assert.equal(parseSessionCookie(reqWithCookie()), null);
});

test('Cookie parse: 空の Cookie ヘッダ → null', () => {
  assert.equal(parseSessionCookie(reqWithCookie('')), null);
});

test('Cookie parse: 他 Cookie が混在していても正しく取れる', () => {
  const t = generateSessionToken();
  const cases = [
    `gtoken=abc; ${SESSION_COOKIE_NAME}=${t}; lang=ja`,
    `${SESSION_COOKIE_NAME}=${t}; other=1`,
    `a=1; b=2; ${SESSION_COOKIE_NAME}=${t}`,
    `  ${SESSION_COOKIE_NAME}=${t}  ; x=y`,
  ];
  for (const c of cases) assert.equal(parseSessionCookie(reqWithCookie(c)), t, c);
});

test('Cookie parse: 他 Cookie しかない → null（他 Cookie に影響しない）', () => {
  assert.equal(parseSessionCookie(reqWithCookie('gtoken=abc; lang=ja')), null);
});

test('Cookie parse: 名前が前方一致する別 Cookie を拾わない', () => {
  const t = generateSessionToken();
  assert.equal(parseSessionCookie(reqWithCookie(`${SESSION_COOKIE_NAME}_x=${t}`)), null);
  assert.equal(parseSessionCookie(reqWithCookie(`x${SESSION_COOKIE_NAME}=${t}`)), null);
});

test('Cookie parse: malformed でも例外を投げず null', () => {
  const cases = [
    `${SESSION_COOKIE_NAME}=`,                 // 値が空
    `${SESSION_COOKIE_NAME}`,                  // = がない
    `${SESSION_COOKIE_NAME}=%E0%A4%A`,         // 不正なパーセント記法
    `${SESSION_COOKIE_NAME}=has space`,        // base64url でない
    `${SESSION_COOKIE_NAME}=a+b/c=`,           // base64url でない
    ';;;',
    '=noname',
  ];
  for (const c of cases) {
    assert.equal(parseSessionCookie(reqWithCookie(c)), null, c);
  }
});

test('Cookie parse: パーセントエンコードされた値を復号する', () => {
  const t = generateSessionToken();
  assert.equal(parseSessionCookie(reqWithCookie(`${SESSION_COOKIE_NAME}=${encodeURIComponent(t)}`)), t);
});

// =========================================================
// buildSessionCookie / buildClearSessionCookie
// =========================================================

function attrs(cookie) {
  return cookie.split(';').map((s) => s.trim());
}

test('buildSessionCookie: 必須属性がすべて含まれる', () => {
  const t = generateSessionToken();
  const now = new Date('2026-09-01T00:00:00Z');
  const c = buildSessionCookie(t, new Date('2026-10-01T00:00:00Z'), { now });
  const a = attrs(c);

  assert.equal(a[0], `${SESSION_COOKIE_NAME}=${t}`);
  assert.ok(a.includes('HttpOnly'), 'HttpOnly');
  assert.ok(a.includes('Secure'), 'Secure');
  assert.ok(a.includes('SameSite=Lax'), 'SameSite=Lax');
  assert.ok(a.includes('Path=/'), 'Path=/');
});

test('buildSessionCookie: Domain 属性を絶対に付けない', () => {
  const c = buildSessionCookie(generateSessionToken(), new Date(Date.now() + 1000));
  assert.equal(/(^|;)\s*Domain\s*=/i.test(c), false, c);
});

test('buildSessionCookie: Max-Age = floor((expiresAt - now)/1000)', () => {
  const t = generateSessionToken();
  const now = new Date('2026-09-01T00:00:00.000Z');
  const cases = [
    ['2026-09-01T00:00:30.000Z', 30],
    ['2026-09-01T00:00:30.999Z', 30],   // 切り捨て
    ['2026-10-01T00:00:00.000Z', 30 * 24 * 3600],
    ['2026-09-01T00:00:00.000Z', 0],
    ['2026-08-31T00:00:00.000Z', 0],    // 過去 → 0 未満にしない
  ];
  for (const [exp, want] of cases) {
    const c = buildSessionCookie(t, exp, { now });
    assert.ok(attrs(c).includes(`Max-Age=${want}`), `${exp} → ${c}`);
  }
});

test('buildSessionCookie: Date / ISO文字列 / epochミリ秒を受け付ける', () => {
  const t = generateSessionToken();
  const now = new Date('2026-09-01T00:00:00Z');
  const target = new Date('2026-09-02T00:00:00Z');
  const want = 'Max-Age=86400';
  for (const v of [target, target.toISOString(), target.getTime()]) {
    assert.ok(attrs(buildSessionCookie(t, v, { now })).includes(want), String(v));
  }
});

test('buildSessionCookie: Expires が併記され UTC 形式', () => {
  const c = buildSessionCookie(generateSessionToken(), '2026-10-01T00:00:00Z',
                               { now: new Date('2026-09-01T00:00:00Z') });
  assert.ok(attrs(c).includes('Expires=Thu, 01 Oct 2026 00:00:00 GMT'), c);
});

test('buildSessionCookie: 不正な token / expiresAt は TypeError', () => {
  const t = generateSessionToken();
  for (const bad of ['', null, 'has space', 'a+b']) {
    assert.throws(() => buildSessionCookie(bad, new Date()), TypeError, String(bad));
  }
  for (const bad of ['not-a-date', null, undefined, {}, NaN]) {
    assert.throws(() => buildSessionCookie(t, bad), TypeError, String(bad));
  }
});

test('buildClearSessionCookie: Max-Age=0 と必須属性', () => {
  const a = attrs(buildClearSessionCookie());
  assert.equal(a[0], `${SESSION_COOKIE_NAME}=`);
  assert.ok(a.includes('Max-Age=0'), 'Max-Age=0');
  assert.ok(a.includes('HttpOnly'), 'HttpOnly');
  assert.ok(a.includes('Secure'), 'Secure');
  assert.ok(a.includes('SameSite=Lax'), 'SameSite=Lax');
  assert.ok(a.includes('Path=/'), 'Path=/');
  assert.equal(/(^|;)\s*Domain\s*=/i.test(buildClearSessionCookie()), false);
});

test('clear cookie の属性は buildSessionCookie と揃っている', () => {
  const set = new Set(attrs(buildSessionCookie(generateSessionToken(), new Date(Date.now() + 1000))));
  for (const a of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) {
    assert.ok(set.has(a) && attrs(buildClearSessionCookie()).includes(a), a);
  }
});

// =========================================================
// getSessionContext
// =========================================================

test('RPC 0行 → unauthenticated', async () => {
  const r = await getSessionContext(ENV, generateSessionToken(),
    { rpc: stubRpc([]), logger: quiet });
  assert.equal(r.status, SESSION_RESULT.UNAUTHENTICATED);
  assert.equal(isValidSession(r), false);
  assert.equal(isServerError(r), false);
});

test('RPC null → unauthenticated', async () => {
  const r = await getSessionContext(ENV, generateSessionToken(),
    { rpc: stubRpc(null), logger: quiet });
  assert.equal(r.status, SESSION_RESULT.UNAUTHENTICATED);
});

test('RPC 1行正常 → valid（内部 context を返す）', async () => {
  const r = await getSessionContext(ENV, generateSessionToken(),
    { rpc: stubRpc([validRow]), logger: quiet });

  assert.equal(r.status, SESSION_RESULT.VALID);
  assert.equal(isValidSession(r), true);
  assert.equal(isServerError(r), false);
  assert.deepEqual(Object.keys(r.context).sort(),
    ['absolute_expires_at', 'idle_expires_at', 'plan_id', 'status', 'user_id']);
  assert.equal(r.context.plan_id, 'free');
  assert.equal(r.context.status, 'active');
  assert.equal(r.context.idle_expires_at, '2026-10-01T00:00:00Z');
  assert.equal(r.context.absolute_expires_at, '2026-11-30T00:00:00Z');
});

test('RPC には p_token_hash だけを渡し、生 token は渡さない', async () => {
  const token = generateSessionToken();
  const rpc = stubRpc([validRow]);
  await getSessionContext(ENV, token, { rpc, logger: quiet });

  assert.equal(rpc.calls.length, 1);
  assert.equal(rpc.calls[0].name, 'get_session_context');
  assert.deepEqual(Object.keys(rpc.calls[0].args), ['p_token_hash']);
  assert.equal(rpc.calls[0].args.p_token_hash, await hashSessionToken(token));
  assert.notEqual(rpc.calls[0].args.p_token_hash, token);
  assert.equal(JSON.stringify(rpc.calls[0].args).includes(token), false);
  assert.equal(rpc.calls[0].options.env, ENV);
});

test('plan_id が null → data_error（未認証に丸めない）', async () => {
  const r = await getSessionContext(ENV, generateSessionToken(),
    { rpc: stubRpc([{ ...validRow, plan_id: null }]), logger: quiet });
  assert.equal(r.status, SESSION_RESULT.DATA_ERROR);
  assert.equal(r.reason, 'missing_subscription');
  assert.equal(isServerError(r), true);
  assert.equal(isValidSession(r), false);
});

test('status が null → data_error', async () => {
  const r = await getSessionContext(ENV, generateSessionToken(),
    { rpc: stubRpc([{ ...validRow, status: null }]), logger: quiet });
  assert.equal(r.status, SESSION_RESULT.DATA_ERROR);
  assert.equal(r.reason, 'missing_subscription');
});

test('user_id が欠落 → data_error', async () => {
  const r = await getSessionContext(ENV, generateSessionToken(),
    { rpc: stubRpc([{ ...validRow, user_id: null }]), logger: quiet });
  assert.equal(r.status, SESSION_RESULT.DATA_ERROR);
  assert.equal(r.reason, 'missing_user_id');
});

test('複数行 → data_error（token_hash は PK なので起き得ない）', async () => {
  const r = await getSessionContext(ENV, generateSessionToken(),
    { rpc: stubRpc([validRow, validRow]), logger: quiet });
  assert.equal(r.status, SESSION_RESULT.DATA_ERROR);
  assert.equal(r.reason, 'multiple_rows');
  assert.equal(isServerError(r), true);
});

test('配列でない戻り値 → data_error', async () => {
  const r = await getSessionContext(ENV, generateSessionToken(),
    { rpc: stubRpc({ not: 'array' }), logger: quiet });
  assert.equal(r.status, SESSION_RESULT.DATA_ERROR);
});

test('Supabase 到達不能 → unavailable（未認証にしない）', async () => {
  const rpc = async () => { throw new SupabaseError('unavailable', 'unreachable'); };
  const r = await getSessionContext(ENV, generateSessionToken(), { rpc, logger: quiet });
  assert.equal(r.status, SESSION_RESULT.UNAVAILABLE);
  assert.equal(isServerError(r), true);
  assert.equal(isValidSession(r), false);
});

test('Supabase リクエスト失敗 → unavailable', async () => {
  const rpc = async () => { throw new SupabaseError('request_failed', 'status=400'); };
  const r = await getSessionContext(ENV, generateSessionToken(), { rpc, logger: quiet });
  assert.equal(r.status, SESSION_RESULT.UNAVAILABLE);
});

test('環境変数の設定漏れ → misconfigured', async () => {
  const rpc = async () => { throw new SupabaseError('not_configured', 'SUPABASE_URL 未設定'); };
  const r = await getSessionContext(ENV, generateSessionToken(), { rpc, logger: quiet });
  assert.equal(r.status, SESSION_RESULT.MISCONFIGURED);
  assert.equal(isServerError(r), true);
});

test('想定外の例外 → unavailable（未認証にしない）', async () => {
  const rpc = async () => { throw new Error('boom'); };
  const r = await getSessionContext(ENV, generateSessionToken(), { rpc, logger: quiet });
  assert.equal(r.status, SESSION_RESULT.UNAVAILABLE);
  assert.equal(isServerError(r), true);
});

test('形式不正な token は DB を叩かずに unauthenticated', async () => {
  const rpc = stubRpc([validRow]);
  const r = await getSessionContext(ENV, 'has space', { rpc, logger: quiet });
  assert.equal(r.status, SESSION_RESULT.UNAUTHENTICATED);
  assert.equal(r.reason, 'malformed_token');
  assert.equal(rpc.calls.length, 0, 'RPC を呼んでいない');
});

// =========================================================
// requireSession
// =========================================================

test('requireSession: Cookie なし → unauthenticated（DB を叩かない）', async () => {
  const rpc = stubRpc([validRow]);
  const r = await requireSession(reqWithCookie(), ENV, { rpc, logger: quiet });
  assert.equal(r.status, SESSION_RESULT.UNAUTHENTICATED);
  assert.equal(r.reason, 'no_cookie');
  assert.equal(rpc.calls.length, 0);
});

test('requireSession: 有効な Cookie → valid', async () => {
  const t = generateSessionToken();
  const rpc = stubRpc([validRow]);
  const r = await requireSession(
    reqWithCookie(`gtoken=x; ${SESSION_COOKIE_NAME}=${t}`), ENV, { rpc, logger: quiet });

  assert.equal(r.status, SESSION_RESULT.VALID);
  assert.equal(r.context.user_id, validRow.user_id);
  assert.equal(rpc.calls[0].args.p_token_hash, await hashSessionToken(t));
});

test('requireSession: DB 異常は未認証に丸めない', async () => {
  const t = generateSessionToken();
  const r = await requireSession(reqWithCookie(`${SESSION_COOKIE_NAME}=${t}`), ENV,
    { rpc: stubRpc([{ ...validRow, plan_id: null }]), logger: quiet });
  assert.equal(r.status, SESSION_RESULT.DATA_ERROR);
  assert.equal(isServerError(r), true);
});

test('requireSession: idle_expires_at から Cookie を更新できる', async () => {
  const t = generateSessionToken();
  const r = await requireSession(reqWithCookie(`${SESSION_COOKIE_NAME}=${t}`), ENV,
    { rpc: stubRpc([validRow]), logger: quiet });

  const cookie = buildSessionCookie(t, r.context.idle_expires_at,
                                    { now: new Date('2026-09-01T00:00:00Z') });
  assert.ok(cookie.includes(`Max-Age=${30 * 24 * 3600}`), cookie);
});

test('valid な結果に google_sub / email / token が含まれない', async () => {
  const r = await getSessionContext(ENV, generateSessionToken(),
    { rpc: stubRpc([{ ...validRow, google_sub: 'LEAK', email: 'leak@example.com' }]),
      logger: quiet });
  const keys = Object.keys(r.context);
  assert.equal(keys.includes('google_sub'), false);
  assert.equal(keys.includes('email'), false);
  assert.equal(keys.includes('token'), false);
  assert.equal(keys.includes('token_hash'), false);
});

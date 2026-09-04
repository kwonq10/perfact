// =========================================================
// _lib/ext-session.js の単体テスト
//
//   - Supabase RPC / google_sub 取得はすべてスタブ。ネットワークへは出ない。
//   - 本番の secret / Project URL / google_sub はフィクスチャに保存しない。
// =========================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_SESSION_TOKEN_ATTEMPTS,
  isTokenHashCollision,
  issueExtensionSession,
  parseBearerToken,
  requireExtSession,
} from '../_lib/ext-session.js';
import { SESSION_RESULT } from '../_lib/session.js';
import { SupabaseError } from '../_lib/supabase.js';

const ENV = {
  SUPABASE_URL: 'https://example-project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_dummy_for_tests_only',
};

const quiet = { error() {}, warn() {}, log() {} };

/** テスト用のダミー値（本番値ではない）。 */
const USER_ID = '11111111-2222-3333-4444-555555555555';
const DUMMY_SUB = 'dummy-sub-for-tests-only';
const TOKEN = 'dummy_session_token_base64url';

function req(authorization) {
  const headers = {};
  if (authorization !== null) headers.authorization = authorization;
  return new Request('https://example.com/api/ext/quota/reserve', { method: 'POST', headers });
}

// ---------------------------------------------------------
// parseBearerToken
// ---------------------------------------------------------

test('parseBearerToken: 正しい Bearer からトークンを取り出す', () => {
  assert.equal(parseBearerToken(req('Bearer ' + TOKEN)), TOKEN);
});

test('parseBearerToken: scheme の大小を区別しない', () => {
  assert.equal(parseBearerToken(req('bearer ' + TOKEN)), TOKEN);
  assert.equal(parseBearerToken(req('BEARER ' + TOKEN)), TOKEN);
});

test('parseBearerToken: 形式が違えば null', () => {
  const cases = [
    null,
    '',
    'Bearer',
    'Bearer ',
    'Basic ' + TOKEN,
    TOKEN,
    'Bearer token with space',
    'Bearer ' + 'token+with/base64=',   // base64url ではない
    'Bearer ' + 'token.with.dots',      // 同上
    'Bearer ' + 'token%2Fencoded',      // 同上
  ];
  for (const value of cases) {
    assert.equal(parseBearerToken(req(value)), null, JSON.stringify(value));
  }
});

// ---------------------------------------------------------
// requireExtSession
// ---------------------------------------------------------

test('requireExtSession: Bearer が無ければ DB を叩かずに未認証', async () => {
  let called = false;
  const rpc = async () => { called = true; return []; };
  const result = await requireExtSession(req(null), ENV, { rpc, logger: quiet });

  assert.equal(result.status, SESSION_RESULT.UNAUTHENTICATED);
  assert.equal(result.reason, 'no_bearer');
  assert.equal(called, false, 'RPC を呼んではいけない');
});

test('requireExtSession: 有効なら context を返す', async () => {
  const rpc = async () => ([{
    user_id: USER_ID,
    plan_id: 'free',
    status: 'active',
    idle_expires_at: '2026-10-01T00:00:00Z',
    absolute_expires_at: '2026-12-01T00:00:00Z',
  }]);

  const result = await requireExtSession(req('Bearer ' + TOKEN), ENV, { rpc, logger: quiet });
  assert.equal(result.status, SESSION_RESULT.VALID);
  assert.equal(result.context.user_id, USER_ID);
  assert.equal(result.context.plan_id, 'free');
});

test('requireExtSession: DB に無ければ未認証', async () => {
  const rpc = async () => ([]);
  const result = await requireExtSession(req('Bearer ' + TOKEN), ENV, { rpc, logger: quiet });
  assert.equal(result.status, SESSION_RESULT.UNAUTHENTICATED);
});

test('requireExtSession: Cookie ヘッダは見ない（Bearer 専用）', async () => {
  const request = new Request('https://example.com/api/ext/quota/reserve', {
    method: 'POST',
    headers: { cookie: '__Host-sukima_session=' + TOKEN },
  });
  let called = false;
  const rpc = async () => { called = true; return []; };
  const result = await requireExtSession(request, ENV, { rpc, logger: quiet });

  assert.equal(result.status, SESSION_RESULT.UNAUTHENTICATED);
  assert.equal(called, false, 'Cookie では認証しない');
});

// ---------------------------------------------------------
// isTokenHashCollision
// ---------------------------------------------------------

test('isTokenHashCollision: 23505 かつ sessions のときだけ true', () => {
  const hit = new SupabaseError('request_failed', 'x {"code":"23505"} sessions_pkey y');
  assert.equal(isTokenHashCollision(hit), true);

  assert.equal(isTokenHashCollision(new SupabaseError('unavailable', '{"code":"23505"} sessions_pkey')), false);
  assert.equal(isTokenHashCollision(new SupabaseError('request_failed', '{"code":"23503"} sessions_pkey')), false);
  assert.equal(isTokenHashCollision(new SupabaseError('request_failed', '{"code":"23505"} other_table')), false);
  assert.equal(isTokenHashCollision(new Error('boom')), false);
  assert.equal(isTokenHashCollision(null), false);
});

// ---------------------------------------------------------
// issueExtensionSession
// ---------------------------------------------------------

function issueDeps(over = {}) {
  return {
    logger: quiet,
    fetchGoogleSub: async () => DUMMY_SUB,
    generateToken: () => TOKEN,
    rpc: async () => ([{
      plan_id: 'free',
      status: 'active',
      idle_expires_at: '2026-10-01T00:00:00Z',
      absolute_expires_at: '2026-12-01T00:00:00Z',
    }]),
    ...over,
  };
}

test('issueExtensionSession: 既存 RPC を google_sub で呼び、トークンを返す', async () => {
  const calls = [];
  const deps = issueDeps({
    rpc: async (name, args) => {
      calls.push({ name, args });
      return [{ plan_id: 'free', status: 'active', idle_expires_at: '2026-10-01T00:00:00Z' }];
    },
  });

  const out = await issueExtensionSession(ENV, USER_ID, deps);

  assert.equal(out.ok, true);
  assert.equal(out.token, TOKEN);
  assert.equal(out.row.plan_id, 'free');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'upsert_user_and_create_session', '既存 RPC をそのまま使う');
  assert.equal(calls[0].args.p_google_sub, DUMMY_SUB);
  assert.equal(typeof calls[0].args.p_token_hash, 'string');
  assert.equal(calls[0].args.p_token_hash.length, 64, 'SHA-256 の hex');
  assert.match(calls[0].args.p_token_hash, /^[0-9a-f]{64}$/);
});

test('issueExtensionSession: 生トークンを DB へ送らない', async () => {
  const calls = [];
  const deps = issueDeps({
    rpc: async (name, args) => {
      calls.push(args);
      return [{ plan_id: 'free', status: 'active', idle_expires_at: '2026-10-01T00:00:00Z' }];
    },
  });

  await issueExtensionSession(ENV, USER_ID, deps);
  assert.equal(JSON.stringify(calls[0]).includes(TOKEN), false, '生トークンを送ってはいけない');
});

test('issueExtensionSession: users 行が無ければ user_not_found', async () => {
  const deps = issueDeps({ fetchGoogleSub: async () => null });
  const out = await issueExtensionSession(ENV, USER_ID, deps);
  assert.deepEqual(out, { ok: false, code: 'user_not_found' });
});

test('issueExtensionSession: google_sub 取得が到達不能なら database_unavailable', async () => {
  const deps = issueDeps({
    fetchGoogleSub: async () => { throw new SupabaseError('unavailable', 'boom'); },
  });
  const out = await issueExtensionSession(ENV, USER_ID, deps);
  assert.deepEqual(out, { ok: false, code: 'database_unavailable' });
});

test('issueExtensionSession: 設定不足なら server_misconfigured', async () => {
  const deps = issueDeps({
    fetchGoogleSub: async () => { throw new SupabaseError('not_configured', '未設定'); },
  });
  const out = await issueExtensionSession(ENV, USER_ID, deps);
  assert.deepEqual(out, { ok: false, code: 'server_misconfigured' });
});

test('issueExtensionSession: token_hash 衝突は張り直す', async () => {
  let attempts = 0;
  const tokens = ['tokenA', 'tokenB'];
  const deps = issueDeps({
    generateToken: () => tokens[attempts],
    rpc: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new SupabaseError('request_failed', '{"code":"23505"} sessions_pkey');
      }
      return [{ plan_id: 'free', status: 'active', idle_expires_at: '2026-10-01T00:00:00Z' }];
    },
  });

  const out = await issueExtensionSession(ENV, USER_ID, deps);
  assert.equal(out.ok, true);
  assert.equal(out.token, 'tokenB');
  assert.equal(attempts, 2);
});

test('issueExtensionSession: 衝突が続けば internal_error', async () => {
  let attempts = 0;
  const deps = issueDeps({
    generateToken: () => 'token' + attempts,
    rpc: async () => {
      attempts += 1;
      throw new SupabaseError('request_failed', '{"code":"23505"} sessions_pkey');
    },
  });

  const out = await issueExtensionSession(ENV, USER_ID, deps);
  assert.deepEqual(out, { ok: false, code: 'internal_error' });
  assert.equal(attempts, MAX_SESSION_TOKEN_ATTEMPTS);
});

test('issueExtensionSession: 戻り値が契約と違えば internal_error', async () => {
  for (const rows of [[], [{}, {}], [{ plan_id: 'free' }], null, [{ plan_id: 'free', status: 'active' }]]) {
    const out = await issueExtensionSession(ENV, USER_ID, issueDeps({ rpc: async () => rows }));
    assert.deepEqual(out, { ok: false, code: 'internal_error' }, JSON.stringify(rows));
  }
});

test('issueExtensionSession: google_sub をログへ出さない', async () => {
  const lines = [];
  const push = (...a) => lines.push(a.map(String).join(' '));
  const deps = issueDeps({
    logger: { error: push, warn: push, log: push },
    rpc: async () => { throw new SupabaseError('unavailable', 'boom'); },
  });

  await issueExtensionSession(ENV, USER_ID, deps);
  const joined = lines.join('\n');
  assert.equal(joined.includes(DUMMY_SUB), false, 'google_sub をログに出してはいけない');
  assert.equal(joined.includes(TOKEN), false, '生トークンをログに出してはいけない');
});

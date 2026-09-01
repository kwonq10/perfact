// =========================================================
// POST /api/auth/logout の単体テスト
//
//   - Supabase RPC はすべてスタブに差し替える。ネットワークへは出ない。
//   - 本番の secret / Project URL はフィクスチャに一切保存しない。
// =========================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { handleLogout } from '../auth/logout.js';
import {
  SESSION_COOKIE_NAME,
  generateSessionToken,
  hashSessionToken,
} from '../_lib/session.js';
import { SupabaseError } from '../_lib/supabase.js';

// --- テスト用のダミー設定（本番値ではない） ---
const ENV = {
  SUPABASE_URL: 'https://example-project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_dummy_for_tests_only',
};

const quiet = { error() {}, warn() {}, log() {} };

function recorder() {
  const lines = [];
  const push = (...a) => lines.push(a.map(String).join(' '));
  return { error: push, warn: push, log: push, lines };
}

function req(method = 'POST', cookie) {
  const headers = cookie === undefined ? {} : { cookie };
  return new Request('https://example.com/api/auth/logout', { method, headers });
}

/** RPC スタブ。呼び出しを記録する。delete_session は void を返す。 */
function stubRpc(result = null) {
  const calls = [];
  const fn = async (name, args, options) => { calls.push({ name, args, options }); return result; };
  fn.calls = calls;
  return fn;
}

function cookieOf(res) { return res.headers.get('set-cookie'); }
function attrs(c) { return c.split(';').map((s) => s.trim()); }
async function body(res) { return res.text(); }

// =========================================================
// メソッド
// =========================================================

test('GET は 405 method_not_allowed', async () => {
  const rpc = stubRpc();
  const res = await handleLogout(req('GET'), ENV, { rpc, logger: quiet });
  assert.equal(res.status, 405);
  assert.deepEqual(JSON.parse(await body(res)), { error: 'method_not_allowed' });
  assert.equal(cookieOf(res), null, '405 では Cookie を触らない');
  assert.equal(rpc.calls.length, 0);
});

test('PUT / DELETE / PATCH も 405', async () => {
  for (const m of ['PUT', 'DELETE', 'PATCH']) {
    assert.equal((await handleLogout(req(m), ENV, { logger: quiet })).status, 405, m);
  }
});

test('405 にも Cache-Control: no-store が付く', async () => {
  const res = await handleLogout(req('GET'), ENV, { logger: quiet });
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

// =========================================================
// Cookie なし / 形式不正（冪等・DB を叩かない）
// =========================================================

test('Cookie なし → 204（DB を叩かない）', async () => {
  const rpc = stubRpc();
  const res = await handleLogout(req('POST'), ENV, { rpc, logger: quiet });

  assert.equal(res.status, 204);
  assert.equal(rpc.calls.length, 0, 'DB を叩かない');
});

test('Cookie なしでも clear cookie を返す', async () => {
  const res = await handleLogout(req('POST'), ENV, { rpc: stubRpc(), logger: quiet });
  const a = attrs(cookieOf(res));
  assert.equal(a[0], `${SESSION_COOKIE_NAME}=`);
  assert.ok(a.includes('Max-Age=0'), 'Max-Age=0');
});

test('malformed Cookie → 204・DB を叩かない・clear cookie', async () => {
  const rpc = stubRpc();
  const cases = [
    `${SESSION_COOKIE_NAME}=`,
    `${SESSION_COOKIE_NAME}=has space`,
    `${SESSION_COOKIE_NAME}=a+b/c=`,
    `${SESSION_COOKIE_NAME}=%E0%A4%A`,
    `${SESSION_COOKIE_NAME}`,
    'gtoken=abc; lang=ja',
    ';;;',
  ];
  for (const c of cases) {
    const res = await handleLogout(req('POST', c), ENV, { rpc, logger: quiet });
    assert.equal(res.status, 204, c);
    assert.ok(attrs(cookieOf(res)).includes('Max-Age=0'), c);
  }
  assert.equal(rpc.calls.length, 0, 'いずれも DB を叩かない');
});

test('logout は冪等（連続呼び出しでも 204）', async () => {
  const t = generateSessionToken();
  const rpc = stubRpc();
  for (let i = 0; i < 3; i += 1) {
    const res = await handleLogout(req('POST', `${SESSION_COOKIE_NAME}=${t}`), ENV,
      { rpc, logger: quiet });
    assert.equal(res.status, 204);
  }
  assert.equal(rpc.calls.length, 3);
});

// =========================================================
// 有効 Cookie（RPC 呼び出し）
// =========================================================

test('有効 Cookie → 204', async () => {
  const t = generateSessionToken();
  const res = await handleLogout(req('POST', `${SESSION_COOKIE_NAME}=${t}`), ENV,
    { rpc: stubRpc(), logger: quiet });
  assert.equal(res.status, 204);
});

test('呼ぶ RPC は delete_session（1回だけ）', async () => {
  const t = generateSessionToken();
  const rpc = stubRpc();
  await handleLogout(req('POST', `${SESSION_COOKIE_NAME}=${t}`), ENV, { rpc, logger: quiet });

  assert.equal(rpc.calls.length, 1);
  assert.equal(rpc.calls[0].name, 'delete_session');
  assert.equal(rpc.calls[0].options.env, ENV);
});

test('RPC 引数は p_token_hash のみ', async () => {
  const t = generateSessionToken();
  const rpc = stubRpc();
  await handleLogout(req('POST', `${SESSION_COOKIE_NAME}=${t}`), ENV, { rpc, logger: quiet });
  assert.deepEqual(Object.keys(rpc.calls[0].args), ['p_token_hash']);
});

test('raw session token を RPC へ送らない', async () => {
  const t = generateSessionToken();
  const rpc = stubRpc();
  await handleLogout(req('POST', `${SESSION_COOKIE_NAME}=${t}`), ENV, { rpc, logger: quiet });

  assert.notEqual(rpc.calls[0].args.p_token_hash, t);
  assert.equal(JSON.stringify(rpc.calls[0].args).includes(t), false);
});

test('hash は小文字 hex 64文字で SHA-256(raw token) と一致', async () => {
  const t = generateSessionToken();
  const rpc = stubRpc();
  await handleLogout(req('POST', `${SESSION_COOKIE_NAME}=${t}`), ENV, { rpc, logger: quiet });

  const sent = rpc.calls[0].args.p_token_hash;
  assert.match(sent, /^[0-9a-f]{64}$/);
  assert.equal(sent, await hashSessionToken(t));
  assert.equal(sent, createHash('sha256').update(t, 'utf8').digest('hex'));
});

test('他 Cookie が混在していても正しい token を使う', async () => {
  const t = generateSessionToken();
  const rpc = stubRpc();
  const res = await handleLogout(
    req('POST', `gtoken=abc; ${SESSION_COOKIE_NAME}=${t}; lang=ja`), ENV, { rpc, logger: quiet });
  assert.equal(res.status, 204);
  assert.equal(rpc.calls[0].args.p_token_hash, await hashSessionToken(t));
});

test('session row が存在しなくても 204（RPC は冪等・void を返す）', async () => {
  const t = generateSessionToken();
  for (const result of [null, undefined, '', {}]) {
    const res = await handleLogout(req('POST', `${SESSION_COOKIE_NAME}=${t}`), ENV,
      { rpc: stubRpc(result), logger: quiet });
    assert.equal(res.status, 204, String(result));
  }
});

// =========================================================
// 成功レスポンス
// =========================================================

test('成功時の body は完全に空', async () => {
  const t = generateSessionToken();
  const res = await handleLogout(req('POST', `${SESSION_COOKIE_NAME}=${t}`), ENV,
    { rpc: stubRpc(), logger: quiet });
  assert.equal(res.status, 204);
  assert.equal(await body(res), '');
});

test('成功時に Cache-Control: no-store が付く', async () => {
  const t = generateSessionToken();
  const res = await handleLogout(req('POST', `${SESSION_COOKIE_NAME}=${t}`), ENV,
    { rpc: stubRpc(), logger: quiet });
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('成功時に clear cookie の属性がそろう', async () => {
  const t = generateSessionToken();
  const res = await handleLogout(req('POST', `${SESSION_COOKIE_NAME}=${t}`), ENV,
    { rpc: stubRpc(), logger: quiet });

  const c = cookieOf(res);
  const a = attrs(c);
  assert.equal(a[0], `${SESSION_COOKIE_NAME}=`);
  assert.ok(a.includes('Max-Age=0'), 'Max-Age=0');
  assert.ok(a.includes('HttpOnly'), 'HttpOnly');
  assert.ok(a.includes('Secure'), 'Secure');
  assert.ok(a.includes('SameSite=Lax'), 'SameSite=Lax');
  assert.ok(a.includes('Path=/'), 'Path=/');
});

test('clear cookie に Domain を付けない', async () => {
  const t = generateSessionToken();
  const res = await handleLogout(req('POST', `${SESSION_COOKIE_NAME}=${t}`), ENV,
    { rpc: stubRpc(), logger: quiet });
  assert.equal(/(^|;)\s*Domain\s*=/i.test(cookieOf(res)), false, cookieOf(res));
});

test('clear cookie に raw token / hash が載らない', async () => {
  const t = generateSessionToken();
  const rpc = stubRpc();
  const res = await handleLogout(req('POST', `${SESSION_COOKIE_NAME}=${t}`), ENV,
    { rpc, logger: quiet });
  const c = cookieOf(res);
  assert.equal(c.includes(t), false, 'raw token');
  assert.equal(c.includes(rpc.calls[0].args.p_token_hash), false, 'hash');
});

// =========================================================
// DB 障害（204 に丸めない・Cookie を削除しない）
// =========================================================

test('Supabase 到達不能 → 502 database_unavailable', async () => {
  const t = generateSessionToken();
  const rpc = async () => { throw new SupabaseError('unavailable', 'unreachable'); };
  const res = await handleLogout(req('POST', `${SESSION_COOKIE_NAME}=${t}`), ENV,
    { rpc, logger: quiet });

  assert.equal(res.status, 502);
  assert.deepEqual(JSON.parse(await body(res)), { error: 'database_unavailable' });
  assert.equal(cookieOf(res), null, 'Cookie を削除しない');
});

test('Supabase リクエスト失敗（4xx）→ 502', async () => {
  const t = generateSessionToken();
  const rpc = async () => { throw new SupabaseError('request_failed', 'status=400'); };
  const res = await handleLogout(req('POST', `${SESSION_COOKIE_NAME}=${t}`), ENV,
    { rpc, logger: quiet });

  assert.equal(res.status, 502);
  assert.deepEqual(JSON.parse(await body(res)), { error: 'database_unavailable' });
  assert.equal(cookieOf(res), null);
});

test('環境変数の設定漏れ → 500 server_misconfigured', async () => {
  const t = generateSessionToken();
  const rpc = async () => { throw new SupabaseError('not_configured', 'SUPABASE_URL 未設定'); };
  const res = await handleLogout(req('POST', `${SESSION_COOKIE_NAME}=${t}`), ENV,
    { rpc, logger: quiet });

  assert.equal(res.status, 500);
  assert.deepEqual(JSON.parse(await body(res)), { error: 'server_misconfigured' });
  assert.equal(cookieOf(res), null);
});

test('想定外の例外 → 500 internal_error', async () => {
  const t = generateSessionToken();
  const rpc = async () => { throw new Error('boom'); };
  const res = await handleLogout(req('POST', `${SESSION_COOKIE_NAME}=${t}`), ENV,
    { rpc, logger: quiet });

  assert.equal(res.status, 500);
  assert.deepEqual(JSON.parse(await body(res)), { error: 'internal_error' });
  assert.equal(cookieOf(res), null);
});

test('DB エラーを 204 へ丸めない', async () => {
  const t = generateSessionToken();
  const errs = [
    new SupabaseError('unavailable', 'x'),
    new SupabaseError('request_failed', 'x'),
    new SupabaseError('not_configured', 'x'),
    new Error('x'),
  ];
  for (const e of errs) {
    const res = await handleLogout(req('POST', `${SESSION_COOKIE_NAME}=${t}`), ENV,
      { rpc: async () => { throw e; }, logger: quiet });
    assert.notEqual(res.status, 204, e.code ?? e.message);
    assert.ok(res.status >= 500, e.code ?? e.message);
    assert.equal(cookieOf(res), null, 'Cookie を触らない');
  }
});

test('DB エラーのレスポンスに内部詳細が漏れない', async () => {
  const t = generateSessionToken();
  const rpc = async () => {
    throw new SupabaseError('unavailable', 'secret detail ' + ENV.SUPABASE_SERVICE_ROLE_KEY);
  };
  const res = await handleLogout(req('POST', `${SESSION_COOKIE_NAME}=${t}`), ENV,
    { rpc, logger: quiet });
  const text = await body(res);
  assert.deepEqual(Object.keys(JSON.parse(text)), ['error']);
  assert.equal(text.includes(ENV.SUPABASE_SERVICE_ROLE_KEY), false);
  assert.equal(text.includes('secret detail'), false);
});

// =========================================================
// 情報漏洩・副作用
// =========================================================

test('ログに raw token / token hash を出さない', async () => {
  const t = generateSessionToken();
  const hash = await hashSessionToken(t);

  // 成功パス
  const okLog = recorder();
  await handleLogout(req('POST', `${SESSION_COOKIE_NAME}=${t}`), ENV,
    { rpc: stubRpc(), logger: okLog });
  assert.equal(okLog.lines.join('\n').includes(t), false, 'raw token（成功時）');
  assert.equal(okLog.lines.join('\n').includes(hash), false, 'hash（成功時）');

  // エラーパス
  const errLog = recorder();
  await handleLogout(req('POST', `${SESSION_COOKIE_NAME}=${t}`), ENV,
    { rpc: async () => { throw new SupabaseError('unavailable', 'boom ' + hash); },
      logger: errLog });
  const all = errLog.lines.join('\n');
  assert.equal(all.includes(t), false, 'raw token（エラー時）');
  assert.equal(all.includes(hash), false, 'hash（エラー時）');
});

test('レスポンスに user_id / google_sub / email が出ない', async () => {
  const t = generateSessionToken();
  const res = await handleLogout(req('POST', `${SESSION_COOKIE_NAME}=${t}`), ENV,
    { rpc: stubRpc(), logger: quiet });
  const dump = (await body(res)) + '\n' + [...res.headers].map((h) => h.join(': ')).join('\n');
  for (const f of ['user_id', 'google_sub', 'email', 'plan_id', 'status',
                   ENV.SUPABASE_SERVICE_ROLE_KEY, ENV.SUPABASE_URL]) {
    assert.equal(dump.includes(f), false, f);
  }
});

test('delete_session 以外の RPC を呼ばない（他 session / user / subscription に触れない）', async () => {
  const t = generateSessionToken();
  const rpc = stubRpc();
  await handleLogout(req('POST', `${SESSION_COOKIE_NAME}=${t}`), ENV, { rpc, logger: quiet });

  const names = rpc.calls.map((c) => c.name);
  assert.deepEqual(names, ['delete_session']);
  for (const forbidden of ['upsert_user_and_create_session', 'upsert_user_and_subscription',
                           'get_session_context', 'consume_weekly_usage']) {
    assert.equal(names.includes(forbidden), false, forbidden);
  }
  // user_id を指定するような引数を持たない = 他端末セッションを消せない
  assert.deepEqual(Object.keys(rpc.calls[0].args), ['p_token_hash']);
});

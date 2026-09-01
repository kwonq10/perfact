// =========================================================
// GET /api/auth/me の単体テスト
//
//   - Supabase RPC はすべてスタブに差し替える。ネットワークへは出ない。
//   - 本番の secret / Project URL はフィクスチャに一切保存しない。
//   - session 検証は実物の requireSession を通し、RPC だけを差し替える
//     （Cookie 解析・分類ロジックを迂回しないため）。
// =========================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { handleMe } from '../auth/me.js';
import {
  SESSION_COOKIE_NAME,
  SESSION_RESULT,
  generateSessionToken,
  hashSessionToken,
} from '../_lib/session.js';
import { SupabaseError } from '../_lib/supabase.js';

// --- テスト用のダミー設定（本番値ではない） ---
const ENV = {
  SUPABASE_URL: 'https://example-project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_dummy_for_tests_only',
};

const IDLE = '2026-10-01T00:00:00Z';
const ABS = '2026-11-30T00:00:00Z';
const NOW = new Date('2026-09-01T00:00:00Z');
const USER_ID = '11111111-2222-3333-4444-555555555555';

const validRow = {
  user_id: USER_ID, plan_id: 'free', status: 'active',
  idle_expires_at: IDLE, absolute_expires_at: ABS,
};

const quiet = { error() {}, warn() {}, log() {} };

function recorder() {
  const lines = [];
  const push = (...a) => lines.push(a.map(String).join(' '));
  return { error: push, warn: push, log: push, lines };
}

function req(method = 'GET', cookie) {
  const headers = cookie === undefined ? {} : { cookie };
  return new Request('https://example.com/api/auth/me', { method, headers });
}

/** RPC スタブ。呼び出しを記録する。 */
function stubRpc(rows) {
  const calls = [];
  const fn = async (name, args, options) => { calls.push({ name, args, options }); return rows; };
  fn.calls = calls;
  return fn;
}

async function body(res) { return JSON.parse(await res.text()); }
function cookieOf(res) { return res.headers.get('set-cookie'); }
function attrs(c) { return c.split(';').map((s) => s.trim()); }

/** requireSession を固定結果に差し替えるスタブ（分類ごとの検証用） */
function sessionStub(result) {
  return async () => result;
}

// =========================================================
// メソッド
// =========================================================

test('POST は 405 method_not_allowed', async () => {
  const res = await handleMe(req('POST'), ENV, { logger: quiet });
  assert.equal(res.status, 405);
  assert.deepEqual(await body(res), { error: 'method_not_allowed' });
  assert.equal(cookieOf(res), null);
});

test('PUT / DELETE も 405', async () => {
  for (const m of ['PUT', 'DELETE', 'PATCH']) {
    assert.equal((await handleMe(req(m), ENV, { logger: quiet })).status, 405, m);
  }
});

test('405 でも Cache-Control: no-store が付く', async () => {
  const res = await handleMe(req('POST'), ENV, { logger: quiet });
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

// =========================================================
// 未認証（401 + Cookie 削除）
// =========================================================

test('Cookie なし → 401 { authenticated: false }', async () => {
  const rpc = stubRpc([validRow]);
  const res = await handleMe(req('GET'), ENV, { rpc, logger: quiet });

  assert.equal(res.status, 401);
  assert.deepEqual(await body(res), { authenticated: false });
  assert.equal(rpc.calls.length, 0, 'DB を叩かない');
});

test('Cookie なしでも clear cookie を返す', async () => {
  const res = await handleMe(req('GET'), ENV, { rpc: stubRpc([]), logger: quiet });
  const a = attrs(cookieOf(res));
  assert.equal(a[0], `${SESSION_COOKIE_NAME}=`);
  assert.ok(a.includes('Max-Age=0'), 'Max-Age=0');
  assert.ok(a.includes('HttpOnly'));
  assert.ok(a.includes('Secure'));
  assert.ok(a.includes('SameSite=Lax'));
  assert.ok(a.includes('Path=/'));
  assert.equal(/(^|;)\s*Domain\s*=/i.test(cookieOf(res)), false);
});

test('形式不正な Cookie → 401 + clear cookie（DB を叩かない）', async () => {
  const rpc = stubRpc([validRow]);
  for (const c of [`${SESSION_COOKIE_NAME}=`, `${SESSION_COOKIE_NAME}=has space`,
                   `${SESSION_COOKIE_NAME}=a+b/c=`, 'gtoken=abc; lang=ja']) {
    const res = await handleMe(req('GET', c), ENV, { rpc, logger: quiet });
    assert.equal(res.status, 401, c);
    assert.deepEqual(await body(res), { authenticated: false });
    assert.ok(attrs(cookieOf(res)).includes('Max-Age=0'), c);
  }
  assert.equal(rpc.calls.length, 0);
});

test('session 不存在（RPC 0行） → 401 + clear cookie', async () => {
  const t = generateSessionToken();
  const res = await handleMe(req('GET', `${SESSION_COOKIE_NAME}=${t}`), ENV,
    { rpc: stubRpc([]), logger: quiet });
  assert.equal(res.status, 401);
  assert.deepEqual(await body(res), { authenticated: false });
  assert.ok(attrs(cookieOf(res)).includes('Max-Age=0'));
});

test('期限切れ session（RPC が 0行を返す） → 401 + clear cookie', async () => {
  const t = generateSessionToken();
  const res = await handleMe(req('GET', `${SESSION_COOKIE_NAME}=${t}`), ENV,
    { rpc: stubRpc(null), logger: quiet });
  assert.equal(res.status, 401);
  assert.ok(attrs(cookieOf(res)).includes('Max-Age=0'));
});

test('401 レスポンスに plan_id / status を含めない', async () => {
  const res = await handleMe(req('GET'), ENV, { rpc: stubRpc([]), logger: quiet });
  const payload = await body(res);
  assert.deepEqual(Object.keys(payload), ['authenticated']);
  assert.equal(payload.authenticated, false);
});

// =========================================================
// 正常系（200 + sliding Cookie）
// =========================================================

test('有効 session → 200 { authenticated, plan_id, status } のみ', async () => {
  const t = generateSessionToken();
  const res = await handleMe(req('GET', `${SESSION_COOKIE_NAME}=${t}`), ENV,
    { rpc: stubRpc([validRow]), logger: quiet, now: NOW });

  assert.equal(res.status, 200);
  const payload = await body(res);
  assert.deepEqual(Object.keys(payload).sort(), ['authenticated', 'plan_id', 'status']);
  assert.deepEqual(payload, { authenticated: true, plan_id: 'free', status: 'active' });
});

test('200 に Cache-Control: no-store と Vary: Cookie が付く', async () => {
  const t = generateSessionToken();
  const res = await handleMe(req('GET', `${SESSION_COOKIE_NAME}=${t}`), ENV,
    { rpc: stubRpc([validRow]), logger: quiet, now: NOW });
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('vary'), 'Cookie');
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
});

test('plan_id / status は毎回 DB の値をそのまま返す（Stripe 変更が即反映）', async () => {
  const t = generateSessionToken();
  for (const [plan, st] of [['free', 'active'], ['all_pro', 'active'],
                            ['web_pro', 'past_due'], ['extension_pro', 'canceled']]) {
    const res = await handleMe(req('GET', `${SESSION_COOKIE_NAME}=${t}`), ENV,
      { rpc: stubRpc([{ ...validRow, plan_id: plan, status: st }]), logger: quiet, now: NOW });
    assert.deepEqual(await body(res), { authenticated: true, plan_id: plan, status: st });
  }
});

test('sliding: Cookie の値は据え置き（新しい token を発行しない）', async () => {
  const t = generateSessionToken();
  const res = await handleMe(req('GET', `${SESSION_COOKIE_NAME}=${t}`), ENV,
    { rpc: stubRpc([validRow]), logger: quiet, now: NOW });

  const a = attrs(cookieOf(res));
  assert.equal(a[0], `${SESSION_COOKIE_NAME}=${t}`, '同じ token');
});

test('sliding: Max-Age は DB の idle_expires_at から算出される', async () => {
  const t = generateSessionToken();
  // 2026-09-01 → 2026-10-01 は 30日
  const res = await handleMe(req('GET', `${SESSION_COOKIE_NAME}=${t}`), ENV,
    { rpc: stubRpc([validRow]), logger: quiet, now: NOW });
  assert.ok(attrs(cookieOf(res)).includes(`Max-Age=${30 * 24 * 3600}`), cookieOf(res));

  // absolute に張り付いて残り 5日のケース → 5日になる（独自 TTL 計算をしない）
  const near = '2026-09-06T00:00:00Z';
  const res2 = await handleMe(req('GET', `${SESSION_COOKIE_NAME}=${t}`), ENV,
    { rpc: stubRpc([{ ...validRow, idle_expires_at: near, absolute_expires_at: near }]),
      logger: quiet, now: NOW });
  assert.ok(attrs(cookieOf(res2)).includes(`Max-Age=${5 * 24 * 3600}`), cookieOf(res2));
});

test('sliding: Cookie 属性がそろい Domain を付けない', async () => {
  const t = generateSessionToken();
  const res = await handleMe(req('GET', `${SESSION_COOKIE_NAME}=${t}`), ENV,
    { rpc: stubRpc([validRow]), logger: quiet, now: NOW });
  const a = attrs(cookieOf(res));
  assert.ok(a.includes('HttpOnly'));
  assert.ok(a.includes('Secure'));
  assert.ok(a.includes('SameSite=Lax'));
  assert.ok(a.includes('Path=/'));
  assert.equal(/(^|;)\s*Domain\s*=/i.test(cookieOf(res)), false);
});

test('他 Cookie が混在していても正しく延長する', async () => {
  const t = generateSessionToken();
  const res = await handleMe(
    req('GET', `gtoken=abc; ${SESSION_COOKIE_NAME}=${t}; lang=ja`), ENV,
    { rpc: stubRpc([validRow]), logger: quiet, now: NOW });
  assert.equal(res.status, 200);
  assert.equal(attrs(cookieOf(res))[0], `${SESSION_COOKIE_NAME}=${t}`);
});

test('RPC には p_token_hash だけを渡す（生 token を渡さない）', async () => {
  const t = generateSessionToken();
  const rpc = stubRpc([validRow]);
  await handleMe(req('GET', `${SESSION_COOKIE_NAME}=${t}`), ENV,
    { rpc, logger: quiet, now: NOW });

  assert.equal(rpc.calls.length, 1);
  assert.equal(rpc.calls[0].name, 'get_session_context');
  assert.deepEqual(Object.keys(rpc.calls[0].args), ['p_token_hash']);
  assert.equal(rpc.calls[0].args.p_token_hash, await hashSessionToken(t));
  assert.equal(JSON.stringify(rpc.calls[0].args).includes(t), false);
});

test('レスポンスに user_id / google_sub / email / 有効期限が漏れない', async () => {
  const t = generateSessionToken();
  const rpc = stubRpc([{ ...validRow, google_sub: 'SUBSUB', email: 'leak@example.com' }]);
  const res = await handleMe(req('GET', `${SESSION_COOKIE_NAME}=${t}`), ENV,
    { rpc, logger: quiet, now: NOW });

  const text = JSON.stringify(await body(res));
  const hash = rpc.calls[0].args.p_token_hash;
  for (const f of ['user_id', USER_ID, 'google_sub', 'SUBSUB', 'leak@example.com',
                   'idle_expires_at', 'absolute_expires_at', IDLE, ABS, hash, t,
                   ENV.SUPABASE_SERVICE_ROLE_KEY, ENV.SUPABASE_URL]) {
    assert.equal(text.includes(f), false, f);
  }
  // Set-Cookie には不透明 token だけ（hash は載らない）
  assert.equal(cookieOf(res).includes(hash), false);
  assert.equal(cookieOf(res).includes(USER_ID), false);
});

test('ログに raw token / token hash を出さない', async () => {
  const t = generateSessionToken();
  const log = recorder();
  const rpc = stubRpc([validRow]);
  await handleMe(req('GET', `${SESSION_COOKIE_NAME}=${t}`), ENV, { rpc, logger: log, now: NOW });
  const all = log.lines.join('\n');
  assert.equal(all.includes(t), false);
  assert.equal(all.includes(rpc.calls[0].args.p_token_hash), false);
});

// =========================================================
// DB データ異常（500・401 に丸めない・Cookie を消さない）
// =========================================================

test('plan_id が null（subscriptions 欠落） → 500 internal_error', async () => {
  const t = generateSessionToken();
  const res = await handleMe(req('GET', `${SESSION_COOKIE_NAME}=${t}`), ENV,
    { rpc: stubRpc([{ ...validRow, plan_id: null }]), logger: quiet, now: NOW });

  assert.equal(res.status, 500);
  assert.deepEqual(await body(res), { error: 'internal_error' });
  assert.equal(cookieOf(res), null, 'Cookie を削除しない');
});

test('status が null → 500・Cookie を消さない', async () => {
  const t = generateSessionToken();
  const res = await handleMe(req('GET', `${SESSION_COOKIE_NAME}=${t}`), ENV,
    { rpc: stubRpc([{ ...validRow, status: null }]), logger: quiet, now: NOW });
  assert.equal(res.status, 500);
  assert.equal(cookieOf(res), null);
});

test('user_id 欠落 → 500', async () => {
  const t = generateSessionToken();
  const res = await handleMe(req('GET', `${SESSION_COOKIE_NAME}=${t}`), ENV,
    { rpc: stubRpc([{ ...validRow, user_id: null }]), logger: quiet, now: NOW });
  assert.equal(res.status, 500);
  assert.equal(cookieOf(res), null);
});

test('複数行 → 500（DB 異常）', async () => {
  const t = generateSessionToken();
  const res = await handleMe(req('GET', `${SESSION_COOKIE_NAME}=${t}`), ENV,
    { rpc: stubRpc([validRow, validRow]), logger: quiet, now: NOW });
  assert.equal(res.status, 500);
  assert.deepEqual(await body(res), { error: 'internal_error' });
  assert.equal(cookieOf(res), null);
});

test('idle_expires_at が日時として不正 → 500・Cookie を消さない', async () => {
  const t = generateSessionToken();
  const res = await handleMe(req('GET', `${SESSION_COOKIE_NAME}=${t}`), ENV,
    { rpc: stubRpc([{ ...validRow, idle_expires_at: 'not-a-date' }]), logger: quiet, now: NOW });
  assert.equal(res.status, 500);
  assert.deepEqual(await body(res), { error: 'internal_error' });
  assert.equal(cookieOf(res), null);
});

test('idle_expires_at が null → 500', async () => {
  const t = generateSessionToken();
  const res = await handleMe(req('GET', `${SESSION_COOKIE_NAME}=${t}`), ENV,
    { rpc: stubRpc([{ ...validRow, idle_expires_at: null }]), logger: quiet, now: NOW });
  assert.equal(res.status, 500);
  assert.equal(cookieOf(res), null);
});

test('DB 異常のレスポンスに内部詳細や user_id を含めない', async () => {
  const t = generateSessionToken();
  const res = await handleMe(req('GET', `${SESSION_COOKIE_NAME}=${t}`), ENV,
    { rpc: stubRpc([{ ...validRow, plan_id: null }]), logger: quiet, now: NOW });
  const payload = await body(res);
  assert.deepEqual(Object.keys(payload), ['error']);
  assert.equal(payload.error, 'internal_error');
  assert.equal(JSON.stringify(payload).includes(USER_ID), false);
});

// =========================================================
// Supabase 障害 / 設定不備（401 に丸めない・Cookie を消さない）
// =========================================================

test('Supabase 到達不能 → 502 database_unavailable', async () => {
  const t = generateSessionToken();
  const rpc = async () => { throw new SupabaseError('unavailable', 'unreachable'); };
  const res = await handleMe(req('GET', `${SESSION_COOKIE_NAME}=${t}`), ENV,
    { rpc, logger: quiet, now: NOW });

  assert.equal(res.status, 502);
  assert.deepEqual(await body(res), { error: 'database_unavailable' });
  assert.equal(cookieOf(res), null, 'Cookie を削除しない');
});

test('Supabase リクエスト失敗 → 502', async () => {
  const t = generateSessionToken();
  const rpc = async () => { throw new SupabaseError('request_failed', 'status=400'); };
  const res = await handleMe(req('GET', `${SESSION_COOKIE_NAME}=${t}`), ENV,
    { rpc, logger: quiet, now: NOW });
  assert.equal(res.status, 502);
  assert.equal(cookieOf(res), null);
});

test('環境変数の設定漏れ → 500 server_misconfigured', async () => {
  const t = generateSessionToken();
  const rpc = async () => { throw new SupabaseError('not_configured', 'SUPABASE_URL 未設定'); };
  const res = await handleMe(req('GET', `${SESSION_COOKIE_NAME}=${t}`), ENV,
    { rpc, logger: quiet, now: NOW });

  assert.equal(res.status, 500);
  assert.deepEqual(await body(res), { error: 'server_misconfigured' });
  assert.equal(cookieOf(res), null);
});

test('想定外の例外 → 502（未認証に丸めない）', async () => {
  const t = generateSessionToken();
  const rpc = async () => { throw new Error('boom'); };
  const res = await handleMe(req('GET', `${SESSION_COOKIE_NAME}=${t}`), ENV,
    { rpc, logger: quiet, now: NOW });
  assert.equal(res.status, 502);
  assert.equal(cookieOf(res), null);
});

// =========================================================
// 分類ごとの網羅（session 結果を直接注入）
// =========================================================

test('SESSION_RESULT の各分類が正しい HTTP へ写像される', async () => {
  const cases = [
    [{ status: SESSION_RESULT.UNAUTHENTICATED, reason: 'no_cookie' }, 401, true],
    [{ status: SESSION_RESULT.DATA_ERROR, reason: 'missing_subscription' }, 500, false],
    [{ status: SESSION_RESULT.UNAVAILABLE, reason: 'unavailable' }, 502, false],
    [{ status: SESSION_RESULT.MISCONFIGURED, reason: 'not_configured' }, 500, false],
    [{ status: 'unknown-status' }, 500, false],
    [undefined, 500, false],
  ];
  for (const [result, want, clears] of cases) {
    const res = await handleMe(req('GET'), ENV,
      { session: sessionStub(result), logger: quiet, now: NOW });
    assert.equal(res.status, want, JSON.stringify(result));
    if (clears) {
      assert.ok(attrs(cookieOf(res)).includes('Max-Age=0'), 'clear cookie');
    } else {
      assert.equal(cookieOf(res), null, 'Cookie を触らない');
    }
  }
});

test('valid なのに context が壊れている → 500', async () => {
  for (const context of [undefined, {}, { plan_id: 'free' }, { status: 'active' }]) {
    const res = await handleMe(req('GET'), ENV,
      { session: sessionStub({ status: SESSION_RESULT.VALID, context }), logger: quiet, now: NOW });
    assert.equal(res.status, 500, JSON.stringify(context ?? null));
    assert.equal(cookieOf(res), null);
  }
});

test('valid なのに Cookie を取り出せない → 500（想定外）', async () => {
  const res = await handleMe(req('GET'), ENV,   // Cookie ヘッダなし
    { session: sessionStub({ status: SESSION_RESULT.VALID, context: {
        user_id: USER_ID, plan_id: 'free', status: 'active',
        idle_expires_at: IDLE, absolute_expires_at: ABS } }),
      logger: quiet, now: NOW });
  assert.equal(res.status, 500);
  assert.deepEqual(await body(res), { error: 'internal_error' });
});

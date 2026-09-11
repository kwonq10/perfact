// =========================================================
// GET /api/quota/status の単体テスト
//
//   - Supabase RPC / session はすべてスタブに差し替える。ネットワークへは出ない。
//   - 本番の secret / Project URL はフィクスチャに一切保存しない。
//   - **quota を消費しないこと**を最重要の検証項目とする。
// =========================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { handleQuotaStatus } from '../quota/status.js';
import { SESSION_COOKIE_NAME, SESSION_RESULT } from '../_lib/session.js';
import { SupabaseError } from '../_lib/supabase.js';
import { FREE_WEEKLY_LIMIT } from '../_lib/quota.js';

const ENV = {
  SUPABASE_URL: 'https://example-project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_dummy_for_tests_only',
};

const quiet = { error() {}, warn() {}, log() {} };
const USER_ID = '11111111-2222-3333-4444-555555555555';

/** get_quota_status の契約どおりの 1 行。 */
const ROW = {
  used: 1,
  remaining: 2,
  quota_limit: 3,
  week_start: '2026-08-31',
  next_reset_at: '2026-09-06T15:00:00+00:00',
};

function req({ method = 'GET', url = 'https://example.com/api/quota/status',
               cookie = `${SESSION_COOKIE_NAME}=dummytoken` } = {}) {
  const headers = {};
  if (cookie !== null) headers.cookie = cookie;
  const init = { method, headers };
  if (method !== 'GET' && method !== 'HEAD') init.body = '{}';
  return new Request(url, init);
}

function stubSession(context = { plan_id: 'free', status: 'active' }) {
  const calls = [];
  const fn = async (request, env, deps) => {
    calls.push({ request, env, deps });
    if (context && context.status && context.plan_id) {
      return { status: SESSION_RESULT.VALID, context: { user_id: USER_ID, ...context } };
    }
    return context;
  };
  fn.calls = calls;
  return fn;
}

function stubRpc(rows = [ROW]) {
  const calls = [];
  const fn = async (name, args, options) => {
    calls.push({ name, args, options });
    if (rows instanceof Error) throw rows;
    return rows;
  };
  fn.calls = calls;
  return fn;
}

async function call(overrides = {}, request = req()) {
  const deps = { session: stubSession(), rpc: stubRpc(), logger: quiet, ...overrides };
  const res = await handleQuotaStatus(request, ENV, deps);
  const body = await res.json().catch(() => null);
  return { res, body, deps };
}

// =========================================================
// 1. 認証 / method
// =========================================================

test('未認証は 401 unauthenticated で RPC を呼ばない', async () => {
  const rpc = stubRpc();
  const { res, body } = await call({
    session: stubSession({ status: SESSION_RESULT.UNAUTHENTICATED }), rpc,
  });
  assert.equal(res.status, 401);
  assert.deepEqual(body, { error: 'unauthenticated' });
  assert.equal(rpc.calls.length, 0);
});

test('GET 以外は 405', async () => {
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const rpc = stubRpc();
    const { res, body } = await call({ rpc }, req({ method }));
    assert.equal(res.status, 405, method);
    assert.deepEqual(body, { error: 'method_not_allowed' });
    assert.equal(rpc.calls.length, 0);
  }
});

test('GET なので Origin 検証はしない（Origin 無しでも 200）', async () => {
  // _lib/origin.js:24 の方針（GET には checkOrigin を適用しない）に合わせる。
  const { res } = await call();
  assert.equal(res.status, 200);
});

// =========================================================
// 2. Free 系（quota 対象）
// =========================================================

test('free + active は get_quota_status を呼ぶ', async () => {
  const rpc = stubRpc();
  const { res, body } = await call({ rpc });
  assert.equal(res.status, 200);
  assert.deepEqual(body, {
    unlimited: false,
    limit: 3,
    used: 1,
    remaining: 2,
    week_start: '2026-08-31',
    next_reset_at: '2026-09-06T15:00:00+00:00',
  });
  assert.equal(rpc.calls.length, 1);
  assert.equal(rpc.calls[0].name, 'get_quota_status');
});

test('p_limit は必ずサーバーの FREE_WEEKLY_LIMIT（3）', async () => {
  const rpc = stubRpc();
  await call({ rpc });
  assert.equal(rpc.calls[0].args.p_limit, FREE_WEEKLY_LIMIT);
  assert.equal(rpc.calls[0].args.p_limit, 3);
  assert.deepEqual(Object.keys(rpc.calls[0].args).sort(), ['p_limit', 'p_user_id']);
});

test('クエリ文字列の limit は無視される', async () => {
  for (const q of ['?limit=999', '?limit=0', '?p_limit=999', '?limit=abc']) {
    const rpc = stubRpc();
    await call({ rpc }, req({ url: 'https://example.com/api/quota/status' + q }));
    assert.equal(rpc.calls[0].args.p_limit, 3, q + ' で上限が変わってはいけない');
  }
});

test('user_id は session 由来のみ', async () => {
  const rpc = stubRpc();
  await call({ rpc }, req({
    url: 'https://example.com/api/quota/status?user_id=99999999-9999-9999-9999-999999999999',
  }));
  assert.equal(rpc.calls[0].args.p_user_id, USER_ID);
});

test('extension_pro は Web では quota 対象', async () => {
  for (const status of ['active', 'trialing']) {
    const rpc = stubRpc();
    const { res, body } = await call({
      session: stubSession({ plan_id: 'extension_pro', status }), rpc,
    });
    assert.equal(res.status, 200, status);
    assert.equal(body.unlimited, false);
    assert.equal(rpc.calls.length, 1, 'RPC を呼ぶこと');
  }
});

test('past_due（past_due_since なし）は quota 対象', async () => {
  for (const plan_id of ['web_pro', 'all_pro']) {
    const rpc = stubRpc();
    const { body } = await call({
      session: stubSession({ plan_id, status: 'past_due' }), rpc,
    });
    assert.equal(body.unlimited, false, plan_id);
    assert.equal(rpc.calls.length, 1);
  }
});

test('Pro 扱いしない status はすべて quota 対象', async () => {
  for (const status of ['canceled', 'unpaid', 'incomplete', 'incomplete_expired']) {
    const rpc = stubRpc();
    const { body } = await call({ session: stubSession({ plan_id: 'web_pro', status }), rpc });
    assert.equal(body.unlimited, false, status);
    assert.equal(rpc.calls.length, 1);
  }
});

// =========================================================
// 3. Pro 系（quota 免除・RPC を呼ばない）
// =========================================================

test('web_pro + active は unlimited を返し RPC を呼ばない', async () => {
  const rpc = stubRpc();
  const { res, body } = await call({
    session: stubSession({ plan_id: 'web_pro', status: 'active' }), rpc,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(body, {
    unlimited: true,
    limit: null,
    used: null,
    remaining: null,
    week_start: null,
    next_reset_at: null,
  });
  assert.equal(rpc.calls.length, 0, 'Pro では DB を叩かない');
});

test('all_pro + active も unlimited', async () => {
  const rpc = stubRpc();
  const { body } = await call({
    session: stubSession({ plan_id: 'all_pro', status: 'active' }), rpc,
  });
  assert.equal(body.unlimited, true);
  assert.equal(rpc.calls.length, 0);
});

test('trialing も unlimited になる', async () => {
  for (const plan_id of ['web_pro', 'all_pro']) {
    const rpc = stubRpc();
    const { body } = await call({ session: stubSession({ plan_id, status: 'trialing' }), rpc });
    assert.equal(body.unlimited, true, plan_id);
    assert.equal(rpc.calls.length, 0);
  }
});

test('plan x status の全組み合わせで unlimited 分岐が entitlement と一致', async () => {
  const plans = ['free', 'web_pro', 'extension_pro', 'all_pro'];
  const statuses = ['active', 'trialing', 'past_due', 'canceled',
                    'unpaid', 'incomplete', 'incomplete_expired'];
  for (const plan_id of plans) {
    for (const status of statuses) {
      const expected = (plan_id === 'web_pro' || plan_id === 'all_pro')
                    && (status === 'active' || status === 'trialing');
      const rpc = stubRpc();
      const { body } = await call({ session: stubSession({ plan_id, status }), rpc });
      assert.equal(body.unlimited, expected, plan_id + ' / ' + status);
      assert.equal(rpc.calls.length, expected ? 0 : 1, plan_id + ' / ' + status);
    }
  }
});

// =========================================================
// 4. quota を消費しないこと（最重要）
// =========================================================

test('何度呼んでも reserve / commit / release を一切呼ばない', async () => {
  const rpc = stubRpc();
  const deps = { session: stubSession(), rpc, logger: quiet };
  for (let i = 0; i < 10; i += 1) {
    const res = await handleQuotaStatus(req(), ENV, deps);
    assert.equal(res.status, 200, 'call ' + i);
  }
  assert.equal(rpc.calls.length, 10);
  const names = new Set(rpc.calls.map((c) => c.name));
  assert.deepEqual([...names], ['get_quota_status']);
  for (const forbidden of ['reserve_weekly_usage', 'commit_weekly_usage',
                           'release_weekly_usage', 'consume_weekly_usage']) {
    assert.equal(names.has(forbidden), false, forbidden + ' を呼んではいけない');
  }
});

test('idempotency_key を作らない（予約行を生む引数を渡さない）', async () => {
  const rpc = stubRpc();
  await call({ rpc });
  const args = rpc.calls[0].args;
  assert.equal('p_idempotency_key' in args, false);
  assert.equal('p_reservation_id' in args, false);
});

// =========================================================
// 5. レスポンスの形 / fail closed
// =========================================================

test('used / remaining / limit は数値、week_start / next_reset_at は文字列', async () => {
  const { body } = await call();
  assert.equal(typeof body.unlimited, 'boolean');
  assert.equal(typeof body.limit, 'number');
  assert.equal(typeof body.used, 'number');
  assert.equal(typeof body.remaining, 'number');
  assert.equal(typeof body.week_start, 'string');
  assert.equal(typeof body.next_reset_at, 'string');
});

test('next_reset_at と week_start を再計算せずそのまま返す', async () => {
  const rpc = stubRpc([{
    ...ROW, week_start: '2027-03-01', next_reset_at: '2027-03-07T13:00:00+00:00',
  }]);
  const { body } = await call({ rpc });
  assert.equal(body.week_start, '2027-03-01');
  assert.equal(body.next_reset_at, '2027-03-07T13:00:00+00:00');
});

test('上限到達（used=3 / remaining=0）をそのまま返す', async () => {
  const rpc = stubRpc([{ ...ROW, used: 3, remaining: 0 }]);
  const { res, body } = await call({ rpc });
  assert.equal(res.status, 200);
  assert.equal(body.used, 3);
  assert.equal(body.remaining, 0);
  assert.equal(body.unlimited, false);
});

test('RPC の戻り値が契約と違えば 500 internal_error（0 で取り繕わない）', async () => {
  const broken = [
    null, [], 'x', [{}], [ROW, ROW],
    [{ ...ROW, used: '1' }],
    [{ ...ROW, remaining: -1 }],
    [{ ...ROW, used: -1 }],
    [{ ...ROW, quota_limit: null }],
    [{ ...ROW, used: 1.5 }],
    [{ ...ROW, week_start: null }],
    [{ ...ROW, next_reset_at: 12345 }],
  ];
  for (const rows of broken) {
    const { res, body } = await call({ rpc: stubRpc(rows) });
    assert.equal(res.status, 500, JSON.stringify(rows));
    assert.deepEqual(body, { error: 'internal_error' });
  }
});

test('セッション context が壊れていたら 500（RPC は呼ばない）', async () => {
  const rpc = stubRpc();
  const bad = async () => ({ status: SESSION_RESULT.VALID, context: { plan_id: 'free' } });
  const { res, body } = await call({ session: bad, rpc });
  assert.equal(res.status, 500);
  assert.deepEqual(body, { error: 'internal_error' });
  assert.equal(rpc.calls.length, 0);
});

test('Supabase エラーを状況別に分類する', async () => {
  const cases = [
    { e: new SupabaseError('unavailable', 'x'), status: 502, error: 'database_unavailable' },
    { e: new SupabaseError('request_failed', 'x'), status: 502, error: 'database_unavailable' },
    { e: new SupabaseError('not_configured', 'x'), status: 500, error: 'server_misconfigured' },
  ];
  for (const c of cases) {
    const { res, body } = await call({ rpc: stubRpc(c.e) });
    assert.equal(res.status, c.status, c.e.code);
    assert.deepEqual(body, { error: c.error });
  }
});

test('セッションのデータ異常 / 設定エラー / DB 障害を取り違えない', async () => {
  const cases = [
    { s: SESSION_RESULT.DATA_ERROR, status: 500, error: 'internal_error' },
    { s: SESSION_RESULT.MISCONFIGURED, status: 500, error: 'server_misconfigured' },
    { s: SESSION_RESULT.UNAVAILABLE, status: 502, error: 'database_unavailable' },
  ];
  for (const c of cases) {
    const rpc = stubRpc();
    const { res, body } = await call({ session: stubSession({ status: c.s, reason: 'x' }), rpc });
    assert.equal(res.status, c.status, c.s);
    assert.deepEqual(body, { error: c.error });
    assert.equal(rpc.calls.length, 0);
  }
});

test('エラー応答に user_id / secret / SQL を漏らさない', async () => {
  const err = new SupabaseError(
    'request_failed',
    'Supabase が status=500 を返しました: sb_secret_dummy select * from users id=' + USER_ID,
  );
  const { body } = await call({ rpc: stubRpc(err) });
  const serialized = JSON.stringify(body);
  for (const leak of [USER_ID, 'sb_secret', 'select', 'users']) {
    assert.equal(serialized.includes(leak), false, leak + ' が漏れている');
  }
});

// =========================================================
// 6. キャッシュ
// =========================================================

test('no-store と Vary: Cookie が付く（Free / Pro / 未認証とも）', async () => {
  const free = await call();
  assert.equal(free.res.headers.get('Cache-Control'), 'no-store');
  assert.equal(free.res.headers.get('Vary'), 'Cookie');

  const pro = await call({ session: stubSession({ plan_id: 'web_pro', status: 'active' }) });
  assert.equal(pro.res.headers.get('Cache-Control'), 'no-store');
  assert.equal(pro.res.headers.get('Vary'), 'Cookie');

  const unauth = await call({ session: stubSession({ status: SESSION_RESULT.UNAUTHENTICATED }) });
  assert.equal(unauth.res.headers.get('Cache-Control'), 'no-store');
});

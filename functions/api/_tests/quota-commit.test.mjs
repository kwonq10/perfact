// =========================================================
// POST /api/quota/commit の単体テスト
//
//   - Supabase RPC / session はすべてスタブに差し替える。ネットワークへは出ない。
//   - 本番の secret / Project URL はフィクスチャに一切保存しない。
// =========================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { handleCommit } from '../quota/commit.js';
import { SESSION_COOKIE_NAME, SESSION_RESULT } from '../_lib/session.js';
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

const ORIGIN = 'https://sukimacalendar.com';
const USER_ID = '11111111-2222-3333-4444-555555555555';
const RESERVATION_ID = 'c9f17da8-e426-46b9-ac84-b1b6159fc53c';

function req({
  method = 'POST',
  body = JSON.stringify({ reservation_id: RESERVATION_ID }),
  origin = ORIGIN,
  contentType = 'application/json',
  cookie = `${SESSION_COOKIE_NAME}=dummytoken`,
} = {}) {
  const headers = {};
  if (origin !== null) headers.origin = origin;
  if (contentType !== null) headers['content-type'] = contentType;
  if (cookie !== null) headers.cookie = cookie;
  const init = { method, headers };
  if (method !== 'GET' && method !== 'HEAD' && body !== null) init.body = body;
  return new Request('https://example.com/api/quota/commit', init);
}

function stubSession(context = { plan_id: 'free', status: 'active' }) {
  const calls = [];
  const fn = async (...a) => {
    calls.push(a);
    return { status: SESSION_RESULT.VALID, context: { user_id: USER_ID, ...context } };
  };
  fn.calls = calls;
  return fn;
}

function stubSessionResult(result) {
  const calls = [];
  const fn = async (...a) => { calls.push(a); return result; };
  fn.calls = calls;
  return fn;
}

function stubRpc(result = [{ ok: true, code: 'ok', state: 'committed', used: 3 }]) {
  const calls = [];
  const fn = async (name, args, options) => {
    calls.push({ name, args, options });
    if (result instanceof Error) throw result;
    return result;
  };
  fn.calls = calls;
  return fn;
}

function deps(over = {}) {
  return { rpc: stubRpc(), session: stubSession(), logger: quiet, ...over };
}

async function bodyOf(res) { return JSON.parse(await res.text()); }

// =========================================================
// 共通（method / Origin / body / session）
// =========================================================

test('GET は 405', async () => {
  const d = deps();
  const res = await handleCommit(req({ method: 'GET' }), ENV, d);
  assert.equal(res.status, 405);
  assert.deepEqual(await bodyOf(res), { error: 'method_not_allowed' });
  assert.equal(d.rpc.calls.length, 0);
});

test('Origin なし → 403（session も RPC も呼ばない）', async () => {
  const d = deps();
  const res = await handleCommit(req({ origin: null }), ENV, d);
  assert.equal(res.status, 403);
  assert.deepEqual(await bodyOf(res), { error: 'forbidden_origin' });
  assert.equal(d.session.calls.length, 0);
  assert.equal(d.rpc.calls.length, 0);
});

test('evil Origin → 403', async () => {
  for (const origin of ['https://evil.example', 'https://sukimacalendar.com.evil.example', 'null']) {
    const d = deps();
    const res = await handleCommit(req({ origin }), ENV, d);
    assert.equal(res.status, 403, origin);
    assert.equal(d.rpc.calls.length, 0, origin);
  }
});

test('正規 Origin のみ通る', async () => {
  const d = deps();
  assert.equal((await handleCommit(req(), ENV, d)).status, 200);
  assert.equal(d.rpc.calls.length, 1);
});

test('Content-Type が JSON でない → 400 invalid_content_type', async () => {
  const res = await handleCommit(req({ contentType: 'text/plain' }), ENV, deps());
  assert.equal(res.status, 400);
  assert.deepEqual(await bodyOf(res), { error: 'invalid_content_type' });
});

test('malformed JSON → 400 malformed_json（RPC を呼ばない）', async () => {
  const d = deps();
  const res = await handleCommit(req({ body: '{"reservation_id":' }), ENV, d);
  assert.equal(res.status, 400);
  assert.deepEqual(await bodyOf(res), { error: 'malformed_json' });
  assert.equal(d.rpc.calls.length, 0);
});

test('1KB 超 → 413 body_too_large', async () => {
  const body = JSON.stringify({ reservation_id: RESERVATION_ID, pad: 'a'.repeat(1100) });
  const res = await handleCommit(req({ body }), ENV, deps());
  assert.equal(res.status, 413);
  assert.deepEqual(await bodyOf(res), { error: 'body_too_large' });
});

test('reservation_id が UUID でない → 400 invalid_reservation_id（RPC を呼ばない）', async () => {
  for (const id of ['not-a-uuid', '', null, 123, undefined, 'c9f17da8e42646b9ac84b1b6159fc53c']) {
    const d = deps();
    const res = await handleCommit(req({ body: JSON.stringify({ reservation_id: id }) }), ENV, d);
    assert.equal(res.status, 400, String(id));
    assert.deepEqual(await bodyOf(res), { error: 'invalid_reservation_id' }, String(id));
    assert.equal(d.rpc.calls.length, 0, String(id));
  }
});

test('body の user_id は無視され、session の user_id が使われる', async () => {
  const d = deps();
  const body = JSON.stringify({ reservation_id: RESERVATION_ID, user_id: 'attacker', p_user_id: 'attacker' });
  await handleCommit(req({ body }), ENV, d);
  assert.deepEqual(d.rpc.calls[0].args, {
    p_user_id: USER_ID,
    p_reservation_id: RESERVATION_ID,
  });
});

test('未認証 → 401 unauthenticated + Cookie 削除', async () => {
  const d = deps({ session: stubSessionResult({ status: SESSION_RESULT.UNAUTHENTICATED, reason: 'no_cookie' }) });
  const res = await handleCommit(req({ cookie: null }), ENV, d);
  assert.equal(res.status, 401);
  assert.deepEqual(await bodyOf(res), { error: 'unauthenticated' });
  assert.ok(res.headers.get('set-cookie').includes('Max-Age=0'));
  assert.equal(d.rpc.calls.length, 0);
});

test('session data_error / misconfigured / unavailable を潰さない', async () => {
  const cases = [
    [SESSION_RESULT.DATA_ERROR, 500, 'internal_error'],
    [SESSION_RESULT.MISCONFIGURED, 500, 'server_misconfigured'],
    [SESSION_RESULT.UNAVAILABLE, 502, 'database_unavailable'],
  ];
  for (const [status, expected, error] of cases) {
    const d = deps({ session: stubSessionResult({ status, reason: 'r' }) });
    const res = await handleCommit(req(), ENV, d);
    assert.equal(res.status, expected, status);
    assert.deepEqual(await bodyOf(res), { error });
    assert.equal(d.rpc.calls.length, 0, status);
  }
});

// =========================================================
// entitlement
// =========================================================

test('Pro は RPC を呼ばず無制限を返す', async () => {
  for (const plan_id of ['web_pro', 'all_pro']) {
    for (const status of ['active', 'trialing']) {
      const d = deps({ session: stubSession({ plan_id, status }) });
      const res = await handleCommit(req(), ENV, d);
      assert.equal(res.status, 200, `${plan_id}/${status}`);
      assert.equal(d.rpc.calls.length, 0, `${plan_id}/${status}`);
      assert.deepEqual(await bodyOf(res), {
        quota_enforced: false, ok: true, code: 'unlimited', state: null, used: null,
      });
    }
  }
});

test('quota 対象は RPC を呼ぶ', async () => {
  const cases = [
    ['free', 'active'], ['web_pro', 'past_due'], ['all_pro', 'past_due'],
    ['extension_pro', 'active'], ['free', 'canceled'],
  ];
  for (const [plan_id, status] of cases) {
    const d = deps({ session: stubSession({ plan_id, status }) });
    const res = await handleCommit(req(), ENV, d);
    assert.equal(d.rpc.calls.length, 1, `${plan_id}/${status}`);
    assert.equal((await bodyOf(res)).quota_enforced, true, `${plan_id}/${status}`);
  }
});

// =========================================================
// RPC の結果を透過する
// =========================================================

test('ok → 200 でそのまま返す', async () => {
  const d = deps();
  const res = await handleCommit(req(), ENV, d);
  assert.equal(d.rpc.calls[0].name, 'commit_weekly_usage');
  assert.equal(res.status, 200);
  assert.deepEqual(await bodyOf(res), {
    quota_enforced: true, ok: true, code: 'ok', state: 'committed', used: 3,
  });
});

test('already_released → 200 + ok=false（4xx にしない）', async () => {
  const d = deps({ rpc: stubRpc([{ ok: false, code: 'already_released', state: 'released', used: 2 }]) });
  const res = await handleCommit(req(), ENV, d);
  assert.equal(res.status, 200);
  assert.deepEqual(await bodyOf(res), {
    quota_enforced: true, ok: false, code: 'already_released', state: 'released', used: 2,
  });
});

test('not_found → 200 + ok=false / state と used は null', async () => {
  const d = deps({ rpc: stubRpc([{ ok: false, code: 'not_found', state: null, used: null }]) });
  const res = await handleCommit(req(), ENV, d);
  assert.equal(res.status, 200);
  assert.deepEqual(await bodyOf(res), {
    quota_enforced: true, ok: false, code: 'not_found', state: null, used: null,
  });
});

test('期限切れ pending の commit は ok のまま透過する', async () => {
  const d = deps({ rpc: stubRpc([{ ok: true, code: 'ok', state: 'committed', used: 3 }]) });
  const body = await bodyOf(await handleCommit(req(), ENV, d));
  assert.equal(body.ok, true);
  assert.equal(body.state, 'committed');
});

test('未知の code もそのまま透過する', async () => {
  const d = deps({ rpc: stubRpc([{ ok: false, code: 'some_future_code', state: 'committed', used: 1 }]) });
  assert.equal((await bodyOf(await handleCommit(req(), ENV, d))).code, 'some_future_code');
});

// =========================================================
// RPC の失敗
// =========================================================

test('RPC not_configured → 500 / unavailable → 502 / 想定外 → 500', async () => {
  const cases = [
    [new SupabaseError('not_configured', 'x'), 500, 'server_misconfigured'],
    [new SupabaseError('unavailable', 'x'), 502, 'database_unavailable'],
    [new SupabaseError('request_failed', 'x'), 502, 'database_unavailable'],
    [new Error('boom'), 500, 'internal_error'],
  ];
  for (const [err, status, error] of cases) {
    const d = deps({ rpc: stubRpc(err) });
    const res = await handleCommit(req(), ENV, d);
    assert.equal(res.status, status, String(err));
    assert.deepEqual(await bodyOf(res), { error });
  }
});

test('RPC の戻り値が契約と違う → 500 internal_error', async () => {
  for (const rows of [null, [], [{}, {}], [{ ok: 'yes', code: 'ok' }], [{ ok: true }]]) {
    const d = deps({ rpc: stubRpc(rows) });
    const res = await handleCommit(req(), ENV, d);
    assert.equal(res.status, 500, JSON.stringify(rows));
    assert.deepEqual(await bodyOf(res), { error: 'internal_error' });
  }
});

// =========================================================
// 秘密値を漏らさない / キャッシュさせない
// =========================================================

test('レスポンスとログに user_id / Cookie / secret が出ない', async () => {
  const logger = recorder();
  const d = deps({ logger, rpc: stubRpc(new SupabaseError('unavailable', 'x')) });
  const res = await handleCommit(req(), ENV, d);
  const dump = (await res.text()) + '\n' + logger.lines.join('\n');
  for (const secret of [USER_ID, 'dummytoken', ENV.SUPABASE_SERVICE_ROLE_KEY, ENV.SUPABASE_URL]) {
    assert.equal(dump.includes(secret), false, secret);
  }
});

test('すべての応答に no-store と Vary: Cookie が付く', async () => {
  for (const r of [req({ method: 'GET' }), req({ origin: null }), req({ body: '{' }), req()]) {
    const res = await handleCommit(r, ENV, deps());
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('vary'), 'Cookie');
  }
});

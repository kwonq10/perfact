// =========================================================
// POST /api/quota/reserve の単体テスト
//
//   - Supabase RPC / session はすべてスタブに差し替える。ネットワークへは出ない。
//   - 本番の secret / Project URL はフィクスチャに一切保存しない。
// =========================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { handleReserve } from '../quota/reserve.js';
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

/** 本番の canonical host。_lib/origin.js の既定 allowlist と同じ値。 */
const ORIGIN = 'https://sukimacalendar.com';

/** テスト用のダミー user_id。実際の users.id ではない。 */
const USER_ID = '11111111-2222-3333-4444-555555555555';
const RESERVATION_ID = 'c9f17da8-e426-46b9-ac84-b1b6159fc53c';
const KEY = 'idem-key-0001';

function req({
  method = 'POST',
  body = JSON.stringify({ idempotency_key: KEY }),
  origin = ORIGIN,
  contentType = 'application/json',
  cookie = `${SESSION_COOKIE_NAME}=dummytoken`,
  extraHeaders = {},
} = {}) {
  const headers = { ...extraHeaders };
  if (origin !== null) headers.origin = origin;
  if (contentType !== null) headers['content-type'] = contentType;
  if (cookie !== null) headers.cookie = cookie;
  const init = { method, headers };
  if (method !== 'GET' && method !== 'HEAD' && body !== null) init.body = body;
  return new Request('https://example.com/api/quota/reserve', init);
}

/** session スタブ。既定は free / active（quota 対象）。 */
function stubSession(context = { plan_id: 'free', status: 'active' }) {
  const calls = [];
  const fn = async (request, env, deps) => {
    calls.push({ request, env, deps });
    if (context && context.status && context.plan_id) {
      return {
        status: SESSION_RESULT.VALID,
        context: { user_id: USER_ID, ...context },
      };
    }
    return context;
  };
  fn.calls = calls;
  return fn;
}

/** session が VALID 以外を返すスタブ。 */
function stubSessionResult(result) {
  const calls = [];
  const fn = async (...a) => { calls.push(a); return result; };
  fn.calls = calls;
  return fn;
}

/** RPC スタブ。呼び出しを記録する。 */
function stubRpc(result = [{
  allowed: true, code: 'ok', reused: false,
  reservation_id: RESERVATION_ID, week_start: '2026-08-31',
  used: 1, remaining: 2, expires_at: '2026-09-03T03:02:34.512Z',
}]) {
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
// メソッド
// =========================================================

test('GET は 405 method_not_allowed（Origin も body も session も見ない）', async () => {
  const d = deps();
  const res = await handleReserve(req({ method: 'GET' }), ENV, d);
  assert.equal(res.status, 405);
  assert.deepEqual(await bodyOf(res), { error: 'method_not_allowed' });
  assert.equal(d.rpc.calls.length, 0);
  assert.equal(d.session.calls.length, 0);
});

test('PUT / DELETE / PATCH も 405', async () => {
  for (const m of ['PUT', 'DELETE', 'PATCH']) {
    const res = await handleReserve(req({ method: m }), ENV, deps());
    assert.equal(res.status, 405, m);
  }
});

test('405 にも no-store と Vary: Cookie が付く', async () => {
  const res = await handleReserve(req({ method: 'GET' }), ENV, deps());
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('vary'), 'Cookie');
});

// =========================================================
// Origin（CSRF）
// =========================================================

test('Origin なし → 403（session も RPC も呼ばない）', async () => {
  const d = deps();
  const res = await handleReserve(req({ origin: null }), ENV, d);
  assert.equal(res.status, 403);
  assert.deepEqual(await bodyOf(res), { error: 'forbidden_origin' });
  assert.equal(d.session.calls.length, 0, 'session へ進まない');
  assert.equal(d.rpc.calls.length, 0, 'RPC へ進まない');
});

test('evil Origin → 403（session も RPC も呼ばない）', async () => {
  for (const origin of [
    'https://evil.example',
    'https://sukimacalendar.com.evil.example',
    'http://sukimacalendar.com',
    'https://www.sukimacalendar.com',
    'null',
    'not a url',
  ]) {
    const d = deps();
    const res = await handleReserve(req({ origin }), ENV, d);
    assert.equal(res.status, 403, origin);
    assert.equal(d.session.calls.length, 0, origin);
    assert.equal(d.rpc.calls.length, 0, origin);
  }
});

test('正規 Origin のみ通る', async () => {
  const d = deps();
  const res = await handleReserve(req(), ENV, d);
  assert.equal(res.status, 200);
  assert.equal(d.rpc.calls.length, 1);
});

test('Origin 失敗時は Set-Cookie を出さない', async () => {
  const res = await handleReserve(req({ origin: null }), ENV, deps());
  assert.equal(res.headers.get('set-cookie'), null);
});

// =========================================================
// body
// =========================================================

test('Content-Type が JSON でない → 400 invalid_content_type（RPC を呼ばない）', async () => {
  const d = deps();
  const res = await handleReserve(req({ contentType: 'text/plain' }), ENV, d);
  assert.equal(res.status, 400);
  assert.deepEqual(await bodyOf(res), { error: 'invalid_content_type' });
  assert.equal(d.rpc.calls.length, 0);
  assert.equal(d.session.calls.length, 0, 'body 不正なら session へ進まない');
});

test('malformed JSON → 400 malformed_json', async () => {
  const d = deps();
  const res = await handleReserve(req({ body: '{"idempotency_key":' }), ENV, d);
  assert.equal(res.status, 400);
  assert.deepEqual(await bodyOf(res), { error: 'malformed_json' });
  assert.equal(d.rpc.calls.length, 0);
});

test('配列 body → 400 invalid_body', async () => {
  const res = await handleReserve(req({ body: '[]' }), ENV, deps());
  assert.equal(res.status, 400);
  assert.deepEqual(await bodyOf(res), { error: 'invalid_body' });
});

test('1KB 超の body → 413 body_too_large（RPC を呼ばない）', async () => {
  const d = deps();
  const body = JSON.stringify({ idempotency_key: 'a'.repeat(1100) });
  const res = await handleReserve(req({ body }), ENV, d);
  assert.equal(res.status, 413);
  assert.deepEqual(await bodyOf(res), { error: 'body_too_large' });
  assert.equal(d.rpc.calls.length, 0);
});

test('idempotency_key が不正 → 400 invalid_idempotency_key（RPC を呼ばない）', async () => {
  for (const key of ['short', 'has space', '', null, 123, undefined]) {
    const d = deps();
    const res = await handleReserve(
      req({ body: JSON.stringify({ idempotency_key: key }) }), ENV, d,
    );
    assert.equal(res.status, 400, String(key));
    assert.deepEqual(await bodyOf(res), { error: 'invalid_idempotency_key' }, String(key));
    assert.equal(d.rpc.calls.length, 0, String(key));
  }
});

test('idempotency_key が無い body → 400', async () => {
  const res = await handleReserve(req({ body: '{}' }), ENV, deps());
  assert.equal(res.status, 400);
  assert.deepEqual(await bodyOf(res), { error: 'invalid_idempotency_key' });
});

test('余分なキーは無視され、idempotency_key だけが RPC へ渡る', async () => {
  const d = deps();
  const body = JSON.stringify({
    idempotency_key: KEY,
    user_id: 'attacker-supplied',
    p_user_id: 'attacker-supplied',
    p_limit: 999,
  });
  const res = await handleReserve(req({ body }), ENV, d);
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(d.rpc.calls[0].args).sort(),
    ['p_idempotency_key', 'p_limit', 'p_user_id']);
  assert.equal(d.rpc.calls[0].args.p_user_id, USER_ID, 'body の user_id を使わない');
  assert.equal(d.rpc.calls[0].args.p_limit, 3, 'body の p_limit を使わない');
});

// =========================================================
// session
// =========================================================

test('未認証 → 401 unauthenticated + Cookie 削除（RPC を呼ばない）', async () => {
  const d = deps({ session: stubSessionResult({ status: SESSION_RESULT.UNAUTHENTICATED, reason: 'no_cookie' }) });
  const res = await handleReserve(req({ cookie: null }), ENV, d);
  assert.equal(res.status, 401);
  assert.deepEqual(await bodyOf(res), { error: 'unauthenticated' });
  assert.ok(res.headers.get('set-cookie').includes('Max-Age=0'), 'Cookie を削除する');
  assert.equal(d.rpc.calls.length, 0);
});

test('session data_error → 500 internal_error（401 に丸めない・Cookie を触らない）', async () => {
  const d = deps({ session: stubSessionResult({ status: SESSION_RESULT.DATA_ERROR, reason: 'missing_subscription' }) });
  const res = await handleReserve(req(), ENV, d);
  assert.equal(res.status, 500);
  assert.deepEqual(await bodyOf(res), { error: 'internal_error' });
  assert.equal(res.headers.get('set-cookie'), null);
  assert.equal(d.rpc.calls.length, 0);
});

test('session misconfigured → 500 server_misconfigured', async () => {
  const d = deps({ session: stubSessionResult({ status: SESSION_RESULT.MISCONFIGURED, reason: 'not_configured' }) });
  const res = await handleReserve(req(), ENV, d);
  assert.equal(res.status, 500);
  assert.deepEqual(await bodyOf(res), { error: 'server_misconfigured' });
});

test('session unavailable → 502 database_unavailable（Cookie を触らない）', async () => {
  const d = deps({ session: stubSessionResult({ status: SESSION_RESULT.UNAVAILABLE, reason: 'unavailable' }) });
  const res = await handleReserve(req(), ENV, d);
  assert.equal(res.status, 502);
  assert.deepEqual(await bodyOf(res), { error: 'database_unavailable' });
  assert.equal(res.headers.get('set-cookie'), null);
});

test('session の戻り値が想定外 → 500 internal_error', async () => {
  for (const r of [undefined, null, {}, { status: 'weird' }]) {
    const d = deps({ session: stubSessionResult(r) });
    const res = await handleReserve(req(), ENV, d);
    assert.equal(res.status, 500, JSON.stringify(r));
    assert.equal(d.rpc.calls.length, 0);
  }
});

test('VALID なのに context が壊れている → 500 internal_error', async () => {
  for (const context of [null, {}, { plan_id: 'free' }, { user_id: '', plan_id: 'free', status: 'active' }]) {
    const d = deps({ session: stubSessionResult({ status: SESSION_RESULT.VALID, context }) });
    const res = await handleReserve(req(), ENV, d);
    assert.equal(res.status, 500, JSON.stringify(context));
    assert.equal(d.rpc.calls.length, 0);
  }
});

// =========================================================
// entitlement
// =========================================================

test('Pro（web_pro / all_pro × active / trialing）は RPC を呼ばず無制限を返す', async () => {
  for (const plan_id of ['web_pro', 'all_pro']) {
    for (const status of ['active', 'trialing']) {
      const d = deps({ session: stubSession({ plan_id, status }) });
      const res = await handleReserve(req(), ENV, d);
      const body = await bodyOf(res);

      assert.equal(res.status, 200, `${plan_id}/${status}`);
      assert.equal(d.rpc.calls.length, 0, `${plan_id}/${status} で RPC を呼ばない`);
      assert.equal(body.quota_enforced, false);
      assert.equal(body.allowed, true);
      assert.equal(body.code, 'unlimited');
      assert.equal(body.reservation_id, null, 'commit / release を呼ばせない');
      assert.equal(body.used, null);
      assert.equal(body.remaining, null);
      assert.equal(body.expires_at, null);
    }
  }
});

test('quota 対象（free / extension_pro / past_due 等）は RPC を呼ぶ', async () => {
  const cases = [
    ['free', 'active'],
    ['web_pro', 'past_due'],
    ['all_pro', 'past_due'],
    ['extension_pro', 'active'],
    ['extension_pro', 'trialing'],
    ['free', 'canceled'],
    ['web_pro', 'unpaid'],
    ['all_pro', 'incomplete'],
  ];
  for (const [plan_id, status] of cases) {
    const d = deps({ session: stubSession({ plan_id, status }) });
    const res = await handleReserve(req(), ENV, d);
    assert.equal(res.status, 200, `${plan_id}/${status}`);
    assert.equal(d.rpc.calls.length, 1, `${plan_id}/${status} で RPC を呼ぶ`);
    assert.equal((await bodyOf(res)).quota_enforced, true, `${plan_id}/${status}`);
  }
});

// =========================================================
// RPC の結果を透過する
// =========================================================

test('allowed=true → 200 で予約内容をそのまま返す', async () => {
  const d = deps();
  const res = await handleReserve(req(), ENV, d);
  assert.equal(res.status, 200);
  assert.deepEqual(await bodyOf(res), {
    quota_enforced: true,
    allowed: true,
    code: 'ok',
    reused: false,
    reservation_id: RESERVATION_ID,
    week_start: '2026-08-31',
    used: 1,
    remaining: 2,
    expires_at: '2026-09-03T03:02:34.512Z',
  });
});

test('RPC には session の user_id と Free 上限 3 を渡す', async () => {
  const d = deps();
  await handleReserve(req(), ENV, d);
  assert.equal(d.rpc.calls[0].name, 'reserve_weekly_usage');
  assert.deepEqual(d.rpc.calls[0].args, {
    p_user_id: USER_ID,
    p_idempotency_key: KEY,
    p_limit: 3,
  });
  assert.equal(d.rpc.calls[0].options.env, ENV);
});

test('limit_reached は 200 + allowed=false（4xx にしない）', async () => {
  const d = deps({
    rpc: stubRpc([{
      allowed: false, code: 'limit_reached', reused: false,
      reservation_id: null, week_start: '2026-08-31',
      used: 3, remaining: 0, expires_at: null,
    }]),
  });
  const res = await handleReserve(req(), ENV, d);
  assert.equal(res.status, 200, 'quota 超過は 4xx にしない');
  assert.deepEqual(await bodyOf(res), {
    quota_enforced: true,
    allowed: false,
    code: 'limit_reached',
    reused: false,
    reservation_id: null,
    week_start: '2026-08-31',
    used: 3,
    remaining: 0,
    expires_at: null,
  });
});

test('reused=true（同じ鍵の再送）をそのまま返す', async () => {
  const d = deps({
    rpc: stubRpc([{
      allowed: true, code: 'ok', reused: true,
      reservation_id: RESERVATION_ID, week_start: '2026-08-31',
      used: 1, remaining: 2, expires_at: '2026-09-03T03:02:34.512Z',
    }]),
  });
  const body = await bodyOf(await handleReserve(req(), ENV, d));
  assert.equal(body.reused, true);
  assert.equal(body.allowed, true);
  assert.equal(body.reservation_id, RESERVATION_ID);
});

test('already_settled も 200 + allowed=false でそのまま返す', async () => {
  const d = deps({
    rpc: stubRpc([{
      allowed: false, code: 'already_settled', reused: true,
      reservation_id: null, week_start: '2026-08-31',
      used: 3, remaining: 0, expires_at: null,
    }]),
  });
  const res = await handleReserve(req(), ENV, d);
  assert.equal(res.status, 200);
  const body = await bodyOf(res);
  assert.equal(body.code, 'already_settled');
  assert.equal(body.allowed, false);
  assert.equal(body.reservation_id, null);
});

test('RPC の code を読み替えない（未知の code もそのまま透過する）', async () => {
  const d = deps({
    rpc: stubRpc([{
      allowed: false, code: 'some_future_code', reused: false,
      reservation_id: null, week_start: '2026-08-31', used: 3, remaining: 0, expires_at: null,
    }]),
  });
  assert.equal((await bodyOf(await handleReserve(req(), ENV, d))).code, 'some_future_code');
});

// =========================================================
// RPC の失敗
// =========================================================

test('RPC not_configured → 500 server_misconfigured', async () => {
  const d = deps({ rpc: stubRpc(new SupabaseError('not_configured', '環境変数が未設定です。')) });
  const res = await handleReserve(req(), ENV, d);
  assert.equal(res.status, 500);
  assert.deepEqual(await bodyOf(res), { error: 'server_misconfigured' });
});

test('RPC unavailable / request_failed → 502 database_unavailable', async () => {
  for (const code of ['unavailable', 'request_failed']) {
    const d = deps({ rpc: stubRpc(new SupabaseError(code, 'x')) });
    const res = await handleReserve(req(), ENV, d);
    assert.equal(res.status, 502, code);
    assert.deepEqual(await bodyOf(res), { error: 'database_unavailable' });
  }
});

test('RPC の想定外例外 → 500 internal_error', async () => {
  const d = deps({ rpc: stubRpc(new Error('boom')) });
  const res = await handleReserve(req(), ENV, d);
  assert.equal(res.status, 500);
  assert.deepEqual(await bodyOf(res), { error: 'internal_error' });
});

test('RPC の戻り値が契約と違う → 500 internal_error（quota 超過に丸めない）', async () => {
  for (const rows of [null, [], [{}, {}], 'x', [{ allowed: 'yes', code: 'ok' }], [{ allowed: true }]]) {
    const d = deps({ rpc: stubRpc(rows) });
    const res = await handleReserve(req(), ENV, d);
    assert.equal(res.status, 500, JSON.stringify(rows));
    assert.deepEqual(await bodyOf(res), { error: 'internal_error' });
  }
});

// =========================================================
// 秘密値を漏らさない / キャッシュさせない
// =========================================================

test('レスポンスに user_id / Cookie / secret が出ない', async () => {
  const d = deps();
  const res = await handleReserve(req(), ENV, d);
  const text = await res.text();
  for (const secret of [USER_ID, 'dummytoken', ENV.SUPABASE_SERVICE_ROLE_KEY, ENV.SUPABASE_URL]) {
    assert.equal(text.includes(secret), false, secret);
  }
});

test('ログに user_id / Cookie / secret が出ない', async () => {
  const cases = [
    { req: req({ origin: 'https://evil.example' }), d: {} },
    { req: req({ body: '{' }), d: {} },
    { req: req(), d: { rpc: stubRpc(new SupabaseError('unavailable', 'x')) } },
    { req: req(), d: { session: stubSessionResult({ status: SESSION_RESULT.DATA_ERROR, reason: 'r' }) } },
  ];
  for (const c of cases) {
    const logger = recorder();
    await handleReserve(c.req, ENV, deps({ ...c.d, logger }));
    const dump = logger.lines.join('\n');
    for (const secret of [USER_ID, 'dummytoken', ENV.SUPABASE_SERVICE_ROLE_KEY, 'evil.example']) {
      assert.equal(dump.includes(secret), false, secret + ' / ' + dump);
    }
  }
});

test('すべての応答に Cache-Control: no-store と Vary: Cookie が付く', async () => {
  const cases = [
    req({ method: 'GET' }),
    req({ origin: null }),
    req({ body: '{' }),
    req(),
  ];
  for (const r of cases) {
    const res = await handleReserve(r, ENV, deps());
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('vary'), 'Cookie');
  }
});

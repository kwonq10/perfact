// =========================================================
// POST /api/user/timezone の単体テスト
//
//   - Supabase RPC / session はすべてスタブに差し替える。ネットワークへは出ない。
//   - 本番の secret / Project URL はフィクスチャに一切保存しない。
// =========================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { handleSetTimezone, isBadRequest, validate } from '../user/timezone.js';
import { SESSION_COOKIE_NAME, SESSION_RESULT } from '../_lib/session.js';
import { SupabaseError } from '../_lib/supabase.js';

const ENV = {
  SUPABASE_URL: 'https://example-project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_dummy_for_tests_only',
};

const quiet = { error() {}, warn() {}, log() {} };

/** 本番の canonical host。_lib/origin.js の既定 allowlist と同じ値。 */
const ORIGIN = 'https://sukimacalendar.com';

/** テスト用のダミー user_id。実際の users.id ではない。 */
const USER_ID = '11111111-2222-3333-4444-555555555555';

function req({
  method = 'POST',
  body = JSON.stringify({ timezone: 'Asia/Tokyo' }),
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
  return new Request('https://example.com/api/user/timezone', init);
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

/** RPC スタブ。既定は set_user_timezone の契約どおりの 1 行を返す。 */
function stubRpc(rows = [{
  display_timezone: 'Asia/Tokyo',
  quota_timezone: 'Asia/Tokyo',
  quota_timezone_pending: null,
  quota_week_start: '2026-08-31',
}]) {
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
  const res = await handleSetTimezone(request, ENV, deps);
  const body = await res.json().catch(() => null);
  return { res, body, deps };
}

// =========================================================
// 1. 認証 / Origin / method
// =========================================================

test('未認証は 401 unauthenticated', async () => {
  const { res, body } = await call({
    session: stubSession({ status: SESSION_RESULT.UNAUTHENTICATED }),
  });
  assert.equal(res.status, 401);
  assert.deepEqual(body, { error: 'unauthenticated' });
});

test('未認証のとき RPC を呼ばない', async () => {
  const rpc = stubRpc();
  await call({ session: stubSession({ status: SESSION_RESULT.UNAUTHENTICATED }), rpc });
  assert.equal(rpc.calls.length, 0);
});

test('Origin が無い / 許可外なら 403 で RPC を呼ばない', async () => {
  for (const origin of [null, 'https://evil.example', 'https://sukimacalendar.com.evil.example']) {
    const rpc = stubRpc();
    const { res, body } = await call({ rpc }, req({ origin }));
    assert.equal(res.status, 403, String(origin));
    assert.deepEqual(body, { error: 'forbidden_origin' });
    assert.equal(rpc.calls.length, 0, 'RPC を呼んではいけない');
  }
});

test('GET は 405', async () => {
  const { res, body } = await call({}, req({ method: 'GET', body: null }));
  assert.equal(res.status, 405);
  assert.deepEqual(body, { error: 'method_not_allowed' });
});

// =========================================================
// 2. body 検証
// =========================================================

test('body が無い / JSON でないと 400', async () => {
  const cases = [
    { r: req({ body: null }), code: 'malformed_json' },
    { r: req({ body: 'not json' }), code: 'malformed_json' },
    { r: req({ contentType: 'text/plain' }), code: 'invalid_content_type' },
  ];
  for (const c of cases) {
    const { res, body } = await call({}, c.r);
    assert.equal(res.status, 400, c.code);
    assert.equal(body.error, c.code);
  }
});

test('timezone が非文字列なら 400 invalid_timezone', async () => {
  for (const tz of [undefined, null, 123, true, {}, []]) {
    const rpc = stubRpc();
    const { res, body } = await call({ rpc }, req({ body: JSON.stringify({ timezone: tz }) }));
    assert.equal(res.status, 400, String(tz));
    assert.deepEqual(body, { error: 'invalid_timezone' });
    assert.equal(rpc.calls.length, 0, 'DB を叩いてはいけない');
  }
});

test('空文字 / 空白だけなら 400 invalid_timezone', async () => {
  for (const tz of ['', ' ', '   ', '\t']) {
    const rpc = stubRpc();
    const { res, body } = await call({ rpc }, req({ body: JSON.stringify({ timezone: tz }) }));
    assert.equal(res.status, 400, JSON.stringify(tz));
    assert.deepEqual(body, { error: 'invalid_timezone' });
    assert.equal(rpc.calls.length, 0);
  }
});

test('長すぎる timezone は DB を叩かずに 400', async () => {
  const rpc = stubRpc();
  const tz = 'A'.repeat(65);
  const { res, body } = await call({ rpc }, req({ body: JSON.stringify({ timezone: tz }) }));
  assert.equal(res.status, 400);
  assert.deepEqual(body, { error: 'invalid_timezone' });
  assert.equal(rpc.calls.length, 0);
});

test('validate は形だけを見て意味を判定しない', () => {
  // 実在しない timezone でも「形」としては通す（判定は DB の責務）
  assert.deepEqual(validate({ timezone: 'Mars/Olympus' }),
    { ok: true, value: { timezone: 'Mars/Olympus' } });
  // 前後空白も落とさずそのまま渡す（正規化しない）
  assert.deepEqual(validate({ timezone: ' Asia/Tokyo ' }),
    { ok: true, value: { timezone: ' Asia/Tokyo ' } });
});

// =========================================================
// 3. 正常系
// =========================================================

test('Asia/Tokyo で session の user_id と timezone を RPC へ渡す', async () => {
  const rpc = stubRpc();
  const { res, body } = await call({ rpc });
  assert.equal(res.status, 200);
  assert.deepEqual(body, { ok: true, display_timezone: 'Asia/Tokyo' });

  assert.equal(rpc.calls.length, 1);
  assert.equal(rpc.calls[0].name, 'set_user_timezone');
  assert.deepEqual(rpc.calls[0].args, {
    p_user_id: USER_ID,
    p_timezone: 'Asia/Tokyo',
  });
});

test('America/New_York も同じ経路で渡る', async () => {
  const rpc = stubRpc([{
    display_timezone: 'America/New_York',
    quota_timezone: 'Asia/Tokyo',
    quota_timezone_pending: 'America/New_York',
    quota_week_start: '2026-08-31',
  }]);
  const { res, body } = await call(
    { rpc },
    req({ body: JSON.stringify({ timezone: 'America/New_York' }) }),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(body, { ok: true, display_timezone: 'America/New_York' });
  assert.equal(rpc.calls[0].args.p_timezone, 'America/New_York');
});

test('body の user_id は無視され、session の user_id が使われる', async () => {
  const rpc = stubRpc();
  const attacker = '99999999-9999-9999-9999-999999999999';
  await call({ rpc }, req({
    body: JSON.stringify({ timezone: 'Asia/Tokyo', user_id: attacker, p_user_id: attacker }),
  }));
  assert.equal(rpc.calls[0].args.p_user_id, USER_ID);
  assert.notEqual(rpc.calls[0].args.p_user_id, attacker);
  assert.deepEqual(Object.keys(rpc.calls[0].args).sort(), ['p_timezone', 'p_user_id']);
});

test('内部の quota 状態（anchor / pending / week）を応答に出さない', async () => {
  const { body } = await call();
  assert.deepEqual(Object.keys(body).sort(), ['display_timezone', 'ok']);
  const serialized = JSON.stringify(body);
  for (const leak of ['quota_timezone', 'quota_week_start', 'pending', USER_ID]) {
    assert.equal(serialized.includes(leak), false, leak + ' が漏れている');
  }
});

test('同じ timezone を繰り返し送っても毎回 200（API は状態を持たない）', async () => {
  const rpc = stubRpc();
  const deps = { session: stubSession(), rpc, logger: quiet };
  for (let i = 0; i < 3; i += 1) {
    const res = await handleSetTimezone(req(), ENV, deps);
    assert.equal(res.status, 200, 'call ' + i);
  }
  assert.equal(rpc.calls.length, 3, '毎回 RPC へ委譲する');
  for (const c of rpc.calls) assert.equal(c.args.p_timezone, 'Asia/Tokyo');
});

test('no-store と Vary: Cookie が付く', async () => {
  const { res } = await call();
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.equal(res.headers.get('Vary'), 'Cookie');
});

// =========================================================
// 4. エラー処理
// =========================================================

test('DB が timezone を拒否（HTTP 400）したら 400 invalid_timezone', async () => {
  const err = new SupabaseError(
    'request_failed',
    'Supabase が status=400 を返しました: {"code":"P0001","message":"p_timezone が IANA timezone として認識できません。"}',
  );
  const { res, body } = await call({ rpc: stubRpc(err) });
  assert.equal(res.status, 400);
  assert.deepEqual(body, { error: 'invalid_timezone' });
});

test('invalid_timezone の応答に SQL / 内部詳細を漏らさない', async () => {
  const err = new SupabaseError(
    'request_failed',
    'Supabase が status=400 を返しました: {"code":"P0001","message":"secret detail","hint":"select * from users"}',
  );
  const { body } = await call({ rpc: stubRpc(err) });
  const serialized = JSON.stringify(body);
  for (const leak of ['P0001', 'secret detail', 'select', 'users', 'sb_secret']) {
    assert.equal(serialized.includes(leak), false, leak + ' が漏れている');
  }
});

test('RPC が存在しない（404）は invalid_timezone にせず 502 にする', async () => {
  // migration 未適用の環境を「不正な timezone」と誤報告しないこと。
  const err = new SupabaseError(
    'request_failed',
    'Supabase が status=404 を返しました: {"code":"PGRST202","message":"Could not find the function"}',
  );
  const { res, body } = await call({ rpc: stubRpc(err) });
  assert.equal(res.status, 502);
  assert.deepEqual(body, { error: 'database_unavailable' });
});

test('isBadRequest は status=400 のときだけ true', () => {
  const mk = (code, msg) => new SupabaseError(code, msg);
  assert.equal(isBadRequest(mk('request_failed', 'Supabase が status=400 を返しました: {}')), true);
  assert.equal(isBadRequest(mk('request_failed', 'Supabase が status=404 を返しました: {}')), false);
  assert.equal(isBadRequest(mk('request_failed', 'Supabase が status=4000 を返しました: {}')), false);
  assert.equal(isBadRequest(mk('unavailable', 'Supabase が status=400 を返しました: {}')), false);
  assert.equal(isBadRequest(mk('not_configured', 'env が未設定です')), false);
  assert.equal(isBadRequest(new Error('status=400')), false);
  assert.equal(isBadRequest(null), false);
});

test('Supabase 到達不能は 502 database_unavailable', async () => {
  const err = new SupabaseError('unavailable', 'Supabase へ到達できません');
  const { res, body } = await call({ rpc: stubRpc(err) });
  assert.equal(res.status, 502);
  assert.deepEqual(body, { error: 'database_unavailable' });
});

test('env 未設定は 500 server_misconfigured', async () => {
  const err = new SupabaseError('not_configured', 'SUPABASE_URL が未設定です');
  const { res, body } = await call({ rpc: stubRpc(err) });
  assert.equal(res.status, 500);
  assert.deepEqual(body, { error: 'server_misconfigured' });
});

test('RPC の戻り値が契約と違えば 500 internal_error', async () => {
  for (const rows of [null, [], [{}], [{ display_timezone: 123 }], [{ a: 1 }, { b: 2 }], 'x']) {
    const { res, body } = await call({ rpc: stubRpc(rows) });
    assert.equal(res.status, 500, JSON.stringify(rows));
    assert.deepEqual(body, { error: 'internal_error' });
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

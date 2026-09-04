// =========================================================
// /api/ext/quota/{reserve,commit,release} と /api/ext/auth/logout の単体テスト
//
//   - Supabase RPC / session はスタブ。ネットワークへは出ない。
//   - Origin 検証は本物の checkExtensionOrigin を通す（ダミー ID を allowlist に置く）。
//   - 本番の secret / 拡張機能 ID はフィクスチャに保存しない。
// =========================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { handleExtReserve, onRequestOptions } from '../ext/quota/reserve.js';
import { handleExtCommit } from '../ext/quota/commit.js';
import { handleExtRelease } from '../ext/quota/release.js';
import { handleExtLogout } from '../ext/auth/logout.js';
import { hasExtensionUnlimited } from '../_lib/ext-quota.js';
import { hasWebUnlimited } from '../_lib/quota.js';
import { SESSION_COOKIE_NAME, SESSION_RESULT } from '../_lib/session.js';
import { SupabaseError } from '../_lib/supabase.js';

const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';
const OTHER_EXT_ID = 'ponmlkjihgfedcbaponmlkjihgfedcba';
const EXT_ORIGIN = 'chrome-extension://' + EXT_ID;

const ENV = {
  SUPABASE_URL: 'https://example-project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_dummy_for_tests_only',
  EXTENSION_IDS: EXT_ID,
};

const quiet = { error() {}, warn() {}, log() {} };

const USER_ID = '11111111-2222-3333-4444-555555555555';
const RESERVATION_ID = 'c9f17da8-e426-46b9-ac84-b1b6159fc53c';
const KEY = 'idem-key-0001';
const TOKEN = 'dummy_session_token_value';

function req({
  method = 'POST',
  body = JSON.stringify({ idempotency_key: KEY }),
  origin = EXT_ORIGIN,
  contentType = 'application/json',
  authorization = 'Bearer ' + TOKEN,
  cookie = null,
  path = '/api/ext/quota/reserve',
} = {}) {
  const headers = {};
  if (origin !== null) headers.origin = origin;
  if (contentType !== null) headers['content-type'] = contentType;
  if (authorization !== null) headers.authorization = authorization;
  if (cookie !== null) headers.cookie = cookie;
  const init = { method, headers };
  if (method !== 'GET' && method !== 'HEAD' && body !== null) init.body = body;
  return new Request('https://sukimacalendar.com' + path, init);
}

function stubSession(context = { plan_id: 'free', status: 'active' }) {
  const calls = [];
  const fn = async (...a) => {
    calls.push(a);
    if (context && context.status && context.plan_id) {
      return { status: SESSION_RESULT.VALID, context: { user_id: USER_ID, ...context } };
    }
    return context;
  };
  fn.calls = calls;
  return fn;
}

function stubRpc(result) {
  const calls = [];
  const fn = async (name, args, options) => {
    calls.push({ name, args, options });
    if (result instanceof Error) throw result;
    return result;
  };
  fn.calls = calls;
  return fn;
}

const RESERVE_OK = [{
  allowed: true, code: 'ok', reused: false,
  reservation_id: RESERVATION_ID, week_start: '2026-08-31',
  used: 1, remaining: 2, expires_at: '2026-09-03T03:02:34.512Z',
}];
const SETTLE_OK = [{ ok: true, code: 'ok', state: 'committed', used: 1 }];

function deps(over = {}) {
  return { logger: quiet, session: stubSession(), rpc: stubRpc(RESERVE_OK), ...over };
}

// =========================================================
// entitlement
// =========================================================

test('hasExtensionUnlimited: extension_pro / all_pro かつ active / trialing のみ true', () => {
  assert.equal(hasExtensionUnlimited({ plan_id: 'extension_pro', status: 'active' }), true);
  assert.equal(hasExtensionUnlimited({ plan_id: 'extension_pro', status: 'trialing' }), true);
  assert.equal(hasExtensionUnlimited({ plan_id: 'all_pro', status: 'active' }), true);
  assert.equal(hasExtensionUnlimited({ plan_id: 'all_pro', status: 'trialing' }), true);

  assert.equal(hasExtensionUnlimited({ plan_id: 'web_pro', status: 'active' }), false,
    'web_pro は拡張では quota 対象');
  assert.equal(hasExtensionUnlimited({ plan_id: 'free', status: 'active' }), false);
  assert.equal(hasExtensionUnlimited({ plan_id: 'all_pro', status: 'past_due' }), false,
    'past_due は Pro 扱いしない');
  assert.equal(hasExtensionUnlimited({ plan_id: 'extension_pro', status: 'canceled' }), false);
  assert.equal(hasExtensionUnlimited(null), false);
  assert.equal(hasExtensionUnlimited({}), false);
});

test('hasWebUnlimited は変更されていない（Web の判定は据え置き）', () => {
  assert.equal(hasWebUnlimited({ plan_id: 'web_pro', status: 'active' }), true);
  assert.equal(hasWebUnlimited({ plan_id: 'all_pro', status: 'active' }), true);
  assert.equal(hasWebUnlimited({ plan_id: 'extension_pro', status: 'active' }), false);
  assert.equal(hasWebUnlimited({ plan_id: 'free', status: 'active' }), false);
});

test('reserve: plan × status の全組み合わせで RPC 呼び出しの有無が仕様どおり', async () => {
  const plans = ['free', 'web_pro', 'extension_pro', 'all_pro'];
  const statuses = ['active', 'trialing', 'past_due', 'canceled'];

  for (const plan_id of plans) {
    for (const status of statuses) {
      const rpc = stubRpc(RESERVE_OK);
      const res = await handleExtReserve(
        req(), ENV, deps({ session: stubSession({ plan_id, status }), rpc }),
      );
      const body = await res.json();
      const expectUnlimited =
        (plan_id === 'extension_pro' || plan_id === 'all_pro')
        && (status === 'active' || status === 'trialing');

      assert.equal(res.status, 200, `${plan_id}/${status}`);
      assert.equal(body.quota_enforced, !expectUnlimited, `${plan_id}/${status}`);
      assert.equal(rpc.calls.length, expectUnlimited ? 0 : 1, `${plan_id}/${status}`);
      if (expectUnlimited) {
        assert.equal(body.code, 'unlimited');
        assert.equal(body.reservation_id, null, 'commit/release を呼ばせない');
      }
    }
  }
});

// =========================================================
// reserve
// =========================================================

test('reserve: Web と同じ RPC を user_id と limit=3 で呼ぶ', async () => {
  const rpc = stubRpc(RESERVE_OK);
  const res = await handleExtReserve(req(), ENV, deps({ rpc }));
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(rpc.calls[0].name, 'reserve_weekly_usage', 'Web と同一の RPC');
  assert.deepEqual(rpc.calls[0].args, {
    p_user_id: USER_ID,
    p_idempotency_key: KEY,
    p_limit: 3,
  });
  assert.equal(body.quota_enforced, true);
  assert.equal(body.allowed, true);
  assert.equal(body.reservation_id, RESERVATION_ID);
});

test('reserve: 上限到達は 200 + allowed:false（4xx にしない）', async () => {
  const rpc = stubRpc([{
    allowed: false, code: 'limit_reached', reused: false,
    reservation_id: null, week_start: '2026-08-31', used: 3, remaining: 0, expires_at: null,
  }]);
  const res = await handleExtReserve(req(), ENV, deps({ rpc }));
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.allowed, false);
  assert.equal(body.code, 'limit_reached');
  assert.equal(body.reservation_id, null);
});

test('reserve: 応答に CORS ヘッダと no-store が付く', async () => {
  const res = await handleExtReserve(req(), ENV, deps());
  assert.equal(res.headers.get('access-control-allow-origin'), EXT_ORIGIN);
  assert.notEqual(res.headers.get('access-control-allow-origin'), '*');
  assert.equal(res.headers.get('access-control-allow-credentials'), null);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('vary'), 'Origin');
});

test('reserve: 許可外 origin は 403 で CORS を付けない', async () => {
  for (const origin of ['chrome-extension://' + OTHER_EXT_ID, 'https://evil.example', null]) {
    const rpc = stubRpc(RESERVE_OK);
    const session = stubSession();
    const res = await handleExtReserve(req({ origin }), ENV, deps({ rpc, session }));

    assert.equal(res.status, 403, String(origin));
    assert.deepEqual(await res.json(), { error: 'forbidden_origin' });
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    assert.equal(rpc.calls.length, 0);
    assert.equal(session.calls.length, 0, 'Origin 不正で session を触らない');
  }
});

test('reserve: Web の origin では通らない（allowlist が独立している）', async () => {
  const res = await handleExtReserve(req({ origin: 'https://sukimacalendar.com' }), ENV, deps());
  assert.equal(res.status, 403);
});

test('reserve: Cookie では認証しない（Bearer 必須）', async () => {
  const rpc = stubRpc(RESERVE_OK);
  const res = await handleExtReserve(
    req({ authorization: null, cookie: `${SESSION_COOKIE_NAME}=dummytoken` }),
    ENV,
    { logger: quiet, rpc },
  );

  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: 'unauthenticated' });
  assert.equal(rpc.calls.length, 0);
});

test('reserve: 401 応答にも CORS ヘッダを付ける（拡張が読めるように）', async () => {
  const session = stubSession({ status: SESSION_RESULT.UNAUTHENTICATED, reason: 'no_bearer' });
  const res = await handleExtReserve(req(), ENV, deps({ session }));
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('access-control-allow-origin'), EXT_ORIGIN);
});

test('reserve: POST 以外は 405', async () => {
  const res = await handleExtReserve(req({ method: 'GET' }), ENV, deps());
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('access-control-allow-origin'), EXT_ORIGIN);
});

test('reserve: body が不正なら RPC を呼ばない', async () => {
  const cases = [
    [req({ contentType: 'text/plain' }), 400, 'invalid_content_type'],
    [req({ body: '{' }), 400, 'malformed_json'],
    [req({ body: '[]' }), 400, 'invalid_body'],
    [req({ body: JSON.stringify({ idempotency_key: 'short' }) }), 400, 'invalid_idempotency_key'],
    [req({ body: JSON.stringify({}) }), 400, 'invalid_idempotency_key'],
  ];
  for (const [request, status, code] of cases) {
    const rpc = stubRpc(RESERVE_OK);
    const res = await handleExtReserve(request, ENV, deps({ rpc }));
    assert.equal(res.status, status, code);
    assert.deepEqual(await res.json(), { error: code });
    assert.equal(rpc.calls.length, 0);
  }
});

test('reserve: RPC 到達不能は 502', async () => {
  const rpc = stubRpc(new SupabaseError('unavailable', 'boom'));
  const res = await handleExtReserve(req(), ENV, deps({ rpc }));
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: 'database_unavailable' });
});

test('reserve: RPC の戻り値が契約と違えば 500', async () => {
  for (const rows of [[], [{}, {}], [{ code: 'ok' }], null]) {
    const res = await handleExtReserve(req(), ENV, deps({ rpc: stubRpc(rows) }));
    assert.equal(res.status, 500, JSON.stringify(rows));
  }
});

test('reserve: レスポンスに user_id を出さない', async () => {
  const res = await handleExtReserve(req(), ENV, deps());
  const text = await res.text();
  assert.equal(text.includes(USER_ID), false);
});

test('OPTIONS: 許可済みなら 204、未許可なら 403', async () => {
  const ok = await onRequestOptions({ request: req({ method: 'OPTIONS' }), env: ENV });
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('access-control-allow-headers'), 'Authorization, Content-Type');

  const ng = await onRequestOptions({
    request: req({ method: 'OPTIONS', origin: 'https://evil.example' }),
    env: ENV,
  });
  assert.equal(ng.status, 403);
  assert.equal(ng.headers.get('access-control-allow-origin'), null);
});

// =========================================================
// commit / release
// =========================================================

const settleBody = JSON.stringify({ reservation_id: RESERVATION_ID });

test('commit: Web と同じ RPC を呼び、値をそのまま透過する', async () => {
  const rpc = stubRpc(SETTLE_OK);
  const res = await handleExtCommit(
    req({ body: settleBody, path: '/api/ext/quota/commit' }), ENV, deps({ rpc }),
  );
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(rpc.calls[0].name, 'commit_weekly_usage');
  assert.deepEqual(rpc.calls[0].args, { p_user_id: USER_ID, p_reservation_id: RESERVATION_ID });
  assert.equal(body.quota_enforced, true);
  assert.equal(body.ok, true);
  assert.equal(body.code, 'ok');
});

test('release: Web と同じ RPC を呼び、値をそのまま透過する', async () => {
  const rpc = stubRpc([{ ok: true, code: 'ok', state: 'released', used: 0 }]);
  const res = await handleExtRelease(
    req({ body: settleBody, path: '/api/ext/quota/release' }), ENV, deps({ rpc }),
  );
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(rpc.calls[0].name, 'release_weekly_usage');
  assert.equal(body.state, 'released');
});

test('release: 予算切れも 200 + ok:false で透過する', async () => {
  const rpc = stubRpc([{
    ok: false, code: 'release_budget_exceeded', state: 'committed', used: 3,
  }]);
  const res = await handleExtRelease(
    req({ body: settleBody, path: '/api/ext/quota/release' }), ENV, deps({ rpc }),
  );
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.ok, false);
  assert.equal(body.code, 'release_budget_exceeded');
});

test('commit / release: UUID でなければ RPC を呼ばない', async () => {
  for (const handler of [handleExtCommit, handleExtRelease]) {
    for (const value of ['not-a-uuid', '', 123, null]) {
      const rpc = stubRpc(SETTLE_OK);
      const res = await handler(
        req({ body: JSON.stringify({ reservation_id: value }) }), ENV, deps({ rpc }),
      );
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: 'invalid_reservation_id' });
      assert.equal(rpc.calls.length, 0);
    }
  }
});

test('commit / release: extension_pro は RPC を呼ばず unlimited', async () => {
  for (const handler of [handleExtCommit, handleExtRelease]) {
    const rpc = stubRpc(SETTLE_OK);
    const res = await handler(
      req({ body: settleBody }),
      ENV,
      deps({ rpc, session: stubSession({ plan_id: 'extension_pro', status: 'active' }) }),
    );
    const body = await res.json();
    assert.equal(body.quota_enforced, false);
    assert.equal(body.code, 'unlimited');
    assert.equal(rpc.calls.length, 0);
  }
});

test('commit / release: web_pro は拡張では quota 対象なので RPC を呼ぶ', async () => {
  for (const handler of [handleExtCommit, handleExtRelease]) {
    const rpc = stubRpc(SETTLE_OK);
    const res = await handler(
      req({ body: settleBody }),
      ENV,
      deps({ rpc, session: stubSession({ plan_id: 'web_pro', status: 'active' }) }),
    );
    assert.equal(res.status, 200);
    assert.equal(rpc.calls.length, 1);
  }
});

// =========================================================
// logout
// =========================================================

test('logout: token_hash で delete_session を呼ぶ（生トークンは送らない）', async () => {
  const rpc = stubRpc(null);
  const res = await handleExtLogout(
    req({ body: null, contentType: null, path: '/api/ext/auth/logout' }), ENV, { logger: quiet, rpc },
  );

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(rpc.calls[0].name, 'delete_session');
  assert.match(rpc.calls[0].args.p_token_hash, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(rpc.calls[0].args).includes(TOKEN), false);
});

test('logout: Bearer が無くても 200（冪等・存在を漏らさない）', async () => {
  const rpc = stubRpc(null);
  const res = await handleExtLogout(
    req({ body: null, contentType: null, authorization: null }), ENV, { logger: quiet, rpc },
  );
  assert.equal(res.status, 200);
  assert.equal(rpc.calls.length, 0);
});

test('logout: 許可外 origin は 403', async () => {
  const rpc = stubRpc(null);
  const res = await handleExtLogout(
    req({ body: null, contentType: null, origin: 'https://evil.example' }), ENV, { logger: quiet, rpc },
  );
  assert.equal(res.status, 403);
  assert.equal(rpc.calls.length, 0);
});

test('logout: POST 以外は 405', async () => {
  const res = await handleExtLogout(
    req({ method: 'GET', body: null, contentType: null }), ENV, { logger: quiet, rpc: stubRpc(null) },
  );
  assert.equal(res.status, 405);
});

test('logout: RPC が失敗したら 502', async () => {
  const rpc = stubRpc(new SupabaseError('unavailable', 'boom'));
  const res = await handleExtLogout(
    req({ body: null, contentType: null }), ENV, { logger: quiet, rpc },
  );
  assert.equal(res.status, 502);
});

// =========================================================
// ログ
// =========================================================

test('quota のログに secret / cookie / user_id / トークンを出さない', async () => {
  const lines = [];
  const push = (...a) => lines.push(a.map(String).join(' '));
  const logger = { error: push, warn: push, log: push };

  await handleExtReserve(req({ origin: 'https://evil.example' }), ENV, deps({ logger }));
  await handleExtReserve(req({ body: '{' }), ENV, deps({ logger }));
  await handleExtReserve(req(), ENV, deps({ logger, rpc: stubRpc(new SupabaseError('unavailable', 'boom')) }));

  const joined = lines.join('\n');
  assert.equal(joined.includes(USER_ID), false);
  assert.equal(joined.includes(TOKEN), false);
  assert.equal(joined.includes(ENV.SUPABASE_SERVICE_ROLE_KEY), false);
  assert.equal(joined.includes(KEY), false);
});

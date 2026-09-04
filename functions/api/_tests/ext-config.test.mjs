// =========================================================
// GET /api/ext/config の単体テスト
//
//   - ネットワークへは出ない。DB も触らない（このエンドポイントは RPC を呼ばない）。
//   - 本番の拡張機能 ID / secret はフィクスチャに保存しない（ダミーを使う）。
// =========================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONFIG_ALLOWED_METHODS,
  handleExtConfig,
  isExtensionQuotaEnabled,
  onRequestOptions,
} from '../ext/config.js';
import {
  DEFAULT_ALLOWED_METHODS,
  buildCorsHeaders,
  handlePreflight,
} from '../_lib/ext-cors.js';
import { FREE_WEEKLY_LIMIT } from '../_lib/quota.js';
import { SESSION_COOKIE_NAME } from '../_lib/session.js';

/** テスト用のダミー拡張機能 ID（本番値ではない）。 */
const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';
const OTHER_EXT_ID = 'ponmlkjihgfedcbaponmlkjihgfedcba';
const EXT_ORIGIN = 'chrome-extension://' + EXT_ID;

const ENV_OFF = { EXTENSION_IDS: EXT_ID };
const ENV_ON = { EXTENSION_IDS: EXT_ID, EXTENSION_QUOTA_ENABLED: 'true' };

const quiet = { error() {}, warn() {}, log() {} };

function req({ method = 'GET', origin = EXT_ORIGIN, headers = {} } = {}) {
  const h = { ...headers };
  if (origin !== null) h.origin = origin;
  return new Request('https://sukimacalendar.com/api/ext/config', { method, headers: h });
}

// ---------------------------------------------------------
// EXTENSION_QUOTA_ENABLED の解釈
// ---------------------------------------------------------

test('config: "true" のときだけ有効', () => {
  assert.equal(isExtensionQuotaEnabled({ EXTENSION_QUOTA_ENABLED: 'true' }), true);
});

test('config: 大文字・前後の空白も "true" として扱う', () => {
  for (const value of ['TRUE', 'True', ' true ', '\ttrue\n', 'tRuE']) {
    assert.equal(isExtensionQuotaEnabled({ EXTENSION_QUOTA_ENABLED: value }), true, JSON.stringify(value));
  }
});

test('config: "true" 以外はすべて false（fail safe）', () => {
  for (const value of ['1', 'yes', 'on', 'false', 'FALSE', '0', 'no', '', '   ', 'truthy', 'true1']) {
    assert.equal(isExtensionQuotaEnabled({ EXTENSION_QUOTA_ENABLED: value }), false, JSON.stringify(value));
  }
});

test('config: 未設定なら false（fail safe）', () => {
  assert.equal(isExtensionQuotaEnabled({}), false);
  assert.equal(isExtensionQuotaEnabled(null), false);
  assert.equal(isExtensionQuotaEnabled(undefined), false);
  assert.equal(isExtensionQuotaEnabled({ EXTENSION_QUOTA_ENABLED: true }), false, '真偽値は文字列でないので false');
});

// ---------------------------------------------------------
// 正常系
// ---------------------------------------------------------

test('config: 正しい Origin なら 200 で quota_enforced=false を返す', async () => {
  const res = await handleExtConfig(req(), ENV_OFF, { logger: quiet });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.deepEqual(body, { quota_enforced: false, free_weekly_limit: 3 });
});

test('config: EXTENSION_QUOTA_ENABLED=true なら quota_enforced=true', async () => {
  const res = await handleExtConfig(req(), ENV_ON, { logger: quiet });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.quota_enforced, true);
});

test('config: free_weekly_limit は FREE_WEEKLY_LIMIT と一致する', async () => {
  const res = await handleExtConfig(req(), ENV_OFF, { logger: quiet });
  const body = await res.json();

  assert.equal(body.free_weekly_limit, FREE_WEEKLY_LIMIT);
  assert.equal(body.free_weekly_limit, 3);
});

test('config: Bearer も Cookie も要求しない', async () => {
  const withAuth = await handleExtConfig(
    req({ headers: { authorization: 'Bearer dummy_token', cookie: `${SESSION_COOKIE_NAME}=dummy` } }),
    ENV_ON,
    { logger: quiet },
  );
  const withoutAuth = await handleExtConfig(req(), ENV_ON, { logger: quiet });

  assert.equal(withAuth.status, 200);
  assert.equal(withoutAuth.status, 200, '認証なしでも 200');
  assert.deepEqual(await withAuth.json(), await withoutAuth.json(), '認証の有無で結果が変わらない');
});

test('config: レスポンスに余計なフィールドを含めない', async () => {
  const res = await handleExtConfig(req(), ENV_ON, { logger: quiet });
  const body = await res.json();
  assert.deepEqual(Object.keys(body).sort(), ['free_weekly_limit', 'quota_enforced']);
});

// ---------------------------------------------------------
// CORS
// ---------------------------------------------------------

test('config: CORS ヘッダが仕様どおり（GET 許可・wildcard なし・credentials なし）', async () => {
  const res = await handleExtConfig(req(), ENV_OFF, { logger: quiet });

  assert.equal(res.headers.get('access-control-allow-origin'), EXT_ORIGIN);
  assert.notEqual(res.headers.get('access-control-allow-origin'), '*');
  assert.equal(res.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
  assert.equal(res.headers.get('access-control-allow-credentials'), null);
  assert.equal(res.headers.get('vary'), 'Origin');
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('config: 未許可 Origin は 403 かつ CORS ヘッダなし', async () => {
  for (const origin of ['chrome-extension://' + OTHER_EXT_ID, 'https://evil.example', null]) {
    const res = await handleExtConfig(req({ origin }), ENV_ON, { logger: quiet });
    assert.equal(res.status, 403, String(origin));
    assert.deepEqual(await res.json(), { error: 'forbidden_origin' });
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  }
});

test('config: Web の origin では通らない（allowlist が独立している）', async () => {
  const res = await handleExtConfig(req({ origin: 'https://sukimacalendar.com' }), ENV_ON, { logger: quiet });
  assert.equal(res.status, 403);
});

test('config: EXTENSION_IDS 未設定なら誰も通さない（fail closed）', async () => {
  const res = await handleExtConfig(req(), { EXTENSION_QUOTA_ENABLED: 'true' }, { logger: quiet });
  assert.equal(res.status, 403);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('config: GET 以外は 405（CORS ヘッダは付ける）', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const res = await handleExtConfig(req({ method }), ENV_OFF, { logger: quiet });
    assert.equal(res.status, 405, method);
    assert.deepEqual(await res.json(), { error: 'method_not_allowed' });
    assert.equal(res.headers.get('access-control-allow-origin'), EXT_ORIGIN);
    assert.equal(res.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
  }
});

test('config: OPTIONS は 204 で GET を許可する', async () => {
  const res = await onRequestOptions({ request: req({ method: 'OPTIONS' }), env: ENV_OFF });

  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), EXT_ORIGIN);
  assert.equal(res.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
  assert.equal(res.headers.get('access-control-allow-credentials'), null);
});

test('config: OPTIONS も未許可 Origin は 403 で CORS なし', async () => {
  const res = await onRequestOptions({
    request: req({ method: 'OPTIONS', origin: 'https://evil.example' }),
    env: ENV_OFF,
  });
  assert.equal(res.status, 403);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('config: quota を消費しない（RPC を一切呼ばない）', async () => {
  let called = false;
  const rpc = async () => { called = true; return []; };
  await handleExtConfig(req(), ENV_ON, { logger: quiet, rpc });
  assert.equal(called, false);
});

// ---------------------------------------------------------
// 既存 /api/ext/* の POST 挙動を壊していないこと
// ---------------------------------------------------------

test('ext-cors: buildCorsHeaders の既定は POST, OPTIONS のまま', () => {
  assert.equal(DEFAULT_ALLOWED_METHODS, 'POST, OPTIONS');
  assert.equal(buildCorsHeaders(EXT_ORIGIN)['Access-Control-Allow-Methods'], 'POST, OPTIONS');
});

test('ext-cors: methods を渡したときだけ差し替わる', () => {
  assert.equal(
    buildCorsHeaders(EXT_ORIGIN, CONFIG_ALLOWED_METHODS)['Access-Control-Allow-Methods'],
    'GET, OPTIONS',
  );
  // 他のヘッダは変わらない
  const h = buildCorsHeaders(EXT_ORIGIN, CONFIG_ALLOWED_METHODS);
  assert.equal(h['Access-Control-Allow-Origin'], EXT_ORIGIN);
  assert.equal(h['Access-Control-Allow-Headers'], 'Authorization, Content-Type');
  assert.equal(h.Vary, 'Origin');
  assert.equal('Access-Control-Allow-Credentials' in h, false);
});

test('ext-cors: handlePreflight の既定も POST, OPTIONS のまま', () => {
  const res = handlePreflight(req({ method: 'OPTIONS' }), ENV_OFF);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-methods'), 'POST, OPTIONS');
});

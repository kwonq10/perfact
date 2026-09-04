// =========================================================
// _lib/ext-cors.js の単体テスト
//
//   - ネットワークへは出ない。
//   - 本番の拡張機能 ID / secret はフィクスチャに保存しない（ダミーを使う）。
// =========================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EXTENSION_ID_RE,
  buildCorsHeaders,
  checkExtensionOrigin,
  extJson,
  getAllowedExtensionIds,
  getAllowedExtensionOrigins,
  handlePreflight,
  isAllowedExtensionId,
} from '../_lib/ext-cors.js';

/** テスト用のダミー拡張機能 ID（本番値ではない）。 */
const EXT_A = 'abcdefghijklmnopabcdefghijklmnop';
const EXT_B = 'ponmlkjihgfedcbaponmlkjihgfedcba';
const ORIGIN_A = 'chrome-extension://' + EXT_A;

const ENV = { EXTENSION_IDS: EXT_A };

function req(origin, method = 'POST') {
  const headers = {};
  if (origin !== null) headers.origin = origin;
  return new Request('https://example.com/api/ext/quota/reserve', { method, headers });
}

test('EXTENSION_ID_RE: 32文字の a〜p のみ通す', () => {
  assert.equal(EXTENSION_ID_RE.test(EXT_A), true);
  assert.equal(EXTENSION_ID_RE.test(EXT_A.slice(0, 31)), false, '31文字は不可');
  assert.equal(EXTENSION_ID_RE.test(EXT_A + 'a'), false, '33文字は不可');
  assert.equal(EXTENSION_ID_RE.test('z'.repeat(32)), false, 'a〜p 以外は不可');
  assert.equal(EXTENSION_ID_RE.test('ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP'), false, '大文字は不可');
});

test('getAllowedExtensionIds: 未設定なら空（フェイルクローズ）', () => {
  assert.deepEqual(getAllowedExtensionIds({}), []);
  assert.deepEqual(getAllowedExtensionIds({ EXTENSION_IDS: '' }), []);
  assert.deepEqual(getAllowedExtensionIds({ EXTENSION_IDS: '   ' }), []);
  assert.deepEqual(getAllowedExtensionIds(null), []);
});

test('getAllowedExtensionIds: 形式が不正な要素は無視する', () => {
  const ids = getAllowedExtensionIds({
    EXTENSION_IDS: `${EXT_A}, zzz, ${'q'.repeat(32)}, ${EXT_B}`,
  });
  assert.deepEqual(ids, [EXT_A, EXT_B]);
});

test('getAllowedExtensionIds: 重複を除く', () => {
  assert.deepEqual(getAllowedExtensionIds({ EXTENSION_IDS: `${EXT_A},${EXT_A}` }), [EXT_A]);
});

test('getAllowedExtensionOrigins: scheme を付けて返す', () => {
  assert.deepEqual(getAllowedExtensionOrigins(ENV), [ORIGIN_A]);
});

test('isAllowedExtensionId: allowlist との完全一致', () => {
  assert.equal(isAllowedExtensionId(EXT_A, ENV), true);
  assert.equal(isAllowedExtensionId(EXT_B, ENV), false);
  assert.equal(isAllowedExtensionId(null, ENV), false);
  assert.equal(isAllowedExtensionId(EXT_A, {}), false, '未設定なら誰も許可しない');
});

test('checkExtensionOrigin: 許可済み origin は通る', () => {
  assert.deepEqual(checkExtensionOrigin(req(ORIGIN_A), ENV), { ok: true, origin: ORIGIN_A });
});

test('checkExtensionOrigin: Origin が無ければ missing_origin', () => {
  assert.deepEqual(checkExtensionOrigin(req(null), ENV), { ok: false, reason: 'missing_origin' });
});

test('checkExtensionOrigin: 別の拡張は拒否する', () => {
  const r = checkExtensionOrigin(req('chrome-extension://' + EXT_B), ENV);
  assert.deepEqual(r, { ok: false, reason: 'forbidden_origin' });
});

test('checkExtensionOrigin: 前方一致・後方一致では通さない', () => {
  const cases = [
    ORIGIN_A + '.evil.example',
    'https://evil.example/' + ORIGIN_A,
    'chrome-extension://' + EXT_A + 'a',
    'chrome-extension://a' + EXT_A,
    ORIGIN_A + '/',
  ];
  for (const origin of cases) {
    assert.deepEqual(
      checkExtensionOrigin(req(origin), ENV),
      { ok: false, reason: 'forbidden_origin' },
      origin,
    );
  }
});

test('checkExtensionOrigin: Web の origin は通さない（別 allowlist）', () => {
  const r = checkExtensionOrigin(req('https://sukimacalendar.com'), ENV);
  assert.deepEqual(r, { ok: false, reason: 'forbidden_origin' });
});

test('buildCorsHeaders: ワイルドカードを使わず、credentials を付けない', () => {
  const h = buildCorsHeaders(ORIGIN_A);
  assert.equal(h['Access-Control-Allow-Origin'], ORIGIN_A);
  assert.notEqual(h['Access-Control-Allow-Origin'], '*');
  assert.equal(h['Access-Control-Allow-Headers'], 'Authorization, Content-Type');
  assert.equal(h['Access-Control-Allow-Methods'], 'POST, OPTIONS');
  assert.equal(h.Vary, 'Origin');
  assert.equal('Access-Control-Allow-Credentials' in h, false);
});

test('extJson: 許可済み origin には CORS ヘッダと no-store が付く', async () => {
  const res = extJson(200, { ok: true }, ORIGIN_A);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN_A);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('vary'), 'Origin');
  assert.equal(res.headers.get('access-control-allow-credentials'), null);
  assert.deepEqual(await res.json(), { ok: true });
});

test('extJson: origin が null なら CORS ヘッダを付けない', () => {
  const res = extJson(403, { error: 'forbidden_origin' }, null);
  assert.equal(res.status, 403);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('handlePreflight: 許可済みなら 204 + CORS', () => {
  const res = handlePreflight(req(ORIGIN_A, 'OPTIONS'), ENV);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN_A);
  assert.equal(res.headers.get('access-control-allow-headers'), 'Authorization, Content-Type');
  assert.equal(res.headers.get('access-control-allow-methods'), 'POST, OPTIONS');
});

test('handlePreflight: 未許可なら 403 で CORS を付けない', () => {
  const res = handlePreflight(req('chrome-extension://' + EXT_B, 'OPTIONS'), ENV);
  assert.equal(res.status, 403);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('handlePreflight: EXTENSION_IDS 未設定なら誰も通さない', () => {
  const res = handlePreflight(req(ORIGIN_A, 'OPTIONS'), {});
  assert.equal(res.status, 403);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

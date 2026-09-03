// =========================================================
// _lib/request-body.js の単体テスト
//
//   - ネットワークへは出ない。
//   - 本番の secret / Project URL はフィクスチャに一切保存しない。
// =========================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  IDEMPOTENCY_KEY_MAX,
  IDEMPOTENCY_KEY_MIN,
  MAX_BODY_BYTES,
  isJsonContentType,
  isValidIdempotencyKey,
  isValidUuid,
  readJsonBody,
} from '../_lib/request-body.js';

function req(body, contentType = 'application/json', extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (contentType !== null) headers['content-type'] = contentType;
  return new Request('https://example.com/api/quota/reserve', {
    method: 'POST',
    headers,
    body,
  });
}

// =========================================================
// Content-Type
// =========================================================

test('isJsonContentType: application/json とパラメータ付きを許す', () => {
  assert.equal(isJsonContentType('application/json'), true);
  assert.equal(isJsonContentType('application/json; charset=utf-8'), true);
  assert.equal(isJsonContentType('  APPLICATION/JSON  '), true);
});

test('isJsonContentType: それ以外は拒否', () => {
  for (const v of [
    'text/plain',
    'application/x-www-form-urlencoded',
    'multipart/form-data; boundary=x',
    'application/json-patch+json',
    '',
    null,
    undefined,
    123,
  ]) {
    assert.equal(isJsonContentType(v), false, String(v));
  }
});

test('Content-Type が JSON でなければ invalid_content_type', async () => {
  const r = await readJsonBody(req('{"a":1}', 'text/plain'));
  assert.deepEqual(r, { ok: false, code: 'invalid_content_type' });
});

test('Content-Type ヘッダが無ければ invalid_content_type', async () => {
  const r = await readJsonBody(req('{"a":1}', null));
  assert.deepEqual(r, { ok: false, code: 'invalid_content_type' });
});

// =========================================================
// サイズ
// =========================================================

test('1KB ちょうどは通る', async () => {
  const pad = 'x'.repeat(MAX_BODY_BYTES - '{"k":""}'.length);
  const body = `{"k":"${pad}"}`;
  assert.equal(new TextEncoder().encode(body).length, MAX_BODY_BYTES);
  const r = await readJsonBody(req(body));
  assert.equal(r.ok, true);
});

test('1KB 超は body_too_large', async () => {
  const body = `{"k":"${'x'.repeat(MAX_BODY_BYTES)}"}`;
  const r = await readJsonBody(req(body));
  assert.deepEqual(r, { ok: false, code: 'body_too_large' });
});

test('Content-Length が上限超なら本文を読まずに body_too_large', async () => {
  const r = await readJsonBody(req('{"a":1}', 'application/json', {
    'content-length': String(MAX_BODY_BYTES + 1),
  }));
  assert.deepEqual(r, { ok: false, code: 'body_too_large' });
});

test('マルチバイトはバイト数で判定する', async () => {
  // 「あ」は UTF-8 で 3 バイト。文字数では上限内でもバイト数で超える。
  const body = `{"k":"${'あ'.repeat(400)}"}`;
  assert.ok(body.length < MAX_BODY_BYTES, '文字数では上限内');
  assert.ok(new TextEncoder().encode(body).length > MAX_BODY_BYTES, 'バイト数では超過');
  assert.deepEqual(await readJsonBody(req(body)), { ok: false, code: 'body_too_large' });
});

// =========================================================
// JSON の形
// =========================================================

test('壊れた JSON は malformed_json', async () => {
  for (const body of ['{', '{"a":}', 'not json', '{"a":1,}']) {
    assert.deepEqual(await readJsonBody(req(body)), { ok: false, code: 'malformed_json' }, body);
  }
});

test('空 body / 空白のみは malformed_json', async () => {
  for (const body of ['', '   ', '\n']) {
    assert.deepEqual(await readJsonBody(req(body)), { ok: false, code: 'malformed_json' });
  }
});

test('配列 / null / プリミティブは invalid_body', async () => {
  for (const body of ['[]', '[{"a":1}]', 'null', '"str"', '42', 'true']) {
    assert.deepEqual(await readJsonBody(req(body)), { ok: false, code: 'invalid_body' }, body);
  }
});

test('正常なオブジェクトは ok', async () => {
  const r = await readJsonBody(req('{"idempotency_key":"abcdefgh"}'));
  assert.deepEqual(r, { ok: true, value: { idempotency_key: 'abcdefgh' } });
});

// =========================================================
// idempotency_key（migration の CHECK 制約と整合）
// =========================================================

test('idempotency_key: 8〜200 文字を許す', () => {
  assert.equal(isValidIdempotencyKey('a'.repeat(IDEMPOTENCY_KEY_MIN)), true);
  assert.equal(isValidIdempotencyKey('a'.repeat(IDEMPOTENCY_KEY_MAX)), true);
  assert.equal(isValidIdempotencyKey(crypto.randomUUID()), true);
});

test('idempotency_key: 短すぎる / 長すぎるは拒否', () => {
  assert.equal(isValidIdempotencyKey('a'.repeat(IDEMPOTENCY_KEY_MIN - 1)), false);
  assert.equal(isValidIdempotencyKey('a'.repeat(IDEMPOTENCY_KEY_MAX + 1)), false);
  assert.equal(isValidIdempotencyKey(''), false);
});

test('idempotency_key: 空白を含むものは拒否（DB の CHECK と同じ）', () => {
  for (const v of ['abcd efgh', 'abcdefgh ', ' abcdefgh', 'abcd\tefgh', 'abcd\nefgh', 'abcd\refgh']) {
    assert.equal(isValidIdempotencyKey(v), false, JSON.stringify(v));
  }
});

test('idempotency_key: 制御文字は拒否', () => {
  // 制御文字はソースへ直接書かずコードポイントから組み立てる。
  for (const cp of [0x00, 0x08, 0x1b, 0x7f, 0x9f]) {
    const value = 'abcd' + String.fromCharCode(cp) + 'efgh';
    assert.equal(isValidIdempotencyKey(value), false, 'cp=0x' + cp.toString(16));
  }
});

test('idempotency_key: 文字数はコードポイントで数える（DB の length() と一致）', () => {
  // 絵文字 4 個 = コードポイント 4。DB の length() も 4 なので 8 未満として拒否する。
  const four = '\u{1F600}'.repeat(4);
  assert.equal(four.length, 8, 'UTF-16 単位では 8');
  assert.equal([...four].length, 4, 'コードポイントでは 4');
  assert.equal(isValidIdempotencyKey(four), false, 'DB が弾く値を API も弾く');

  const eight = '\u{1F600}'.repeat(8);
  assert.equal(isValidIdempotencyKey(eight), true);
});

test('idempotency_key: 文字列以外は拒否', () => {
  for (const v of [undefined, null, 123, {}, [], true]) {
    assert.equal(isValidIdempotencyKey(v), false, String(v));
  }
});

// =========================================================
// reservation_id
// =========================================================

test('isValidUuid: UUID の形を許す（大文字小文字は問わない）', () => {
  assert.equal(isValidUuid(crypto.randomUUID()), true);
  assert.equal(isValidUuid('C9F17DA8-E426-46B9-AC84-B1B6159FC53C'), true);
  assert.equal(isValidUuid('00000000-0000-0000-0000-000000000000'), true);
});

test('isValidUuid: 形が違うものは拒否', () => {
  for (const v of [
    '',
    'not-a-uuid',
    'c9f17da8e42646b9ac84b1b6159fc53c',
    'c9f17da8-e426-46b9-ac84-b1b6159fc53',
    'c9f17da8-e426-46b9-ac84-b1b6159fc53cc',
    'g9f17da8-e426-46b9-ac84-b1b6159fc53c',
    ' c9f17da8-e426-46b9-ac84-b1b6159fc53c',
    undefined,
    null,
    123,
    {},
  ]) {
    assert.equal(isValidUuid(v), false, String(v));
  }
});

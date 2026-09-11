// =========================================================
// Stripe REST utilityの単体テスト
//
//   - **api.stripe.com へは一度も通信しない。** fetch はすべて mock する。
//   - 本番の secret はフィクスチャに一切保存しない（sk_test_dummy_… のみ）。
//   - Stripe Dashboard も触らない。
// =========================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  IDEMPOTENT_METHODS,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  STRIPE_API_BASE,
  STRIPE_TIMEOUT_MS,
  SUPPORTED_METHODS,
  StripeApiError,
  assertValidIdempotencyKey,
  assertValidPath,
  encodeStripeParams,
  getStripeConfig,
  stripeRequest,
} from '../_lib/stripe.js';

// --- テスト用のダミー設定（本番値ではない） ---
const SECRET = 'sk_test_dummy_for_tests_only';
const ENV = { STRIPE_SECRET_KEY: SECRET };

/** 任意のレスポンスを返す fetch mock。呼び出し内容を記録する。 */
function mockFetch(responder) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return typeof responder === 'function' ? responder(url, init) : responder;
  };
  fn.calls = calls;
  return fn;
}

const okJson = (obj, init = {}) =>
  new Response(JSON.stringify(obj), { status: 200, ...init });

const isStripeError = (code, extra = () => true) => (e) =>
  e instanceof StripeApiError && e.code === code && extra(e);

/** stripeRequest を既定 env で呼ぶ短縮形。 */
const call = (o) => stripeRequest({ env: ENV, ...o });


// =========================================================
// 1. 設定と secret
// =========================================================

test('env 未設定 → not_configured', () => {
  for (const env of [undefined, null, {}, { STRIPE_SECRET_KEY: '' }]) {
    assert.throws(() => getStripeConfig(env), isStripeError('not_configured'));
  }
});

test('publishable key を渡すと not_configured', () => {
  assert.throws(() => getStripeConfig({ STRIPE_SECRET_KEY: 'pk_test_x' }),
    isStripeError('not_configured'));
});

test('not_configured のメッセージに secret を載せない', () => {
  try {
    getStripeConfig({ STRIPE_SECRET_KEY: '' });
  } catch (e) {
    assert.equal(e.message.includes('sk_'), false);
    assert.ok(e.message.includes('STRIPE_SECRET_KEY'), 'キー名だけは出す');
  }
});

test('STRIPE_API_VERSION は未設定なら null（既定値を焼き込まない）', () => {
  assert.equal(getStripeConfig(ENV).apiVersion, null);
  assert.equal(getStripeConfig({ ...ENV, STRIPE_API_VERSION: '' }).apiVersion, null);
});

test('STRIPE_API_VERSION は設定すればそのまま使う。改行入りは拒否', () => {
  assert.equal(getStripeConfig({ ...ENV, STRIPE_API_VERSION: '2026-01-01' }).apiVersion,
    '2026-01-01');
  for (const bad of ['a\r\nX-Evil: 1', 'a\nb', 'x'.repeat(65)]) {
    assert.throws(() => getStripeConfig({ ...ENV, STRIPE_API_VERSION: bad }),
      isStripeError('not_configured'));
  }
});

test('stripeRequest も env 未設定なら通信せず not_configured', async () => {
  const f = mockFetch(okJson({}));
  await assert.rejects(() => stripeRequest({ env: {}, method: 'GET', path: '/v1/x', fetchImpl: f }),
    isStripeError('not_configured'));
  assert.equal(f.calls.length, 0, '通信していない');
});


// =========================================================
// 2. フォームエンコード
// =========================================================

const enc = (p) => encodeStripeParams(p).toString();

test('文字列 / 数値 / 真偽値をエンコードする', () => {
  assert.equal(enc({ a: 'x', b: 12, c: true, d: false }), 'a=x&b=12&c=true&d=false');
});

test('入れ子オブジェクトは a[b] 形式', () => {
  assert.equal(decodeURIComponent(enc({ automatic_tax: { enabled: true } })),
    'automatic_tax[enabled]=true');
  assert.equal(decodeURIComponent(enc({ metadata: { user_id: 'u1' } })),
    'metadata[user_id]=u1');
});

test('多段の入れ子も a[b][c] 形式', () => {
  assert.equal(
    decodeURIComponent(enc({ subscription_data: { metadata: { user_id: 'u1', plan_id: 'web_pro' } } })),
    'subscription_data[metadata][user_id]=u1&subscription_data[metadata][plan_id]=web_pro');
});

test('配列は添字形式 a[0]', () => {
  assert.equal(decodeURIComponent(enc({ expand: ['customer', 'latest_invoice'] })),
    'expand[0]=customer&expand[1]=latest_invoice');
  assert.equal(decodeURIComponent(enc({ line_items: [{ price: 'p1', quantity: 1 }] })),
    'line_items[0][price]=p1&line_items[0][quantity]=1');
});

test('null / undefined はキーごと落とす', () => {
  assert.equal(enc({ a: 'x', b: null, c: undefined, d: 'y' }), 'a=x&d=y');
  assert.equal(decodeURIComponent(enc({ meta: { a: null, b: 'y' } })), 'meta[b]=y');
});

test('空オブジェクト / 空配列 / params 省略は空文字', () => {
  assert.equal(enc({}), '');
  assert.equal(enc({ a: {} }), '');
  assert.equal(enc({ a: [] }), '');
  assert.equal(encodeStripeParams(undefined).toString(), '');
  assert.equal(encodeStripeParams(null).toString(), '');
});

test('値のエスケープが行われる', () => {
  assert.equal(enc({ 'a b': 'x&y=z' }), 'a+b=x%26y%3Dz');
});

test('同じ入力からは常に同じ出力（決定的）', () => {
  const p = { b: 1, a: { z: 'z', y: 'y' }, c: [1, 2] };
  assert.equal(enc(p), enc(p));
  assert.equal(enc(p), enc(JSON.parse(JSON.stringify(p))));
});

test('不正な型 / 非有限数 / 深すぎる入れ子は invalid_request', () => {
  assert.throws(() => enc({ a: () => {} }), isStripeError('invalid_request'));
  assert.throws(() => enc({ a: Symbol('s') }), isStripeError('invalid_request'));
  assert.throws(() => enc({ a: NaN }), isStripeError('invalid_request'));
  assert.throws(() => enc({ a: Infinity }), isStripeError('invalid_request'));
  assert.throws(() => enc({ a: { b: { c: { d: { e: { f: { g: 1 } } } } } } }),
    isStripeError('invalid_request'));
});

test('params がオブジェクトでなければ invalid_request', () => {
  for (const p of ['x', 1, true, ['a']]) {
    assert.throws(() => encodeStripeParams(p), isStripeError('invalid_request'));
  }
});


// =========================================================
// 3. path / idempotency key の検証
// =========================================================

test('path の検証', () => {
  assert.doesNotThrow(() => assertValidPath('/v1/subscriptions/sub_123'));
  for (const bad of ['', 'v1/x', '/v1//x', '/v1/../x', '/v1/x y', '/v1/x?a=1',
                     '/v1/x#f', '/v1/undefined', '/v1/null', '/v1/subs/undefined',
                     null, undefined, 123]) {
    assert.throws(() => assertValidPath(bad), isStripeError('invalid_request'), String(bad));
  }
});

test('idempotencyKey の検証（ヘッダ注入を防ぐ）', () => {
  assert.doesNotThrow(() => assertValidIdempotencyKey('ok-key-1', 'POST'));
  const CRLF = String.fromCharCode(13, 10);
  for (const bad of ['', 'a' + CRLF + 'X-Evil: 1', 'a' + String.fromCharCode(10) + 'b',
                     'x'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH + 1), null, undefined, 12]) {
    assert.throws(() => assertValidIdempotencyKey(bad, 'POST'),
      isStripeError('invalid_request'), String(bad));
  }
  assert.throws(() => assertValidIdempotencyKey('ok', 'GET'), isStripeError('invalid_request'));
  assert.deepEqual([...IDEMPOTENT_METHODS], ['POST', 'DELETE']);
});


// =========================================================
// 4. リクエストの組み立て
// =========================================================

test('Authorization: Bearer と Accept が付く', async () => {
  const f = mockFetch(okJson({ id: 'sub_1' }));
  await call({ method: 'GET', path: '/v1/subscriptions/sub_1', fetchImpl: f });

  const h = f.calls[0].init.headers;
  assert.equal(h.Authorization, 'Bearer ' + SECRET);
  assert.equal(h.Accept, 'application/json');
});

test('GET は params をクエリへ載せ、ボディを付けない', async () => {
  const f = mockFetch(okJson({ object: 'list' }));
  await call({ method: 'GET', path: '/v1/subscriptions',
               params: { customer: 'cus_1', limit: 10, expand: ['data.customer'] },
               fetchImpl: f });

  const { url, init } = f.calls[0];
  assert.ok(url.startsWith(STRIPE_API_BASE + '/v1/subscriptions?'), url);
  assert.equal(decodeURIComponent(url.split('?')[1]),
    'customer=cus_1&limit=10&expand[0]=data.customer');
  assert.equal('body' in init, false, 'GET にボディを付けない');
  assert.equal(init.headers['Content-Type'], undefined, 'GET に Content-Type を付けない');
});

test('POST はフォームエンコードしたボディと Content-Type を付ける', async () => {
  const f = mockFetch(okJson({ id: 'cs_1' }));
  await call({ method: 'POST', path: '/v1/checkout/sessions',
               params: { mode: 'subscription', automatic_tax: { enabled: true },
                         metadata: { user_id: 'u1' } },
               fetchImpl: f });

  const { init } = f.calls[0];
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(decodeURIComponent(init.body),
    'mode=subscription&automatic_tax[enabled]=true&metadata[user_id]=u1');
});

test('POST は params が無くてもボディを付ける（空文字）', async () => {
  const f = mockFetch(okJson({ id: 'x' }));
  await call({ method: 'POST', path: '/v1/subscriptions/sub_1', fetchImpl: f });
  assert.equal(f.calls[0].init.body, '');
  assert.equal(f.calls[0].init.headers['Content-Type'], 'application/x-www-form-urlencoded');
});

test('DELETE は params があるときだけボディを付ける', async () => {
  const f1 = mockFetch(okJson({ deleted: true }));
  await call({ method: 'DELETE', path: '/v1/subscriptions/sub_1', fetchImpl: f1 });
  assert.equal('body' in f1.calls[0].init, false);
  assert.equal(f1.calls[0].init.headers['Content-Type'], undefined);

  const f2 = mockFetch(okJson({ deleted: true }));
  await call({ method: 'DELETE', path: '/v1/subscriptions/sub_1',
               params: { prorate: true }, fetchImpl: f2 });
  assert.equal(f2.calls[0].init.body, 'prorate=true');
  assert.equal(f2.calls[0].init.headers['Content-Type'], 'application/x-www-form-urlencoded');
});

test('未対応 method は通信せず invalid_request', async () => {
  const f = mockFetch(okJson({}));
  for (const m of ['PUT', 'PATCH', 'HEAD', 'OPTIONS', 'get', '', null, undefined, 1]) {
    await assert.rejects(() => call({ method: m, path: '/v1/x', fetchImpl: f }),
      isStripeError('invalid_request'), String(m));
  }
  assert.equal(f.calls.length, 0, '通信していない');
  assert.deepEqual([...SUPPORTED_METHODS], ['GET', 'POST', 'DELETE']);
});

test('不正な path は通信しない', async () => {
  const f = mockFetch(okJson({}));
  await assert.rejects(() => call({ method: 'GET', path: '/v1/subs/undefined', fetchImpl: f }),
    isStripeError('invalid_request'));
  assert.equal(f.calls.length, 0);
});

test('Idempotency-Key は渡したときだけ付く', async () => {
  const f1 = mockFetch(okJson({ id: 'x' }));
  await call({ method: 'POST', path: '/v1/checkout/sessions',
               idempotencyKey: 'checkout-u1-2026-09-07', fetchImpl: f1 });
  assert.equal(f1.calls[0].init.headers['Idempotency-Key'], 'checkout-u1-2026-09-07');

  const f2 = mockFetch(okJson({ id: 'x' }));
  await call({ method: 'POST', path: '/v1/checkout/sessions', fetchImpl: f2 });
  assert.equal('Idempotency-Key' in f2.calls[0].init.headers, false, '勝手に生成しない');

  // null / undefined は「指定なし」と同じ
  const f3 = mockFetch(okJson({ id: 'x' }));
  await call({ method: 'POST', path: '/v1/x', idempotencyKey: null, fetchImpl: f3 });
  assert.equal('Idempotency-Key' in f3.calls[0].init.headers, false);
});

test('不正な Idempotency-Key は通信しない（ヘッダ注入対策）', async () => {
  const f = mockFetch(okJson({}));
  const CRLF = String.fromCharCode(13, 10);
  await assert.rejects(() => call({ method: 'POST', path: '/v1/x',
    idempotencyKey: 'a' + CRLF + 'X-Evil: 1', fetchImpl: f }), isStripeError('invalid_request'));
  await assert.rejects(() => call({ method: 'GET', path: '/v1/x',
    idempotencyKey: 'ok', fetchImpl: f }), isStripeError('invalid_request'));
  assert.equal(f.calls.length, 0);
});

test('Stripe-Version は env にあるときだけ付く', async () => {
  const f1 = mockFetch(okJson({}));
  await call({ method: 'GET', path: '/v1/x', fetchImpl: f1 });
  assert.equal('Stripe-Version' in f1.calls[0].init.headers, false);

  const f2 = mockFetch(okJson({}));
  await stripeRequest({ env: { ...ENV, STRIPE_API_VERSION: '2026-01-01' },
                        method: 'GET', path: '/v1/x', fetchImpl: f2 });
  assert.equal(f2.calls[0].init.headers['Stripe-Version'], '2026-01-01');
});

test('timeout の signal が渡る（既定 10 秒）', async () => {
  const f = mockFetch(okJson({}));
  await call({ method: 'GET', path: '/v1/x', fetchImpl: f });
  assert.ok(f.calls[0].init.signal, 'signal が渡っている');
  assert.equal(STRIPE_TIMEOUT_MS, 10000);
});

test('fetch は注入したものだけが使われる（実 Stripe を叩かない）', async () => {
  const f = mockFetch(okJson({ id: 'sub_1' }));
  const out = await call({ method: 'GET', path: '/v1/subscriptions/sub_1', fetchImpl: f });
  assert.deepEqual(out, { id: 'sub_1' });
  assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0].url.startsWith('https://api.stripe.com/'), '組み立て先の URL だけ確認');
});


// =========================================================
// 5. レスポンスの解釈とエラー分類
// =========================================================

test('2xx の JSON オブジェクトはそのまま返る', async () => {
  const f = mockFetch(okJson({ id: 'sub_1', status: 'active', items: { data: [] } }));
  const out = await call({ method: 'GET', path: '/v1/subscriptions/sub_1', fetchImpl: f });
  assert.deepEqual(out, { id: 'sub_1', status: 'active', items: { data: [] } });
});

test('2xx でも JSON でなければ bad_response', async () => {
  const f = mockFetch(new Response('<html>oops</html>', { status: 200 }));
  await assert.rejects(() => call({ method: 'GET', path: '/v1/x', fetchImpl: f }),
    isStripeError('bad_response', (e) => e.retryable === false && e.httpStatus === 200));
});

test('2xx でも null / 配列 / スカラーなら bad_response', async () => {
  for (const bodyText of ['null', '[]', '"x"', '12', 'true']) {
    const f = mockFetch(new Response(bodyText, { status: 200 }));
    await assert.rejects(() => call({ method: 'GET', path: '/v1/x', fetchImpl: f }),
      isStripeError('bad_response'), bodyText);
  }
});

test('400 は request_failed（non-retryable）で type / code を保持する', async () => {
  const f = mockFetch(new Response(JSON.stringify({
    error: { type: 'invalid_request_error', code: 'parameter_missing',
             message: 'Missing required param: mode.' },
  }), { status: 400, headers: { 'Request-Id': 'req_400' } }));

  await assert.rejects(() => call({ method: 'POST', path: '/v1/checkout/sessions', fetchImpl: f }),
    isStripeError('request_failed', (e) =>
      e.httpStatus === 400 &&
      e.stripeType === 'invalid_request_error' &&
      e.stripeCode === 'parameter_missing' &&
      e.requestId === 'req_400' &&
      e.retryable === false &&
      e.message.includes('Missing required param')));
});

test('401 は request_failed（non-retryable）', async () => {
  const f = mockFetch(new Response(JSON.stringify({
    error: { type: 'invalid_request_error', message: 'Invalid API Key provided' },
  }), { status: 401 }));
  await assert.rejects(() => call({ method: 'GET', path: '/v1/x', fetchImpl: f }),
    isStripeError('request_failed', (e) => e.httpStatus === 401 && e.retryable === false));
});

test('403 / 404 は non-retryable', async () => {
  for (const status of [403, 404]) {
    const f = mockFetch(new Response('{}', { status }));
    await assert.rejects(() => call({ method: 'GET', path: '/v1/x', fetchImpl: f }),
      isStripeError('request_failed', (e) => e.retryable === false), String(status));
  }
});

test('409 / 429 / 5xx は retryable', async () => {
  for (const status of [409, 429, 500, 502, 503]) {
    const f = mockFetch(new Response('{}', { status }));
    await assert.rejects(() => call({ method: 'GET', path: '/v1/x', fetchImpl: f }),
      isStripeError('request_failed', (e) => e.retryable === true && e.httpStatus === status),
      String(status));
  }
});

test('エラー本文が JSON でなくても落ちない', async () => {
  const f = mockFetch(new Response('gateway timeout', { status: 504 }));
  await assert.rejects(() => call({ method: 'GET', path: '/v1/x', fetchImpl: f }),
    isStripeError('request_failed', (e) =>
      e.retryable === true && e.stripeType === null && e.stripeCode === null &&
      e.message.includes('gateway timeout')));
});

test('Request-Id は成功時もエラー時も拾える', async () => {
  const f = mockFetch(new Response('{}', { status: 500, headers: { 'Request-Id': 'req_abc' } }));
  await assert.rejects(() => call({ method: 'GET', path: '/v1/x', fetchImpl: f }),
    isStripeError('request_failed', (e) => e.requestId === 'req_abc'));

  const f2 = mockFetch(new Response('not json', { status: 200,
    headers: { 'Request-Id': 'req_ok' } }));
  await assert.rejects(() => call({ method: 'GET', path: '/v1/x', fetchImpl: f2 }),
    isStripeError('bad_response', (e) => e.requestId === 'req_ok'));
});

test('Request-Id が無ければ null', async () => {
  const f = mockFetch(new Response('{}', { status: 500 }));
  await assert.rejects(() => call({ method: 'GET', path: '/v1/x', fetchImpl: f }),
    isStripeError('request_failed', (e) => e.requestId === null));
});


// =========================================================
// 6. 通信エラーとタイムアウト
// =========================================================

test('ネットワーク失敗は unavailable（retryable）', async () => {
  const f = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(() => call({ method: 'GET', path: '/v1/x', fetchImpl: f }),
    isStripeError('unavailable', (e) => e.retryable === true));
});

test('タイムアウト（AbortError / TimeoutError）は unavailable（retryable）', async () => {
  for (const name of ['AbortError', 'TimeoutError']) {
    const f = async () => { const e = new Error('aborted'); e.name = name; throw e; };
    await assert.rejects(() => call({ method: 'GET', path: '/v1/x', fetchImpl: f }),
      isStripeError('unavailable', (e) => e.retryable === true), name);
  }
});

test('transport でない例外は request_failed（non-retryable）', async () => {
  const f = async () => { throw new Error('something else'); };
  await assert.rejects(() => call({ method: 'GET', path: '/v1/x', fetchImpl: f }),
    isStripeError('request_failed', (e) => e.retryable === false));
});

test('本文の読み取りに失敗したら bad_response', async () => {
  const f = async () => ({
    ok: true, status: 200,
    headers: { get: () => 'req_x' },
    text: async () => { throw new Error('stream broken'); },
  });
  await assert.rejects(() => call({ method: 'GET', path: '/v1/x', fetchImpl: f }),
    isStripeError('bad_response', (e) => e.requestId === 'req_x'));
});


// =========================================================
// 7. secret が漏れないこと
// =========================================================

test('fetch の例外に secret が混ざっても最終エラーへ残さない', async () => {
  const f = async () => { throw new TypeError('fetch failed for key ' + SECRET); };
  await assert.rejects(() => call({ method: 'GET', path: '/v1/x', fetchImpl: f }),
    (e) => e instanceof StripeApiError &&
           !e.message.includes(SECRET) && e.message.includes('<REDACTED>'));
});

test('transport でない例外でも secret を伏せる', async () => {
  const f = async () => { throw new Error('boom ' + SECRET); };
  await assert.rejects(() => call({ method: 'GET', path: '/v1/x', fetchImpl: f }),
    (e) => !e.message.includes(SECRET) && e.message.includes('<REDACTED>'));
});

test('Stripe のエラー本文に secret が混ざっても伏せる', async () => {
  const f = mockFetch(new Response(JSON.stringify({
    error: { type: 'invalid_request_error', message: 'bad key ' + SECRET },
  }), { status: 400 }));
  await assert.rejects(() => call({ method: 'GET', path: '/v1/x', fetchImpl: f }),
    (e) => !e.message.includes(SECRET) && e.message.includes('<REDACTED>'));
});

test('JSON でないエラー本文でも secret を伏せる', async () => {
  const f = mockFetch(new Response('leaked ' + SECRET, { status: 500 }));
  await assert.rejects(() => call({ method: 'GET', path: '/v1/x', fetchImpl: f }),
    (e) => !e.message.includes(SECRET) && e.message.includes('<REDACTED>'));
});

test('レスポンス全文をエラーへ保持しない（長い本文は切り詰める）', async () => {
  const huge = 'A'.repeat(5000) + 'TAILMARK';
  const f = mockFetch(new Response(huge, { status: 500 }));
  await assert.rejects(() => call({ method: 'GET', path: '/v1/x', fetchImpl: f }),
    (e) => {
      assert.equal(e.message.includes('TAILMARK'), false, '末尾まで保持していない');
      assert.ok(e.message.length < 500, 'メッセージが肥大していない: ' + e.message.length);
      return true;
    });
});

test('エラーオブジェクトに body / headers / request を保持しない', async () => {
  const f = mockFetch(new Response(JSON.stringify({
    error: { type: 'card_error', code: 'card_declined', message: 'declined',
             payment_method: { card: { number: '4242424242424242' } } },
  }), { status: 402 }));

  await assert.rejects(() => call({ method: 'POST', path: '/v1/x',
    params: { card: '4242424242424242' }, fetchImpl: f }), (e) => {
      const keys = Object.keys(e).sort();
      assert.deepEqual(keys,
        ['code', 'httpStatus', 'name', 'requestId', 'retryable', 'stripeCode', 'stripeType'],
        'body / headers / request を持たない');
      const dump = JSON.stringify({ ...e, message: e.message });
      assert.equal(dump.includes('4242424242424242'), false, 'カード番号を保持しない');
      assert.equal(dump.includes('payment_method'), false, 'raw body を保持しない');
      return true;
    });
});

test('Authorization ヘッダをエラーへ載せない', async () => {
  const f = mockFetch(new Response('{}', { status: 500 }));
  await assert.rejects(() => call({ method: 'GET', path: '/v1/x', fetchImpl: f }),
    (e) => {
      const dump = JSON.stringify({ ...e, message: e.message });
      assert.equal(dump.includes('Authorization'), false);
      assert.equal(dump.includes('Bearer'), false);
      assert.equal(dump.includes(SECRET), false);
      return true;
    });
});

test('StripeApiError は診断用の最小フィールドだけ持つ', () => {
  const e = new StripeApiError('request_failed', 'msg',
    { httpStatus: 429, stripeType: 'rate_limit_error', stripeCode: null,
      requestId: 'req_1', retryable: true });
  assert.equal(e.name, 'StripeApiError');
  assert.equal(e.code, 'request_failed');
  assert.equal(e.httpStatus, 429);
  assert.equal(e.stripeType, 'rate_limit_error');
  assert.equal(e.requestId, 'req_1');
  assert.equal(e.retryable, true);
  assert.ok(e instanceof Error);

  // 既定値
  const bare = new StripeApiError('bad_response', 'x');
  assert.equal(bare.httpStatus, null);
  assert.equal(bare.stripeType, null);
  assert.equal(bare.stripeCode, null);
  assert.equal(bare.requestId, null);
  assert.equal(bare.retryable, false);
});

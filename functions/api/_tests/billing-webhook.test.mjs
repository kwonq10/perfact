// =========================================================
// POST /api/billing/webhookの単体テスト
//
//   - **api.stripe.com へは一度も通信しない。** fetch も RPC も mock する。
//   - 本番の secret / Project URL はフィクスチャに一切保存しない。
//   - 署名は実物の verifyStripeWebhookSignature を通す（迂回しない）。
// =========================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HANDLED_EVENT_TYPES,
  buildSnapshot,
  extractCurrentPeriodEnd,
  extractPriceId,
  extractSubscriptionId,
  handleWebhook,
  readStripeId,
  unixToIso,
} from '../billing/webhook.js';
import { computeStripeSignature } from '../_lib/stripe-webhook.js';
import { SupabaseError } from '../_lib/supabase.js';

// --- テスト用のダミー設定（本番値ではない） ---
const WEBHOOK_SECRET = 'whsec_dummy_for_tests_only';
const PRICE_ID = 'price_dummy_web_pro_jpy_launch';
const ENV = {
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  STRIPE_SECRET_KEY: 'sk_test_dummy_for_tests_only',
  SUPABASE_URL: 'https://example-project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_dummy_for_tests_only',
  STRIPE_PRICE_WEB_PRO_JPY_LAUNCH: PRICE_ID,
  STRIPE_PRICE_WEB_PRO_JPY_STANDARD: 'price_dummy_jpy_standard',
  STRIPE_PRICE_WEB_PRO_USD_LAUNCH: 'price_dummy_usd_launch',
  STRIPE_PRICE_WEB_PRO_USD_STANDARD: 'price_dummy_usd_standard',
};

const USER_ID = '11111111-2222-3333-4444-555555555555';
const SUB_ID = 'sub_dummy_1';
const CUS_ID = 'cus_dummy_1';
const NOW_SEC = 1788000000;
const NOW_MS = NOW_SEC * 1000;
const PERIOD_END_SEC = 1790000000;

const quiet = { error() {}, warn() {}, log() {} };

/** Stripe から取り直した subscription の既定形。 */
function subscription(over = {}) {
  return {
    id: SUB_ID,
    object: 'subscription',
    customer: CUS_ID,
    status: 'active',
    cancel_at_period_end: false,
    current_period_end: PERIOD_END_SEC,
    metadata: { user_id: USER_ID },
    items: { data: [{ id: 'si_1', price: { id: PRICE_ID } }] },
    ...over,
  };
}

/**
 * Stripe から取り直した Customer の既定形。
 * **請求先国は JP**（販売国判定を通す既定）。
 */
function customer(over = {}) {
  return {
    id: CUS_ID,
    object: 'customer',
    address: { country: 'JP', postal_code: '100-0001' },
    ...over,
  };
}

/** webhook event の既定形。 */
function stripeEvent(type = 'customer.subscription.updated', obj = { id: SUB_ID }, over = {}) {
  return {
    id: 'evt_dummy_1',
    object: 'event',
    type,
    created: NOW_SEC,
    data: { object: obj },
    ...over,
  };
}

/** 署名付き Request を作る。 */
async function signedRequest(event, o = {}) {
  const body = o.rawBody ?? JSON.stringify(event);
  const t = o.t ?? NOW_SEC;
  const secret = o.secret ?? WEBHOOK_SECRET;
  const v1 = await computeStripeSignature(secret, t, body);
  const headers = { 'Stripe-Signature': o.header ?? `t=${t},v1=${v1}` };
  return new Request('https://example.com/api/billing/webhook', {
    method: o.method ?? 'POST', headers, body,
  });
}

/** Stripe GET の mock。 */
/**
 * Stripe fetch の mock。
 *
 * webhook は **subscription に加えて Customer も取り直す**
 * （販売国の判定を entitlement の前に行うため）。
 * responder を渡さない場合は URL で振り分け、既定で JP の Customer を返す。
 */
function stripeFetch(responder, over = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    if (typeof responder === 'function') return responder(url, init);
    if (String(url).includes('/v1/customers/')) {
      return new Response(JSON.stringify(over.customer ?? customer()), { status: 200 });
    }
    return new Response(JSON.stringify(responder ?? subscription()), { status: 200 });
  };
  fn.calls = calls;
  return fn;
}

/** subscription 取得だけを数える（Customer 取得と区別する）。 */
function subscriptionCalls(fetchImpl) {
  return fetchImpl.calls.filter((c) => String(c.url).includes('/v1/subscriptions/'));
}

/** Supabase RPC の mock。 */
function rpcMock(rowsOrFn) {
  const calls = [];
  const fn = async (name, args) => {
    calls.push({ name, args });
    if (typeof rowsOrFn === 'function') return rowsOrFn(name, args);
    return rowsOrFn ?? [{ processed: true, already_processed: false, stale: false }];
  };
  fn.calls = calls;
  return fn;
}

/** 既定 env / 既定 mock で 1 回叩く。 */
async function post(event, o = {}) {
  const request = await signedRequest(event, o);
  const fetchImpl = o.fetchImpl
    ?? stripeFetch(o.subscription ?? subscription(), { customer: o.customer });
  const rpc = o.rpc ?? rpcMock(o.rows);
  const res = await handleWebhook(request, o.env ?? ENV,
    { rpc, fetchImpl, logger: quiet, now: NOW_MS });
  return { res, body: await res.json(), fetchImpl, rpc };
}


// =========================================================
// 1. メソッド / 設定 / 署名
// =========================================================

test('POST 以外は 405', async () => {
  for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
    const req = new Request('https://example.com/api/billing/webhook', { method });
    const res = await handleWebhook(req, ENV, { logger: quiet });
    assert.equal(res.status, 405, method);
    assert.deepEqual(await res.json(), { error: 'method_not_allowed' });
  }
});

test('レスポンスに no-store が付く', async () => {
  const { res } = await post(stripeEvent());
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
});

test('STRIPE_WEBHOOK_SECRET 未設定は 500 server_misconfigured', async () => {
  for (const secret of [undefined, '', null]) {
    const env = { ...ENV, STRIPE_WEBHOOK_SECRET: secret };
    const req = await signedRequest(stripeEvent());
    const fetchImpl = stripeFetch();
    const res = await handleWebhook(req, env, { rpc: rpcMock(), fetchImpl, logger: quiet });
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'server_misconfigured' });
    assert.equal(fetchImpl.calls.length, 0, 'Stripe を叩かない');
  }
});

test('署名が無い / 不正なら 400 invalid_signature（DB も Stripe も触らない）', async () => {
  const cases = [
    { header: '' },
    { header: 't=' + NOW_SEC },
    { header: 'v1=' + '0'.repeat(64) },
    { header: `t=${NOW_SEC},v1=${'0'.repeat(64)}` },
    { header: 'garbage' },
    { secret: 'whsec_other_dummy' },
    { t: NOW_SEC - 100000 },
    { t: NOW_SEC + 100000 },
  ];
  for (const o of cases) {
    const fetchImpl = stripeFetch();
    const rpc = rpcMock();
    const { res, body } = await post(stripeEvent(), { ...o, fetchImpl, rpc });
    assert.equal(res.status, 400, JSON.stringify(o));
    assert.deepEqual(body, { error: 'invalid_signature' });
    assert.equal(fetchImpl.calls.length, 0, 'Stripe を叩かない');
    assert.equal(rpc.calls.length, 0, 'DB を触らない');
  }
});

test('Stripe-Signature ヘッダが完全に無い場合も 400', async () => {
  const req = new Request('https://example.com/api/billing/webhook',
    { method: 'POST', body: JSON.stringify(stripeEvent()) });
  const res = await handleWebhook(req, ENV, { rpc: rpcMock(), logger: quiet, now: NOW_MS });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'invalid_signature' });
});

test('生ボディが 1 文字でも変われば署名が通らない', async () => {
  const event = stripeEvent();
  const body = JSON.stringify(event);
  const v1 = await computeStripeSignature(WEBHOOK_SECRET, NOW_SEC, body);
  const req = new Request('https://example.com/api/billing/webhook', {
    method: 'POST',
    headers: { 'Stripe-Signature': `t=${NOW_SEC},v1=${v1}` },
    body: body + ' ',
  });
  const res = await handleWebhook(req, ENV, { rpc: rpcMock(), logger: quiet, now: NOW_MS });
  assert.equal(res.status, 400);
});

test('複数 v1 のうち 1 つが正しければ受理される', async () => {
  const event = stripeEvent();
  const body = JSON.stringify(event);
  const good = await computeStripeSignature(WEBHOOK_SECRET, NOW_SEC, body);
  const { res } = await post(event, { header: `t=${NOW_SEC},v1=${'0'.repeat(64)},v1=${good}` });
  assert.equal(res.status, 200);
});

test('Cookie session も Origin も要求しない', async () => {
  const event = stripeEvent();
  const body = JSON.stringify(event);
  const v1 = await computeStripeSignature(WEBHOOK_SECRET, NOW_SEC, body);
  // Cookie 無し・Origin 無しでも通る
  const req = new Request('https://example.com/api/billing/webhook', {
    method: 'POST', headers: { 'Stripe-Signature': `t=${NOW_SEC},v1=${v1}` }, body,
  });
  const res = await handleWebhook(req, ENV,
    { rpc: rpcMock(), fetchImpl: stripeFetch(), logger: quiet, now: NOW_MS });
  assert.equal(res.status, 200);

  // 敵対的な Origin が付いていても署名が正しければ通る（Origin を見ていない）
  const req2 = new Request('https://example.com/api/billing/webhook', {
    method: 'POST',
    headers: { 'Stripe-Signature': `t=${NOW_SEC},v1=${v1}`, Origin: 'https://evil.example' },
    body,
  });
  const res2 = await handleWebhook(req2, ENV,
    { rpc: rpcMock(), fetchImpl: stripeFetch(), logger: quiet, now: NOW_MS });
  assert.equal(res2.status, 200);
});

test('webhook.js は origin.js / session / request-body を使わない', async () => {
  const src = await (await import('node:fs/promises')).readFile(
    new URL('../billing/webhook.js', import.meta.url), 'utf8');
  const NL = String.fromCharCode(10);
  const rows = src.split(NL);
  // コメントでは言及してよい。実際の import 文だけを見る。
  const imports = rows.filter((l) => l.startsWith('import ')).join(NL);
  assert.equal(imports.includes('origin.js'), false, 'checkOrigin を import しない');
  assert.equal(imports.includes('request-body.js'), false, 'raw body を自前で読む');
  assert.equal(imports.includes('session.js'), false, 'session を要求しない');
  // 実コード（コメント行を除く）に呼び出しが無い
  const code = rows.filter((l) => !l.trimStart().startsWith('//')).join(NL);
  assert.equal(code.includes('checkOrigin'), false);
  assert.equal(code.includes('requireSession'), false);
});


// =========================================================
// 2. event の形と対象判定
// =========================================================

test('署名は通るが JSON でなければ 400 invalid_payload', async () => {
  const { res, body } = await post(null, { rawBody: 'not json at all' });
  assert.equal(res.status, 400);
  assert.deepEqual(body, { error: 'invalid_payload' });
});

test('event の必須項目が欠けたら 400 invalid_event', async () => {
  const cases = [
    stripeEvent('customer.subscription.updated', { id: SUB_ID }, { id: undefined }),
    stripeEvent('customer.subscription.updated', { id: SUB_ID }, { type: undefined }),
    stripeEvent('customer.subscription.updated', { id: SUB_ID }, { created: undefined }),
    stripeEvent('customer.subscription.updated', { id: SUB_ID }, { created: 'x' }),
    stripeEvent('customer.subscription.updated', { id: SUB_ID }, { id: '' }),
  ];
  for (const ev of cases) {
    const { res, body } = await post(ev);
    assert.equal(res.status, 400, JSON.stringify(ev));
    assert.deepEqual(body, { error: 'invalid_event' });
  }
});

test('event が配列 / スカラーなら 400 invalid_event', async () => {
  for (const raw of ['[]', '"x"', '12', 'null', 'true']) {
    const { res, body } = await post(null, { rawBody: raw });
    assert.equal(res.status, 400, raw);
    assert.deepEqual(body, { error: 'invalid_event' });
  }
});

test('対象外 event は 200 ignored（DB も Stripe も触らない）', async () => {
  for (const type of ['payment_intent.succeeded', 'customer.created',
                      'charge.refunded', 'price.updated', 'ping']) {
    const fetchImpl = stripeFetch();
    const rpc = rpcMock();
    const { res, body } = await post(stripeEvent(type, {}), { fetchImpl, rpc });
    assert.equal(res.status, 200, type);
    assert.deepEqual(body, { received: true, ignored: true });
    assert.equal(fetchImpl.calls.length, 0, type);
    assert.equal(rpc.calls.length, 0, type);
  }
});

test('対象 event は 6 種類', () => {
  assert.deepEqual([...HANDLED_EVENT_TYPES], [
    'checkout.session.completed',
    'customer.subscription.created',
    'customer.subscription.updated',
    'customer.subscription.deleted',
    'invoice.payment_failed',
    'invoice.payment_succeeded',
  ]);
});

test('subscription を含まない対象 event は 200 ignored', async () => {
  const cases = [
    // 買い切りの checkout
    stripeEvent('checkout.session.completed', { id: 'cs_1', mode: 'payment', subscription: null }),
    // subscription に紐づかない invoice
    stripeEvent('invoice.payment_succeeded', { id: 'in_1', subscription: null, lines: { data: [] } }),
  ];
  for (const ev of cases) {
    const fetchImpl = stripeFetch();
    const rpc = rpcMock();
    const { res, body } = await post(ev, { fetchImpl, rpc });
    assert.equal(res.status, 200, ev.type);
    assert.deepEqual(body, { received: true, ignored: true });
    assert.equal(fetchImpl.calls.length, 0);
    assert.equal(rpc.calls.length, 0);
  }
});


// =========================================================
// 3. subscription ID の抽出（API version 差異に強いこと）
// =========================================================

test('readStripeId は文字列でも展開済みオブジェクトでも拾う', () => {
  assert.equal(readStripeId('sub_1'), 'sub_1');
  assert.equal(readStripeId({ id: 'sub_1', object: 'subscription' }), 'sub_1');
  assert.equal(readStripeId('  sub_1  '), 'sub_1');
  for (const bad of [null, undefined, '', '   ', 12, {}, { id: '' }, { id: 5 }, []]) {
    assert.equal(readStripeId(bad), null, JSON.stringify(bad));
  }
});

test('customer.subscription.* は data.object.id', () => {
  for (const t of ['customer.subscription.created', 'customer.subscription.updated',
                   'customer.subscription.deleted']) {
    assert.equal(extractSubscriptionId(t, { id: SUB_ID }), SUB_ID, t);
  }
});

test('checkout.session.completed は data.object.subscription', () => {
  assert.equal(
    extractSubscriptionId('checkout.session.completed', { id: 'cs_1', subscription: SUB_ID }),
    SUB_ID);
  // 展開されている場合
  assert.equal(
    extractSubscriptionId('checkout.session.completed', { id: 'cs_1', subscription: { id: SUB_ID } }),
    SUB_ID);
});

test('invoice は subscription / parent / lines のどれからでも拾える', () => {
  // 旧来の位置
  assert.equal(extractSubscriptionId('invoice.payment_failed',
    { id: 'in_1', subscription: SUB_ID }), SUB_ID);
  // 新しい API version の位置
  assert.equal(extractSubscriptionId('invoice.payment_failed',
    { id: 'in_1', parent: { subscription_details: { subscription: SUB_ID } } }), SUB_ID);
  // 明細行にしか無い場合
  assert.equal(extractSubscriptionId('invoice.payment_succeeded',
    { id: 'in_1', lines: { data: [{ subscription: SUB_ID }] } }), SUB_ID);
  assert.equal(extractSubscriptionId('invoice.payment_succeeded',
    { id: 'in_1', lines: { data: [{ parent: { subscription_item_details: { subscription: SUB_ID } } }] } }),
    SUB_ID);
});

test('subscription が見つからなければ null', () => {
  assert.equal(extractSubscriptionId('invoice.payment_failed', { id: 'in_1' }), null);
  assert.equal(extractSubscriptionId('checkout.session.completed', { id: 'cs_1' }), null);
  assert.equal(extractSubscriptionId('customer.subscription.updated', {}), null);
  assert.equal(extractSubscriptionId('invoice.payment_failed', null), null);
  assert.equal(extractSubscriptionId('invoice.payment_failed', undefined), null);
});


// =========================================================
// 4. subscription 再取得と snapshot 化
// =========================================================

test('Stripe から subscription を GET し直す（payload を信用しない）', async () => {
  // payload には canceled と書いてあるが、再取得した snapshot は active
  const ev = stripeEvent('customer.subscription.updated',
    { id: SUB_ID, status: 'canceled', cancel_at_period_end: true });
  const { res, fetchImpl, rpc } = await post(ev,
    { subscription: subscription({ status: 'active', cancel_at_period_end: false }) });

  assert.equal(res.status, 200);
  assert.equal(subscriptionCalls(fetchImpl).length, 1, 'subscription は 1 回だけ取り直す');
  assert.equal(subscriptionCalls(fetchImpl)[0].url,
    `https://api.stripe.com/v1/subscriptions/${SUB_ID}`);
  assert.equal(subscriptionCalls(fetchImpl)[0].init.method, 'GET');
  // 再取得側の値が DB へ渡る
  assert.equal(rpc.calls[0].args.p_status, 'active');
  assert.equal(rpc.calls[0].args.p_cancel_at_period_end, false);
});

test('Authorization は stripe.js が組み立てる（webhook が直接作らない）', async () => {
  const { fetchImpl } = await post(stripeEvent());
  assert.equal(fetchImpl.calls[0].init.headers.Authorization,
    'Bearer ' + ENV.STRIPE_SECRET_KEY);
  assert.equal(fetchImpl.calls[0].init.headers.Accept, 'application/json');
});

test('Stripe が一時障害（429 / 5xx / 通信断）なら 502 で再送させる', async () => {
  for (const make of [
    () => stripeFetch(() => new Response('{}', { status: 429 })),
    () => stripeFetch(() => new Response('{}', { status: 500 })),
    () => stripeFetch(() => new Response('{}', { status: 503 })),
    () => stripeFetch(() => { throw new TypeError('fetch failed'); }),
  ]) {
    const rpc = rpcMock();
    const { res, body } = await post(stripeEvent(), { fetchImpl: make(), rpc });
    assert.equal(res.status, 502);
    assert.deepEqual(body, { error: 'stripe_unavailable' });
    assert.equal(rpc.calls.length, 0, 'DB を触らない');
  }
});

test('Stripe の 4xx は 500（再送では直らないが取りこぼしを隠さない）', async () => {
  for (const status of [400, 401, 403, 404]) {
    const fetchImpl = stripeFetch(() => new Response(
      JSON.stringify({ error: { type: 'invalid_request_error', message: 'no such subscription' } }),
      { status }));
    const rpc = rpcMock();
    const { res, body } = await post(stripeEvent(), { fetchImpl, rpc });
    assert.equal(res.status, 500, String(status));
    assert.deepEqual(body, { error: 'internal_error' });
    assert.equal(rpc.calls.length, 0);
  }
});

test('STRIPE_SECRET_KEY 未設定は 500 server_misconfigured', async () => {
  const env = { ...ENV, STRIPE_SECRET_KEY: '' };
  const { res, body } = await post(stripeEvent(), { env });
  assert.equal(res.status, 500);
  assert.deepEqual(body, { error: 'server_misconfigured' });
});

test('壊れた subscription snapshot は 500（fail closed）', async () => {
  const cases = [
    subscription({ id: undefined }),
    subscription({ customer: null }),
    subscription({ status: 'paused' }),
    subscription({ status: undefined }),
    subscription({ items: { data: [] } }),
    subscription({ items: undefined }),
    subscription({ items: { data: [{ price: { id: PRICE_ID } }, { price: { id: PRICE_ID } }] } }),
    subscription({ items: { data: [{ price: null }] } }),
    subscription({ cancel_at_period_end: undefined }),
    subscription({ cancel_at_period_end: 'false' }),
  ];
  for (const sub of cases) {
    const rpc = rpcMock();
    const { res, body } = await post(stripeEvent(), { subscription: sub, rpc });
    assert.equal(res.status, 500, JSON.stringify(sub).slice(0, 80));
    assert.deepEqual(body, { error: 'internal_error' });
    assert.equal(rpc.calls.length, 0, 'DB を触らない');
  }
});

test('未知の price は 500（fail closed。再送対象）', async () => {
  const sub = subscription({ items: { data: [{ price: { id: 'price_unknown_xyz' } }] } });
  const rpc = rpcMock();
  const { res, body } = await post(stripeEvent(), { subscription: sub, rpc });
  assert.equal(res.status, 500);
  assert.deepEqual(body, { error: 'internal_error' });
  assert.equal(rpc.calls.length, 0);
});

test('metadata.user_id の欠落 / 不正 UUID は 500', async () => {
  for (const metadata of [undefined, {}, { user_id: '' }, { user_id: 'not-a-uuid' },
                          { user_id: 123 }, { user_id: USER_ID + 'x' }]) {
    const rpc = rpcMock();
    const { res, body } = await post(stripeEvent(),
      { subscription: subscription({ metadata }), rpc });
    assert.equal(res.status, 500, JSON.stringify(metadata));
    assert.deepEqual(body, { error: 'internal_error' });
    assert.equal(rpc.calls.length, 0);
  }
});

test('customer が展開済みオブジェクトでも文字列でも扱える', async () => {
  for (const customer of [CUS_ID, { id: CUS_ID, object: 'customer', email: 'x@example.com' }]) {
    const { res, rpc } = await post(stripeEvent(),
      { subscription: subscription({ customer }) });
    assert.equal(res.status, 200);
    assert.equal(rpc.calls[0].args.p_stripe_customer_id, CUS_ID);
  }
});

test('price が展開済みでも ID 文字列でも扱える', async () => {
  for (const price of [PRICE_ID, { id: PRICE_ID, object: 'price' }]) {
    const { res, rpc } = await post(stripeEvent(),
      { subscription: subscription({ items: { data: [{ price }] } }) });
    assert.equal(res.status, 200);
    assert.equal(rpc.calls[0].args.p_stripe_price_id, PRICE_ID);
  }
});


// =========================================================
// 5. RPC への写像
// =========================================================

test('RPC へ 13 引数を正しく渡す', async () => {
  const { res, rpc } = await post(stripeEvent('customer.subscription.updated', { id: SUB_ID }));
  assert.equal(res.status, 200);
  assert.equal(rpc.calls.length, 1, 'RPC は 1 回だけ');
  assert.equal(rpc.calls[0].name, 'apply_stripe_subscription_event');

  const a = rpc.calls[0].args;
  assert.deepEqual(Object.keys(a).sort(), [
    'p_cancel_at_period_end', 'p_currency', 'p_current_period_end', 'p_event_created_at',
    'p_event_type', 'p_plan_id', 'p_price_phase', 'p_status', 'p_stripe_customer_id',
    'p_stripe_event_id', 'p_stripe_price_id', 'p_stripe_subscription_id', 'p_user_id',
  ]);
  assert.equal(Object.keys(a).length, 13);

  assert.equal(a.p_stripe_event_id, 'evt_dummy_1');
  assert.equal(a.p_event_type, 'customer.subscription.updated');
  assert.equal(a.p_event_created_at, new Date(NOW_SEC * 1000).toISOString());
  assert.equal(a.p_user_id, USER_ID);
  assert.equal(a.p_plan_id, 'web_pro');
  assert.equal(a.p_status, 'active');
  assert.equal(a.p_stripe_customer_id, CUS_ID);
  assert.equal(a.p_stripe_subscription_id, SUB_ID);
  assert.equal(a.p_stripe_price_id, PRICE_ID);
  assert.equal(a.p_currency, 'jpy');
  assert.equal(a.p_price_phase, 'launch');
  assert.equal(a.p_current_period_end, new Date(PERIOD_END_SEC * 1000).toISOString());
  assert.equal(a.p_cancel_at_period_end, false);
});

test('price ごとに plan / currency / phase が引かれる', async () => {
  const table = [
    [ENV.STRIPE_PRICE_WEB_PRO_JPY_LAUNCH, 'web_pro', 'jpy', 'launch'],
    [ENV.STRIPE_PRICE_WEB_PRO_JPY_STANDARD, 'web_pro', 'jpy', 'standard'],
    [ENV.STRIPE_PRICE_WEB_PRO_USD_LAUNCH, 'web_pro', 'usd', 'launch'],
    [ENV.STRIPE_PRICE_WEB_PRO_USD_STANDARD, 'web_pro', 'usd', 'standard'],
  ];
  for (const [priceId, plan, currency, phase] of table) {
    const sub = subscription({ items: { data: [{ price: { id: priceId } }] } });
    const { rpc } = await post(stripeEvent(), { subscription: sub });
    assert.equal(rpc.calls[0].args.p_plan_id, plan, priceId);
    assert.equal(rpc.calls[0].args.p_currency, currency, priceId);
    assert.equal(rpc.calls[0].args.p_price_phase, phase, priceId);
  }
});

test('plan の正は price mapping。metadata.plan_id は見ない', async () => {
  const sub = subscription({ metadata: { user_id: USER_ID, plan_id: 'all_pro' } });
  const { rpc } = await post(stripeEvent(), { subscription: sub });
  assert.equal(rpc.calls[0].args.p_plan_id, 'web_pro', 'price mapping が勝つ');
});

test('status は Stripe の 7 種をそのまま渡す', async () => {
  for (const status of ['active', 'trialing', 'past_due', 'canceled',
                        'unpaid', 'incomplete', 'incomplete_expired']) {
    const { res, rpc } = await post(stripeEvent(), { subscription: subscription({ status }) });
    assert.equal(res.status, 200, status);
    assert.equal(rpc.calls[0].args.p_status, status);
  }
});

test('current_period_end は Unix 秒から ISO へ変換される', () => {
  assert.equal(unixToIso(PERIOD_END_SEC), new Date(PERIOD_END_SEC * 1000).toISOString());
  assert.equal(unixToIso(0), '1970-01-01T00:00:00.000Z');
  for (const bad of [null, undefined, 'x', NaN, Infinity, {}]) {
    assert.equal(unixToIso(bad), null, String(bad));
  }
});

test('current_period_end は items 側にあっても拾う', () => {
  assert.equal(extractCurrentPeriodEnd(subscription()),
    new Date(PERIOD_END_SEC * 1000).toISOString());
  const alt = subscription({
    current_period_end: undefined,
    items: { data: [{ price: { id: PRICE_ID }, current_period_end: PERIOD_END_SEC }] },
  });
  assert.equal(extractCurrentPeriodEnd(alt), new Date(PERIOD_END_SEC * 1000).toISOString());
  assert.equal(extractCurrentPeriodEnd(subscription({
    current_period_end: undefined, items: { data: [{ price: { id: PRICE_ID } }] } })), null);
});

test('current_period_end が取れなくても null で通す（RPC 側で NULL 可）', async () => {
  const sub = subscription({ current_period_end: undefined });
  const { res, rpc } = await post(stripeEvent(), { subscription: sub });
  assert.equal(res.status, 200);
  assert.equal(rpc.calls[0].args.p_current_period_end, null);
});

test('cancel_at_period_end は boolean のまま渡る', async () => {
  for (const v of [true, false]) {
    const { rpc } = await post(stripeEvent(),
      { subscription: subscription({ cancel_at_period_end: v }) });
    assert.equal(rpc.calls[0].args.p_cancel_at_period_end, v);
    assert.equal(typeof rpc.calls[0].args.p_cancel_at_period_end, 'boolean');
  }
});

test('extractPriceId / buildSnapshot の失敗コード', () => {
  assert.deepEqual(extractPriceId({ items: { data: [] } }), { ok: false, code: 'missing_items' });
  assert.deepEqual(extractPriceId({}), { ok: false, code: 'missing_items' });
  assert.deepEqual(extractPriceId({ items: { data: [{ price: 'p1' }, { price: 'p2' }] } }),
    { ok: false, code: 'multiple_items' });
  assert.deepEqual(extractPriceId({ items: { data: [{}] } }), { ok: false, code: 'missing_price' });
  assert.deepEqual(extractPriceId({ items: { data: [{ price: 'p1' }] } }),
    { ok: true, priceId: 'p1' });

  assert.equal(buildSnapshot(null, ENV).code, 'invalid_subscription');
  assert.equal(buildSnapshot(subscription({ customer: null }), ENV).code, 'missing_customer');
  assert.equal(buildSnapshot(subscription({ status: 'paused' }), ENV).code, 'unsupported_status');
  assert.equal(buildSnapshot(subscription({ metadata: {} }), ENV).code, 'invalid_metadata_user_id');
  assert.equal(buildSnapshot(subscription({ cancel_at_period_end: null }), ENV).code,
    'invalid_cancel_at_period_end');
  assert.equal(buildSnapshot(subscription(), ENV).ok, true);
});

test('割引で請求額が下がっても plan / phase は price_id どおり', () => {
  // Stripe の Promotion Code を使うと amount_total / amount_paid が下がるが、
  // **price_id は変わらない**。webhook は金額を一切見ない。
  const discounted = subscription({
    // Stripe が subscription へ返す割引情報（ダミー形状）
    discounts: ['di_dummy_for_tests_only'],
    latest_invoice: { amount_total: 0, amount_paid: 0, amount_due: 0 },
    items: { data: [{ id: 'si_1', price: { id: PRICE_ID }, amount_total: 0 }] },
  });
  const plain = buildSnapshot(subscription(), ENV);
  const withCoupon = buildSnapshot(discounted, ENV);

  assert.equal(withCoupon.ok, true);
  assert.equal(withCoupon.snapshot.priceId, PRICE_ID);
  assert.equal(withCoupon.snapshot.phase, plain.snapshot.phase);
  assert.equal(withCoupon.snapshot.planId, plain.snapshot.planId);
  assert.equal(withCoupon.snapshot.currency, plain.snapshot.currency);
  // 割引の有無で snapshot 全体が変わらない
  assert.deepEqual(withCoupon.snapshot, plain.snapshot);
});

test('standard price でも割引の有無で phase 判定は変わらない', () => {
  const std = { items: { data: [{ id: 'si_1', price: { id: ENV.STRIPE_PRICE_WEB_PRO_JPY_STANDARD } }] } };
  const plain = buildSnapshot(subscription(std), ENV);
  const withCoupon = buildSnapshot(
    subscription({ ...std, discounts: ['di_dummy_for_tests_only'] }),
    ENV,
  );
  assert.equal(plain.snapshot.phase, 'standard');
  assert.deepEqual(withCoupon.snapshot, plain.snapshot);
});


// =========================================================
// 6. RPC の結果と HTTP 応答
// =========================================================

test('processed / already_processed / stale はいずれも 200', async () => {
  const table = [
    [{ processed: true, already_processed: false, stale: false },
     { received: true, processed: true, already_processed: false, stale: false }],
    [{ processed: false, already_processed: true, stale: false },
     { received: true, processed: false, already_processed: true, stale: false }],
    [{ processed: false, already_processed: false, stale: true },
     { received: true, processed: false, already_processed: false, stale: true }],
  ];
  for (const [row, expected] of table) {
    const { res, body } = await post(stripeEvent(), { rows: [row] });
    assert.equal(res.status, 200, JSON.stringify(row));
    assert.deepEqual(body, expected);
  }
});

test('RPC の戻りが空 / 想定外なら 500', async () => {
  // rpcMock の既定値に倒れないよう、関数形式で明示的に返す
  for (const rows of [[], null, undefined, 'x', [null], [12], {}]) {
    const rpc = rpcMock(() => rows);
    const { res, body } = await post(stripeEvent(), { rpc });
    assert.equal(res.status, 500, JSON.stringify(rows) ?? String(rows));
    assert.deepEqual(body, { error: 'internal_error' });
  }
});

test('Supabase が使えなければ 502 database_unavailable', async () => {
  const rpc = rpcMock(() => { throw new SupabaseError('unavailable', 'down'); });
  const { res, body } = await post(stripeEvent(), { rpc });
  assert.equal(res.status, 502);
  assert.deepEqual(body, { error: 'database_unavailable' });
});

test('Supabase 設定漏れは 500 server_misconfigured', async () => {
  const rpc = rpcMock(() => { throw new SupabaseError('not_configured', 'missing'); });
  const { res, body } = await post(stripeEvent(), { rpc });
  assert.equal(res.status, 500);
  assert.deepEqual(body, { error: 'server_misconfigured' });
});

test('RPC が失敗（rollback 済み）なら 500 internal_error', async () => {
  const rpc = rpcMock(() => { throw new SupabaseError('request_failed', 'subscriptions 行が存在しません。'); });
  const { res, body } = await post(stripeEvent(), { rpc });
  assert.equal(res.status, 500);
  assert.deepEqual(body, { error: 'internal_error' });
});

test('想定外の例外でも 500 に丸める', async () => {
  const rpc = rpcMock(() => { throw new Error('boom'); });
  const { res, body } = await post(stripeEvent(), { rpc });
  assert.equal(res.status, 500);
  assert.deepEqual(body, { error: 'internal_error' });
});

test('同じ event を 2 回受けても DB 副作用は RPC に委ねる（HTTP 層で重複管理しない）', async () => {
  const rows = [{ processed: false, already_processed: true, stale: false }];
  const rpc = rpcMock(rows);
  const fetchImpl = stripeFetch();
  await post(stripeEvent(), { rpc, fetchImpl });
  const { res, body } = await post(stripeEvent(), { rpc, fetchImpl });

  assert.equal(res.status, 200);
  assert.equal(body.already_processed, true);
  assert.equal(rpc.calls.length, 2, 'RPC は毎回呼ぶ（冪等性は DB 側の責務）');
  assert.deepEqual(rpc.calls[0].args, rpc.calls[1].args, '同じ引数を渡す');
});


// =========================================================
// 7. 対象 event それぞれが通ること
// =========================================================

test('対象 6 event すべてが snapshot を適用できる', async () => {
  const cases = [
    ['checkout.session.completed', { id: 'cs_1', mode: 'subscription', subscription: SUB_ID }],
    ['customer.subscription.created', { id: SUB_ID, status: 'incomplete' }],
    ['customer.subscription.updated', { id: SUB_ID }],
    ['customer.subscription.deleted', { id: SUB_ID, status: 'canceled' }],
    ['invoice.payment_failed', { id: 'in_1', subscription: SUB_ID }],
    ['invoice.payment_succeeded', { id: 'in_1', subscription: SUB_ID }],
  ];
  for (const [type, obj] of cases) {
    const { res, body, rpc, fetchImpl } = await post(stripeEvent(type, obj));
    assert.equal(res.status, 200, type);
    assert.equal(body.received, true, type);
    assert.equal(subscriptionCalls(fetchImpl).length, 1, type);
    assert.equal(rpc.calls.length, 1, type);
    assert.equal(rpc.calls[0].args.p_event_type, type);
    assert.equal(rpc.calls[0].args.p_stripe_subscription_id, SUB_ID);
  }
});

test('subscription.deleted でも取り直した status を渡す', async () => {
  const { rpc } = await post(
    stripeEvent('customer.subscription.deleted', { id: SUB_ID, status: 'active' }),
    { subscription: subscription({ status: 'canceled' }) });
  assert.equal(rpc.calls[0].args.p_status, 'canceled');
});


// =========================================================
// 8. 情報漏洩と副作用
// =========================================================

test('レスポンスに secret / 生ボディ / 内部 ID を出さない', async () => {
  const { body } = await post(stripeEvent());
  const dump = JSON.stringify(body);
  for (const f of [WEBHOOK_SECRET, ENV.STRIPE_SECRET_KEY, ENV.SUPABASE_SERVICE_ROLE_KEY,
                   ENV.SUPABASE_URL, USER_ID, CUS_ID, SUB_ID, PRICE_ID, 'whsec_', 'sk_test']) {
    assert.equal(dump.includes(f), false, f);
  }
});

test('エラー応答にも内部詳細を出さない', async () => {
  const rpc = rpcMock(() => {
    throw new SupabaseError('request_failed',
      'subscriptions 行が存在しません。 ' + ENV.SUPABASE_SERVICE_ROLE_KEY);
  });
  const { body } = await post(stripeEvent(), { rpc });
  const dump = JSON.stringify(body);
  assert.deepEqual(body, { error: 'internal_error' });
  assert.equal(dump.includes(ENV.SUPABASE_SERVICE_ROLE_KEY), false);
  assert.equal(dump.includes('subscriptions'), false);
});

test('ログに secret / 生ボディ / user_id を出さない', async () => {
  const lines = [];
  const logger = { error: (...a) => lines.push(a.map(String).join(' ')),
                   warn() {}, log() {} };
  const req = await signedRequest(stripeEvent(), { header: 't=1,v1=' + '0'.repeat(64) });
  await handleWebhook(req, ENV, { rpc: rpcMock(), fetchImpl: stripeFetch(), logger, now: NOW_MS });

  const all = lines.join(' ');
  for (const f of [WEBHOOK_SECRET, ENV.STRIPE_SECRET_KEY, ENV.SUPABASE_SERVICE_ROLE_KEY,
                   USER_ID, 'whsec_', 'sk_test']) {
    assert.equal(all.includes(f), false, f);
  }
});

test('署名前に JSON.parse しない（壊れた JSON でも署名検証が先に走る）', async () => {
  // 署名は正しいが本文が JSON でない -> invalid_payload（invalid_signature ではない）
  const bad = await post(null, { rawBody: '{oops' });
  assert.equal(bad.res.status, 400);
  assert.deepEqual(bad.body, { error: 'invalid_payload' });

  // 署名が誤っていれば JSON の良し悪しに関わらず invalid_signature
  const worse = await post(null, { rawBody: '{oops', header: 't=' + NOW_SEC + ',v1=' + '0'.repeat(64) });
  assert.deepEqual(worse.body, { error: 'invalid_signature' });
});


// =========================================================
// 10. 販売国の検証
//
//   **DB を書く前に必ず国を判定する。**
//   非 JP へは一瞬も entitlement を与えない（= RPC を呼ばない）。
//   国が分からないときは非 JP と同一視せず、金銭操作もしない。
// =========================================================

/** Stripe 呼び出しを path 別に記録する mock。 */
function countryFetch(o = {}) {
  const calls = [];
  const fn = async (url, init) => {
    const method = init?.method ?? 'GET';
    calls.push({ url: String(url), method });
    const u = String(url);
    if (u.includes('/v1/customers/')) {
      if (o.customerFails) return new Response('{"error":{"message":"boom"}}', { status: 500 });
      return new Response(JSON.stringify(o.customer ?? customer()), { status: 200 });
    }
    if (u.includes('/v1/subscriptions/')) {
      return new Response(
        JSON.stringify(o.subscription ?? subscription({ latest_invoice: 'in_1' })),
        { status: 200 },
      );
    }
    if (u.includes('/v1/invoices/')) {
      return new Response(JSON.stringify(o.invoice ?? {
        id: 'in_1',
        status: 'paid',
        billing_reason: 'subscription_create',
        parent: { subscription_details: { subscription: SUB_ID } },
        payments: {
          data: [{ status: 'paid', payment: { type: 'payment_intent', payment_intent: 'pi_1' } }],
        },
      }), { status: 200 });
    }
    if (u.includes('/v1/refunds')) {
      if (method === 'GET') {
        return new Response(JSON.stringify({ data: o.existingRefunds ?? [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: 're_1', status: 'succeeded' }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  };
  fn.calls = calls;
  fn.countOf = (method, part) =>
    calls.filter((c) => c.method === method && c.url.includes(part)).length;
  return fn;
}

test('JP なら従来どおり entitlement を書く', async () => {
  const fetchImpl = countryFetch();
  const { res, body, rpc } = await post(stripeEvent(), { fetchImpl });
  assert.equal(res.status, 200);
  assert.equal(body.processed, true);
  assert.equal(rpc.calls.length, 1, 'RPC を呼ぶ');
});

test('**非 JP では RPC を 1 回も呼ばない**（一瞬も Pro にしない）', async () => {
  for (const country of ['US', 'GB', 'CA', 'AU', 'FR']) {
    const fetchImpl = countryFetch({ customer: customer({ address: { country } }) });
    const { res, body, rpc } = await post(stripeEvent(), { fetchImpl });
    assert.equal(res.status, 200, country);
    assert.equal(body.processed, false, country);
    assert.equal(body.rejected, 'country_not_sellable', country);
    assert.equal(rpc.calls.length, 0, country + ': entitlement を書かない');
  }
});

test('非 JP では解約と返金を行う', async () => {
  const fetchImpl = countryFetch({ customer: customer({ address: { country: 'US' } }) });
  const { res, body } = await post(stripeEvent(), { fetchImpl });
  assert.equal(res.status, 200);
  assert.equal(body.canceled, true);
  assert.equal(body.refunded, true);
  assert.equal(fetchImpl.countOf('DELETE', '/v1/subscriptions/'), 1, '解約 1 回');
  assert.equal(fetchImpl.countOf('POST', '/v1/refunds'), 1, '返金 1 回');
});

test('非 JP の同じ購入で複数 event が来ても二重解約・二重返金しない', async () => {
  // 1 回目で解約済み・返金済みになった状態を再現する
  const fetchImpl = countryFetch({
    customer: customer({ address: { country: 'US' } }),
    subscription: subscription({ status: 'canceled', latest_invoice: 'in_1' }),
    existingRefunds: [{ id: 're_1', status: 'succeeded' }],
  });
  for (const type of ['customer.subscription.created', 'invoice.payment_succeeded',
                      'checkout.session.completed']) {
    const obj = type === 'checkout.session.completed'
      ? { id: 'cs_1', subscription: SUB_ID }
      : { id: SUB_ID, subscription: SUB_ID };
    const { res, rpc } = await post(stripeEvent(type, obj), { fetchImpl });
    assert.equal(res.status, 200, type);
    assert.equal(rpc.calls.length, 0, type);
  }
  assert.equal(fetchImpl.countOf('DELETE', '/v1/subscriptions/'), 0, '二重解約しない');
  assert.equal(fetchImpl.countOf('POST', '/v1/refunds'), 0, '二重返金しない');
});

test('国が分からないときは fail closed（Pro なし・解約なし・返金なし・retry 可能）', async () => {
  const cases = [
    ['住所なし', customer({ address: undefined })],
    ['国コードなし', customer({ address: { postal_code: '100-0001' } })],
    ['壊れた国コード', customer({ address: { country: 'JPN' } })],
    ['空の国コード', customer({ address: { country: '' } })],
    ['削除済み Customer', { id: CUS_ID, deleted: true }],
  ];
  for (const [label, cus] of cases) {
    const fetchImpl = countryFetch({ customer: cus });
    const { res, body, rpc } = await post(stripeEvent(), { fetchImpl });
    assert.equal(res.status, 502, label);
    assert.deepEqual(body, { error: 'country_unverified' }, label);
    assert.equal(rpc.calls.length, 0, label + ': entitlement を書かない');
    assert.equal(fetchImpl.countOf('DELETE', '/v1/subscriptions/'), 0, label + ': 解約しない');
    assert.equal(fetchImpl.countOf('POST', '/v1/refunds'), 0, label + ': 返金しない');
  }
});

test('Customer を取得できないときも fail closed（金銭操作をしない）', async () => {
  const fetchImpl = countryFetch({ customerFails: true });
  const { res, body, rpc } = await post(stripeEvent(), { fetchImpl });
  assert.equal(res.status, 502);
  assert.deepEqual(body, { error: 'country_unverified' });
  assert.equal(rpc.calls.length, 0);
  assert.equal(fetchImpl.countOf('DELETE', '/v1/subscriptions/'), 0);
  assert.equal(fetchImpl.countOf('POST', '/v1/refunds'), 0);
});

test('後始末に失敗したら 200 にしない（Stripe の再送でやり直す）', async () => {
  const fetchImpl = countryFetch({
    customer: customer({ address: { country: 'US' } }),
    // 更新分の請求なので返金対象を特定できない
    invoice: {
      id: 'in_1',
      status: 'paid',
      billing_reason: 'subscription_cycle',
      parent: { subscription_details: { subscription: SUB_ID } },
      payments: {
        data: [{ status: 'paid', payment: { type: 'payment_intent', payment_intent: 'pi_1' } }],
      },
    },
  });
  const { res, body, rpc } = await post(stripeEvent(), { fetchImpl });
  assert.equal(res.status, 502);
  assert.deepEqual(body, { error: 'remediation_failed' });
  assert.equal(rpc.calls.length, 0);
  assert.equal(fetchImpl.countOf('POST', '/v1/refunds'), 0, '推測で返金しない');
});

test('国の判定は DB 書き込みより前に行われる（呼び出し順で固定）', async () => {
  const order = [];
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes('/v1/customers/')) order.push('customer');
    else if (u.includes('/v1/subscriptions/')) order.push('subscription');
    return new Response(
      JSON.stringify(u.includes('/v1/customers/') ? customer() : subscription()),
      { status: 200 },
    );
  };
  const rpc = async () => {
    order.push('rpc');
    return [{ processed: true, already_processed: false, stale: false }];
  };
  const request = await signedRequest(stripeEvent());
  await handleWebhook(request, ENV, { rpc, fetchImpl, logger: quiet, now: NOW_MS });
  assert.deepEqual(order, ['subscription', 'customer', 'rpc']);
});

test('応答にもログにも secret / PII を出さない（非 JP 経路）', async () => {
  const seen = [];
  const logger = {
    error(...a) { seen.push(a.map(String).join(' ')); },
    warn(...a) { seen.push(a.map(String).join(' ')); },
    log(...a) { seen.push(a.map(String).join(' ')); },
  };
  const fetchImpl = countryFetch({ customer: customer({ address: { country: 'US' } }) });
  const request = await signedRequest(stripeEvent());
  const res = await handleWebhook(request, ENV, { rpc: rpcMock(), fetchImpl, logger, now: NOW_MS });
  const text = await res.text();
  const log = seen.join(' ');
  for (const leak of [USER_ID, CUS_ID, 'pi_1', ENV.STRIPE_SECRET_KEY, ENV.STRIPE_WEBHOOK_SECRET]) {
    assert.equal(text.includes(leak), false, '応答に漏れている: ' + leak);
    assert.equal(log.includes(leak), false, 'ログに漏れている: ' + leak);
  }
  // 国コードは PII ではないので運用のためログに残す
  assert.ok(log.includes('US'));
});

// =========================================================
// 販売国の判定と、販売対象外だったときの後始末のテスト
//
//   対象:
//     functions/api/_lib/billing-country.js      国の判定
//     functions/api/_lib/billing-remediation.js  解約 + 返金
//
//   - **実 Stripe へ接続しない。** stripeRequest を注入で差し替える。
//   - このテストが守るもの:
//       * 国が分からないときに「非 JP」と同一視しないこと（fail closed）
//       * 返金対象を推測しないこと（初回請求の 1 件だけ）
//       * 解約・返金が retry-safe であること（二重実行しない）
// =========================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COUNTRY_STATUS,
  classifyCustomerCountry,
  normalizeCountry,
} from '../_lib/billing-country.js';
import {
  INITIAL_BILLING_REASON,
  REFUND_REASON,
  TERMINAL_SUBSCRIPTION_STATUSES,
  cancelSubscriptionIfLive,
  invoiceBelongsToSubscription,
  refundPaymentIntentOnce,
  remediateNotSellableCountry,
  resolveInitialPaymentIntent,
} from '../_lib/billing-remediation.js';
import { StripeApiError } from '../_lib/stripe.js';
import { PURCHASABLE_COUNTRIES } from '../_lib/billing-config.js';

const ENV = { STRIPE_SECRET_KEY: 'sk_test_dummy_for_tests_only' };
const quiet = { error() {}, warn() {}, log() {} };

const SUB_ID = 'sub_dummy_1';
const PI_ID = 'pi_dummy_1';
const IN_ID = 'in_dummy_1';

function subscription(over = {}) {
  return {
    id: SUB_ID,
    object: 'subscription',
    status: 'active',
    customer: 'cus_dummy_1',
    latest_invoice: IN_ID,
    ...over,
  };
}

/** 新しい API version（invoice_payment 方式）の invoice。 */
function invoice(over = {}) {
  return {
    id: IN_ID,
    object: 'invoice',
    status: 'paid',
    billing_reason: INITIAL_BILLING_REASON,
    parent: { type: 'subscription_details', subscription_details: { subscription: SUB_ID } },
    payments: {
      object: 'list',
      data: [{
        id: 'inpay_1',
        status: 'paid',
        payment: { type: 'payment_intent', payment_intent: PI_ID },
      }],
    },
    ...over,
  };
}

/**
 * Stripe 呼び出しの mock。path ごとに応答を決める。
 * refunds は既定で「まだ返金なし」。
 */
function stubStripe(over = {}) {
  const calls = [];
  const fn = async (o) => {
    calls.push(o);
    const { method, path } = o;
    if (over.throwOn && over.throwOn(o)) throw over.error ?? new StripeApiError('unavailable', 'boom', { retryable: true });
    if (method === 'DELETE' && path.startsWith('/v1/subscriptions/')) {
      return { id: SUB_ID, status: 'canceled' };
    }
    if (method === 'GET' && path.startsWith('/v1/invoices/')) {
      return over.invoice ?? invoice();
    }
    if (method === 'GET' && path === '/v1/refunds') {
      return { object: 'list', data: over.existingRefunds ?? [] };
    }
    if (method === 'POST' && path === '/v1/refunds') {
      return { id: 're_dummy_1', status: 'succeeded' };
    }
    throw new Error('想定外の呼び出し: ' + method + ' ' + path);
  };
  fn.calls = calls;
  return fn;
}

const find = (stripe, method, path) =>
  stripe.calls.filter((c) => c.method === method && c.path.startsWith(path));


// =========================================================
// 1. 国の判定
// =========================================================

test('前提: いま販売できるのは日本のみ', () => {
  assert.deepEqual([...PURCHASABLE_COUNTRIES], ['JP']);
});

test('JP は販売可能と判定する', () => {
  const r = classifyCustomerCountry({ address: { country: 'JP' } });
  assert.equal(r.status, COUNTRY_STATUS.SELLABLE);
  assert.equal(r.country, 'JP');
});

test('小文字でも前後空白があっても JP は JP', () => {
  for (const value of ['jp', ' JP ', 'Jp']) {
    assert.equal(classifyCustomerCountry({ address: { country: value } }).status,
      COUNTRY_STATUS.SELLABLE, value);
  }
});

test('JP 以外の国は not_sellable', () => {
  for (const country of ['US', 'GB', 'CA', 'AU', 'FR', 'KR']) {
    const r = classifyCustomerCountry({ address: { country } });
    assert.equal(r.status, COUNTRY_STATUS.NOT_SELLABLE, country);
    assert.equal(r.country, country);
  }
});

test('**国が分からないときは非 JP と同一視しない**（unknown）', () => {
  const cases = [
    [undefined, 'invalid_customer'],
    [null, 'invalid_customer'],
    ['cus_1', 'invalid_customer'],
    [{}, 'missing_address'],
    [{ address: null }, 'missing_address'],
    [{ address: 'JP' }, 'missing_address'],
    [{ address: {} }, 'missing_country'],
    [{ address: { country: null } }, 'missing_country'],
    [{ address: { country: '' } }, 'missing_country'],
    [{ address: { country: ' ' } }, 'missing_country'],
    [{ address: { country: 'JPN' } }, 'missing_country'],
    [{ address: { country: 'J' } }, 'missing_country'],
    [{ address: { country: 12 } }, 'missing_country'],
    [{ deleted: true, address: { country: 'US' } }, 'customer_deleted'],
  ];
  for (const [customer, code] of cases) {
    const r = classifyCustomerCountry(customer);
    assert.equal(r.status, COUNTRY_STATUS.UNKNOWN, JSON.stringify(customer));
    assert.equal(r.code, code, JSON.stringify(customer));
  }
});

test('normalizeCountry は 2 文字の英字だけを受け付ける', () => {
  assert.equal(normalizeCountry('jp'), 'JP');
  assert.equal(normalizeCountry('US'), 'US');
  assert.equal(normalizeCountry('JPN'), null);
  assert.equal(normalizeCountry('J1'), null);
  assert.equal(normalizeCountry(''), null);
  assert.equal(normalizeCountry(null), null);
});


// =========================================================
// 2. 返金対象の特定（推測しない）
// =========================================================

test('初回請求の支払い 1 件だけを返金対象にする', () => {
  const r = resolveInitialPaymentIntent(invoice(), SUB_ID);
  assert.deepEqual(r, { ok: true, paymentIntentId: PI_ID });
});

test('古い API version の invoice.payment_intent でも引ける', () => {
  const old = {
    id: IN_ID,
    status: 'paid',
    paid: true,
    billing_reason: INITIAL_BILLING_REASON,
    subscription: SUB_ID,
    payment_intent: PI_ID,
  };
  assert.deepEqual(resolveInitialPaymentIntent(old, SUB_ID), { ok: true, paymentIntentId: PI_ID });
});

test('別 subscription の invoice は返金対象にしない', () => {
  const r = resolveInitialPaymentIntent(invoice(), 'sub_other');
  assert.deepEqual(r, { ok: false, code: 'invoice_mismatch' });
});

test('**更新分の請求は返金対象にしない**（初回だけ）', () => {
  const renewal = invoice({ billing_reason: 'subscription_cycle' });
  assert.deepEqual(resolveInitialPaymentIntent(renewal, SUB_ID),
    { ok: false, code: 'not_initial_invoice' });
});

test('未払いの invoice は返金対象が無い', () => {
  const unpaid = invoice({ status: 'open', payments: { data: [] } });
  assert.deepEqual(resolveInitialPaymentIntent(unpaid, SUB_ID),
    { ok: false, code: 'invoice_not_paid' });
});

test('支払い済みが複数あって一意に決まらなければ返金しない', () => {
  const many = invoice({
    payments: {
      data: [
        { status: 'paid', payment: { type: 'payment_intent', payment_intent: 'pi_a' } },
        { status: 'paid', payment: { type: 'payment_intent', payment_intent: 'pi_b' } },
      ],
    },
  });
  assert.deepEqual(resolveInitialPaymentIntent(many, SUB_ID),
    { ok: false, code: 'ambiguous_payment' });
});

test('同じ PaymentIntent が 2 行あっても 1 件として扱う', () => {
  const dup = invoice({
    payments: {
      data: [
        { status: 'paid', payment: { type: 'payment_intent', payment_intent: PI_ID } },
        { status: 'paid', payment: { type: 'payment_intent', payment_intent: PI_ID } },
      ],
    },
  });
  assert.deepEqual(resolveInitialPaymentIntent(dup, SUB_ID), { ok: true, paymentIntentId: PI_ID });
});

test('invoiceBelongsToSubscription は新旧どちらの形も見る', () => {
  assert.equal(invoiceBelongsToSubscription(invoice(), SUB_ID), true);
  assert.equal(invoiceBelongsToSubscription({ subscription: SUB_ID }, SUB_ID), true);
  assert.equal(invoiceBelongsToSubscription({ subscription: 'sub_x' }, SUB_ID), false);
  assert.equal(invoiceBelongsToSubscription({}, SUB_ID), false);
  assert.equal(invoiceBelongsToSubscription(null, SUB_ID), false);
});


// =========================================================
// 3. 解約は retry-safe
// =========================================================

test('生きている契約は解約する', async () => {
  const stripe = stubStripe();
  const r = await cancelSubscriptionIfLive({ env: ENV, subscription: subscription(), stripe, logger: quiet });
  assert.deepEqual(r, { ok: true, canceled: true });
  assert.equal(find(stripe, 'DELETE', '/v1/subscriptions/').length, 1);
});

test('**解約済みなら解約 API を呼ばない**（二重解約しない）', async () => {
  for (const status of TERMINAL_SUBSCRIPTION_STATUSES) {
    const stripe = stubStripe();
    const r = await cancelSubscriptionIfLive({
      env: ENV, subscription: subscription({ status }), stripe, logger: quiet,
    });
    assert.deepEqual(r, { ok: true, canceled: false }, status);
    assert.equal(stripe.calls.length, 0, status);
  }
});

test('解約が一時障害なら retryable として返す', async () => {
  const stripe = stubStripe({ throwOn: (o) => o.method === 'DELETE' });
  const r = await cancelSubscriptionIfLive({ env: ENV, subscription: subscription(), stripe, logger: quiet });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'cancel_failed');
  assert.equal(r.retryable, true);
});


// =========================================================
// 4. 返金は retry-safe
// =========================================================

test('未返金なら全額返金する（amount を指定しない）', async () => {
  const stripe = stubStripe();
  const r = await refundPaymentIntentOnce({ env: ENV, paymentIntentId: PI_ID, stripe, logger: quiet });
  assert.deepEqual(r, { ok: true, refunded: true });
  const posted = find(stripe, 'POST', '/v1/refunds');
  assert.equal(posted.length, 1);
  assert.equal(posted[0].params.payment_intent, PI_ID);
  assert.equal(posted[0].params.reason, REFUND_REASON);
  assert.equal('amount' in posted[0].params, false, '全額返金なので amount を渡さない');
  assert.equal(posted[0].idempotencyKey, 'refund:country:' + PI_ID);
});

test('**返金済みなら返金 API を呼ばない**（二重返金しない）', async () => {
  for (const status of ['succeeded', 'pending']) {
    const stripe = stubStripe({ existingRefunds: [{ id: 're_1', status }] });
    const r = await refundPaymentIntentOnce({ env: ENV, paymentIntentId: PI_ID, stripe, logger: quiet });
    assert.deepEqual(r, { ok: true, refunded: false }, status);
    assert.equal(find(stripe, 'POST', '/v1/refunds').length, 0, status);
  }
});

test('返金状況を確認できないときは返金しない（未返金のほうが回復可能）', async () => {
  const stripe = stubStripe({ throwOn: (o) => o.method === 'GET' && o.path === '/v1/refunds' });
  const r = await refundPaymentIntentOnce({ env: ENV, paymentIntentId: PI_ID, stripe, logger: quiet });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'refund_lookup_failed');
  assert.equal(find(stripe, 'POST', '/v1/refunds').length, 0);
});

test('Stripe が charge_already_refunded を返したら成功として扱う', async () => {
  const stripe = stubStripe({
    throwOn: (o) => o.method === 'POST' && o.path === '/v1/refunds',
    error: new StripeApiError('request_failed', 'already refunded',
      { stripeCode: 'charge_already_refunded' }),
  });
  const r = await refundPaymentIntentOnce({ env: ENV, paymentIntentId: PI_ID, stripe, logger: quiet });
  assert.deepEqual(r, { ok: true, refunded: false });
});


// =========================================================
// 5. 後始末の全体（解約 -> 返金の順）
// =========================================================

test('販売対象外なら「解約 -> 返金」の順に実行する', async () => {
  const stripe = stubStripe();
  const r = await remediateNotSellableCountry({
    env: ENV, subscription: subscription(), stripe, logger: quiet,
    country: 'US', userId: '11111111-2222-3333-4444-555555555555',
  });
  assert.deepEqual(r, { ok: true, canceled: true, refunded: true });

  const order = stripe.calls.map((c) => c.method + ' ' + c.path);
  assert.deepEqual(order, [
    'DELETE /v1/subscriptions/' + SUB_ID,
    'GET /v1/invoices/' + IN_ID,
    'GET /v1/refunds',
    'POST /v1/refunds',
  ]);
});

test('返金 metadata に理由と国を残す（user_id はログには出さない）', async () => {
  const stripe = stubStripe();
  await remediateNotSellableCountry({
    env: ENV, subscription: subscription(), stripe, logger: quiet, country: 'US', userId: 'u-1',
  });
  const md = find(stripe, 'POST', '/v1/refunds')[0].params.metadata;
  assert.equal(md.sukima_reason, 'country_not_sellable');
  assert.equal(md.sukima_country, 'US');
  assert.equal(md.sukima_user_id, 'u-1');
});

test('請求がまだ無ければ解約だけで完了する', async () => {
  const stripe = stubStripe();
  const r = await remediateNotSellableCountry({
    env: ENV, subscription: subscription({ latest_invoice: null }), stripe, logger: quiet, country: 'US',
  });
  assert.deepEqual(r, { ok: true, canceled: true, refunded: false });
  assert.equal(find(stripe, 'POST', '/v1/refunds').length, 0);
});

test('返金対象を特定できないときは返金せず失敗を返す', async () => {
  const stripe = stubStripe({ invoice: invoice({ billing_reason: 'subscription_cycle' }) });
  const r = await remediateNotSellableCountry({
    env: ENV, subscription: subscription(), stripe, logger: quiet, country: 'US',
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'refund_target_not_initial_invoice');
  assert.equal(find(stripe, 'POST', '/v1/refunds').length, 0);
});

test('2 回目以降の呼び出しでは解約も返金もやり直さない（retry-safe）', async () => {
  // 1 回目の結果として「解約済み・返金済み」になった状態を再現する
  const stripe = stubStripe({ existingRefunds: [{ id: 're_1', status: 'succeeded' }] });
  const r = await remediateNotSellableCountry({
    env: ENV, subscription: subscription({ status: 'canceled' }), stripe, logger: quiet, country: 'US',
  });
  assert.deepEqual(r, { ok: true, canceled: false, refunded: false });
  assert.equal(find(stripe, 'DELETE', '/v1/subscriptions/').length, 0, '二重解約しない');
  assert.equal(find(stripe, 'POST', '/v1/refunds').length, 0, '二重返金しない');
});

test('解約に失敗したら返金へ進まない', async () => {
  const stripe = stubStripe({ throwOn: (o) => o.method === 'DELETE' });
  const r = await remediateNotSellableCountry({
    env: ENV, subscription: subscription(), stripe, logger: quiet, country: 'US',
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'cancel_failed');
  assert.equal(find(stripe, 'POST', '/v1/refunds').length, 0);
});

// =========================================================
// 新規購入の受付停止スイッチ（BILLING_SALES_SUSPENDED）の単体テスト
//
//   - **実 DB / 実 Stripe へ接続しない。** session / RPC / Stripe / fetch はすべてスタブ。
//   - 本番の secret / Price ID はフィクスチャに保存しない（ダミー値のみ）。
//
//   このテストが守るもの:
//     1. 受付中は既存の Checkout 処理へ進む
//     2. 停止中は Checkout API が 503 sales_suspended で断る
//     3. 停止中は Stripe を呼ばない
//     4. 停止中は規約同意を含む DB（RPC）にも session にも触れない
//     5. 画面を経由しない直接の呼び出し（Origin / Cookie / body なし、pages.dev）も断る
//     6. 停止中も webhook は処理する
//     7. 停止中も Billing Portal は開ける
//     8. 停止中も既存の Pro 権限は維持される（/api/auth/me）
//     9. 停止 -> 受付中へ戻すと購入処理を再開できる
//    10. 値が不正 / 未設定のときの扱いが設計どおり
// =========================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  SALES_SUSPENDED_ERROR,
  SALES_SWITCH_ENV_KEY,
  SALES_SWITCH_REASON,
  readSalesSwitch,
  salesSuspendedRejection,
} from '../_lib/sales-switch.js';
import { handleBillingCheckout } from '../billing/checkout.js';
import { handleTermsConsent } from '../terms/consent.js';
import { handleBillingPortal } from '../billing/portal.js';
import { handleWebhook } from '../billing/webhook.js';
import { handleMe } from '../auth/me.js';
import { computeStripeSignature } from '../_lib/stripe-webhook.js';
import { SESSION_COOKIE_NAME, SESSION_RESULT, generateSessionToken } from '../_lib/session.js';

/** ダミー値のみ。**本番の Price ID / secret は書かない。** */
const BASE_ENV = Object.freeze({
  SUPABASE_URL: 'https://example-project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_dummy_for_tests_only',
  STRIPE_SECRET_KEY: 'sk_test_dummy_for_tests_only',
  STRIPE_WEBHOOK_SECRET: 'whsec_dummy_for_tests_only',
  STRIPE_PRICE_WEB_PRO_JPY_LAUNCH: 'price_dummy_jpy_launch',
  STRIPE_PRICE_WEB_PRO_JPY_STANDARD: 'price_dummy_jpy_standard',
  STRIPE_BILLING_PORTAL_CONFIGURATION_ID: 'bpc_TESTDUMMY0001',
});
const SUSPENDED_ENV = Object.freeze({ ...BASE_ENV, [SALES_SWITCH_ENV_KEY]: 'true' });

const ORIGIN = 'https://sukimacalendar.com';
const USER_ID = '11111111-2222-3333-4444-555555555555';
const CUSTOMER_ID = 'cus_TESTDUMMY0001';
const SUB_ID = 'sub_dummy_1';
const NOW_LAUNCH = Date.parse('2026-09-09T00:00:00.000Z');
const CHECKOUT_URL = 'https://checkout.stripe.com/c/pay/cs_test_dummy';
const PORTAL_URL = 'https://billing.stripe.com/p/session/test_dummy';

/** 呼ばれた回数を数えるだけのロガー。 */
function recordingLogger() {
  const log = { error: [], warn: [], log: [] };
  return {
    error: (...a) => log.error.push(a.join(' ')),
    warn: (...a) => log.warn.push(a.join(' ')),
    log: (...a) => log.log.push(a.join(' ')),
    entries: log,
  };
}
const quiet = { error() {}, warn() {}, log() {} };

function counted(fn) {
  const calls = [];
  const wrapped = async (...args) => { calls.push(args); return fn(...args); };
  wrapped.calls = calls;
  return wrapped;
}

function request(path, {
  method = 'POST',
  body = '{}',
  origin = ORIGIN,
  cookie = `${SESSION_COOKIE_NAME}=dummytoken`,
  host = 'https://sukimacalendar.com',
} = {}) {
  const headers = { 'content-type': 'application/json' };
  if (origin !== null) headers.origin = origin;
  if (cookie !== null) headers.cookie = cookie;
  const init = { method, headers };
  if (method !== 'GET' && method !== 'HEAD' && body !== null) init.body = body;
  return new Request(host + path, init);
}

const CHECKOUT_BODY = JSON.stringify({ locale: 'ja', age_confirmed: true });
const CONSENT_BODY = JSON.stringify({ locale: 'ja' });

function checkoutDeps(over = {}) {
  return {
    session: counted(async () => ({
      status: SESSION_RESULT.VALID,
      context: { user_id: USER_ID, plan_id: 'free', status: 'active' },
    })),
    rpc: counted(async () => [{
      plan_id: 'free', status: 'active', stripe_customer_id: null, terms_consented: true,
    }]),
    stripe: counted(async () => ({ id: 'cs_test_dummy', url: CHECKOUT_URL, expires_at: 1789000000 })),
    logger: quiet,
    now: () => NOW_LAUNCH,
    currentVersion: () => '2026-09-09',
    ...over,
  };
}

function consentDeps(over = {}) {
  return {
    session: counted(async () => ({
      status: SESSION_RESULT.VALID,
      context: { user_id: USER_ID, plan_id: 'free', status: 'active' },
    })),
    rpc: counted(async () => [{
      terms_version: '2026-09-09', locale: 'ja', accepted_at: '2026-09-09T00:00:00.000Z',
    }]),
    logger: quiet,
    currentVersion: () => '2026-09-09',
    ...over,
  };
}

async function jsonOf(res) {
  const text = await res.text();
  try { return { body: JSON.parse(text), text }; } catch { return { body: null, text }; }
}


// =========================================================
// 10. 値の解釈
// =========================================================

test('10: 未設定・空文字・false は受付中、true は停止中、それ以外は停止中（fail closed）', () => {
  const cases = [
    [undefined, false, SALES_SWITCH_REASON.UNSET],
    [null, false, SALES_SWITCH_REASON.UNSET],
    ['', false, SALES_SWITCH_REASON.UNSET],
    ['   ', false, SALES_SWITCH_REASON.UNSET],
    ['false', false, SALES_SWITCH_REASON.DISABLED],
    [' FALSE ', false, SALES_SWITCH_REASON.DISABLED],
    ['true', true, SALES_SWITCH_REASON.ENABLED],
    [' True ', true, SALES_SWITCH_REASON.ENABLED],
    ['yes', true, SALES_SWITCH_REASON.INVALID],
    ['on', true, SALES_SWITCH_REASON.INVALID],
    ['1', true, SALES_SWITCH_REASON.INVALID],
    ['0', true, SALES_SWITCH_REASON.INVALID],
    ['ture', true, SALES_SWITCH_REASON.INVALID],
    [true, true, SALES_SWITCH_REASON.INVALID],
    [0, true, SALES_SWITCH_REASON.INVALID],
  ];
  for (const [value, suspended, reason] of cases) {
    const env = value === undefined ? {} : { [SALES_SWITCH_ENV_KEY]: value };
    assert.deepEqual(readSalesSwitch(env), { suspended, reason }, JSON.stringify(value));
  }
  // env そのものが無い / 壊れていても例外にしない（受付中＝現行どおり）。
  assert.deepEqual(readSalesSwitch(undefined), { suspended: false, reason: 'unset' });
  assert.deepEqual(readSalesSwitch(null), { suspended: false, reason: 'unset' });
});

test('10: 不正な値は停止扱いにし、error ログを残す（値そのものは出さない）', async () => {
  const logger = recordingLogger();
  const env = { ...BASE_ENV, [SALES_SWITCH_ENV_KEY]: 'secret-looking-value-xyz' };
  const r = salesSuspendedRejection(env, 'unit', logger);
  assert.deepEqual(r, { status: 503, body: { error: SALES_SUSPENDED_ERROR } });
  assert.equal(logger.entries.error.length, 1);
  assert.equal(logger.entries.error[0].includes('secret-looking-value-xyz'), false);

  const d = checkoutDeps({ logger });
  const res = await handleBillingCheckout(request('/api/billing/checkout', { body: CHECKOUT_BODY }), env, d);
  assert.equal(res.status, 503);
  assert.equal(d.stripe.calls.length, 0);
});

test('10: 未設定（現行の本番と同じ）では受付を止めない', () => {
  const logger = recordingLogger();
  assert.equal(salesSuspendedRejection(BASE_ENV, 'unit', logger), null);
  assert.equal(logger.entries.error.length + logger.entries.warn.length, 0);
});


// =========================================================
// 1. 受付中は既存の Checkout 処理へ進む
// =========================================================

test('1: 受付中（未設定 / false）は Checkout Session を作り 200 を返す', async () => {
  for (const env of [BASE_ENV, { ...BASE_ENV, [SALES_SWITCH_ENV_KEY]: 'false' }]) {
    const d = checkoutDeps();
    const res = await handleBillingCheckout(request('/api/billing/checkout', { body: CHECKOUT_BODY }), env, d);
    const { body } = await jsonOf(res);
    assert.equal(res.status, 200);
    assert.equal(body.url, CHECKOUT_URL);
    assert.equal(d.stripe.calls.length, 1);
    // 価格は既存どおり launch の Price（金額・切り替えを変えていない）。
    assert.equal(d.stripe.calls[0][0].params.line_items[0].price, 'price_dummy_jpy_launch');
    // プロモーションコード欄の仕様も変えていない。
    assert.equal(d.stripe.calls[0][0].params.allow_promotion_codes, true);
  }
});


// =========================================================
// 2・3・4. 停止中は Checkout / 規約同意を断り、Stripe にも DB にも触れない
// =========================================================

test('2・3・4: 停止中の Checkout は 503 sales_suspended。session / RPC / Stripe を呼ばない', async () => {
  const d = checkoutDeps();
  const res = await handleBillingCheckout(
    request('/api/billing/checkout', { body: CHECKOUT_BODY }), SUSPENDED_ENV, d);
  const { body, text } = await jsonOf(res);
  assert.equal(res.status, 503);
  assert.deepEqual(body, { error: SALES_SUSPENDED_ERROR });
  assert.equal(d.session.calls.length, 0, 'session（sessions 行の更新を含む）に触れない');
  assert.equal(d.rpc.calls.length, 0, 'DB の RPC を呼ばない');
  assert.equal(d.stripe.calls.length, 0, 'Checkout Session を作らない');
  // 応答に secret・user_id・env の中身を含めない。
  for (const s of [USER_ID, 'sk_test', 'whsec_', 'sb_secret', 'price_dummy', SALES_SWITCH_ENV_KEY]) {
    assert.equal(text.includes(s), false, s);
  }
});

test('4: 停止中の規約同意は 503 sales_suspended。record_terms_consent を呼ばない', async () => {
  const d = consentDeps();
  const res = await handleTermsConsent(
    request('/api/terms/consent', { body: CONSENT_BODY }), SUSPENDED_ENV, d);
  const { body } = await jsonOf(res);
  assert.equal(res.status, 503);
  assert.deepEqual(body, { error: SALES_SUSPENDED_ERROR });
  assert.equal(d.session.calls.length, 0);
  assert.equal(d.rpc.calls.length, 0, '規約同意の行を書かない');
});

test('2: 停止中でも POST 以外は従来どおり 405（停止を理由にした別の応答にしない）', async () => {
  const d1 = checkoutDeps();
  const r1 = await handleBillingCheckout(
    request('/api/billing/checkout', { method: 'GET', body: null }), SUSPENDED_ENV, d1);
  assert.equal(r1.status, 405);
  const d2 = consentDeps();
  const r2 = await handleTermsConsent(
    request('/api/terms/consent', { method: 'GET', body: null }), SUSPENDED_ENV, d2);
  assert.equal(r2.status, 405);
});


// =========================================================
// 5. 画面を経由しない直接の呼び出しも断る
// =========================================================

test('5: Origin・Cookie・body が無い / 壊れた直接呼び出しでも 503 で、何も呼ばない', async () => {
  const variants = [
    { origin: null },
    { cookie: null },
    { origin: null, cookie: null },
    { body: '{"price_id":"price_attacker","amount":1}' },
    { body: 'not json' },
    { host: 'https://sukima-web-8ws.pages.dev' },   // pages.dev でも同じ handler
    { host: 'https://sukima-web-8ws.pages.dev', origin: 'https://sukima-web-8ws.pages.dev' },
  ];
  for (const v of variants) {
    const d = checkoutDeps();
    const res = await handleBillingCheckout(request('/api/billing/checkout', v), SUSPENDED_ENV, d);
    assert.equal(res.status, 503, JSON.stringify(v));
    assert.equal(d.session.calls.length + d.rpc.calls.length + d.stripe.calls.length, 0, JSON.stringify(v));

    const c = consentDeps();
    const res2 = await handleTermsConsent(request('/api/terms/consent', v), SUSPENDED_ENV, c);
    assert.equal(res2.status, 503, JSON.stringify(v));
    assert.equal(c.session.calls.length + c.rpc.calls.length, 0, JSON.stringify(v));
  }
});


// =========================================================
// 6・7・8. 停止の対象外（webhook / Portal / 既存の Pro 権限）
// =========================================================

test('6: 停止中も webhook は署名を検証して DB へ適用する（200 processed）', async () => {
  const NOW_SEC = 1788000000;
  const event = {
    id: 'evt_dummy_1', object: 'event', type: 'customer.subscription.updated',
    created: NOW_SEC, data: { object: { id: SUB_ID } },
  };
  const raw = JSON.stringify(event);
  const v1 = await computeStripeSignature(SUSPENDED_ENV.STRIPE_WEBHOOK_SECRET, NOW_SEC, raw);
  const req = new Request('https://sukimacalendar.com/api/billing/webhook', {
    method: 'POST', headers: { 'Stripe-Signature': `t=${NOW_SEC},v1=${v1}` }, body: raw,
  });
  const fetchImpl = counted(async (url) => {
    if (String(url).includes('/v1/customers/')) {
      return new Response(JSON.stringify({ id: CUSTOMER_ID, address: { country: 'JP' } }), { status: 200 });
    }
    return new Response(JSON.stringify({
      id: SUB_ID, object: 'subscription', customer: CUSTOMER_ID, status: 'active',
      cancel_at_period_end: false, current_period_end: 1790000000,
      metadata: { user_id: USER_ID },
      items: { data: [{ id: 'si_1', price: { id: 'price_dummy_jpy_launch' }, current_period_end: 1790000000 }] },
    }), { status: 200 });
  });
  const rpc = counted(async () => [{ processed: true, already_processed: false, stale: false }]);
  const res = await handleWebhook(req, SUSPENDED_ENV, { rpc, fetchImpl, logger: quiet, now: NOW_SEC * 1000 });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.processed, true);
  assert.equal(rpc.calls.length, 1, 'apply_stripe_subscription_event を 1 回呼ぶ');
});

test('7: 停止中も Billing Portal は開ける（既存契約者の解約・管理を塞がない）', async () => {
  const stripe = counted(async () => ({ url: PORTAL_URL }));
  const rpc = counted(async () => [{
    plan_id: 'web_pro', status: 'active', stripe_customer_id: CUSTOMER_ID, terms_consented: true,
  }]);
  const res = await handleBillingPortal(request('/api/billing/portal'), SUSPENDED_ENV, {
    rpc, stripe, logger: quiet, currentVersion: () => '2026-09-09',
    session: async () => ({
      status: SESSION_RESULT.VALID,
      context: { user_id: USER_ID, plan_id: 'web_pro', status: 'active' },
    }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.url, PORTAL_URL);
  assert.equal(stripe.calls.length, 1);
});

test('8: 停止中も既存の Pro 権限は維持される（/api/auth/me）', async () => {
  const token = generateSessionToken();
  const rows = [{
    user_id: USER_ID, plan_id: 'web_pro', status: 'active',
    idle_expires_at: '2026-10-01T00:00:00Z', absolute_expires_at: '2026-11-30T00:00:00Z',
    past_due_since: null, current_period_end: null, cancel_at_period_end: false,
    currency: null, price_phase: null,
  }];
  const res = await handleMe(
    new Request('https://sukimacalendar.com/api/auth/me', {
      method: 'GET', headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
    }),
    SUSPENDED_ENV,
    { rpc: async () => rows, logger: quiet, now: new Date('2026-09-01T00:00:00Z') },
  );
  const payload = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(payload.entitlement, { web: true, extension: false });
});

test('6・7・8: webhook / Portal / auth / entitlement / 削除 API はスイッチを参照しない', async () => {
  const files = [
    '../billing/webhook.js',
    '../billing/portal.js',
    '../auth/me.js',
    '../auth/session.js',
    '../auth/logout.js',
    '../_lib/entitlement.js',
    '../account/delete.js',
  ];
  for (const f of files) {
    const src = await readFile(new URL(f, import.meta.url), 'utf8');
    assert.equal(src.includes('sales-switch'), false, f);
    assert.equal(src.includes(SALES_SWITCH_ENV_KEY), false, f);
  }
});


// =========================================================
// 9. 停止 -> 受付中へ戻すと再開できる
// =========================================================

test('9: 停止中は断り、スイッチを false / 未設定に戻すと同じ依頼で購入処理が再開する', async () => {
  const d = checkoutDeps();
  const make = () => request('/api/billing/checkout', { body: CHECKOUT_BODY });

  const stopped = await handleBillingCheckout(make(), SUSPENDED_ENV, d);
  assert.equal(stopped.status, 503);
  assert.equal(d.stripe.calls.length, 0);

  const resumedFalse = await handleBillingCheckout(make(), { ...BASE_ENV, [SALES_SWITCH_ENV_KEY]: 'false' }, d);
  assert.equal(resumedFalse.status, 200);
  assert.equal(d.stripe.calls.length, 1);

  const resumedUnset = await handleBillingCheckout(make(), BASE_ENV, d);
  assert.equal(resumedUnset.status, 200);
  assert.equal(d.stripe.calls.length, 2);

  const c = consentDeps();
  assert.equal((await handleTermsConsent(request('/api/terms/consent', { body: CONSENT_BODY }), SUSPENDED_ENV, c)).status, 503);
  assert.equal((await handleTermsConsent(request('/api/terms/consent', { body: CONSENT_BODY }), BASE_ENV, c)).status, 200);
  assert.equal(c.rpc.calls.length, 1);
});

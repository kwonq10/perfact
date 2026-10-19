// =========================================================
// POST /api/billing/conversion と GET /api/ads/tag-config の単体テスト
//
//   - **実 Stripe / 実 DB / Google へ接続しない。** session / RPC / Stripe をスタブ化する。
//   - 本番の secret / Price ID はフィクスチャに書かない（ダミー値のみ）。
//
//   このテストが守るもの:
//     - 本番設定（ADS_CONVERSION_MODE=live）かつ日本からのときだけ動く
//     - 初回の請求を Checkout Session との関連から特定する（最新の請求を使わない）
//     - 更新決済・0 円・テストモード・他人の Session・販売国外を送らない
//     - 「今回より前の Sukima 有料プランの支払い」だけを再契約とみなす
//       （未払い・0 円・無関係な商品・単発請求は除外理由にしない。返金済みは支払い実績）
//     - webhook の反映を今回の subscription ID で照合し、反映前は Stripe を追加で呼ばない
//     - 応答をキャッシュさせない / ログに ID・金額を出さない / DB と Stripe に書かない
// =========================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  handleBillingConversion,
  validate,
} from '../billing/conversion.js';
import { handleAdsTagConfig } from '../ads/tag-config.js';
import {
  MAX_SESSION_AGE_MS,
  RPC_BILLING_REFLECTION,
  buildTransactionId,
} from '../_lib/ads-conversion.js';
import { GOOGLE_ADS_CONVERSION_SEND_TO, GOOGLE_ADS_TAG_ID } from '../_lib/ads-config.js';
import { SESSION_COOKIE_NAME, SESSION_RESULT } from '../_lib/session.js';
import { StripeApiError } from '../_lib/stripe.js';
import { SupabaseError } from '../_lib/supabase.js';

const ENV = {
  ADS_CONVERSION_MODE: 'live',
  SUPABASE_URL: 'https://example-project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_dummy_for_tests_only',
  STRIPE_SECRET_KEY: 'sk_test_dummy_for_tests_only',
  STRIPE_PRICE_WEB_PRO_JPY_LAUNCH: 'price_dummy_jpy_launch',
  STRIPE_PRICE_WEB_PRO_JPY_STANDARD: 'price_dummy_jpy_standard',
};

const ORIGIN = 'https://sukimacalendar.com';
const USER_ID = '11111111-2222-3333-4444-555555555555';
const OTHER_USER_ID = '99999999-8888-7777-6666-555555555555';
const SESSION_ID = 'cs_live_a1B2c3D4e5F6';
const NOW_MS = Date.parse('2026-10-18T03:00:00.000Z');
const NOW_S = Math.floor(NOW_MS / 1000);

// ---------------------------------------------------------
// フィクスチャ
// ---------------------------------------------------------

function fixtures(over = {}) {
  const session = {
    id: SESSION_ID,
    object: 'checkout.session',
    mode: 'subscription',
    livemode: true,
    created: NOW_S - 120,
    status: 'complete',
    payment_status: 'paid',
    subscription: 'sub_new',
    customer: 'cus_1',
    invoice: 'in_first',
    metadata: { user_id: USER_ID },
    ...over.session,
  };
  const invoices = {
    in_first: {
      id: 'in_first',
      status: 'paid',
      billing_reason: 'subscription_create',
      currency: 'jpy',
      amount_paid: 300,
      created: NOW_S - 110,
      customer: 'cus_1',
      parent: { subscription_details: { subscription: 'sub_new' } },
      ...over.invoice,
    },
    ...over.invoices,
  };
  const subscriptions = {
    sub_new: {
      id: 'sub_new',
      customer: 'cus_1',
      status: 'active',
      metadata: { user_id: USER_ID },
      items: { data: [{ price: { id: 'price_dummy_jpy_launch' } }] },
      // 「最新の請求」は判定に使わない（これを取りに行ったらテストが失敗する）。
      latest_invoice: 'in_latest_should_not_be_used',
      ...over.subscription,
    },
    ...over.subscriptions,
  };
  const customer = { id: 'cus_1', address: { country: 'JP' }, ...over.customer };
  // 顧客の支払い済み請求の一覧（status=paid）。既定は今回の 1 件だけ。
  const customerPaidInvoices = over.customerPaidInvoices ?? [invoices.in_first];
  // subscription で絞った支払い済み請求（session.invoice が空のときの代替経路）。
  const subscriptionPaidInvoices = over.subscriptionPaidInvoices ?? [invoices.in_first];
  return { session, invoices, subscriptions, customer, customerPaidInvoices, subscriptionPaidInvoices };
}

function stubStripe(fx, { fail = null } = {}) {
  const calls = [];
  const fn = async (o) => {
    calls.push({ method: o.method, path: o.path, params: o.params });
    if (o.method !== 'GET') throw new Error('GET 以外を呼んではいけない: ' + o.method);
    if (fail && fail(o)) throw fail(o);
    const p = o.path;
    if (p === '/v1/checkout/sessions/' + SESSION_ID) return fx.session;
    if (p.startsWith('/v1/checkout/sessions/')) {
      throw new StripeApiError('request_failed', 'not found', { httpStatus: 404 });
    }
    if (p.startsWith('/v1/invoices/')) {
      const inv = fx.invoices[p.slice('/v1/invoices/'.length)];
      if (!inv) throw new StripeApiError('request_failed', 'not found', { httpStatus: 404 });
      return inv;
    }
    if (p === '/v1/invoices') {
      const data = o.params?.subscription ? fx.subscriptionPaidInvoices : fx.customerPaidInvoices;
      return { object: 'list', data, has_more: false };
    }
    if (p.startsWith('/v1/subscriptions/')) {
      const sub = fx.subscriptions[p.slice('/v1/subscriptions/'.length)];
      if (!sub) throw new StripeApiError('request_failed', 'not found', { httpStatus: 404 });
      return sub;
    }
    if (p.startsWith('/v1/customers/')) return fx.customer;
    throw new Error('想定外の Stripe 呼び出し: ' + p);
  };
  fn.calls = calls;
  return fn;
}

function stubRpc(value = [{ reflected: true }]) {
  const calls = [];
  const fn = async (name, args) => {
    calls.push({ name, args });
    if (value instanceof Error) throw value;
    return value;
  };
  fn.calls = calls;
  return fn;
}

function stubSession(userId = USER_ID) {
  const fn = async () => ({
    status: SESSION_RESULT.VALID,
    context: { user_id: userId, plan_id: 'web_pro', status: 'active' },
  });
  return fn;
}

function recordingLogger() {
  const lines = [];
  const rec = (...args) => lines.push(args.map((a) => String(a)).join(' '));
  return { lines, error: rec, warn: rec, log: rec, info: rec };
}

function req({ body = { session_id: SESSION_ID }, country = 'JP', origin = ORIGIN, method = 'POST' } = {}) {
  const headers = { cookie: SESSION_COOKIE_NAME + '=dummytoken' };
  if (origin) headers.origin = origin;
  const init = { method, headers };
  if (method === 'POST') {
    headers['content-type'] = 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const r = new Request('https://sukimacalendar.com/api/billing/conversion', init);
  if (country !== 'no-cf') Object.defineProperty(r, 'cf', { value: country === null ? undefined : { country } });
  return r;
}

async function run({ fx = fixtures(), env = ENV, request = req(), rpc = stubRpc(),
  stripe = null, session = stubSession(), logger = recordingLogger() } = {}) {
  const s = stripe ?? stubStripe(fx);
  const res = await handleBillingConversion(request, env, {
    rpc, stripe: s, session, logger, now: () => NOW_MS,
  });
  const body = await res.json();
  return { res, body, stripe: s, rpc, logger };
}

// ---------------------------------------------------------
// 1. 本番以外・日本以外では何もしない
// ---------------------------------------------------------

test('ADS_CONVERSION_MODE が live でなければ disabled（session / RPC / Stripe に触れない）', async () => {
  for (const mode of [undefined, '', 'LIVE', 'debug', 'true']) {
    const env = { ...ENV, ADS_CONVERSION_MODE: mode };
    let sessionCalled = false;
    const r = await run({ env, session: async () => { sessionCalled = true; return {}; } });
    assert.equal(r.res.status, 200);
    assert.deepEqual(r.body, { state: 'disabled' });
    assert.equal(sessionCalled, false);
    assert.equal(r.stripe.calls.length, 0);
    assert.equal(r.rpc.calls.length, 0);
  }
});

test('日本以外・国が不明なら disabled', async () => {
  for (const country of ['US', 'GB', 'XX', null]) {
    const r = await run({ request: req({ country }) });
    assert.deepEqual(r.body, { state: 'disabled' }, String(country));
    assert.equal(r.stripe.calls.length, 0);
  }
  // request.cf が無い（ローカル）
  const r = await run({ request: req({ country: 'no-cf' }) });
  assert.deepEqual(r.body, { state: 'disabled' });
});

// ---------------------------------------------------------
// 2. 正常系
// ---------------------------------------------------------

test('初回の有料契約なら eligible（値は割引後の実支払額・JPY、送信先はサーバーが決める）', async () => {
  const r = await run();
  assert.equal(r.res.status, 200);
  assert.equal(r.res.headers.get('Cache-Control'), 'no-store');
  assert.equal(r.body.state, 'eligible');
  assert.equal(r.body.send_to, GOOGLE_ADS_CONVERSION_SEND_TO);
  assert.equal(r.body.value, 300);
  assert.equal(r.body.currency, 'JPY');
  assert.equal(r.body.transaction_id, await buildTransactionId('sub_new'));
  assert.match(r.body.transaction_id, /^sukima_sub_[0-9a-f]{40}$/);
  assert.ok(r.body.transaction_id.length <= 64);
  // 応答に Stripe の ID・user_id を含めない
  const raw = JSON.stringify(r.body);
  for (const s of ['sub_new', 'cus_1', 'in_first', SESSION_ID, USER_ID]) {
    assert.equal(raw.includes(s), false, s);
  }
});

test('transaction_id は同じ subscription なら毎回同じ（再読み込み・別タブで Google 側の重複除外が効く）', async () => {
  const a = await run();
  const b = await run();
  assert.equal(a.body.transaction_id, b.body.transaction_id);
});

test('反映の照合は Cookie session の user_id と今回の subscription ID で行う', async () => {
  const r = await run();
  assert.equal(r.rpc.calls.length, 1);
  assert.equal(r.rpc.calls[0].name, RPC_BILLING_REFLECTION);
  assert.deepEqual(r.rpc.calls[0].args, { p_user_id: USER_ID, p_stripe_subscription_id: 'sub_new' });
});

test('Stripe へは GET だけ。subscription の最新の請求（latest_invoice）は取りに行かない', async () => {
  const r = await run();
  assert.ok(r.stripe.calls.every((c) => c.method === 'GET'));
  assert.equal(r.stripe.calls.some((c) => c.path.includes('in_latest_should_not_be_used')), false);
  assert.ok(r.stripe.calls.some((c) => c.path === '/v1/invoices/in_first'));
});

test('割引で金額が下がった場合はその額を送る', async () => {
  const fx = fixtures({ invoice: { amount_paid: 150 } });
  const r = await run({ fx });
  assert.equal(r.body.state, 'eligible');
  assert.equal(r.body.value, 150);
});

// ---------------------------------------------------------
// 3. 反映待ち・Stripe への負荷
// ---------------------------------------------------------

test('webhook の反映前は pending。Stripe は Session の取得 1 回だけ', async () => {
  const r = await run({ rpc: stubRpc([{ reflected: false }]) });
  assert.deepEqual(r.body, { state: 'pending' });
  assert.equal(r.stripe.calls.length, 1);
  assert.equal(r.stripe.calls[0].path, '/v1/checkout/sessions/' + SESSION_ID);
});

test('Session が未完了・未入金なら pending', async () => {
  assert.equal((await run({ fx: fixtures({ session: { status: 'open' } }) })).body.state, 'pending');
  assert.equal((await run({ fx: fixtures({ session: { payment_status: 'unpaid' } }) })).body.state, 'pending');
});

test('初回の請求がまだ open なら pending', async () => {
  const r = await run({ fx: fixtures({ invoice: { status: 'open' } }) });
  assert.equal(r.body.state, 'pending');
});

// ---------------------------------------------------------
// 4. 送らないケース
// ---------------------------------------------------------

test('他人の Checkout Session なら not_eligible（RPC も呼ばない）', async () => {
  const fx = fixtures({ session: { metadata: { user_id: OTHER_USER_ID } } });
  const r = await run({ fx });
  assert.deepEqual(r.body, { state: 'not_eligible' });
  assert.equal(r.rpc.calls.length, 0);
});

test('存在しない Session は not_eligible', async () => {
  const r = await run({ request: req({ body: { session_id: 'cs_live_doesNotExist' } }) });
  assert.deepEqual(r.body, { state: 'not_eligible' });
});

test('テストモード（livemode=false）の決済は送らない', async () => {
  const r = await run({ fx: fixtures({ session: { livemode: false } }) });
  assert.deepEqual(r.body, { state: 'not_eligible' });
});

test('100% 割引で支払いが無い Session（no_payment_required）は送らない', async () => {
  const r = await run({ fx: fixtures({ session: { payment_status: 'no_payment_required' } }) });
  assert.deepEqual(r.body, { state: 'not_eligible' });
});

test('初回の請求が 0 円なら送らない', async () => {
  const r = await run({ fx: fixtures({ invoice: { amount_paid: 0 } }) });
  assert.deepEqual(r.body, { state: 'not_eligible' });
});

test('更新の請求（subscription_cycle）は送らない', async () => {
  const r = await run({ fx: fixtures({ invoice: { billing_reason: 'subscription_cycle' } }) });
  assert.deepEqual(r.body, { state: 'not_eligible' });
});

test('請求が別の subscription / 別の顧客のものなら送らない', async () => {
  const a = await run({ fx: fixtures({ invoice: { parent: { subscription_details: { subscription: 'sub_other' } } } }) });
  assert.deepEqual(a.body, { state: 'not_eligible' });
  const b = await run({ fx: fixtures({ invoice: { customer: 'cus_other' } }) });
  assert.deepEqual(b.body, { state: 'not_eligible' });
});

test('JPY 以外の請求は送らない', async () => {
  const r = await run({ fx: fixtures({ invoice: { currency: 'usd' } }) });
  assert.deepEqual(r.body, { state: 'not_eligible' });
});

test('Sukima 有料プランの Price でない subscription は送らない', async () => {
  const fx = fixtures({ subscription: { items: { data: [{ price: { id: 'price_unrelated' } }] } } });
  const r = await run({ fx });
  assert.deepEqual(r.body, { state: 'not_eligible' });
});

test('請求先が販売国外・不明なら送らない', async () => {
  const a = await run({ fx: fixtures({ customer: { address: { country: 'US' } } }) });
  assert.deepEqual(a.body, { state: 'not_eligible' });
  const b = await run({ fx: fixtures({ customer: { address: null } }) });
  assert.deepEqual(b.body, { state: 'not_eligible' });
});

test('作成から 24 時間を過ぎた Session は送らない', async () => {
  const created = Math.floor((NOW_MS - MAX_SESSION_AGE_MS - 1000) / 1000);
  const r = await run({ fx: fixtures({ session: { created } }) });
  assert.deepEqual(r.body, { state: 'not_eligible' });
});

// ---------------------------------------------------------
// 5. 初回の請求の特定（Session に invoice が無いとき）
// ---------------------------------------------------------

test('Session に invoice が無いときは、その subscription の subscription_create の請求を使う', async () => {
  const fx = fixtures({
    session: { invoice: null },
    subscriptionPaidInvoices: [
      { id: 'in_renewal', billing_reason: 'subscription_cycle', status: 'paid' },
      { id: 'in_first', billing_reason: 'subscription_create', status: 'paid' },
    ],
  });
  const r = await run({ fx });
  assert.equal(r.body.state, 'eligible');
  const list = r.stripe.calls.find((c) => c.path === '/v1/invoices' && c.params?.subscription);
  assert.deepEqual({ subscription: list.params.subscription, status: list.params.status },
    { subscription: 'sub_new', status: 'paid' });
});

test('subscription_create の請求が見つからない・複数あるときは送らない', async () => {
  const none = await run({ fx: fixtures({ session: { invoice: null }, subscriptionPaidInvoices: [] }) });
  assert.deepEqual(none.body, { state: 'not_eligible' });
  const two = await run({
    fx: fixtures({
      session: { invoice: null },
      subscriptionPaidInvoices: [
        { id: 'in_a', billing_reason: 'subscription_create' },
        { id: 'in_b', billing_reason: 'subscription_create' },
      ],
    }),
  });
  assert.deepEqual(two.body, { state: 'not_eligible' });
});

// ---------------------------------------------------------
// 6. 過去の支払い実績（再契約の判定）
// ---------------------------------------------------------

const PRIOR_SUB = {
  id: 'sub_old',
  customer: 'cus_1',
  status: 'canceled',
  metadata: { user_id: USER_ID },
  items: { data: [{ price: { id: 'price_dummy_jpy_standard' } }] },
};

function priorInvoice(over = {}) {
  return {
    id: 'in_old',
    status: 'paid',
    billing_reason: 'subscription_create',
    amount_paid: 500,
    created: NOW_S - 86400 * 60,
    customer: 'cus_1',
    parent: { subscription_details: { subscription: 'sub_old' } },
    ...over,
  };
}

test('過去に Sukima 有料プランの支払い実績があれば再契約として送らない', async () => {
  const base = fixtures();
  const fx = fixtures({
    subscriptions: { sub_old: PRIOR_SUB },
    customerPaidInvoices: [base.invoices.in_first, priorInvoice()],
  });
  const r = await run({ fx });
  assert.deepEqual(r.body, { state: 'not_eligible' });
});

test('過去の支払いが返金済みでも、支払い実績として扱う（請求の status は paid のまま）', async () => {
  const base = fixtures();
  const fx = fixtures({
    subscriptions: { sub_old: PRIOR_SUB },
    customerPaidInvoices: [base.invoices.in_first, priorInvoice({ post_payment_credit_notes_amount: 500 })],
  });
  assert.deepEqual((await run({ fx })).body, { state: 'not_eligible' });
});

test('過去の契約が 0 円だけなら初回として送る', async () => {
  const base = fixtures();
  const fx = fixtures({
    subscriptions: { sub_old: PRIOR_SUB },
    customerPaidInvoices: [base.invoices.in_first, priorInvoice({ amount_paid: 0 })],
  });
  assert.equal((await run({ fx })).body.state, 'eligible');
});

test('過去の未払い・未完了の契約は除外理由にしない（支払い済みの一覧に出ない）', async () => {
  // status=paid で一覧を取るので、未払いの請求は一覧に現れない。
  const r = await run({ fx: fixtures({ subscriptions: { sub_old: PRIOR_SUB } }) });
  assert.equal(r.body.state, 'eligible');
  const list = r.stripe.calls.find((c) => c.path === '/v1/invoices' && c.params?.customer);
  assert.equal(list.params.status, 'paid');
});

test('同じ顧客の無関係な商品・単発請求は除外理由にしない', async () => {
  const base = fixtures();
  const fx = fixtures({
    subscriptions: {
      sub_other_product: {
        id: 'sub_other_product',
        customer: 'cus_1',
        metadata: {},
        items: { data: [{ price: { id: 'price_unrelated_product' } }] },
      },
    },
    customerPaidInvoices: [
      base.invoices.in_first,
      // 別商品の subscription の請求
      priorInvoice({ id: 'in_other', parent: { subscription_details: { subscription: 'sub_other_product' } } }),
      // subscription に属さない単発請求
      priorInvoice({ id: 'in_oneoff', parent: null, billing_reason: 'manual' }),
    ],
  });
  assert.equal((await run({ fx })).body.state, 'eligible');
});

test('今回より後の請求（更新の請求）は「過去の支払い」に数えない', async () => {
  const base = fixtures();
  const fx = fixtures({
    customerPaidInvoices: [
      base.invoices.in_first,
      priorInvoice({
        id: 'in_renewal',
        billing_reason: 'subscription_cycle',
        created: NOW_S + 86400 * 30,
        parent: { subscription_details: { subscription: 'sub_new' } },
      }),
    ],
  });
  assert.equal((await run({ fx })).body.state, 'eligible');
});

test('過去の subscription を取得できない場合は、請求の明細の Price で判断する', async () => {
  const base = fixtures();
  const fx = fixtures({
    customerPaidInvoices: [
      base.invoices.in_first,
      priorInvoice({
        parent: { subscription_details: { subscription: 'sub_deleted' } },
        lines: { data: [{ pricing: { price_details: { price: 'price_dummy_jpy_launch' } } }] },
      }),
    ],
  });
  assert.deepEqual((await run({ fx })).body, { state: 'not_eligible' });
});

// ---------------------------------------------------------
// 7. 失敗の扱い
// ---------------------------------------------------------

test('Stripe の一時障害は 502（ブラウザ側が回数の上限内で再試行する）', async () => {
  const fail = () => new StripeApiError('unavailable', 'down', { retryable: true });
  const r = await run({ stripe: stubStripe(fixtures(), { fail }) });
  assert.equal(r.res.status, 502);
  assert.deepEqual(r.body, { error: 'payment_provider_unavailable' });
  assert.equal(r.res.headers.get('Cache-Control'), 'no-store');
});

test('DB の障害は 502 database_unavailable', async () => {
  const r = await run({ rpc: stubRpc(new SupabaseError('unavailable', 'down')) });
  assert.equal(r.res.status, 502);
  assert.deepEqual(r.body, { error: 'database_unavailable' });
});

test('RPC の戻り値が想定と違えば 502（推測で送らない）', async () => {
  const r = await run({ rpc: stubRpc([]) });
  assert.equal(r.res.status, 502);
});

test('ログに Session / 顧客 / 契約 / 請求の ID、user_id、金額を出さない', async () => {
  const scenarios = [
    {},
    { rpc: stubRpc([{ reflected: false }]) },
    { fx: fixtures({ session: { livemode: false } }) },
    { stripe: stubStripe(fixtures(), { fail: () => new StripeApiError('unavailable', 'down cus_1', { retryable: true }) }) },
  ];
  for (const sc of scenarios) {
    const logger = recordingLogger();
    await run({ ...sc, logger });
    const text = logger.lines.join('\n');
    for (const s of [SESSION_ID, 'cus_1', 'sub_new', 'in_first', USER_ID, '300']) {
      assert.equal(text.includes(s), false, s + ' がログに出ている: ' + text);
    }
  }
});

// ---------------------------------------------------------
// 8. 入力検証
// ---------------------------------------------------------

test('validate: session_id の形だけを受け付け、余計なキーは拒否する', () => {
  assert.equal(validate({ session_id: SESSION_ID }).ok, true);
  assert.equal(validate({ session_id: 'cs_test_abc' }).ok, true);
  for (const bad of ['', 'cs_live_', 'cs_live_a/b', 'sub_123', 'cs_live_abc?x=1', 123, null]) {
    assert.deepEqual(validate({ session_id: bad }), { ok: false, code: 'invalid_session_id' }, String(bad));
  }
  assert.deepEqual(validate({ session_id: SESSION_ID, value: 1 }), { ok: false, code: 'unknown_field' });
});

test('不正な session_id は 400、Origin 違いは 403、POST 以外は 405', async () => {
  assert.equal((await run({ request: req({ body: { session_id: '../x' } }) })).res.status, 400);
  assert.equal((await run({ request: req({ origin: 'https://evil.example' }) })).res.status, 403);
  assert.equal((await run({ request: req({ method: 'GET' }) })).res.status, 405);
});

// ---------------------------------------------------------
// 9. GET /api/ads/tag-config
// ---------------------------------------------------------

function tagReq({ method = 'GET', country = 'JP' } = {}) {
  const r = new Request('https://sukimacalendar.com/api/ads/tag-config', { method });
  if (country !== 'no-cf') Object.defineProperty(r, 'cf', { value: country === null ? undefined : { country } });
  return r;
}

test('tag-config: 本番設定かつ日本からのときだけタグ ID を返す（キャッシュさせない）', async () => {
  const on = handleAdsTagConfig(tagReq(), ENV);
  assert.equal(on.status, 200);
  assert.equal(on.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await on.json(), { enabled: true, tag_id: GOOGLE_ADS_TAG_ID });

  for (const [request, env] of [
    [tagReq(), { ...ENV, ADS_CONVERSION_MODE: undefined }],
    [tagReq(), { ...ENV, ADS_CONVERSION_MODE: 'debug' }],
    [tagReq({ country: 'US' }), ENV],
    [tagReq({ country: null }), ENV],
    [tagReq({ country: 'no-cf' }), ENV],
  ]) {
    const res = handleAdsTagConfig(request, env);
    assert.deepEqual(await res.json(), { enabled: false });
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
  }
});

test('tag-config: GET 以外は 405', async () => {
  const res = handleAdsTagConfig(tagReq({ method: 'POST' }), ENV);
  assert.equal(res.status, 405);
});

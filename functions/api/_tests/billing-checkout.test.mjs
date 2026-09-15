// =========================================================
// POST /api/billing/checkout の単体テスト
//
//   - **実 DB / 実 Stripe へ接続しない。** session / RPC / Stripe をスタブ化する。
//   - **本番の billing-config を書き換えない。** draft の経路は
//     `currentVersion` を注入して再現する（terms-consent.test.mjs と同じ流儀）。
//   - 本番の secret / Price ID / Project URL はフィクスチャに保存しない。
//
//   このテストが守るもの:
//     - **client が価格・通貨・国・プラン・版・user_id を指定できないこと**
//     - **価格解決が resolvePurchasablePrice() 経由であること**（販売停止を素通りしない）
//     - **entitlement を付与しないこと**（DB へ書かない / RPC は読み取り 1 本だけ）
//     - **1 user = 1 active subscription / 1 Stripe Customer**
//     - **18 歳確認と規約同意が無ければ Stripe を呼ばないこと**
//     - 応答・ログに PII と secret を出さないこと
// =========================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ALLOWED_BODY_KEYS,
  CHECKOUT_PATH,
  CHECKOUT_PLAN_ID,
  RESUBSCRIBABLE_STATUSES,
  RPC_NAME,
  buildCheckoutParams,
  buildIdempotencyKey,
  buildLegalUrls,
  buildSubmitMessage,
  canStartCheckout,
  handleBillingCheckout,
  mapStripeError,
  readCustomerId,
  resolveCheckoutMarket,
  resolveSiteOrigin,
  validate,
} from '../billing/checkout.js';
import { SESSION_COOKIE_NAME, SESSION_RESULT } from '../_lib/session.js';
import { SupabaseError } from '../_lib/supabase.js';
import { StripeApiError, encodeStripeParams } from '../_lib/stripe.js';
import {
  PURCHASABLE_COUNTRIES,
  PURCHASABLE_CURRENCIES,
  SUBSCRIPTION_TERMS_CONFIG,
  SubscriptionTermsConfigError,
} from '../_lib/billing-config.js';

/** ダミー値のみ。**本番の Price ID / secret は書かない。** */
const ENV = {
  SUPABASE_URL: 'https://example-project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_dummy_for_tests_only',
  STRIPE_SECRET_KEY: 'sk_test_dummy_for_tests_only',
  STRIPE_PRICE_WEB_PRO_JPY_LAUNCH: 'price_dummy_jpy_launch',
  STRIPE_PRICE_WEB_PRO_JPY_STANDARD: 'price_dummy_jpy_standard',
};

const quiet = { error() {}, warn() {}, log() {} };

/** 本番の canonical host。_lib/origin.js の既定 allowlist と同じ値。 */
const ORIGIN = 'https://sukimacalendar.com';

/** テスト用のダミー user_id。実際の users.id ではない。 */
const USER_ID = '11111111-2222-3333-4444-555555555555';

/** launch 期間内の固定時刻（LAUNCH_END_AT = 2027-01-01T00:00:00Z より前）。 */
const NOW_LAUNCH = Date.parse('2026-09-09T00:00:00.000Z');
/** launch 終了後の固定時刻。 */
const NOW_STANDARD = Date.parse('2027-02-01T00:00:00.000Z');

const CHECKOUT_URL = 'https://checkout.stripe.com/c/pay/cs_test_dummy';

function req({
  method = 'POST',
  body = JSON.stringify({ locale: 'ja', age_confirmed: true }),
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
  return new Request('https://example.com/api/billing/checkout', init);
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

/** get_checkout_context の戻り値スタブ。既定は「free / 同意済み / Customer 無し」。 */
function stubRpc(rows, over = {}) {
  const value = rows ?? [{
    plan_id: 'free',
    status: 'active',
    stripe_customer_id: null,
    terms_consented: true,
    ...over,
  }];
  const calls = [];
  const fn = async (name, args, options) => {
    calls.push({ name, args, options });
    if (value instanceof Error) throw value;
    return value;
  };
  fn.calls = calls;
  return fn;
}

/** Stripe スタブ。既定は Checkout Session を 1 つ返す。 */
function stubStripe(result) {
  const value = result ?? { id: 'cs_test_dummy', url: CHECKOUT_URL, expires_at: 1789000000 };
  const calls = [];
  const fn = async (o) => {
    calls.push(o);
    if (value instanceof Error) throw value;
    return value;
  };
  fn.calls = calls;
  return fn;
}

function deps(over = {}) {
  return {
    session: stubSession(),
    rpc: stubRpc(),
    stripe: stubStripe(),
    logger: quiet,
    now: () => NOW_LAUNCH,
    ...over,
  };
}

async function call(d, request = req()) {
  const res = await handleBillingCheckout(request, ENV, d);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* JSON でない応答も見る */ }
  return { res, body, text };
}


// =========================================================
// 1. method / Origin / session
// =========================================================

test('POST 以外は 405 で、session も RPC も Stripe も触らない', async () => {
  for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
    const d = deps();
    const { res, body } = await call(d, req({ method }));
    assert.equal(res.status, 405, method);
    assert.deepEqual(body, { error: 'method_not_allowed' });
    assert.equal(d.session.calls.length, 0, method);
    assert.equal(d.rpc.calls.length, 0, method);
    assert.equal(d.stripe.calls.length, 0, method);
  }
});

test('Origin が不正なら 403 で、session も RPC も Stripe も触らない', async () => {
  for (const origin of ['https://evil.example.com', 'null', null]) {
    const d = deps();
    const { res, body } = await call(d, req({ origin }));
    assert.equal(res.status, 403, String(origin));
    assert.deepEqual(body, { error: 'forbidden_origin' });
    assert.equal(d.session.calls.length, 0, String(origin));
    assert.equal(d.rpc.calls.length, 0, String(origin));
    assert.equal(d.stripe.calls.length, 0, String(origin));
  }
});

test('未認証は 401 で、RPC も Stripe も呼ばない', async () => {
  const d = deps({ session: stubSession({ status: SESSION_RESULT.UNAUTHENTICATED }) });
  const { res, body } = await call(d);
  assert.equal(res.status, 401);
  assert.deepEqual(body, { error: 'unauthenticated' });
  assert.equal(d.rpc.calls.length, 0);
  assert.equal(d.stripe.calls.length, 0);
});

test('session が DB 障害なら 502 で Stripe を呼ばない', async () => {
  const d = deps({
    session: stubSession({ status: SESSION_RESULT.UNAVAILABLE, reason: 'boom' }),
  });
  const { res, body } = await call(d);
  assert.equal(res.status, 502);
  assert.deepEqual(body, { error: 'database_unavailable' });
  assert.equal(d.stripe.calls.length, 0);
});


// =========================================================
// 2. body — client が価格や利用者を指定できないこと
// =========================================================

test('受け付ける body キーは locale と age_confirmed だけ', () => {
  assert.deepEqual([...ALLOWED_BODY_KEYS], ['locale', 'age_confirmed']);
});

test('価格や利用者を指定しようとする body は 400 unknown_field', async () => {
  const forbidden = [
    { price_id: 'price_x' },
    { amount: 1 },
    { currency: 'usd' },
    { country: 'US' },
    { plan_id: 'all_pro' },
    { user_id: '00000000-0000-4000-8000-000000000000' },
    { terms_version: '1999-01-01' },
    { phase: 'launch' },
    { interval: 'year' },
    { customer: 'cus_x' },
    { success_url: 'https://evil.example.com' },
  ];
  for (const extra of forbidden) {
    const d = deps();
    const { res, body } = await call(d, req({
      body: JSON.stringify({ locale: 'ja', age_confirmed: true, ...extra }),
    }));
    assert.equal(res.status, 400, JSON.stringify(extra));
    assert.deepEqual(body, { error: 'unknown_field' }, JSON.stringify(extra));
    assert.equal(d.rpc.calls.length, 0, JSON.stringify(extra));
    assert.equal(d.stripe.calls.length, 0, JSON.stringify(extra));
  }
});

test('locale は ja / en のみ。大文字や未対応は 400', async () => {
  for (const locale of ['JA', 'fr', '', ' ja', 1, null, undefined]) {
    const d = deps();
    const { res, body } = await call(d, req({
      body: JSON.stringify({ locale, age_confirmed: true }),
    }));
    assert.equal(res.status, 400, String(locale));
    assert.deepEqual(body, { error: 'invalid_locale' }, String(locale));
    assert.equal(d.stripe.calls.length, 0, String(locale));
  }
});

test('18 歳確認が無い / true でなければ 400 age_confirmation_required', async () => {
  for (const value of [undefined, false, 'true', 1, 'on', null, {}]) {
    const d = deps();
    const body0 = value === undefined
      ? { locale: 'ja' }
      : { locale: 'ja', age_confirmed: value };
    const { res, body } = await call(d, req({ body: JSON.stringify(body0) }));
    assert.equal(res.status, 400, String(value));
    assert.deepEqual(body, { error: 'age_confirmation_required' }, String(value));
    assert.equal(d.rpc.calls.length, 0, String(value));
    assert.equal(d.stripe.calls.length, 0, String(value));
  }
});

test('body が壊れていたら 400 で RPC も Stripe も呼ばない', async () => {
  const cases = [
    ['{locale:', 'malformed_json'],
    ['[]', 'invalid_body'],
    ['"ja"', 'invalid_body'],
    ['null', 'invalid_body'],
  ];
  for (const [raw, code] of cases) {
    const d = deps();
    const { res, body } = await call(d, req({ body: raw }));
    assert.equal(res.status, 400, raw);
    assert.deepEqual(body, { error: code }, raw);
    assert.equal(d.rpc.calls.length, 0, raw);
    assert.equal(d.stripe.calls.length, 0, raw);
  }
});

test('validate は純粋関数として同じ判定をする', () => {
  assert.deepEqual(validate({ locale: 'ja', age_confirmed: true }),
    { ok: true, value: { locale: 'ja', age_confirmed: true } });
  assert.deepEqual(validate({ locale: 'en', age_confirmed: true }),
    { ok: true, value: { locale: 'en', age_confirmed: true } });
  assert.deepEqual(validate({ locale: 'ja', age_confirmed: false }),
    { ok: false, code: 'age_confirmation_required' });
  assert.deepEqual(validate({ locale: 'JA', age_confirmed: true }),
    { ok: false, code: 'invalid_locale' });
  assert.deepEqual(validate({ locale: 'ja', age_confirmed: true, price_id: 'x' }),
    { ok: false, code: 'unknown_field' });
});


// =========================================================
// 3. 規約の版は server が決める
// =========================================================

test('前提: 本番の Subscription Terms 設定は published', () => {
  assert.equal(SUBSCRIPTION_TERMS_CONFIG.status, 'published');
  assert.match(String(SUBSCRIPTION_TERMS_CONFIG.version), /^\d{4}-\d{2}-\d{2}(?:-\d+)?$/);
});

test('draft を再現すると 503 terms_not_available で Stripe を呼ばない', async () => {
  const d = deps({
    currentVersion: () => { throw new SubscriptionTermsConfigError('not_published', 'draft'); },
  });
  const { res, body } = await call(d);
  assert.equal(res.status, 503);
  assert.deepEqual(body, { error: 'terms_not_available' });
  assert.equal(d.rpc.calls.length, 0);
  assert.equal(d.stripe.calls.length, 0);
});

test('現行版が文字列でなければ 503（契約違反を成功にしない）', async () => {
  for (const bad of [null, undefined, '', 0, {}]) {
    const d = deps({ currentVersion: () => bad });
    const { res, body } = await call(d);
    assert.equal(res.status, 503, JSON.stringify(bad));
    assert.deepEqual(body, { error: 'terms_not_available' }, JSON.stringify(bad));
    assert.equal(d.stripe.calls.length, 0, JSON.stringify(bad));
  }
});

test('RPC と metadata へ渡る版は server config の値', async () => {
  const d = deps();
  await call(d);
  assert.equal(d.rpc.calls[0].args.p_terms_version, SUBSCRIPTION_TERMS_CONFIG.version);
  assert.equal(d.stripe.calls[0].params.metadata.terms_version,
    SUBSCRIPTION_TERMS_CONFIG.version);
});


// =========================================================
// 4. 販売可否と価格解決
// =========================================================

test('販売できる市場は billing-config の購入可能集合から決まる', () => {
  const market = resolveCheckoutMarket();
  assert.deepEqual(market, { ok: true, country: 'JP', currency: 'jpy' });
  assert.deepEqual([...PURCHASABLE_COUNTRIES], ['JP']);
  assert.deepEqual([...PURCHASABLE_CURRENCIES], ['jpy']);
});

test('launch 期間中は JPY launch の Price ID が使われる', async () => {
  const d = deps({ now: () => NOW_LAUNCH });
  const { res } = await call(d);
  assert.equal(res.status, 200);
  assert.equal(d.stripe.calls[0].params.line_items[0].price,
    ENV.STRIPE_PRICE_WEB_PRO_JPY_LAUNCH);
  assert.equal(d.stripe.calls[0].params.metadata.price_phase, 'launch');
});

test('launch 終了後は JPY standard の Price ID が使われる（server 判定）', async () => {
  const d = deps({ now: () => NOW_STANDARD });
  const { res } = await call(d);
  assert.equal(res.status, 200);
  assert.equal(d.stripe.calls[0].params.line_items[0].price,
    ENV.STRIPE_PRICE_WEB_PRO_JPY_STANDARD);
  assert.equal(d.stripe.calls[0].params.metadata.price_phase, 'standard');
});

test('USD の Price は Checkout に使わない', async () => {
  const d = deps();
  await call(d);
  const encoded = encodeStripeParams(d.stripe.calls[0].params).toString();
  assert.equal(encoded.includes('usd'), false);
  assert.equal(encoded.includes('STRIPE_PRICE_WEB_PRO_USD_LAUNCH'), false);
});

test('now が解釈できないときは売らない（503 sales_unavailable）', async () => {
  const d = deps({ now: () => NaN });
  const { res, body } = await call(d);
  assert.equal(res.status, 503);
  assert.deepEqual(body, { error: 'sales_unavailable' });
  assert.equal(d.rpc.calls.length, 0);
  assert.equal(d.stripe.calls.length, 0);
});

test('Price ID の環境変数が無ければ 500 で、値をログにも応答にも出さない', async () => {
  const seen = [];
  const logger = { warn() {}, log() {}, error(...a) { seen.push(a.join(' ')); } };
  const envWithout = { ...ENV, STRIPE_PRICE_WEB_PRO_JPY_LAUNCH: '   ' };
  const d = deps({ logger });
  const res = await handleBillingCheckout(req(), envWithout, d);
  const text = await res.text();
  assert.equal(res.status, 500);
  assert.deepEqual(JSON.parse(text), { error: 'server_misconfigured' });
  assert.equal(d.rpc.calls.length, 0);
  assert.equal(d.stripe.calls.length, 0);
  // ログに出てよいのは**環境変数名**まで。実値は出さない。
  assert.ok(seen.some((l) => l.includes('STRIPE_PRICE_WEB_PRO_JPY_LAUNCH')));
  assert.equal(seen.join(' ').includes(ENV.STRIPE_PRICE_WEB_PRO_JPY_LAUNCH), false);
});


// =========================================================
// 5. get_checkout_context（読み取り専用）
// =========================================================

test('RPC は読み取り専用の 1 本だけを 1 回呼ぶ（entitlement を書かない）', async () => {
  const d = deps();
  const { res } = await call(d);
  assert.equal(res.status, 200);
  assert.equal(d.rpc.calls.length, 1);
  assert.equal(d.rpc.calls[0].name, RPC_NAME);
  assert.equal(RPC_NAME, 'get_checkout_context');
  // 書き込み系の RPC を呼んでいないこと
  for (const write of ['apply_stripe_subscription_event', 'record_terms_consent',
                       'upsert_user_and_subscription']) {
    assert.equal(d.rpc.calls.some((c) => c.name === write), false, write);
  }
});

test('RPC へ渡す user_id は session 由来（body では変えられない）', async () => {
  const d = deps();
  await call(d, req({
    body: JSON.stringify({ locale: 'ja', age_confirmed: true }),
  }));
  assert.equal(d.rpc.calls[0].args.p_user_id, USER_ID);
  assert.deepEqual(Object.keys(d.rpc.calls[0].args).sort(),
    ['p_terms_version', 'p_user_id']);
});

test('RPC が失敗したら 502 database_unavailable で Stripe を呼ばない', async () => {
  const d = deps({ rpc: stubRpc(new SupabaseError('unavailable', 'boom')) });
  const { res, body } = await call(d);
  assert.equal(res.status, 502);
  assert.deepEqual(body, { error: 'database_unavailable' });
  assert.equal(d.stripe.calls.length, 0);
});

test('RPC が 0 行 / 複数行を返したら 500（free として扱わない）', async () => {
  for (const rows of [[], [{ plan_id: 'free' }, { plan_id: 'free' }], null, 'x']) {
    const d = deps({ rpc: stubRpc(rows === null ? [] : rows) });
    const { res, body } = await call(d);
    assert.equal(res.status, 500, JSON.stringify(rows));
    assert.deepEqual(body, { error: 'internal_error' }, JSON.stringify(rows));
    assert.equal(d.stripe.calls.length, 0, JSON.stringify(rows));
  }
});

test('plan_id / status が欠けていたら 500（推測しない）', async () => {
  const d = deps({ rpc: stubRpc([{ terms_consented: true }]) });
  const { res, body } = await call(d);
  assert.equal(res.status, 500);
  assert.deepEqual(body, { error: 'internal_error' });
  assert.equal(d.stripe.calls.length, 0);
});


// =========================================================
// 6. 1 user = 1 active subscription
// =========================================================

test('再契約してよい status は canceled / incomplete_expired だけ', () => {
  assert.deepEqual([...RESUBSCRIBABLE_STATUSES], ['canceled', 'incomplete_expired']);
});

test('契約が生きているあいだは 409 already_subscribed で Stripe を呼ばない', async () => {
  const live = ['active', 'trialing', 'past_due', 'unpaid', 'incomplete'];
  for (const status of live) {
    for (const planId of ['web_pro', 'all_pro', 'extension_pro']) {
      const d = deps({ rpc: stubRpc(null, { plan_id: planId, status }) });
      const { res, body } = await call(d);
      assert.equal(res.status, 409, planId + '/' + status);
      assert.deepEqual(body, { error: 'already_subscribed' }, planId + '/' + status);
      assert.equal(d.stripe.calls.length, 0, planId + '/' + status);
    }
  }
});

test('解約済み / 期限切れなら再契約できる', async () => {
  for (const status of RESUBSCRIBABLE_STATUSES) {
    const d = deps({ rpc: stubRpc(null, { plan_id: 'web_pro', status }) });
    const { res } = await call(d);
    assert.equal(res.status, 200, status);
    assert.equal(d.stripe.calls.length, 1, status);
  }
});

test('無料プランなら status によらず開始できる', async () => {
  for (const status of ['active', 'canceled']) {
    const d = deps({ rpc: stubRpc(null, { plan_id: 'free', status }) });
    const { res } = await call(d);
    assert.equal(res.status, 200, status);
  }
});

test('canStartCheckout は純粋関数として同じ判定をする', () => {
  assert.deepEqual(canStartCheckout({ plan_id: 'free', status: 'active' }), { ok: true });
  assert.deepEqual(canStartCheckout({ plan_id: 'web_pro', status: 'canceled' }), { ok: true });
  assert.deepEqual(canStartCheckout({ plan_id: 'web_pro', status: 'active' }),
    { ok: false, code: 'already_subscribed' });
  assert.deepEqual(canStartCheckout({ plan_id: 'web_pro' }),
    { ok: false, code: 'invalid_context' });
  assert.deepEqual(canStartCheckout(null), { ok: false, code: 'invalid_context' });
});


// =========================================================
// 7. 規約同意が無ければ開始しない
// =========================================================

test('現行版へ同意していなければ 409 terms_consent_required', async () => {
  for (const value of [false, null, undefined, 'true', 1]) {
    const d = deps({ rpc: stubRpc(null, { terms_consented: value }) });
    const { res, body } = await call(d);
    assert.equal(res.status, 409, String(value));
    assert.deepEqual(body, { error: 'terms_consent_required' }, String(value));
    assert.equal(d.stripe.calls.length, 0, String(value));
  }
});

test('同意の記録は checkout では行わない（consent API の責務）', async () => {
  const d = deps({ rpc: stubRpc(null, { terms_consented: false }) });
  await call(d);
  assert.equal(d.rpc.calls.length, 1);
  assert.equal(d.rpc.calls[0].name, RPC_NAME);
});


// =========================================================
// 8. Stripe へ渡す内容
// =========================================================

test('Checkout Session を POST で 1 回だけ作る', async () => {
  const d = deps();
  await call(d);
  assert.equal(d.stripe.calls.length, 1);
  const sent = d.stripe.calls[0];
  assert.equal(sent.method, 'POST');
  assert.equal(sent.path, CHECKOUT_PATH);
  assert.equal(sent.path, '/v1/checkout/sessions');
  assert.equal(sent.env, ENV);
});

test('subscription mode / 数量 1 / プロモーションコード入力有効', async () => {
  const d = deps();
  await call(d);
  const p = d.stripe.calls[0].params;
  assert.equal(p.mode, 'subscription');
  assert.equal(p.line_items.length, 1);
  assert.equal(p.line_items[0].quantity, 1);
  // Stripe 側の Promotion Code を使う（duration=once 運用）
  assert.equal(p.allow_promotion_codes, true);
  assert.equal(p.billing_address_collection, 'required');
  // 税の登録判断が未決なので automatic_tax は有効にしない
  assert.equal('automatic_tax' in p, false);
});

test('クーポンを有効にしても line_items は launch price のまま', async () => {
  const d = deps();
  await call(d);
  const p = d.stripe.calls[0].params;
  // 割引は price_id を変えない。ここが崩れると plan / phase 判定が崩れる。
  assert.equal(p.line_items[0].price, ENV.STRIPE_PRICE_WEB_PRO_JPY_LAUNCH);
  assert.equal(p.metadata.price_phase, 'launch');
  assert.equal(p.subscription_data.metadata.price_phase, 'launch');
});

test('launch 終了後でもクーポン有効のまま standard price を使う', async () => {
  const d = deps({ now: () => NOW_STANDARD });
  await call(d);
  const p = d.stripe.calls[0].params;
  assert.equal(p.allow_promotion_codes, true);
  assert.equal(p.line_items[0].price, ENV.STRIPE_PRICE_WEB_PRO_JPY_STANDARD);
  assert.equal(p.metadata.price_phase, 'standard');
});

test('クーポンコード自体を params へハードコードしない', async () => {
  const d = deps();
  await call(d);
  const p = d.stripe.calls[0].params;
  // クーポンの正は Stripe 側。server から coupon / 割引を指定しない。
  assert.equal('discounts' in p, false);
  assert.equal('coupon' in p, false);
  assert.equal('promotion_code' in p, false);
  assert.equal('discounts' in p.subscription_data, false);
  assert.equal('coupon' in p.subscription_data, false);
});

test('locale / customer の有無で Checkout params が壊れない', () => {
  for (const locale of ['ja', 'en']) {
    for (const customerId of [null, 'cus_dummy_for_tests_only']) {
      const label = `${locale}/${String(customerId)}`;
      const params = buildCheckoutParams({
        userId: USER_ID,
        priceId: 'price_dummy',
        planId: 'web_pro',
        phase: 'launch',
        termsVersion: '2026-09-09',
        locale,
        origin: ORIGIN,
        customerId,
        confirmedAt: '2026-09-09T00:00:00.000Z',
      });
      // どの組み合わせでも入力欄は出す
      assert.equal(params.allow_promotion_codes, true, label);
      assert.equal(params.mode, 'subscription', label);
      assert.equal(params.locale, locale, label);
      assert.equal(params.line_items[0].price, 'price_dummy', label);
      assert.equal(params.line_items[0].quantity, 1, label);
      assert.equal(params.billing_address_collection, 'required', label);
      assert.equal(params.metadata.user_id, USER_ID, label);
      assert.deepEqual(params.subscription_data.metadata, params.metadata, label);
      // customer ありのときだけ customer_update が付く（Stripe の制約）
      if (customerId === null) {
        assert.equal('customer' in params, false, label);
        assert.equal('customer_update' in params, false, label);
      } else {
        assert.equal(params.customer, customerId, label);
        assert.deepEqual(params.customer_update, { address: 'auto' }, label);
      }
      // Stripe のフォーム形式へもそのまま流せる
      const encoded = encodeStripeParams(params);
      assert.equal(encoded.get('allow_promotion_codes'), 'true', label);
    }
  }
});

test('metadata と subscription_data.metadata に user_id が必ず入る', async () => {
  const d = deps();
  await call(d);
  const p = d.stripe.calls[0].params;
  assert.equal(p.metadata.user_id, USER_ID);
  assert.equal(p.subscription_data.metadata.user_id, USER_ID);
  // webhook は subscription 側の metadata を正とする
  assert.deepEqual(p.subscription_data.metadata, p.metadata);
});

test('metadata の plan / phase / 版 / locale は server が決めた値', async () => {
  const d = deps();
  await call(d, req({ body: JSON.stringify({ locale: 'en', age_confirmed: true }) }));
  const m = d.stripe.calls[0].params.metadata;
  assert.equal(m.plan_id, CHECKOUT_PLAN_ID);
  assert.equal(m.plan_id, 'web_pro');
  assert.equal(m.price_phase, 'launch');
  assert.equal(m.terms_version, SUBSCRIPTION_TERMS_CONFIG.version);
  assert.equal(m.terms_locale, 'en');
  assert.equal(m.age_confirmed, 'true');
  assert.equal(m.age_confirmed_at, new Date(NOW_LAUNCH).toISOString());
});

test('既知の Customer は必ず再利用する（1 user = 1 Customer）', async () => {
  const d = deps({ rpc: stubRpc(null, { stripe_customer_id: 'cus_existing_dummy' }) });
  await call(d);
  assert.equal(d.stripe.calls[0].params.customer, 'cus_existing_dummy');
});

test('再契約では Customer の住所を最新化する（customer_update: address auto）', async () => {
  // 初回は日本、再契約で別の国、という住所据え置きを防ぐための補助防御。
  const d = deps({ rpc: stubRpc(null, { stripe_customer_id: 'cus_existing_dummy' }) });
  await call(d);
  assert.deepEqual(d.stripe.calls[0].params.customer_update, { address: 'auto' });
});

test('新規利用者には customer_update を送らない（Stripe が拒否するため）', async () => {
  // 実 API は `customer_update can only be used with customer` を返す。
  // customer を渡さないときに付けると Checkout の作成自体が失敗する。
  const d = deps();
  await call(d);
  const p = d.stripe.calls[0].params;
  assert.equal('customer' in p, false);
  assert.equal('customer_update' in p, false);
});

test('Customer が未記録なら customer を渡さない（Stripe が作る）', async () => {
  for (const value of [null, undefined, '', '   ', 42]) {
    const d = deps({ rpc: stubRpc(null, { stripe_customer_id: value }) });
    await call(d);
    assert.equal('customer' in d.stripe.calls[0].params, false, String(value));
  }
});

test('readCustomerId は空白と非文字列を弾く', () => {
  assert.equal(readCustomerId({ stripe_customer_id: ' cus_x ' }), 'cus_x');
  assert.equal(readCustomerId({ stripe_customer_id: '' }), null);
  assert.equal(readCustomerId({ stripe_customer_id: null }), null);
  assert.equal(readCustomerId({}), null);
  assert.equal(readCustomerId(null), null);
});

test('戻り先 URL は allowlist の origin から作る', async () => {
  const d = deps();
  await call(d);
  const p = d.stripe.calls[0].params;
  assert.equal(p.success_url, ORIGIN + '/billing/success?session_id={CHECKOUT_SESSION_ID}');
  assert.equal(p.cancel_url, ORIGIN + '/billing/cancel');
});

test('ALLOWED_ORIGINS を差し替えると戻り先もそちらになる', () => {
  assert.equal(resolveSiteOrigin({}), ORIGIN);
  assert.equal(resolveSiteOrigin({ ALLOWED_ORIGINS: 'http://127.0.0.1:8788' }),
    'http://127.0.0.1:8788');
});

test('購入前確認に特商法ページと規約の URL を含める', async () => {
  const d = deps();
  await call(d);
  const message = d.stripe.calls[0].params.custom_text.submit.message;
  assert.ok(message.includes(ORIGIN + '/legal/commercial-transactions'), message);
  assert.ok(message.includes(ORIGIN + '/terms/subscription'), message);
  assert.ok(message.length <= 1200, 'custom_text の上限（1200）を超えない');
});

test('英語ロケールでは英語ページと英語の確認文になる', async () => {
  const d = deps();
  await call(d, req({ body: JSON.stringify({ locale: 'en', age_confirmed: true }) }));
  const p = d.stripe.calls[0].params;
  assert.equal(p.locale, 'en');
  const message = p.custom_text.submit.message;
  assert.ok(message.includes(ORIGIN + '/terms/subscription/en'), message);
  assert.ok(message.includes('Subscription Terms'), message);
});

test('buildLegalUrls / buildSubmitMessage は locale ごとに対応する', () => {
  assert.deepEqual(buildLegalUrls(ORIGIN, 'ja'), {
    subscription_terms: ORIGIN + '/terms/subscription',
    commercial_transactions: ORIGIN + '/legal/commercial-transactions',
  });
  assert.deepEqual(buildLegalUrls(ORIGIN, 'en'), {
    subscription_terms: ORIGIN + '/terms/subscription/en',
    commercial_transactions: ORIGIN + '/legal/commercial-transactions',
  });
  const ja = buildSubmitMessage('ja', buildLegalUrls(ORIGIN, 'ja'));
  assert.match(ja, /特定商取引法に基づく表記/);
  assert.match(ja, /毎月自動で更新/);
});

test('Idempotency-Key は同じ params なら同じ', async () => {
  const d = deps();
  await call(d);
  const key = d.stripe.calls[0].idempotencyKey;
  const sameParams = await buildIdempotencyKey(USER_ID, NOW_LAUNCH, d.stripe.calls[0].params);
  assert.equal(key, sameParams);
  assert.match(key, new RegExp('^checkout:' + USER_ID + ':2026-09-09:[0-9a-f]{16}$'));
  assert.ok(key.length <= 255);
  // ヘッダへ載せる値なので制御文字を含まないこと
  assert.ok([...key].every((c) => c.charCodeAt(0) > 31 && c.charCodeAt(0) !== 127));
});

test('customer の有無で Idempotency-Key が変わる（実 Stripe で踏んだ事故の再発防止）', async () => {
  // 同じ日のうちに「新規契約（customer なし）」->「解約後の再契約（customer あり）」
  // と進むと params が変わる。キーが同じままだと Stripe が
  // 「同じキーで違う params」を拒否し、2 回目の Checkout が 502 になる。
  const withoutCustomer = deps();
  await call(withoutCustomer);

  const withCustomer = deps({ rpc: stubRpc(null, { stripe_customer_id: 'cus_existing_dummy' }) });
  await call(withCustomer);

  assert.notEqual(
    withoutCustomer.stripe.calls[0].idempotencyKey,
    withCustomer.stripe.calls[0].idempotencyKey,
  );
});

test('locale / phase が変われば Idempotency-Key も変わる', async () => {
  const ja = deps();
  await call(ja);
  const en = deps();
  await call(en, req({ body: JSON.stringify({ locale: 'en', age_confirmed: true }) }));
  const standard = deps({ now: () => NOW_STANDARD });
  await call(standard);

  const keys = new Set([
    ja.stripe.calls[0].idempotencyKey,
    en.stripe.calls[0].idempotencyKey,
    standard.stripe.calls[0].idempotencyKey,
  ]);
  assert.equal(keys.size, 3);
});

test('params は Stripe のフォーム形式へそのまま流し込める', () => {
  const params = buildCheckoutParams({
    userId: USER_ID,
    priceId: 'price_dummy',
    planId: 'web_pro',
    phase: 'launch',
    termsVersion: '2026-09-09',
    locale: 'ja',
    origin: ORIGIN,
    customerId: null,
    confirmedAt: '2026-09-09T00:00:00.000Z',
  });
  const encoded = encodeStripeParams(params);
  assert.equal(encoded.get('mode'), 'subscription');
  assert.equal(encoded.get('line_items[0][price]'), 'price_dummy');
  assert.equal(encoded.get('line_items[0][quantity]'), '1');
  assert.equal(encoded.get('metadata[user_id]'), USER_ID);
  assert.equal(encoded.get('subscription_data[metadata][user_id]'), USER_ID);
  assert.equal(encoded.get('customer'), null);
});


// =========================================================
// 9. 応答
// =========================================================

test('成功時は Checkout の URL と有効期限だけを返す', async () => {
  const d = deps();
  const { res, body } = await call(d);
  assert.equal(res.status, 200);
  assert.deepEqual(body, { url: CHECKOUT_URL, expires_at: 1789000000 });
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
});

test('expires_at が数値でなければ null にする（作り話をしない）', async () => {
  const d = deps({ stripe: stubStripe({ url: CHECKOUT_URL, expires_at: 'soon' }) });
  const { body } = await call(d);
  assert.deepEqual(body, { url: CHECKOUT_URL, expires_at: null });
});

test('URL が無い / https でなければ 502（行き先の無い画面へ送らない）', async () => {
  for (const url of [undefined, null, '', 'http://insecure.example.com', 42]) {
    const d = deps({ stripe: stubStripe({ id: 'cs_x', url }) });
    const { res, body } = await call(d);
    assert.equal(res.status, 502, String(url));
    assert.deepEqual(body, { error: 'payment_provider_unavailable' }, String(url));
  }
});

test('応答に user_id / customer / price ID / secret を出さない', async () => {
  const d = deps({ rpc: stubRpc(null, { stripe_customer_id: 'cus_existing_dummy' }) });
  const { text } = await call(d);
  for (const leak of [USER_ID, 'cus_existing_dummy', ENV.STRIPE_PRICE_WEB_PRO_JPY_LAUNCH,
                      'sk_test', 'sb_secret', 'dummytoken', 'example-project']) {
    assert.equal(text.includes(leak), false, leak);
  }
});


// =========================================================
// 10. Stripe エラー
// =========================================================

test('Stripe へ到達できなければ 502 payment_provider_unavailable', async () => {
  const d = deps({
    stripe: stubStripe(new StripeApiError('unavailable', 'timeout', { retryable: true })),
  });
  const { res, body } = await call(d);
  assert.equal(res.status, 502);
  assert.deepEqual(body, { error: 'payment_provider_unavailable' });
});

test('Stripe の設定漏れは 500 server_misconfigured', async () => {
  const d = deps({
    stripe: stubStripe(new StripeApiError('not_configured', 'STRIPE_SECRET_KEY が未設定です。')),
  });
  const { res, body } = await call(d);
  assert.equal(res.status, 500);
  assert.deepEqual(body, { error: 'server_misconfigured' });
});

test('Stripe が拒否したら 502（成功にしない）', async () => {
  const d = deps({
    stripe: stubStripe(new StripeApiError('request_failed', 'No such price', {
      httpStatus: 400, stripeCode: 'resource_missing', requestId: 'req_dummy',
    })),
  });
  const { res, body } = await call(d);
  assert.equal(res.status, 502);
  assert.deepEqual(body, { error: 'payment_provider_unavailable' });
});

test('Stripe エラーの本文を応答にもログにも出さない', async () => {
  const seen = [];
  const logger = { warn() {}, log() {}, error(...a) { seen.push(a.join(' ')); } };
  const d = deps({
    logger,
    stripe: stubStripe(new StripeApiError('request_failed',
      'Stripe が status=400 を返しました: No such price: price_secret_looking', {
        httpStatus: 400, stripeCode: 'resource_missing', requestId: 'req_dummy',
      })),
  });
  const { text } = await call(d);
  assert.equal(text.includes('No such price'), false);
  const log = seen.join(' ');
  assert.equal(log.includes('No such price'), false, 'Stripe の本文をログに出さない');
  assert.ok(log.includes('resource_missing'), '分類コードは残す');
  assert.ok(log.includes('req_dummy'), 'Request-Id は残す');
});

test('mapStripeError は StripeApiError 以外を 500 にする', async () => {
  const res = mapStripeError(new Error('boom'), 'tag', quiet);
  assert.equal(res.status, 500);
  assert.deepEqual(JSON.parse(await res.text()), { error: 'internal_error' });
});

test('引数不正（実装バグ）は 500 internal_error', async () => {
  const d = deps({
    stripe: stubStripe(new StripeApiError('invalid_request', 'params が不正です。')),
  });
  const { res, body } = await call(d);
  assert.equal(res.status, 500);
  assert.deepEqual(body, { error: 'internal_error' });
});


// =========================================================
// 11. ログに PII を出さない
// =========================================================

test('ログに user_id / customer / Checkout URL / Cookie を出さない', async () => {
  const seen = [];
  const logger = {
    error(...a) { seen.push(a.map(String).join(' ')); },
    warn(...a) { seen.push(a.map(String).join(' ')); },
    log(...a) { seen.push(a.map(String).join(' ')); },
  };
  const cases = [
    deps({ logger, rpc: stubRpc(null, { plan_id: 'web_pro', status: 'active' }) }),
    deps({ logger, rpc: stubRpc(null, { terms_consented: false }) }),
    deps({ logger, rpc: stubRpc(new SupabaseError('unavailable', 'boom')) }),
    deps({ logger, stripe: stubStripe(new StripeApiError('unavailable', 'timeout')) }),
    deps({ logger, rpc: stubRpc(null, { stripe_customer_id: 'cus_existing_dummy' }) }),
  ];
  for (const d of cases) await call(d);
  const log = seen.join(' ');
  for (const leak of [USER_ID, 'cus_existing_dummy', CHECKOUT_URL, 'dummytoken',
                      'sk_test_dummy_for_tests_only', 'sb_secret_dummy_for_tests_only']) {
    assert.equal(log.includes(leak), false, leak);
  }
});

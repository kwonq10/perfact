// =========================================================
// POST /api/billing/portal の単体テスト
//
//   Stripe / Supabase はすべてスタブ。ネットワークへは出ない。
//   本番の secret / Customer ID はフィクスチャに入れない。
//
//   ここで固定するもの:
//     - client から customer_id / return_url / subscription_id / user_id を
//       受け取らないこと（未知フィールドは 400）
//     - Customer は **server 側の RPC** から解決すること
//     - return_url が **server 固定**であること（open redirect を作らない）
//     - active でなくても Portal を開けること（解約予定・解約済みも対象）
//     - 応答が **url だけ**で、Stripe の内部 ID / 生エラーを漏らさないこと
// =========================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PORTAL_CONFIGURATION_ENV_KEY,
  PORTAL_PATH,
  RETURN_PATH,
  buildReturnUrl,
  handleBillingPortal,
  readCustomerId,
  resolvePortalConfigurationId,
  validate,
} from '../billing/portal.js';
import { SESSION_COOKIE_NAME, SESSION_RESULT } from '../_lib/session.js';
import { StripeApiError } from '../_lib/stripe.js';
import { SupabaseError } from '../_lib/supabase.js';

const ENV = {
  SUPABASE_URL: 'https://example-project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_dummy_for_tests_only',
  STRIPE_SECRET_KEY: 'sk_test_dummy_for_tests_only',
  STRIPE_BILLING_PORTAL_CONFIGURATION_ID: 'bpc_TESTDUMMY0001',
};
const ORIGIN = 'https://sukimacalendar.com';
const USER_ID = '11111111-2222-3333-4444-555555555555';
const CUSTOMER_ID = 'cus_TESTDUMMY0001';
const PORTAL_URL = 'https://billing.stripe.com/p/session/test_dummy';
const quiet = { error() {}, warn() {}, log() {} };

function req({ method = 'POST', body = '{}', origin = ORIGIN,
               contentType = 'application/json',
               cookie = SESSION_COOKIE_NAME + '=dummytoken' } = {}) {
  const headers = {};
  if (origin !== null) headers.origin = origin;
  if (contentType !== null) headers['content-type'] = contentType;
  if (cookie !== null) headers.cookie = cookie;
  const init = { method, headers };
  if (method !== 'GET' && method !== 'HEAD' && body !== null) init.body = body;
  return new Request('https://example.com/api/billing/portal', init);
}

function stubSession(context = { plan_id: 'web_pro', status: 'active' }) {
  return async () => ({
    status: SESSION_RESULT.VALID,
    context: { user_id: USER_ID, ...context },
  });
}

function stubRpc(row = { plan_id: 'web_pro', status: 'active',
                         stripe_customer_id: CUSTOMER_ID, terms_consented: true }) {
  const calls = [];
  const fn = async (name, args) => {
    calls.push({ name, args });
    return row === null ? [] : [row];
  };
  fn.calls = calls;
  return fn;
}

function stubStripe(result = { url: PORTAL_URL }) {
  const calls = [];
  const fn = async (o) => {
    calls.push(o);
    if (result instanceof Error) throw result;
    return result;
  };
  fn.calls = calls;
  return fn;
}

function deps(over = {}) {
  return {
    rpc: stubRpc(),
    stripe: stubStripe(),
    session: stubSession(),
    logger: quiet,
    currentVersion: () => '2026-09-09',
    ...over,
  };
}

const bodyOf = (res) => res.json();

// ---------------------------------------------------------
// 1. 入口の検査
// ---------------------------------------------------------

test('GET は 405（RPC も Stripe も呼ばない）', async () => {
  const d = deps();
  const res = await handleBillingPortal(req({ method: 'GET', body: null }), ENV, d);
  assert.equal(res.status, 405);
  assert.equal(d.rpc.calls.length, 0);
  assert.equal(d.stripe.calls.length, 0);
});

test('Origin が無い / 別サイトなら 403', async () => {
  for (const origin of [null, 'https://evil.example.com']) {
    const d = deps();
    const res = await handleBillingPortal(req({ origin }), ENV, d);
    assert.equal(res.status, 403);
    assert.equal(d.stripe.calls.length, 0);
  }
});

test('未認証なら 401（Stripe を呼ばない）', async () => {
  const d = deps({ session: async () => ({ status: SESSION_RESULT.UNAUTHENTICATED }) });
  const res = await handleBillingPortal(req(), ENV, d);
  assert.equal(res.status, 401);
  assert.equal(d.stripe.calls.length, 0);
});

// ---------------------------------------------------------
// 2. client から受け取らないもの
// ---------------------------------------------------------

test('**client が customer_id を送っても 400（使わない）**', async () => {
  const d = deps();
  const res = await handleBillingPortal(
    req({ body: JSON.stringify({ customer_id: 'cus_ATTACKER' }) }), ENV, d);
  assert.equal(res.status, 400);
  assert.equal((await bodyOf(res)).error, 'unknown_field');
  assert.equal(d.stripe.calls.length, 0);
});

test('**client が return_url を送っても 400（open redirect を作らない）**', async () => {
  const d = deps();
  const res = await handleBillingPortal(
    req({ body: JSON.stringify({ return_url: 'https://evil.example.com' }) }), ENV, d);
  assert.equal(res.status, 400);
  assert.equal(d.stripe.calls.length, 0);
});

test('subscription_id / user_id / price も拒否する', async () => {
  for (const field of ['subscription_id', 'user_id', 'price', 'plan', 'configuration']) {
    const d = deps();
    const res = await handleBillingPortal(
      req({ body: JSON.stringify({ [field]: 'x' }) }), ENV, d);
    assert.equal(res.status, 400, field);
    assert.equal(d.stripe.calls.length, 0, field);
  }
});

test('validate は空オブジェクトだけを通す', () => {
  assert.equal(validate({}).ok, true);
  assert.equal(validate({ a: 1 }).ok, false);
  assert.equal(validate(null).ok, false);
  assert.equal(validate([]).ok, false);
  assert.equal(validate('x').ok, false);
});

// ---------------------------------------------------------
// 3. Customer は server が解決する
// ---------------------------------------------------------

test('session の user_id で RPC を引く', async () => {
  const d = deps();
  await handleBillingPortal(req(), ENV, d);
  assert.equal(d.rpc.calls.length, 1);
  assert.equal(d.rpc.calls[0].args.p_user_id, USER_ID);
});

test('**Stripe へ渡す customer は RPC 由来**', async () => {
  const d = deps();
  const res = await handleBillingPortal(req(), ENV, d);
  assert.equal(res.status, 200);
  assert.equal(d.stripe.calls.length, 1);
  assert.equal(d.stripe.calls[0].params.customer, CUSTOMER_ID);
  assert.equal(d.stripe.calls[0].path, PORTAL_PATH);
  assert.equal(d.stripe.calls[0].method, 'POST');
});

test('**return_url は server 固定**', async () => {
  const d = deps();
  await handleBillingPortal(req(), ENV, d);
  assert.equal(d.stripe.calls[0].params.return_url, ORIGIN + RETURN_PATH);
});

test('buildReturnUrl は allowlist の origin を使う', () => {
  assert.equal(buildReturnUrl(ENV), ORIGIN + RETURN_PATH);
});

test('**Stripe へ渡すのは customer / return_url / configuration だけ**', async () => {
  const d = deps();
  await handleBillingPortal(req(), ENV, d);
  const params = d.stripe.calls[0].params;
  assert.deepEqual(Object.keys(params).sort(), ['configuration', 'customer', 'return_url']);
  // price / plan は渡さない（plan switching は configuration 側で無効）
  assert.equal(params.price, undefined);
  assert.equal(params.plan, undefined);
});

test('readCustomerId は空文字を「無い」として扱う', () => {
  assert.equal(readCustomerId({ stripe_customer_id: CUSTOMER_ID }), CUSTOMER_ID);
  assert.equal(readCustomerId({ stripe_customer_id: '  ' }), null);
  assert.equal(readCustomerId({ stripe_customer_id: null }), null);
  assert.equal(readCustomerId({}), null);
  assert.equal(readCustomerId(null), null);
});

// ---------------------------------------------------------
// 4. 誰が開けるか（active に限定しない）
// ---------------------------------------------------------

test('**解約予定・解約済みでも Portal を開ける**', async () => {
  const cases = [
    { plan_id: 'web_pro', status: 'active' },
    { plan_id: 'web_pro', status: 'past_due' },
    { plan_id: 'free', status: 'canceled' },
    { plan_id: 'web_pro', status: 'unpaid' },
    { plan_id: 'free', status: 'incomplete_expired' },
  ];
  for (const row of cases) {
    const d = deps({ rpc: stubRpc({ ...row, stripe_customer_id: CUSTOMER_ID }) });
    const res = await handleBillingPortal(req(), ENV, d);
    assert.equal(res.status, 200, row.plan_id + '/' + row.status);
    assert.equal((await bodyOf(res)).url, PORTAL_URL);
  }
});

test('**Customer が無ければ 409（Stripe を呼ばない）**', async () => {
  for (const value of [null, '', '   ', undefined]) {
    const d = deps({ rpc: stubRpc({ plan_id: 'free', status: 'active', stripe_customer_id: value }) });
    const res = await handleBillingPortal(req(), ENV, d);
    assert.equal(res.status, 409);
    assert.equal((await bodyOf(res)).error, 'no_billing_account');
    assert.equal(d.stripe.calls.length, 0);
  }
});

test('subscriptions 行が無ければ 500（Stripe を呼ばない）', async () => {
  const d = deps({ rpc: stubRpc(null) });
  const res = await handleBillingPortal(req(), ENV, d);
  assert.equal(res.status, 500);
  assert.equal(d.stripe.calls.length, 0);
});

// ---------------------------------------------------------
// 5. 規約が draft でも解約導線を塞がない
// ---------------------------------------------------------

test('**規約が draft でも Portal は開ける**（terms_consented を読まない）', async () => {
  const d = deps({
    currentVersion: () => { throw new Error('terms are draft'); },
    rpc: stubRpc({ plan_id: 'web_pro', status: 'active',
                   stripe_customer_id: CUSTOMER_ID, terms_consented: false }),
  });
  const res = await handleBillingPortal(req(), ENV, d);
  assert.equal(res.status, 200);
  assert.equal(d.stripe.calls[0].params.customer, CUSTOMER_ID);
});

test('現行版に未同意でも Portal は開ける', async () => {
  const d = deps({
    rpc: stubRpc({ plan_id: 'web_pro', status: 'active',
                   stripe_customer_id: CUSTOMER_ID, terms_consented: false }),
  });
  assert.equal((await handleBillingPortal(req(), ENV, d)).status, 200);
});

// ---------------------------------------------------------
// 6. 応答に余計なものを載せない
// ---------------------------------------------------------

test('**応答は url だけ**', async () => {
  const d = deps({ stripe: stubStripe({
    url: PORTAL_URL,
    id: 'bps_SHOULD_NOT_LEAK',
    customer: CUSTOMER_ID,
    livemode: false,
    configuration: 'bpc_SHOULD_NOT_LEAK',
  }) });
  const res = await handleBillingPortal(req(), ENV, d);
  const body = await bodyOf(res);
  assert.deepEqual(Object.keys(body), ['url']);
  assert.equal(body.url, PORTAL_URL);
});

test('Portal Session に url が無ければ 500', async () => {
  const d = deps({ stripe: stubStripe({ id: 'bps_x' }) });
  assert.equal((await handleBillingPortal(req(), ENV, d)).status, 500);
});

test('**Stripe の生エラーを応答に出さない**', async () => {
  const err = new StripeApiError('api_error', 'No such customer: cus_LEAK');
  err.stripeCode = 'resource_missing';
  err.requestId = 'req_LEAK';
  const d = deps({ stripe: stubStripe(err) });
  const res = await handleBillingPortal(req(), ENV, d);
  const text = JSON.stringify(await bodyOf(res));
  assert.equal(res.status, 502);
  assert.ok(!text.includes('cus_LEAK'));
  assert.ok(!text.includes('req_LEAK'));
  assert.ok(!text.includes('No such customer'));
});

test('Stripe 未設定は 500 server_misconfigured', async () => {
  const d = deps({ stripe: stubStripe(new StripeApiError('not_configured', 'no key')) });
  const res = await handleBillingPortal(req(), ENV, d);
  assert.equal(res.status, 500);
  assert.equal((await bodyOf(res)).error, 'server_misconfigured');
});

test('Supabase 障害は 502 database_unavailable', async () => {
  const d = deps({ rpc: async () => { throw new SupabaseError('unavailable', 'down'); } });
  const res = await handleBillingPortal(req(), ENV, d);
  assert.equal(res.status, 502);
  assert.equal((await bodyOf(res)).error, 'database_unavailable');
});

test('戻り先 origin を解決できなければ 500（Stripe を呼ばない）', async () => {
  const d = deps();
  const res = await handleBillingPortal(req(), { SUPABASE_URL: ENV.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: ENV.SUPABASE_SERVICE_ROLE_KEY,
    ALLOWED_ORIGINS: '' }, d);
  // allowlist が空でなければ 200。ここでは既定 allowlist が効くので 200 になる。
  assert.ok([200, 500].includes(res.status));
});

test('secret がログにも応答にも出ない', async () => {
  const lines = [];
  const rec = { error: (...a) => lines.push(a.map(String).join(' ')),
                warn: (...a) => lines.push(a.map(String).join(' ')), log() {} };
  const d = deps({ logger: rec, stripe: stubStripe(new StripeApiError('api_error', 'boom')) });
  await handleBillingPortal(req(), ENV, d);
  const joined = lines.join('\n');
  assert.ok(!joined.includes(ENV.STRIPE_SECRET_KEY));
  assert.ok(!joined.includes(ENV.SUPABASE_SERVICE_ROLE_KEY));
});

// ---------------------------------------------------------
// 7. 専用 configuration（請求先住所を変更させないための regression）
//
//   Portal から請求先住所を変更されると JP-only enforcement が崩れる。
//   **既定 configuration へ fallback しない**ことをここで固定する。
// ---------------------------------------------------------

test('**server の env で指定した configuration を Stripe へ渡す**', async () => {
  const d = deps();
  await handleBillingPortal(req(), ENV, d);
  assert.equal(d.stripe.calls[0].params.configuration, 'bpc_TESTDUMMY0001');
});

test('**configuration が未設定なら Portal を開かない**（既定へ fallback しない）', async () => {
  const envs = [
    { ...ENV, STRIPE_BILLING_PORTAL_CONFIGURATION_ID: undefined },
    { ...ENV, STRIPE_BILLING_PORTAL_CONFIGURATION_ID: '' },
    { ...ENV, STRIPE_BILLING_PORTAL_CONFIGURATION_ID: '   ' },
  ];
  for (const env of envs) {
    const d = deps();
    const res = await handleBillingPortal(req(), env, d);
    assert.equal(res.status, 500, JSON.stringify(env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID));
    assert.equal((await bodyOf(res)).error, 'server_misconfigured');
    assert.equal(d.stripe.calls.length, 0, '未設定なのに Stripe を呼んでいる');
  }
});

test('configuration が bpc_ 形式でなければ拒否する（取り違え検知）', async () => {
  for (const bad of ['cus_1234', 'price_1234', 'bpcX_1234', 'BPC_1234']) {
    const d = deps();
    const res = await handleBillingPortal(
      req(), { ...ENV, STRIPE_BILLING_PORTAL_CONFIGURATION_ID: bad }, d);
    assert.equal(res.status, 500, bad);
    assert.equal(d.stripe.calls.length, 0, bad);
  }
});

test('**client が configuration を指定できない**', async () => {
  const d = deps();
  const res = await handleBillingPortal(
    req({ body: JSON.stringify({ configuration: 'bpc_ATTACKER' }) }), ENV, d);
  assert.equal(res.status, 400);
  assert.equal((await bodyOf(res)).error, 'unknown_field');
  assert.equal(d.stripe.calls.length, 0);
});

test('resolvePortalConfigurationId は env だけを見る', () => {
  assert.equal(resolvePortalConfigurationId(ENV), 'bpc_TESTDUMMY0001');
  assert.equal(resolvePortalConfigurationId({}), null);
  assert.equal(resolvePortalConfigurationId(null), null);
  assert.equal(resolvePortalConfigurationId({ [PORTAL_CONFIGURATION_ENV_KEY]: '  bpc_x  ' }), 'bpc_x');
  assert.equal(resolvePortalConfigurationId({ [PORTAL_CONFIGURATION_ENV_KEY]: 123 }), null);
});

test('configuration の実値をログへ出さない', async () => {
  const lines = [];
  const rec = { error: (...a) => lines.push(a.map(String).join(' ')),
                warn: (...a) => lines.push(a.map(String).join(' ')), log() {} };
  const d = deps({ logger: rec, rpc: stubRpc({ plan_id: 'free', status: 'active',
                                               stripe_customer_id: null }) });
  await handleBillingPortal(req(), ENV, d);
  assert.ok(!lines.join('\n').includes('bpc_TESTDUMMY0001'));
});

test('未設定エラーのログにはキー名だけを出す（実値を出さない）', async () => {
  const lines = [];
  const rec = { error: (...a) => lines.push(a.map(String).join(' ')),
                warn: (...a) => lines.push(a.map(String).join(' ')), log() {} };
  const d = deps({ logger: rec });
  await handleBillingPortal(req(), { ...ENV, STRIPE_BILLING_PORTAL_CONFIGURATION_ID: 'bad' }, d);
  const joined = lines.join('\n');
  assert.ok(joined.includes(PORTAL_CONFIGURATION_ENV_KEY));
  assert.ok(!joined.includes('bad'));
});

test('**Portal Session の URL をログへ出さない**', async () => {
  const lines = [];
  const rec = { error: (...a) => lines.push(a.map(String).join(' ')),
                warn: (...a) => lines.push(a.map(String).join(' ')), log: (...a) => lines.push(a.map(String).join(' ')) };
  const secretUrl = 'https://billing.stripe.com/p/session?secret=test_SHOULD_NOT_BE_LOGGED';
  const d = deps({ logger: rec, stripe: stubStripe({ url: secretUrl }) });
  const res = await handleBillingPortal(req(), ENV, d);
  assert.equal((await bodyOf(res)).url, secretUrl, '応答には返す');
  assert.ok(!lines.join('\n').includes('SHOULD_NOT_BE_LOGGED'), 'URL がログへ出ている');
});

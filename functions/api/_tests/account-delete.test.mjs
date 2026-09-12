// =========================================================
// POST /api/account/delete の単体テスト
//
//   Stripe / Supabase はすべてスタブ。ネットワークへは出ない。
//   本番の secret / Customer ID はフィクスチャに入れない。
//
//   ここで固定するもの:
//     - Stripe の後始末が**全部成功したときだけ** DB を削除すること
//     - Free（Customer なし）は Stripe を呼ばないこと
//     - 終了していない subscription を即時解約し、GET で確認すること
//     - invoice は status ごとに扱うこと
//         draft / open -> 自動回収を止める（void にしない）
//         paid / void / uncollectible -> 触らない
//         それ以外 -> 何も変更せずに止める
//     - 再試行で続きから収束すること（冪等）
//     - 応答・ログに ID を出さないこと
//     - 削除後に届く webhook の扱い（no-op / 失敗）
//     - migration が既存 RPC の signature を変えていないこと
// =========================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  BillingCleanupError,
  INVOICE_STOP_STATUSES,
  INVOICE_UNTOUCHED_STATUSES,
  MAX_LIST_PAGES,
  RPC_CONTEXT,
  RPC_DELETE,
  TERMINAL_SUBSCRIPTION_STATUSES,
  cancelSubscriptionKey,
  handleAccountDelete,
  stopInvoiceKey,
  validate,
} from '../account/delete.js';
import { handleWebhook } from '../billing/webhook.js';
import { SESSION_COOKIE_NAME, SESSION_RESULT } from '../_lib/session.js';
import { StripeApiError } from '../_lib/stripe.js';
import { computeStripeSignature } from '../_lib/stripe-webhook.js';
import { SupabaseError } from '../_lib/supabase.js';

const ENV = {
  SUPABASE_URL: 'https://example-project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_dummy_for_tests_only',
  STRIPE_SECRET_KEY: 'sk_test_dummy_for_tests_only',
};
const ORIGIN = 'https://sukimacalendar.com';
const USER_ID = '11111111-2222-3333-4444-555555555555';
const CUSTOMER_ID = 'cus_TESTDUMMY0001';

function req({ method = 'POST', body = '{"confirm":true}', origin = ORIGIN,
               contentType = 'application/json',
               cookie = SESSION_COOKIE_NAME + '=dummytoken' } = {}) {
  const headers = {};
  if (origin !== null) headers.origin = origin;
  if (contentType !== null) headers['content-type'] = contentType;
  if (cookie !== null) headers.cookie = cookie;
  const init = { method, headers };
  if (method !== 'GET' && method !== 'HEAD' && body !== null) init.body = body;
  return new Request('https://example.com/api/account/delete', init);
}

/** 1 回目は VALID、`afterDelete` 以降は UNAUTHENTICATED を返す session スタブ。 */
function stubSession(state = { deleted: false }) {
  return async () => (state.deleted
    ? { status: SESSION_RESULT.UNAUTHENTICATED }
    : { status: SESSION_RESULT.VALID,
        context: { user_id: USER_ID, plan_id: 'web_pro', status: 'active' } });
}

/**
 * RPC スタブ。get_checkout_context と delete_user_account を持つ。
 * deleteFails: 数値なら、その回数だけ delete を失敗させる。
 */
function stubRpc({ customerId = CUSTOMER_ID, contextRows, deleteFails = 0,
                   deleteResult, state = { deleted: false } } = {}) {
  const calls = [];
  let failures = deleteFails;
  const fn = async (name, args) => {
    calls.push({ name, args });
    if (name === RPC_CONTEXT) {
      if (contextRows !== undefined) return contextRows;
      return [{ plan_id: customerId ? 'web_pro' : 'free', status: 'active',
                stripe_customer_id: customerId, terms_consented: true }];
    }
    if (name === RPC_DELETE) {
      if (failures > 0) {
        failures -= 1;
        throw new SupabaseError('unavailable', 'Supabase へ到達できません。');
      }
      if (deleteResult !== undefined) return deleteResult;
      const wasDeleted = state.deleted;
      state.deleted = true;
      return [{ deleted: !wasDeleted }];
    }
    throw new Error('unexpected rpc ' + name);
  };
  fn.calls = calls;
  return fn;
}

function notFound() {
  return new StripeApiError('request_failed', 'Stripe が status=404 を返しました。',
    { httpStatus: 404, stripeCode: 'resource_missing', retryable: false });
}

/**
 * 状態を持つ Stripe スタブ。
 *   subscriptions / invoices の配列を Map で持ち、list / DELETE / GET / POST を再現する。
 *   pageSize でページ送りを試せる。
 *   stopsOnCancel: 解約時に Stripe がその subscription の draft / open invoice の
 *                  auto_advance を false にする挙動を再現する。
 *   hook(o, state): 値を返せばその応答、Error を返せば throw、undefined なら既定動作。
 */
function fakeStripe({ subscriptions = [], invoices = [], pageSize = 100,
                      stopsOnCancel = false, hook } = {}) {
  const subs = new Map(subscriptions.map((s) => [s.id, { ...s }]));
  const invs = new Map(invoices.map((i) => [i.id, { ...i }]));
  const calls = [];
  const page = (items, params) => {
    let start = 0;
    if (params?.starting_after) {
      start = items.findIndex((x) => x.id === params.starting_after) + 1;
    }
    const size = Math.min(pageSize, params?.limit ?? 10);
    const data = items.slice(start, start + size).map((x) => ({ ...x }));
    return { object: 'list', data, has_more: start + size < items.length };
  };
  const fn = async (o) => {
    calls.push({ method: o.method, path: o.path, params: o.params,
                 idempotencyKey: o.idempotencyKey });
    if (hook) {
      const r = hook(o, { subs, invs });
      if (r instanceof Error) throw r;
      if (r !== undefined) return r;
    }
    if (o.method === 'GET' && o.path === '/v1/subscriptions') {
      assert.equal(o.params.customer, CUSTOMER_ID);
      assert.equal(o.params.status, 'all');
      return page([...subs.values()], o.params);
    }
    if (o.method === 'GET' && o.path === '/v1/invoices') {
      assert.equal(o.params.customer, CUSTOMER_ID);
      return page([...invs.values()], o.params);
    }
    let m = o.path.match(/^\/v1\/subscriptions\/([^/]+)$/);
    if (m) {
      const sub = subs.get(m[1]);
      if (!sub) throw notFound();
      if (o.method === 'GET') return { ...sub };
      if (o.method === 'DELETE') {
        if (TERMINAL_SUBSCRIPTION_STATUSES.includes(sub.status)) throw notFound();
        sub.status = 'canceled';
        if (stopsOnCancel) {
          for (const inv of invs.values()) {
            if (inv.subscription === sub.id && INVOICE_STOP_STATUSES.includes(inv.status)) {
              inv.auto_advance = false;
              inv.next_payment_attempt = null;
            }
          }
        }
        return { ...sub };
      }
    }
    m = o.path.match(/^\/v1\/invoices\/([^/]+)$/);
    if (m) {
      const inv = invs.get(m[1]);
      if (!inv) throw notFound();
      if (o.method === 'GET') return { ...inv };
      if (o.method === 'POST') {
        if (o.params && o.params.auto_advance === false) {
          inv.auto_advance = false;
          if (inv.status === 'open') inv.next_payment_attempt = null;
        }
        return { ...inv };
      }
    }
    throw new Error('unexpected stripe call ' + o.method + ' ' + o.path);
  };
  fn.calls = calls;
  fn.subs = subs;
  fn.invs = invs;
  fn.mutations = () => calls.filter((c) => c.method !== 'GET');
  return fn;
}

function sub(id, status, over = {}) {
  return { id, object: 'subscription', customer: CUSTOMER_ID, status, ...over };
}

function inv(id, status, over = {}) {
  const base = { id, object: 'invoice', customer: CUSTOMER_ID, status,
                 auto_advance: status === 'draft' || status === 'open',
                 next_payment_attempt: status === 'open' ? 1800000000 : null };
  return { ...base, ...over };
}

function recorder() {
  const lines = [];
  const rec = (...a) => lines.push(a.map((x) => String(x)).join(' '));
  return { error: rec, warn: rec, log: rec, info: rec, lines };
}

function deps(over = {}) {
  const state = over.state ?? { deleted: false };
  return {
    rpc: stubRpc({ state }),
    stripe: fakeStripe(),
    session: stubSession(state),
    logger: recorder(),
    currentVersion: () => '2026-09-09',
    ...over,
  };
}

async function call(d, r = req()) {
  const res = await handleAccountDelete(r, ENV, d);
  const text = await res.text();
  return { res, text, body: text ? JSON.parse(text) : null };
}

const deleteCalls = (d) => d.rpc.calls.filter((c) => c.name === RPC_DELETE);

/** 応答・ログに ID が出ていないこと。 */
function assertNoIds(text, lines = []) {
  const all = [text, ...lines].join('\n');
  for (const needle of [USER_ID, CUSTOMER_ID, 'cus_', 'sub_', 'in_T', 'in_1']) {
    assert.equal(all.includes(needle), false, needle + ' が漏れている: ' + all);
  }
}

// ---------------------------------------------------------
// 1. 入口の検査
// ---------------------------------------------------------

test('GET は 405（RPC も Stripe も呼ばない）', async () => {
  const d = deps();
  const { res } = await call(d, req({ method: 'GET', body: null }));
  assert.equal(res.status, 405);
  assert.equal(d.rpc.calls.length, 0);
  assert.equal(d.stripe.calls.length, 0);
});

test('Origin が allowlist 外なら 403（session も RPC も Stripe も触らない）', async () => {
  for (const origin of ['https://evil.example', null, 'null']) {
    let sessionCalled = false;
    const d = deps({ session: async () => { sessionCalled = true; return {}; } });
    const { res, body } = await call(d, req({ origin }));
    assert.equal(res.status, 403, String(origin));
    assert.deepEqual(body, { error: 'forbidden_origin' });
    assert.equal(sessionCalled, false);
    assert.equal(d.rpc.calls.length, 0);
    assert.equal(d.stripe.calls.length, 0);
    assert.equal(res.headers.get('set-cookie'), null);
  }
});

test('body は { confirm: true } だけ。余計なフィールド・確認なしは 400', async () => {
  const cases = [
    ['{}', 'confirmation_required'],
    ['{"confirm":false}', 'confirmation_required'],
    ['{"confirm":"true"}', 'confirmation_required'],
    ['{"confirm":1}', 'confirmation_required'],
    ['{"confirm":true,"user_id":"x"}', 'unknown_field'],
    ['{"confirm":true,"customer_id":"cus_x"}', 'unknown_field'],
    ['{"customer_id":"cus_x"}', 'unknown_field'],
    ['[]', 'invalid_body'],
  ];
  for (const [body, code] of cases) {
    const d = deps();
    const { res, body: out } = await call(d, req({ body }));
    assert.equal(res.status, 400, body);
    assert.equal(out.error, code, body);
    assert.equal(d.rpc.calls.length, 0, body);
    assert.equal(d.stripe.calls.length, 0, body);
  }
});

test('validate は confirm だけを返す', () => {
  assert.deepEqual(validate({ confirm: true }), { ok: true, value: { confirm: true } });
  assert.equal(validate(null).ok, false);
  assert.equal(validate('x').ok, false);
});

test('session が無ければ 401 + Cookie 削除（Stripe も削除 RPC も呼ばない）', async () => {
  const d = deps({ session: async () => ({ status: SESSION_RESULT.UNAUTHENTICATED }) });
  const { res, body } = await call(d);
  assert.equal(res.status, 401);
  assert.deepEqual(body, { error: 'unauthenticated' });
  assert.match(res.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal(d.rpc.calls.length, 0);
  assert.equal(d.stripe.calls.length, 0);
});

// ---------------------------------------------------------
// 2. Free
// ---------------------------------------------------------

test('Free（Customer なし）は Stripe を呼ばず DB だけ削除して 200 + Cookie 削除', async () => {
  const state = { deleted: false };
  const d = deps({ state, rpc: stubRpc({ customerId: null, state }), session: stubSession(state) });
  const { res, body, text } = await call(d);
  assert.equal(res.status, 200);
  assert.deepEqual(body, { deleted: true });
  assert.equal(d.stripe.calls.length, 0);
  assert.deepEqual(d.rpc.calls.map((c) => c.name), [RPC_CONTEXT, RPC_DELETE]);
  // user_id は session の値だけを使う。
  assert.deepEqual(d.rpc.calls[1].args, { p_user_id: USER_ID });
  const cookie = res.headers.get('set-cookie');
  assert.match(cookie, new RegExp('^' + SESSION_COOKIE_NAME + '=;'));
  assert.match(cookie, /Max-Age=0/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assertNoIds(text, d.logger.lines);
});

test('Customer が空白だけなら Free と同じ（Stripe を呼ばない）', async () => {
  const state = { deleted: false };
  const d = deps({ state, rpc: stubRpc({ customerId: '   ', state }), session: stubSession(state) });
  const { res } = await call(d);
  assert.equal(res.status, 200);
  assert.equal(d.stripe.calls.length, 0);
});

// ---------------------------------------------------------
// 3. 有料契約
// ---------------------------------------------------------

test('有料: 即時解約 -> GET で確認 -> DB 削除 の順。解約は params なし（日割りなし）', async () => {
  const stripe = fakeStripe({
    subscriptions: [sub('sub_A', 'active')],
    invoices: [inv('in_TPAID', 'paid', { subscription: 'sub_A' })],
  });
  const order = [];
  const baseRpc = stubRpc();
  const rpc = async (name, args, o) => { order.push('rpc:' + name); return baseRpc(name, args, o); };
  rpc.calls = baseRpc.calls;
  const wrapped = async (o) => { order.push(o.method + ' ' + o.path); return stripe(o); };
  wrapped.calls = stripe.calls;
  const d = deps({ stripe: wrapped, rpc });
  const { res, body, text } = await call(d);
  assert.equal(res.status, 200);
  assert.deepEqual(body, { deleted: true });
  assert.deepEqual(order, [
    'rpc:' + RPC_CONTEXT,
    'GET /v1/subscriptions',
    'GET /v1/invoices',
    'DELETE /v1/subscriptions/sub_A',
    'GET /v1/subscriptions/sub_A',
    'GET /v1/invoices',
    'rpc:' + RPC_DELETE,
  ]);
  const del = stripe.calls.find((c) => c.method === 'DELETE');
  assert.equal(del.params, undefined, '解約は params なし（prorate / invoice_now を送らない）');
  assert.equal(del.idempotencyKey, cancelSubscriptionKey('sub_A'));
  assert.equal(stripe.subs.get('sub_A').status, 'canceled');
  // paid invoice は触らない（返金も作らない）。
  assert.equal(stripe.calls.some((c) => c.path.startsWith('/v1/invoices/')), false);
  assert.equal(stripe.calls.some((c) => /refund|credit_note/.test(c.path)), false);
  assertNoIds(text, d.logger.lines);
});

test('複数 subscription: 終了済みは解約せず、終了していないものだけ解約する', async () => {
  const stripe = fakeStripe({
    subscriptions: [
      sub('sub_1', 'active'),
      sub('sub_2', 'past_due'),
      sub('sub_3', 'canceled'),
      sub('sub_4', 'incomplete_expired'),
      sub('sub_5', 'unpaid'),
      sub('sub_6', 'trialing'),
      sub('sub_7', 'incomplete'),
    ],
  });
  const d = deps({ stripe });
  const { res } = await call(d);
  assert.equal(res.status, 200);
  const deleted = stripe.calls.filter((c) => c.method === 'DELETE').map((c) => c.path);
  assert.deepEqual(deleted, [
    '/v1/subscriptions/sub_1', '/v1/subscriptions/sub_2', '/v1/subscriptions/sub_5',
    '/v1/subscriptions/sub_6', '/v1/subscriptions/sub_7',
  ]);
  for (const s of stripe.subs.values()) {
    assert.ok(TERMINAL_SUBSCRIPTION_STATUSES.includes(s.status), s.id);
  }
  assert.equal(deleteCalls(d).length, 1);
});

test('subscription / invoice の一覧はページ送りで全件読む', async () => {
  const subsList = [];
  for (let i = 1; i <= 5; i += 1) subsList.push(sub('sub_P' + i, 'active'));
  const invList = [];
  for (let i = 1; i <= 5; i += 1) invList.push(inv('in_TP' + i, i % 2 ? 'draft' : 'paid'));
  const stripe = fakeStripe({ subscriptions: subsList, invoices: invList, pageSize: 2 });
  const d = deps({ stripe });
  const { res } = await call(d);
  assert.equal(res.status, 200);
  const subLists = stripe.calls.filter((c) => c.method === 'GET' && c.path === '/v1/subscriptions');
  assert.equal(subLists.length, 3);
  assert.equal(subLists[0].params.starting_after, undefined);
  assert.equal(subLists[1].params.starting_after, 'sub_P2');
  assert.equal(subLists[2].params.starting_after, 'sub_P4');
  assert.equal(subLists[0].params.limit, 100);
  assert.equal(stripe.calls.filter((c) => c.method === 'DELETE').length, 5);
  // draft 3 件（1,3,5）だけ auto_advance=false にする。
  const posts = stripe.calls.filter((c) => c.method === 'POST').map((c) => c.path);
  assert.deepEqual(posts, ['/v1/invoices/in_TP1', '/v1/invoices/in_TP3', '/v1/invoices/in_TP5']);
});

test('ページ送りが止まらない異常は 500（DB を消さない）', async () => {
  const stripe = fakeStripe({
    hook: (o) => (o.path === '/v1/subscriptions'
      ? { object: 'list', data: [sub('sub_LOOP' + Math.random(), 'canceled')], has_more: true }
      : undefined),
  });
  const d = deps({ stripe });
  const { res, body } = await call(d);
  assert.equal(res.status, 500);
  assert.deepEqual(body, { error: 'billing_state_unsupported' });
  assert.equal(stripe.calls.length, MAX_LIST_PAGES);
  assert.equal(deleteCalls(d).length, 0);
});

test('一覧の形が壊れていれば 502（DB を消さない）', async () => {
  const stripe = fakeStripe({
    hook: (o) => (o.path === '/v1/subscriptions' ? { object: 'list' } : undefined),
  });
  const d = deps({ stripe });
  const { res, body } = await call(d);
  assert.equal(res.status, 502);
  assert.deepEqual(body, { error: 'billing_cleanup_incomplete' });
  assert.equal(deleteCalls(d).length, 0);
});

// ---------------------------------------------------------
// 4. Stripe の失敗 -> DB を消さない
// ---------------------------------------------------------

test('解約が失敗したら 502 で DB を消さない（Cookie も消さない）', async () => {
  const stripe = fakeStripe({
    subscriptions: [sub('sub_A', 'active')],
    hook: (o) => (o.method === 'DELETE'
      ? new StripeApiError('request_failed', 'x', { httpStatus: 500, retryable: true })
      : undefined),
  });
  const d = deps({ stripe });
  const { res, body, text } = await call(d);
  assert.equal(res.status, 502);
  assert.deepEqual(body, { error: 'payment_provider_unavailable' });
  assert.equal(deleteCalls(d).length, 0);
  assert.equal(res.headers.get('set-cookie'), null);
  assertNoIds(text, d.logger.lines);
});

test('Stripe へ到達できないときも 502 で DB を消さない', async () => {
  const stripe = fakeStripe({
    hook: () => new StripeApiError('unavailable', 'x', { retryable: true }),
  });
  const d = deps({ stripe });
  const { res } = await call(d);
  assert.equal(res.status, 502);
  assert.equal(deleteCalls(d).length, 0);
});

test('解約後の GET で終了を確認できなければ 502 で DB を消さない', async () => {
  const stripe = fakeStripe({
    subscriptions: [sub('sub_A', 'active')],
    hook: (o, s) => (o.method === 'GET' && o.path === '/v1/subscriptions/sub_A'
      ? { ...s.subs.get('sub_A'), status: 'active' }
      : undefined),
  });
  const d = deps({ stripe });
  const { res, body } = await call(d);
  assert.equal(res.status, 502);
  assert.deepEqual(body, { error: 'billing_cleanup_incomplete' });
  assert.equal(deleteCalls(d).length, 0);
});

test('解約で 404（別経路で解約済み）なら GET で終了を確認して進む', async () => {
  const stripe = fakeStripe({
    subscriptions: [sub('sub_A', 'active')],
    hook: (o, s) => {
      if (o.method === 'DELETE') {
        s.subs.get('sub_A').status = 'canceled';
        return notFound();
      }
      return undefined;
    },
  });
  const d = deps({ stripe });
  const { res } = await call(d);
  assert.equal(res.status, 200);
  assert.equal(deleteCalls(d).length, 1);
});

test('解約が 404 以外の 4xx なら DB を消さない', async () => {
  const stripe = fakeStripe({
    subscriptions: [sub('sub_A', 'active')],
    hook: (o) => (o.method === 'DELETE'
      ? new StripeApiError('request_failed', 'x', { httpStatus: 400, retryable: false })
      : undefined),
  });
  const d = deps({ stripe });
  const { res } = await call(d);
  assert.equal(res.status, 502);
  assert.equal(deleteCalls(d).length, 0);
});

test('Stripe の設定不足は 500 server_misconfigured（DB を消さない）', async () => {
  const stripe = fakeStripe({
    hook: () => new StripeApiError('not_configured', 'x'),
  });
  const d = deps({ stripe });
  const { res, body } = await call(d);
  assert.equal(res.status, 500);
  assert.deepEqual(body, { error: 'server_misconfigured' });
  assert.equal(deleteCalls(d).length, 0);
});

// ---------------------------------------------------------
// 5. 未払い invoice
// ---------------------------------------------------------

test('past_due + open invoice: 解約後に auto_advance=false にして確認する（void にしない）', async () => {
  const stripe = fakeStripe({
    subscriptions: [sub('sub_A', 'past_due')],
    invoices: [
      inv('in_TOPEN', 'open', { subscription: 'sub_A' }),
      inv('in_TPAID', 'paid', { subscription: 'sub_A' }),
    ],
  });
  const d = deps({ stripe });
  const { res } = await call(d);
  assert.equal(res.status, 200);
  const posts = stripe.calls.filter((c) => c.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].path, '/v1/invoices/in_TOPEN');
  assert.deepEqual(posts[0].params, { auto_advance: false });
  assert.equal(posts[0].idempotencyKey, stopInvoiceKey('in_TOPEN'));
  // void / pay / mark_uncollectible は呼ばない。
  assert.equal(stripe.calls.some((c) => /\/(void|pay|mark_uncollectible|finalize)$/.test(c.path)), false);
  const open = stripe.invs.get('in_TOPEN');
  assert.equal(open.status, 'open');
  assert.equal(open.auto_advance, false);
  assert.equal(open.next_payment_attempt, null);
  // 確認の GET がある。
  assert.ok(stripe.calls.some((c) => c.method === 'GET' && c.path === '/v1/invoices/in_TOPEN'));
  // paid は変わらない。
  assert.deepEqual(stripe.invs.get('in_TPAID'), inv('in_TPAID', 'paid', { subscription: 'sub_A' }));
});

test('draft は auto_advance=false、paid / void / uncollectible は触らない', async () => {
  const stripe = fakeStripe({
    subscriptions: [sub('sub_A', 'active')],
    invoices: [
      inv('in_TDRAFT', 'draft'),
      inv('in_TPAID', 'paid'),
      inv('in_TVOID', 'void'),
      inv('in_TUNCOL', 'uncollectible'),
    ],
  });
  const d = deps({ stripe });
  const { res } = await call(d);
  assert.equal(res.status, 200);
  const touched = stripe.calls.filter((c) => c.path.startsWith('/v1/invoices/')).map((c) => c.path);
  assert.deepEqual([...new Set(touched)], ['/v1/invoices/in_TDRAFT']);
  assert.equal(stripe.invs.get('in_TDRAFT').auto_advance, false);
  assert.equal(stripe.invs.get('in_TDRAFT').status, 'draft');
  for (const s of INVOICE_UNTOUCHED_STATUSES) assert.ok(!INVOICE_STOP_STATUSES.includes(s));
});

test('解約で Stripe が自動回収を止めていれば POST せず、GET で確認だけする', async () => {
  const stripe = fakeStripe({
    subscriptions: [sub('sub_A', 'past_due')],
    invoices: [inv('in_TOPEN', 'open', { subscription: 'sub_A' })],
    stopsOnCancel: true,
  });
  const d = deps({ stripe });
  const { res } = await call(d);
  assert.equal(res.status, 200);
  assert.equal(stripe.calls.filter((c) => c.method === 'POST').length, 0);
  assert.ok(stripe.calls.some((c) => c.method === 'GET' && c.path === '/v1/invoices/in_TOPEN'));
});

test('open invoice の回収予定が消えなければ 502 で DB を消さない', async () => {
  const stripe = fakeStripe({
    subscriptions: [sub('sub_A', 'past_due')],
    invoices: [inv('in_TOPEN', 'open')],
    hook: (o, s) => (o.method === 'GET' && o.path === '/v1/invoices/in_TOPEN'
      ? { ...s.invs.get('in_TOPEN'), next_payment_attempt: 1800000000 }
      : undefined),
  });
  const d = deps({ stripe });
  const { res, body } = await call(d);
  assert.equal(res.status, 502);
  assert.deepEqual(body, { error: 'billing_cleanup_incomplete' });
  assert.equal(deleteCalls(d).length, 0);
});

test('auto_advance が false にならなければ 502 で DB を消さない', async () => {
  const stripe = fakeStripe({
    subscriptions: [],
    invoices: [inv('in_TDRAFT', 'draft')],
    hook: (o, s) => (o.method === 'GET' && o.path === '/v1/invoices/in_TDRAFT'
      ? { ...s.invs.get('in_TDRAFT'), auto_advance: true }
      : undefined),
  });
  const d = deps({ stripe });
  const { res } = await call(d);
  assert.equal(res.status, 502);
  assert.equal(deleteCalls(d).length, 0);
});

test('扱い方の決まっていない invoice status があれば、解約もせずに 500 で止める', async () => {
  const stripe = fakeStripe({
    subscriptions: [sub('sub_A', 'active')],
    invoices: [inv('in_TODD', 'something_new')],
  });
  const d = deps({ stripe });
  const { res, body, text } = await call(d);
  assert.equal(res.status, 500);
  assert.deepEqual(body, { error: 'billing_state_unsupported' });
  assert.equal(stripe.mutations().length, 0, 'Stripe へ何も変更を送らない');
  assert.equal(stripe.subs.get('sub_A').status, 'active');
  assert.equal(deleteCalls(d).length, 0);
  assertNoIds(text, d.logger.lines);
});

test('確認までの間に open が paid へ進んだら、それ以上触らずに進む', async () => {
  const stripe = fakeStripe({
    subscriptions: [],
    invoices: [inv('in_TOPEN', 'open')],
    hook: (o, s) => (o.method === 'GET' && o.path === '/v1/invoices/in_TOPEN'
      ? { ...s.invs.get('in_TOPEN'), status: 'paid', auto_advance: false, next_payment_attempt: null }
      : undefined),
  });
  const d = deps({ stripe });
  const { res } = await call(d);
  assert.equal(res.status, 200);
});

test('BillingCleanupError は ID を持たない', () => {
  const e = new BillingCleanupError('subscription_not_terminal', true);
  assert.equal(e.message, 'subscription_not_terminal');
  assert.equal(e.retryable, true);
});

// ---------------------------------------------------------
// 6. 再試行・二重送信
// ---------------------------------------------------------

test('DB 削除が失敗したら 502。再試行では Stripe を二重に変更せず DB 削除まで進む', async () => {
  const state = { deleted: false };
  const stripe = fakeStripe({
    subscriptions: [sub('sub_A', 'past_due')],
    invoices: [inv('in_TOPEN', 'open', { subscription: 'sub_A' }), inv('in_TPAID', 'paid')],
  });
  const rpc = stubRpc({ state, deleteFails: 1 });
  const d = deps({ state, stripe, rpc, session: stubSession(state) });

  const first = await call(d);
  assert.equal(first.res.status, 502);
  assert.deepEqual(first.body, { error: 'database_unavailable' });
  assert.equal(first.res.headers.get('set-cookie'), null);
  const mutationsAfterFirst = stripe.mutations().length;
  assert.equal(mutationsAfterFirst, 2);   // DELETE sub + POST invoice

  const second = await call(d);
  assert.equal(second.res.status, 200);
  assert.deepEqual(second.body, { deleted: true });
  assert.equal(stripe.mutations().length, mutationsAfterFirst, '再試行で Stripe を変更しない');
  assert.equal(deleteCalls(d).length, 2);
});

test('削除済みの後の再送は 401（session は CASCADE で消えている）', async () => {
  const state = { deleted: false };
  const d = deps({ state, rpc: stubRpc({ customerId: null, state }), session: stubSession(state) });
  const first = await call(d);
  assert.equal(first.res.status, 200);
  const second = await call(d);
  assert.equal(second.res.status, 401);
  assert.equal(deleteCalls(d).length, 1);
});

test('並行した二重送信で先に消えていても（deleted=false）200', async () => {
  const d = deps({ rpc: stubRpc({ customerId: null, deleteResult: [{ deleted: false }] }) });
  const { res, body } = await call(d);
  assert.equal(res.status, 200);
  assert.deepEqual(body, { deleted: true });
});

test('削除 RPC の戻り値が壊れていれば 500', async () => {
  for (const deleteResult of [[], [{}], [{ deleted: 'yes' }], null]) {
    const d = deps({ rpc: stubRpc({ customerId: null, deleteResult }) });
    const { res } = await call(d);
    assert.equal(res.status, 500, JSON.stringify(deleteResult));
    assert.equal(res.headers.get('set-cookie'), null);
  }
});

test('context RPC が 0 行なら 500（Stripe も削除も呼ばない）', async () => {
  const d = deps({ rpc: stubRpc({ contextRows: [] }) });
  const { res, body } = await call(d);
  assert.equal(res.status, 500);
  assert.deepEqual(body, { error: 'internal_error' });
  assert.equal(d.stripe.calls.length, 0);
  assert.equal(deleteCalls(d).length, 0);
});

test('context RPC の障害は 502', async () => {
  const rpc = async () => { throw new SupabaseError('unavailable', 'x'); };
  rpc.calls = [];
  const d = deps({ rpc });
  const { res, body } = await call(d);
  assert.equal(res.status, 502);
  assert.deepEqual(body, { error: 'database_unavailable' });
});

test('規約の版が取れなくても番兵で Customer を引ける', async () => {
  const d = deps({ currentVersion: () => { throw new Error('draft'); } });
  await call(d);
  assert.equal(d.rpc.calls[0].args.p_terms_version, 'unavailable');
});

test('応答とログに ID を出さない（成功・各種失敗）', async () => {
  const scenarios = [
    fakeStripe({ subscriptions: [sub('sub_A', 'active')], invoices: [inv('in_TOPEN', 'open')] }),
    fakeStripe({ subscriptions: [sub('sub_A', 'active')],
                 hook: (o) => (o.method === 'DELETE'
                   ? new StripeApiError('request_failed', 'sub_A cus_TESTDUMMY0001', { httpStatus: 500, retryable: true, requestId: 'req_x' })
                   : undefined) }),
    fakeStripe({ invoices: [inv('in_TODD', 'weird')] }),
  ];
  for (const stripe of scenarios) {
    const d = deps({ stripe });
    const { text } = await call(d);
    assertNoIds(text, d.logger.lines);
  }
});

// ---------------------------------------------------------
// 7. 削除後に届く webhook
// ---------------------------------------------------------

const WEBHOOK_SECRET = 'whsec_dummy_for_tests_only';
const PRICE_ID = 'price_dummy_web_pro_jpy_launch';
const WEBHOOK_ENV = {
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  STRIPE_SECRET_KEY: 'sk_test_dummy_for_tests_only',
  SUPABASE_URL: 'https://example-project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_dummy_for_tests_only',
  STRIPE_PRICE_WEB_PRO_JPY_LAUNCH: PRICE_ID,
  STRIPE_PRICE_WEB_PRO_JPY_STANDARD: 'price_dummy_jpy_standard',
  STRIPE_PRICE_WEB_PRO_USD_LAUNCH: 'price_dummy_usd_launch',
  STRIPE_PRICE_WEB_PRO_USD_STANDARD: 'price_dummy_usd_standard',
};
const NOW_SEC = 1788000000;

async function lateWebhook({ status, rpc }) {
  const event = {
    id: 'evt_dummy_late', object: 'event', type: 'customer.subscription.deleted',
    created: NOW_SEC, data: { object: { id: 'sub_dummy_1' } },
  };
  const body = JSON.stringify(event);
  const v1 = await computeStripeSignature(WEBHOOK_SECRET, NOW_SEC, body);
  const request = new Request('https://example.com/api/billing/webhook', {
    method: 'POST', headers: { 'Stripe-Signature': `t=${NOW_SEC},v1=${v1}` }, body,
  });
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET' });
    if (String(url).includes('/v1/customers/')) {
      return new Response(JSON.stringify({ id: 'cus_dummy_1', object: 'customer',
        address: { country: 'JP' } }), { status: 200 });
    }
    return new Response(JSON.stringify({
      id: 'sub_dummy_1', object: 'subscription', customer: 'cus_dummy_1', status,
      cancel_at_period_end: false, current_period_end: 1790000000,
      metadata: { user_id: USER_ID },
      items: { data: [{ id: 'si_1', price: { id: PRICE_ID } }] },
    }), { status: 200 });
  };
  const res = await handleWebhook(request, WEBHOOK_ENV,
    { rpc, fetchImpl, logger: { error() {}, warn() {}, log() {} }, now: NOW_SEC * 1000 });
  return { res, body: await res.json(), calls };
}

test('削除後に届いた canceled の event は RPC の no-op 行で 200（schedule も触らない）', async () => {
  const rpcCalls = [];
  const rpc = async (name, args) => {
    rpcCalls.push({ name, args });
    return [{ processed: false, already_processed: false, stale: false,
              plan_id: null, status: 'canceled', past_due_since: null, last_stripe_event_at: null }];
  };
  const { res, body, calls } = await lateWebhook({ status: 'canceled', rpc });
  assert.equal(res.status, 200);
  assert.deepEqual(body, { received: true, processed: false, already_processed: false, stale: false });
  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].args.p_status, 'canceled');
  // 取り直し（subscription + Customer）以外に Stripe を呼ばない。
  assert.equal(calls.length, 2);
  assert.equal(calls.some((c) => c.url.includes('subscription_schedules')), false);
});

test('削除後に届いた active の event（RPC が例外）は 500 で失敗させる', async () => {
  const rpc = async () => { throw new SupabaseError('request_failed', 'subscriptions 行が存在しません。'); };
  const { res, body } = await lateWebhook({ status: 'active', rpc });
  assert.equal(res.status, 500);
  assert.deepEqual(body, { error: 'internal_error' });
});

// ---------------------------------------------------------
// 8. migration の静的検査
// ---------------------------------------------------------

const MIGRATIONS = new URL('../../../supabase/migrations/', import.meta.url);
const NEW_SQL = fs.readFileSync(new URL('20260911090000_account_deletion.sql', MIGRATIONS), 'utf8');
const OLD_SQL = fs.readFileSync(new URL('20260907052839_stripe_subscription_event_rpc.sql', MIGRATIONS), 'utf8');

/** `--` コメントを除き、空白を 1 つにまとめる。 */
function normalizeSql(sql) {
  return sql.split('\n').map((l) => l.replace(/--.*$/, '')).join(' ').replace(/\s+/g, ' ').trim();
}

function applyFunction(sql) {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.apply_stripe_subscription_event(');
  assert.ok(start >= 0);
  const end = sql.indexOf('$$;', sql.indexOf('AS $$', start));
  return sql.slice(start, end + 3);
}

test('migration: delete_user_account は SECURITY INVOKER + search_path 固定 + service_role のみ', () => {
  const sql = normalizeSql(NEW_SQL);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.delete_user_account\( p_user_id UUID \) RETURNS TABLE \( deleted BOOLEAN \) LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.delete_user_account\(UUID\) FROM PUBLIC;/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.delete_user_account\(UUID\) FROM anon, authenticated;/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.delete_user_account\(UUID\) TO service_role;/);
  assert.doesNotMatch(sql, /SECURITY DEFINER/);
  assert.doesNotMatch(sql, /\bEXECUTE format|\bformat\(/);
});

test('migration: 削除は users だけ。terms_consents / stripe_events を消さず、表定義も変えない', () => {
  const sql = normalizeSql(NEW_SQL);
  const deletes = sql.match(/DELETE FROM [a-z_.]+/g) || [];
  assert.deepEqual(deletes, ['DELETE FROM public.users']);
  assert.doesNotMatch(sql, /(DELETE|UPDATE|INSERT INTO)\s+(FROM\s+)?public\.terms_consents/);
  assert.doesNotMatch(sql, /\b(ALTER|DROP|TRUNCATE|CREATE TABLE|CREATE INDEX)\b/);
});

test('migration: apply_stripe_subscription_event の signature と戻り値は変えていない', () => {
  const sigOf = (sql) => {
    const f = normalizeSql(applyFunction(sql));
    return f.slice(0, f.indexOf(' AS $$'));
  };
  assert.equal(sigOf(NEW_SQL), sigOf(OLD_SQL));
  for (const g of [
    /REVOKE ALL ON FUNCTION public\.apply_stripe_subscription_event\( TEXT, TEXT, TIMESTAMPTZ, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, BOOLEAN \) FROM PUBLIC;/,
    /REVOKE ALL ON FUNCTION public\.apply_stripe_subscription_event\( TEXT, TEXT, TIMESTAMPTZ, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, BOOLEAN \) FROM anon, authenticated;/,
    /GRANT EXECUTE ON FUNCTION public\.apply_stripe_subscription_event\( TEXT, TEXT, TIMESTAMPTZ, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, BOOLEAN \) TO service_role;/,
  ]) {
    assert.match(normalizeSql(NEW_SQL), g);
  }
});

test('migration: apply 本体の差分は「削除済み + 終了状態なら no-op」の 2 か所だけ', () => {
  const next = normalizeSql(applyFunction(NEW_SQL));
  const prev = normalizeSql(applyFunction(OLD_SQL));
  const blocks = next.match(/IF p_status = ANY \(v_terminal_statuses\) AND NOT EXISTS \(SELECT 1 FROM public\.users u WHERE u\.id = p_user_id\) THEN RETURN QUERY SELECT FALSE, (TRUE|FALSE), FALSE, NULL::TEXT, p_status, NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ; RETURN; END IF; /g) || [];
  assert.equal(blocks.length, 2);
  assert.ok(blocks[0].includes('SELECT FALSE, TRUE, FALSE'), 'Step 1 側は already_processed=TRUE');
  assert.ok(blocks[1].includes('SELECT FALSE, FALSE, FALSE'), 'Step 2 側は processed=FALSE');
  let stripped = next;
  for (const b of blocks) stripped = stripped.replace(b, '');
  stripped = stripped.replace(/ v_terminal_statuses CONSTANT TEXT\[\] := ARRAY\['canceled', 'incomplete_expired'\];/, '');
  assert.equal(stripped, prev);
  // 行が無いときの例外は 2 か所とも残っている。
  assert.equal((next.match(/RAISE EXCEPTION 'subscriptions 行が存在しません。'/g) || []).length, 2);
});

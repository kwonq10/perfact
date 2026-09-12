// =========================================================
// 削除済みアカウントの孤児 subscription 回収の単体テスト
//
//   対象:
//     functions/api/billing/webhook.js  handleMissingSubscriptionRow
//     functions/api/_lib/billing-cleanup.js
//     supabase/migrations/20260912000000_user_exists.sql
//
//   背景（race の発生条件）:
//     Checkout 完了の直後、webhook が stripe_customer_id を DB へ書く前に
//     /api/account/delete が走ると、削除 API は DB に Customer が無いため
//     Stripe を 1 回も呼ばずに終わる。結果、Stripe 側に **課金され続ける
//     孤児 subscription** が残り、遅れて届く active の event は
//     apply_stripe_subscription_event の例外 -> 500 になり続けていた。
//
//   ここで固定するもの:
//     - 孤児と判定する条件（Sukima の Price / UUID の metadata / users 行が無い）
//     - terminal status では Stripe を **1 回も呼ばない**こと
//     - 非 terminal では即時解約し、GET で終了を確認すること
//     - invoice は削除 API と**同じ規則**で扱うこと（void しない・返金しない）
//     - users 行が**ある**ときは従来どおり 500 で、Stripe を変更しないこと
//     - 未知の invoice status では何も変更せずに止まること
//     - 再送しても二重変更にならないこと（Idempotency-Key が同じ）
//     - 応答にもログにも ID を出さないこと
//
//   **api.stripe.com へは一度も通信しない。** fetch も RPC も mock する。
//   本番の secret / Customer ID はフィクスチャに入れない。
// =========================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { RPC_USER_EXISTS, handleWebhook } from '../billing/webhook.js';
import {
  cancelSubscriptionKey,
  stopInvoiceKey,
  stopOrphanSubscriptionBilling,
} from '../_lib/billing-cleanup.js';
import * as deleteApi from '../account/delete.js';
import * as cleanup from '../_lib/billing-cleanup.js';
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
const SUB_ID = 'sub_dummy_orphan_1';
const CUS_ID = 'cus_dummy_orphan_1';
const INV_ID = 'in_dummy_orphan_1';
const NOW_SEC = 1788000000;
const NOW_MS = NOW_SEC * 1000;
const PERIOD_END_SEC = 1790000000;

const quiet = { error() {}, warn() {}, log() {} };

const MIGRATION_PATH = new URL(
  '../../../supabase/migrations/20260912000000_user_exists.sql', import.meta.url,
);


// =========================================================
// テスト用の Stripe（状態を持つ）
// =========================================================

/** Stripe 側の状態。DELETE / POST で実際に変化する。 */
function stripeState(over = {}) {
  return {
    sub: {
      id: SUB_ID,
      object: 'subscription',
      customer: CUS_ID,
      status: over.subStatus ?? 'active',
      cancel_at_period_end: false,
      current_period_end: PERIOD_END_SEC,
      metadata: { user_id: USER_ID },
      items: { data: [{ id: 'si_1', price: { id: over.priceId ?? PRICE_ID } }] },
    },
    customer: { id: CUS_ID, object: 'customer', address: { country: 'JP', postal_code: '100-0001' } },
    invoices: over.invoices ?? [],
  };
}

/** draft / open / paid などの invoice を作る。 */
function invoice(over = {}) {
  return {
    id: over.id ?? INV_ID,
    object: 'invoice',
    status: over.status ?? 'open',
    auto_advance: over.auto_advance ?? true,
    next_payment_attempt: over.next_payment_attempt ?? NOW_SEC + 86400,
    ...over,
  };
}

function res(body, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

/**
 * Stripe fetch の mock。**状態を書き換える**ので、
 * 解約後の GET は canceled を返し、auto_advance を止めた後の GET は false を返す。
 */
function stripeFetch(state, hooks = {}) {
  const calls = [];
  const fn = async (url, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = new URL(String(url)).pathname;
    const call = {
      method,
      path,
      url: String(url),
      key: init?.headers?.['Idempotency-Key'] ?? null,
      body: init?.body ?? null,
    };
    calls.push(call);

    const forced = hooks.before ? hooks.before(call, state) : null;
    if (forced) return forced;

    if (path === '/v1/invoices') {
      return res({ object: 'list', data: state.invoices.map((i) => ({ ...i })), has_more: false });
    }
    if (path.startsWith('/v1/invoices/')) {
      const id = path.slice('/v1/invoices/'.length);
      const inv = state.invoices.find((i) => i.id === id);
      if (!inv) return res({ error: { message: 'no such invoice' } }, 404);
      if (method === 'POST') {
        inv.auto_advance = false;
        if (inv.status === 'open') inv.next_payment_attempt = null;
      }
      return res({ ...inv });
    }
    if (path === '/v1/subscriptions/' + SUB_ID) {
      if (method === 'DELETE') {
        state.sub = { ...state.sub, status: 'canceled' };
      }
      return res({ ...state.sub });
    }
    if (path === '/v1/customers/' + CUS_ID) return res(state.customer);
    return res({ error: { message: 'unexpected path ' + path } }, 404);
  };
  fn.calls = calls;
  return fn;
}

/**
 * Supabase RPC の mock。
 * apply は既定で「subscriptions 行が存在しません。」の例外を投げる。
 */
function rpcMock(o = {}) {
  const calls = [];
  const fn = async (name, args) => {
    calls.push({ name, args });
    if (name === 'apply_stripe_subscription_event') {
      if (o.applyOk === true) return [{ processed: true, already_processed: false, stale: false }];
      throw (o.applyError ?? new SupabaseError('request_failed', 'subscriptions 行が存在しません。'));
    }
    if (name === RPC_USER_EXISTS) {
      if (o.userExistsError) throw o.userExistsError;
      if (o.userExistsRows !== undefined) return o.userExistsRows;
      return [{ exists: o.userExists === true }];
    }
    throw new Error('想定外の RPC: ' + name);
  };
  fn.calls = calls;
  return fn;
}

function stripeEvent(type = 'customer.subscription.created', over = {}) {
  return {
    id: over.id ?? 'evt_dummy_orphan_1',
    object: 'event',
    type,
    created: NOW_SEC,
    data: { object: { id: SUB_ID } },
  };
}

async function signedRequest(event) {
  const body = JSON.stringify(event);
  const v1 = await computeStripeSignature(WEBHOOK_SECRET, NOW_SEC, body);
  return new Request('https://example.com/api/billing/webhook', {
    method: 'POST',
    headers: { 'Stripe-Signature': `t=${NOW_SEC},v1=${v1}` },
    body,
  });
}

/** 1 回叩く。state / rpc を差し替えられる。 */
async function post(o = {}) {
  const state = o.state ?? stripeState();
  const fetchImpl = o.fetchImpl ?? stripeFetch(state, o.hooks);
  const rpc = o.rpc ?? rpcMock(o.rpcOptions ?? {});
  const logger = o.logger ?? quiet;
  const request = await signedRequest(o.event ?? stripeEvent(o.eventType));
  const response = await handleWebhook(request, o.env ?? ENV,
    { rpc, fetchImpl, logger, now: NOW_MS });
  return { res: response, body: await response.json(), state, fetchImpl, rpc };
}

/** Stripe を「変更した」呼び出しだけを数える（GET は含めない）。 */
function mutatingCalls(fetchImpl) {
  return fetchImpl.calls.filter((c) => c.method === 'DELETE' || c.method === 'POST');
}


// =========================================================
// 1. 孤児の判定（users 行が無い + 非 terminal）
// =========================================================

test('孤児 active: 即時解約して 200 orphan_canceled=true を返す', async () => {
  const { res: r, body, fetchImpl, state } = await post({ rpcOptions: { userExists: false } });

  assert.equal(r.status, 200);
  assert.deepEqual(body, { received: true, processed: false, orphan: true, orphan_canceled: true });
  assert.equal(state.sub.status, 'canceled', 'Stripe 側が解約済みになる');

  const del = fetchImpl.calls.filter((c) => c.method === 'DELETE');
  assert.equal(del.length, 1, '解約は 1 回だけ');
  assert.equal(del[0].path, '/v1/subscriptions/' + SUB_ID);
  assert.equal(del[0].body, null, 'params なし = 日割りも追加請求も作らない');
});

test('孤児 active: user_exists へ渡すのは p_user_id だけ', async () => {
  const { rpc } = await post({ rpcOptions: { userExists: false } });
  const call = rpc.calls.find((c) => c.name === RPC_USER_EXISTS);
  assert.ok(call, 'user_exists を呼ぶ');
  assert.deepEqual(Object.keys(call.args), ['p_user_id']);
  assert.equal(call.args.p_user_id, USER_ID);
});

test('孤児 active: 解約後に GET で終了を確認している', async () => {
  const { fetchImpl } = await post({ rpcOptions: { userExists: false } });
  const subCalls = fetchImpl.calls.filter((c) => c.path === '/v1/subscriptions/' + SUB_ID);
  const methods = subCalls.map((c) => c.method);
  assert.deepEqual(methods, ['GET', 'DELETE', 'GET'],
    '再取得 -> 解約 -> 終了確認 の順');
});

test('孤児 past_due / trialing / unpaid / incomplete も解約する', async () => {
  for (const status of ['past_due', 'trialing', 'unpaid', 'incomplete']) {
    const state = stripeState({ subStatus: status });
    const { res: r, body, state: after } = await post({ state, rpcOptions: { userExists: false } });
    assert.equal(r.status, 200, status);
    assert.equal(body.orphan_canceled, true, status);
    assert.equal(after.sub.status, 'canceled', status);
  }
});


// =========================================================
// 2. terminal status は Stripe を 1 回も変更しない
// =========================================================

test('孤児 canceled / incomplete_expired: Stripe を変更せず 200 orphan_canceled=false', async () => {
  for (const status of ['canceled', 'incomplete_expired']) {
    const state = stripeState({ subStatus: status });
    const { res: r, body, fetchImpl } = await post({ state, rpcOptions: { userExists: false } });
    assert.equal(r.status, 200, status);
    assert.deepEqual(body,
      { received: true, processed: false, orphan: true, orphan_canceled: false }, status);
    assert.equal(mutatingCalls(fetchImpl).length, 0, status + ': 変更系を呼ばない');
    // invoice の一覧すら引かない（削除済み契約に追加の後始末は要らない）。
    assert.equal(fetchImpl.calls.some((c) => c.path === '/v1/invoices'), false, status);
  }
});


// =========================================================
// 3. users 行がある = データ異常。Stripe を触らない
// =========================================================

test('users 行があるのに subscriptions 行が無い場合は 500 のまま（Stripe を変更しない）', async () => {
  const { res: r, body, fetchImpl, state } = await post({ rpcOptions: { userExists: true } });

  assert.equal(r.status, 500);
  assert.deepEqual(body, { error: 'internal_error' });
  assert.equal(mutatingCalls(fetchImpl).length, 0, '解約も invoice 変更もしない');
  assert.equal(state.sub.status, 'active', 'Stripe 側は無傷');
});

test('user_exists が失敗したら Stripe を触らずに 5xx（切り分け不能）', async () => {
  const cases = [
    { err: new SupabaseError('unavailable', 'down'), status: 502, body: { error: 'database_unavailable' } },
    { err: new SupabaseError('not_configured', 'x'), status: 500, body: { error: 'server_misconfigured' } },
    { err: new SupabaseError('request_failed', 'x'), status: 500, body: { error: 'internal_error' } },
    { err: new Error('boom'), status: 500, body: { error: 'internal_error' } },
  ];
  for (const c of cases) {
    const { res: r, body, fetchImpl, state } = await post({
      rpcOptions: { userExistsError: c.err },
    });
    assert.equal(r.status, c.status, c.err.message);
    assert.deepEqual(body, c.body, c.err.message);
    assert.equal(mutatingCalls(fetchImpl).length, 0, c.err.message);
    assert.equal(state.sub.status, 'active', c.err.message);
  }
});

test('user_exists の戻り値が契約と違えば 500（Stripe を触らない）', async () => {
  for (const rows of [[], [{}], [{ exists: 'false' }], [{ exists: null }], null]) {
    const { res: r, body, fetchImpl } = await post({ rpcOptions: { userExistsRows: rows } });
    assert.equal(r.status, 500, JSON.stringify(rows));
    assert.deepEqual(body, { error: 'internal_error' }, JSON.stringify(rows));
    assert.equal(mutatingCalls(fetchImpl).length, 0, JSON.stringify(rows));
  }
});


// =========================================================
// 4. Sukima 以外の subscription には絶対に触れない
// =========================================================

test('未知の Price の subscription は孤児処理へ進まない（user_exists すら呼ばない）', async () => {
  const state = stripeState({ priceId: 'price_someone_elses_product' });
  const { res: r, body, fetchImpl, rpc } = await post({ state, rpcOptions: { userExists: false } });

  assert.equal(r.status, 500);
  assert.deepEqual(body, { error: 'internal_error' });
  assert.equal(mutatingCalls(fetchImpl).length, 0, '解約しない');
  assert.equal(rpc.calls.some((c) => c.name === RPC_USER_EXISTS), false,
    'snapshot の段階で落ちるので user_exists まで到達しない');
  assert.equal(state.sub.status, 'active');
});

test('metadata.user_id が UUID でない subscription は孤児処理へ進まない', async () => {
  for (const bad of [undefined, '', 'not-a-uuid', 12345]) {
    const state = stripeState();
    state.sub.metadata = bad === undefined ? {} : { user_id: bad };
    const { res: r, fetchImpl, rpc } = await post({ state, rpcOptions: { userExists: false } });
    assert.equal(r.status, 500, String(bad));
    assert.equal(mutatingCalls(fetchImpl).length, 0, String(bad));
    assert.equal(rpc.calls.some((c) => c.name === RPC_USER_EXISTS), false, String(bad));
  }
});


// =========================================================
// 5. invoice の扱い（削除 API と同じ規則）
// =========================================================

test('孤児 past_due: open invoice は void せず auto_advance=false / next_payment_attempt=null', async () => {
  const state = stripeState({
    subStatus: 'past_due',
    invoices: [invoice({ id: INV_ID, status: 'open', auto_advance: true })],
  });
  const { res: r, body, state: after, fetchImpl } = await post({
    state, rpcOptions: { userExists: false },
  });

  assert.equal(r.status, 200);
  assert.equal(body.orphan_canceled, true);
  const inv = after.invoices[0];
  assert.equal(inv.status, 'open', 'void にしない（請求の記録を消さない）');
  assert.equal(inv.auto_advance, false);
  assert.equal(inv.next_payment_attempt, null);
  assert.equal(fetchImpl.calls.some((c) => c.path.startsWith('/v1/credit_notes')), false,
    '返金もクレジットも作らない');
});

test('paid / void / uncollectible の invoice は触らない', async () => {
  const state = stripeState({
    invoices: [
      invoice({ id: 'in_paid', status: 'paid', auto_advance: false, next_payment_attempt: null }),
      invoice({ id: 'in_void', status: 'void', auto_advance: false, next_payment_attempt: null }),
      invoice({ id: 'in_unc', status: 'uncollectible', auto_advance: false, next_payment_attempt: null }),
    ],
  });
  const { res: r, fetchImpl } = await post({ state, rpcOptions: { userExists: false } });

  assert.equal(r.status, 200);
  const invoicePosts = fetchImpl.calls.filter(
    (c) => c.method === 'POST' && c.path.startsWith('/v1/invoices/'),
  );
  assert.equal(invoicePosts.length, 0, '支払い済み・取り消し済みは変更しない');
});

test('draft invoice は auto_advance=false にする', async () => {
  const state = stripeState({
    invoices: [invoice({ id: 'in_draft', status: 'draft', auto_advance: true, next_payment_attempt: null })],
  });
  const { res: r, state: after } = await post({ state, rpcOptions: { userExists: false } });
  assert.equal(r.status, 200);
  assert.equal(after.invoices[0].status, 'draft', 'draft のまま（確定させない）');
  assert.equal(after.invoices[0].auto_advance, false);
});

test('未知の invoice status では何も変更せずに 500 billing_state_unsupported', async () => {
  const state = stripeState({
    invoices: [invoice({ id: 'in_weird', status: 'some_future_status' })],
  });
  const { res: r, body, fetchImpl, state: after } = await post({
    state, rpcOptions: { userExists: false },
  });

  assert.equal(r.status, 500);
  assert.deepEqual(body, { error: 'billing_state_unsupported' });
  assert.equal(mutatingCalls(fetchImpl).length, 0, '解約すらしない（順序どおり）');
  assert.equal(after.sub.status, 'active', 'subscription は無傷');
});


// =========================================================
// 6. Stripe 失敗時の扱い
// =========================================================

test('解約が一時障害なら 502（DB も Stripe も確定させない）', async () => {
  const state = stripeState();
  const fetchImpl = stripeFetch(state, {
    before: (call) => (call.method === 'DELETE'
      ? res({ error: { message: 'temporary' } }, 500)
      : null),
  });
  const { res: r, body } = await post({ state, fetchImpl, rpcOptions: { userExists: false } });
  assert.equal(r.status, 502);
  assert.deepEqual(body, { error: 'stripe_unavailable' });
});

test('解約したのに終了を確認できなければ 502 billing_cleanup_incomplete', async () => {
  const state = stripeState();
  // DELETE は成功扱いにするが、状態を変えない（= 確認できない）。
  const fetchImpl = stripeFetch(state, {
    before: (call, st) => (call.method === 'DELETE' ? res({ ...st.sub }) : null),
  });
  const { res: r, body } = await post({ state, fetchImpl, rpcOptions: { userExists: false } });
  assert.equal(r.status, 502);
  assert.deepEqual(body, { error: 'billing_cleanup_incomplete' });
});

test('Stripe の設定不足は 500 server_misconfigured', async () => {
  const env = { ...ENV, STRIPE_SECRET_KEY: '' };
  const state = stripeState();
  const { res: r, body } = await post({ state, env, rpcOptions: { userExists: false } });
  assert.equal(r.status, 500);
  assert.deepEqual(body, { error: 'server_misconfigured' });
});


// =========================================================
// 7. 冪等（再送）
// =========================================================

test('Idempotency-Key は削除 API と同じ形（二重処理にならない）', async () => {
  const state = stripeState({
    invoices: [invoice({ id: INV_ID, status: 'open', auto_advance: true })],
  });
  const { fetchImpl } = await post({ state, rpcOptions: { userExists: false } });

  const del = fetchImpl.calls.find((c) => c.method === 'DELETE');
  assert.equal(del.key, cancelSubscriptionKey(SUB_ID));

  const invPost = fetchImpl.calls.find(
    (c) => c.method === 'POST' && c.path === '/v1/invoices/' + INV_ID,
  );
  assert.equal(invPost.key, stopInvoiceKey(INV_ID));
});

test('同じ event を再送しても二重に変更しない（2 回目は解約済みとして 200）', async () => {
  const state = stripeState({
    invoices: [invoice({ id: INV_ID, status: 'open', auto_advance: true })],
  });

  const first = await post({ state, rpcOptions: { userExists: false } });
  assert.equal(first.res.status, 200);
  assert.equal(first.body.orphan_canceled, true);

  // 2 回目。Stripe は canceled を返すので terminal 扱いになる。
  const second = await post({ state, rpcOptions: { userExists: false } });
  assert.equal(second.res.status, 200);
  assert.deepEqual(second.body,
    { received: true, processed: false, orphan: true, orphan_canceled: false });
  assert.equal(mutatingCalls(second.fetchImpl).length, 0, '2 回目は何も変更しない');
});

test('解約済み subscription への DELETE が 404 でも GET の確認で収束する', async () => {
  const state = stripeState();
  const fetchImpl = stripeFetch(state, {
    before: (call, st) => {
      if (call.method !== 'DELETE') return null;
      st.sub = { ...st.sub, status: 'canceled' };
      return res({ error: { message: 'No such subscription' } }, 404);
    },
  });
  const { res: r, body } = await post({ state, fetchImpl, rpcOptions: { userExists: false } });
  assert.equal(r.status, 200);
  assert.equal(body.orphan_canceled, true);
});


// =========================================================
// 8. 情報漏洩
// =========================================================

test('孤児処理の応答に ID を出さない', async () => {
  const state = stripeState({
    invoices: [invoice({ id: INV_ID, status: 'open', auto_advance: true })],
  });
  const { body } = await post({ state, rpcOptions: { userExists: false } });
  const dump = JSON.stringify(body);
  for (const f of [USER_ID, SUB_ID, CUS_ID, INV_ID, PRICE_ID,
                   ENV.STRIPE_SECRET_KEY, ENV.SUPABASE_SERVICE_ROLE_KEY, 'sk_test', 'whsec_']) {
    assert.equal(dump.includes(f), false, f);
  }
});

test('孤児処理のログに ID を出さない（件数だけ）', async () => {
  const lines = [];
  const logger = {
    error: (...a) => lines.push(a.map(String).join(' ')),
    warn: (...a) => lines.push(a.map(String).join(' ')),
    log: (...a) => lines.push(a.map(String).join(' ')),
  };
  const state = stripeState({
    invoices: [invoice({ id: INV_ID, status: 'open', auto_advance: true })],
  });
  await post({ state, logger, rpcOptions: { userExists: false } });

  const all = lines.join(' ');
  for (const f of [USER_ID, SUB_ID, CUS_ID, INV_ID, PRICE_ID,
                   ENV.STRIPE_SECRET_KEY, ENV.SUPABASE_SERVICE_ROLE_KEY,
                   'sk_test', 'whsec_', 'cus_', 'sub_', 'in_']) {
    assert.equal(all.includes(f), false, f + ' がログに出ている: ' + all);
  }
  assert.ok(all.includes('canceled=1'), '件数は残す');
  assert.ok(all.includes('invoices_stopped=1'), '件数は残す');
});


// =========================================================
// 9. 共通化（削除 API と webhook が同じ実装を使う）
// =========================================================

test('delete.js の re-export は _lib/billing-cleanup.js と同一実体', async () => {
  const shared = [
    'BillingCleanupError', 'INVOICE_STOP_STATUSES', 'INVOICE_UNTOUCHED_STATUSES',
    'LIST_PAGE_LIMIT', 'MAX_LIST_PAGES', 'TERMINAL_SUBSCRIPTION_STATUSES',
    'assertInvoiceStatusesSupported', 'cancelOpenSubscriptions', 'cancelSubscriptionKey',
    'listAll', 'stopCustomerBilling', 'stopInvoiceCollection', 'stopInvoiceKey',
  ];
  for (const name of shared) {
    assert.equal(deleteApi[name], cleanup[name], name + ' が別実装になっている');
  }
});

test('孤児処理は渡された subscription 1 本しか解約しない', async () => {
  // Customer 配下を列挙しないことを、呼び出し先の直接テストで固定する。
  const calls = [];
  const ctx = {
    env: ENV,
    stripe: async (o) => {
      calls.push(o);
      if (o.path === '/v1/invoices') return { object: 'list', data: [], has_more: false };
      if (o.method === 'DELETE') return { id: SUB_ID, status: 'canceled' };
      return { id: SUB_ID, status: 'canceled' };
    },
  };
  const sub = { id: SUB_ID, status: 'active' };
  const out = await stopOrphanSubscriptionBilling(ctx, sub, CUS_ID);

  assert.deepEqual(out, { canceled: 1, invoicesStopped: 0 });
  assert.equal(calls.some((c) => c.path === '/v1/subscriptions'), false,
    'Customer 配下の subscription を列挙しない');
});


// =========================================================
// 10. migration の静的検査
// =========================================================

test('20260912000000_user_exists.sql が存在し、方針どおりに書かれている', () => {
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');

  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.user_exists\(/,
    '再実行可能な CREATE OR REPLACE');
  assert.match(sql, /RETURNS TABLE \(\s*"exists" BOOLEAN\s*\)/,
    '予約語なので "exists" は二重引用符で囲む');
  assert.match(sql, /\bSTABLE\b/, '読み取り専用');
  assert.match(sql, /SECURITY INVOKER/, '既存流儀に合わせる');
  assert.match(sql, /SET search_path = public, pg_temp/, 'search_path を固定する');
  assert.match(sql, /GRANT\s+EXECUTE ON FUNCTION public\.user_exists\(UUID\) TO service_role/,
    'service_role にだけ EXECUTE');
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.user_exists\(UUID\) FROM anon, authenticated/,
    'anon / authenticated からは剥奪する');
});

test('user_exists は書き込みをしない（additive であること）', () => {
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  const body = sql.replace(/^\s*--.*$/gm, '');  // コメントを除く
  for (const forbidden of [
    /\bINSERT\s+INTO\b/i, /\bUPDATE\s+public\./i, /\bDELETE\s+FROM\b/i,
    /\bDROP\s+(FUNCTION|TABLE)\b/i, /\bALTER\s+TABLE\b/i, /\bCREATE\s+TABLE\b/i,
    /\bEXECUTE\s+format\(/i,
  ]) {
    assert.equal(forbidden.test(body), false, '禁止パターン: ' + forbidden);
  }
});

test('user_exists は利用者の属性を返さない', () => {
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  const body = sql.replace(/^\s*--.*$/gm, '');
  for (const column of ['email', 'google_sub', 'display_name', 'timezone']) {
    assert.equal(body.includes(column), false, column + ' を返している');
  }
});

test('既存 2 つの migration に手を入れていない（signature 不変）', () => {
  const applyPath = new URL(
    '../../../supabase/migrations/20260911090000_account_deletion.sql', import.meta.url,
  );
  const sql = fs.readFileSync(applyPath, 'utf8');
  // アカウント削除の migration は apply_stripe_subscription_event を
  // CREATE OR REPLACE のまま差し替えている（DROP しない）。
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.apply_stripe_subscription_event\(/);
  assert.equal(/DROP\s+FUNCTION\s+public\.apply_stripe_subscription_event/i.test(sql), false);
  // 孤児回収は API 層の責務。DB 側へ Stripe の知識を持ち込んでいないこと。
  assert.equal(sql.includes('user_exists'), false,
    'アカウント削除の migration は今回の変更で書き換えない');
});

// =========================================================
// Stripe API version による object shape の回帰テスト
//
//   次の 2 つは Stripe の API version によって位置が変わる:
//     - invoice event の subscription の位置
//     - subscription の current_period_end の位置
//   各版の実レスポンスで確認した shape を
//   そのまま固定する。以後 Stripe の API version が動いても、
//   どちらの shape でも壊れないことをここで担保する。
//
//   確認方法: 同一の subscription / invoice を
//             GET /v1/subscriptions/{id} と GET /v1/invoices/{id} に対して
//             Stripe-Version を変えて取得し、フィールドの有無を突き合わせた。
//
//   結果（invoice）:
//     | 経路                                                  | 2023-08-16 | 2025-03-31.basil 以降 |
//     | obj.subscription                                      | あり       | **なし**              |
//     | obj.parent.subscription_details.subscription          | あり       | あり                  |
//     | obj.lines.data[0].subscription                        | あり       | **なし**              |
//     | obj.lines.data[0].parent.subscription_item_details... | あり       | あり                  |
//
//   結果（subscription）:
//     | 位置                        | 2023-08-16 | 2025-03-31.basil 以降 |
//     | root.current_period_end     | あり       | **なし**              |
//     | items.data[0].current_...   | あり       | あり                  |
//
//   確認した版: 2023-08-16 / 2025-03-31.basil / 2025-08-27.basil / 2025-09-30.clover
//   （通常請求・決済失敗請求の両方で同一の結果）
//
//   **api.stripe.com へは通信しない。** ここに置くのは実レスポンスから起こした shape だけで、
//   id 類はダミーへ置き換えてある（Stripe の識別子をリポジトリへ持ち込まない）。
// =========================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSnapshot,
  extractCurrentPeriodEnd,
  extractPriceId,
  extractSubscriptionId,
  handleWebhook,
} from '../billing/webhook.js';
import { computeStripeSignature } from '../_lib/stripe-webhook.js';

const SUB_ID = 'sub_shapes_1';
const CUS_ID = 'cus_shapes_1';
const INV_ID = 'in_shapes_1';
const PRICE_ID = 'price_shapes_web_pro_jpy_launch';
const USER_ID = '11111111-2222-3333-4444-555555555555';
const PERIOD_END_SEC = 1791426311;
const PERIOD_END_ISO = '2026-10-08T02:25:11.000Z';

const ENV = {
  STRIPE_WEBHOOK_SECRET: 'whsec_dummy_for_tests_only',
  STRIPE_SECRET_KEY: 'sk_test_dummy_for_tests_only',
  SUPABASE_URL: 'https://example-project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_dummy_for_tests_only',
  STRIPE_PRICE_WEB_PRO_JPY_LAUNCH: PRICE_ID,
  STRIPE_PRICE_WEB_PRO_JPY_STANDARD: 'price_dummy_jpy_standard',
  STRIPE_PRICE_WEB_PRO_USD_LAUNCH: 'price_dummy_usd_launch',
  STRIPE_PRICE_WEB_PRO_USD_STANDARD: 'price_dummy_usd_standard',
};

// --- subscription の shape ---

/** 2023-08-16: current_period_end が root と items の両方にある。 */
function subscriptionOld() {
  return {
    id: SUB_ID,
    object: 'subscription',
    customer: CUS_ID,
    status: 'active',
    cancel_at_period_end: false,
    current_period_end: PERIOD_END_SEC,
    metadata: { user_id: USER_ID },
    items: {
      object: 'list',
      data: [{
        id: 'si_shapes_1',
        object: 'subscription_item',
        current_period_end: PERIOD_END_SEC,
        price: { id: PRICE_ID, object: 'price' },
      }],
    },
  };
}

/** 2025-03-31.basil 以降: root から current_period_end が消え、items 側だけになる。 */
function subscriptionNew() {
  const s = subscriptionOld();
  delete s.current_period_end;
  return s;
}

// --- invoice の shape ---

/** 2023-08-16: 4 経路すべてに subscription がある。 */
function invoiceOld() {
  return {
    id: INV_ID,
    object: 'invoice',
    customer: CUS_ID,
    subscription: SUB_ID,
    parent: { type: 'subscription_details', subscription_details: { subscription: SUB_ID } },
    lines: {
      object: 'list',
      data: [{
        id: 'il_shapes_1',
        object: 'line_item',
        subscription: SUB_ID,
        parent: { subscription_item_details: { subscription: SUB_ID } },
      }],
    },
  };
}

/** 2025-03-31.basil 以降: root と明細行の subscription が消え、parent 側だけになる。 */
function invoiceNew() {
  const i = invoiceOld();
  delete i.subscription;
  delete i.lines.data[0].subscription;
  return i;
}


// =========================================================
// 1. invoice からの subscription 抽出
// =========================================================

test('invoice（2023-08-16 の shape）から subscription を取れる', () => {
  assert.equal(extractSubscriptionId('invoice.payment_succeeded', invoiceOld()), SUB_ID);
  assert.equal(extractSubscriptionId('invoice.payment_failed', invoiceOld()), SUB_ID);
});

test('invoice（2025-03-31.basil 以降の shape）でも subscription を取れる', () => {
  assert.equal(extractSubscriptionId('invoice.payment_succeeded', invoiceNew()), SUB_ID);
  assert.equal(extractSubscriptionId('invoice.payment_failed', invoiceNew()), SUB_ID);
});

test('新しい版の invoice には root / 明細行の subscription が無い', () => {
  const i = invoiceNew();
  assert.equal(i.subscription, undefined);
  assert.equal(i.lines.data[0].subscription, undefined);
  // parent 経路だけが残る
  assert.equal(i.parent.subscription_details.subscription, SUB_ID);
  assert.equal(i.lines.data[0].parent.subscription_item_details.subscription, SUB_ID);
});

test('parent 経路だけでも subscription を取れる（他 3 経路を消しても成立）', () => {
  const i = invoiceNew();
  delete i.lines;
  assert.equal(extractSubscriptionId('invoice.payment_succeeded', i), SUB_ID);
});

test('明細行の parent 経路だけでも subscription を取れる', () => {
  const i = invoiceNew();
  delete i.parent;
  assert.equal(extractSubscriptionId('invoice.payment_succeeded', i), SUB_ID);
});

test('subscription を持たない invoice は null（呼び出し側が 200 ignored にする）', () => {
  const i = invoiceNew();
  delete i.parent;
  delete i.lines;
  assert.equal(extractSubscriptionId('invoice.payment_succeeded', i), null);
});

// =========================================================
// 2. current_period_end の位置
// =========================================================

test('subscription（2023-08-16）は root から current_period_end を取る', () => {
  assert.equal(extractCurrentPeriodEnd(subscriptionOld()), PERIOD_END_ISO);
});

test('subscription（2025-03-31.basil 以降）は items[0] から取る', () => {
  const s = subscriptionNew();
  assert.equal(s.current_period_end, undefined);
  assert.equal(extractCurrentPeriodEnd(s), PERIOD_END_ISO);
});

test('root と items のどちらにも無ければ null（推測で埋めない）', () => {
  const s = subscriptionNew();
  delete s.items.data[0].current_period_end;
  assert.equal(extractCurrentPeriodEnd(s), null);
});

// =========================================================
// 3. price 抽出はどちらの版でも同じ
// =========================================================

test('price は版に依らず items[0].price から 1 件だけ取れる', () => {
  for (const s of [subscriptionOld(), subscriptionNew()]) {
    assert.deepEqual(extractPriceId(s), { ok: true, priceId: PRICE_ID });
  }
});

// =========================================================
// 4. snapshot は版が違っても同じ結果になる
// =========================================================

test('新旧どちらの shape でも buildSnapshot の結果が一致する', () => {
  const a = buildSnapshot(subscriptionOld(), ENV);
  const b = buildSnapshot(subscriptionNew(), ENV);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.deepEqual(a.snapshot, b.snapshot);
  assert.equal(a.snapshot.currentPeriodEnd, PERIOD_END_ISO);
  assert.equal(a.snapshot.planId, 'web_pro');
  assert.equal(a.snapshot.currency, 'jpy');
  assert.equal(a.snapshot.phase, 'launch');
  assert.equal(a.snapshot.userId, USER_ID);
});


// =========================================================
// 5. endpoint 全体（shape を使った end-to-end）
//
//   実際の経路（webhook -> 再取得 -> snapshot）をテストでも通す。
//   Stripe / DB は mock（このテストは api.stripe.com へ通信しない）。
// =========================================================

const NOW_SEC = 1788835600;
const NOW_MS = NOW_SEC * 1000;
const quiet = { error() {}, warn() {}, log() {} };

function rpcMock(rows) {
  const calls = [];
  const fn = async (name, args) => {
    calls.push({ name, args });
    return rows ?? [{ processed: true, already_processed: false, stale: false }];
  };
  fn.calls = calls;
  return fn;
}

function stripeFetch(subscriptionObj) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    // webhook は Customer も取り直して請求先国を判定する。
    // ここは版差（shape）の検証なので、国は既定で JP を返す。
    if (String(url).includes('/v1/customers/')) {
      return new Response(
        JSON.stringify({ id: CUS_ID, object: 'customer', address: { country: 'JP' } }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify(subscriptionObj), { status: 200 });
  };
  fn.calls = calls;
  /** subscription の取得だけを数える（Customer 取得と区別する）。 */
  fn.subscriptionCalls = () =>
    calls.filter((c) => String(c.url).includes('/v1/subscriptions/'));
  return fn;
}

async function postEvent(event, subscriptionObj) {
  const body = JSON.stringify(event);
  const v1 = await computeStripeSignature(ENV.STRIPE_WEBHOOK_SECRET, NOW_SEC, body);
  const request = new Request('https://example.com/api/billing/webhook', {
    method: 'POST',
    headers: { 'Stripe-Signature': `t=${NOW_SEC},v1=${v1}` },
    body,
  });
  const fetchImpl = stripeFetch(subscriptionObj);
  const rpc = rpcMock();
  const res = await handleWebhook(request, ENV, { rpc, fetchImpl, logger: quiet, now: NOW_MS });
  return { res, body: await res.json(), fetchImpl, rpc };
}

test('invoice.payment_succeeded（新版 shape）+ subscription（新版 shape）で RPC まで通る', async () => {
  const event = {
    id: 'evt_shapes_1',
    object: 'event',
    type: 'invoice.payment_succeeded',
    created: NOW_SEC,
    data: { object: invoiceNew() },
  };
  const { res, body, fetchImpl, rpc } = await postEvent(event, subscriptionNew());

  assert.equal(res.status, 200);
  assert.equal(body.processed, true);

  // 再取得は 1 回だけ、抽出した subscription ID に対して行う
  assert.equal(fetchImpl.subscriptionCalls().length, 1);
  assert.match(String(fetchImpl.subscriptionCalls()[0].url),
    new RegExp(`/v1/subscriptions/${SUB_ID}$`));

  // RPC には items[0] 由来の current_period_end が渡る（root は存在しない）
  assert.equal(rpc.calls.length, 1);
  const args = rpc.calls[0].args;
  assert.equal(args.p_current_period_end, PERIOD_END_ISO);
  assert.equal(args.p_plan_id, 'web_pro');
  assert.equal(args.p_currency, 'jpy');
  assert.equal(args.p_price_phase, 'launch');
  assert.equal(args.p_user_id, USER_ID);
  assert.equal(args.p_stripe_subscription_id, SUB_ID);
});

test('invoice.payment_failed（新版 shape）でも RPC まで通る', async () => {
  const event = {
    id: 'evt_shapes_2',
    object: 'event',
    type: 'invoice.payment_failed',
    created: NOW_SEC,
    data: { object: invoiceNew() },
  };
  const { res, body, rpc } = await postEvent(event, subscriptionNew());
  assert.equal(res.status, 200);
  assert.equal(body.processed, true);
  assert.equal(rpc.calls[0].args.p_stripe_subscription_id, SUB_ID);
});

test('旧版 shape でも同じ RPC 引数になる（版差が DB へ漏れない）', async () => {
  const mk = (inv) => ({
    id: 'evt_shapes_3', object: 'event',
    type: 'invoice.payment_succeeded', created: NOW_SEC,
    data: { object: inv },
  });
  const oldRun = await postEvent(mk(invoiceOld()), subscriptionOld());
  const newRun = await postEvent(mk(invoiceNew()), subscriptionNew());
  assert.deepEqual(oldRun.rpc.calls[0].args, newRun.rpc.calls[0].args);
});

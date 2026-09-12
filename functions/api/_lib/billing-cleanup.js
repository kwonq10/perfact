// =========================================================
// Stripe 側の課金を止める共通処理
//
//   使う場所は 2 つある。**どちらも同じ規則で動かすためにここへ集めた。**
//     1. `functions/api/account/delete.js`
//        利用者が自分でアカウントを削除したとき（Customer が DB に記録済み）
//     2. `functions/api/billing/webhook.js`
//        削除済み利用者の **孤児 subscription** を webhook が見つけたとき
//        （決済直後 / webhook 到達前に削除されると、DB に Customer が
//          記録されないまま Stripe 側だけ契約が残る）
//
//   invoice の扱いが 2 か所に分かれると、片方だけ直して規則がずれる。
//   **ここが唯一の実装**にしておくこと。
//
//   **即時解約の条件**
//     DELETE /v1/subscriptions/:id を params なしで呼ぶ。
//     Stripe の既定は prorate=false / invoice_now=false なので、
//     日割りの返金・クレジットも、解約時の追加請求も作らない。
//     終了状態（canceled / incomplete_expired）の subscription は呼ばない。
//
//   **invoice の扱い（status ごと）**
//     draft          auto_advance=false にする（確定・請求へ進ませない）
//     open           auto_advance=false にし、next_payment_attempt が無いことを確認
//                    （void にはしない。請求の記録を消さないため）
//     paid           触らない（支払い済みの履歴は変えない。返金もしない）
//     void           触らない
//     uncollectible  触らない
//     上記以外       **推測で扱わない。** 何も変更せず止める（retryable=false）
//
//   **返金はしない。** 日割り返金も、paid invoice の変更もしない。
//   （販売対象外の国の後始末だけは返金する。あちらは `billing-remediation.js`。）
//
//   **すべて成功したときだけ resolve する。** 途中で確認が取れなければ
//   BillingCleanupError を投げ、呼び出し側が DB を消さずに再試行させる。
//
//   ID をログへ出さないのは呼び出し側の責務。ここは例外に ID を持たせない。
// =========================================================

import { StripeApiError } from './stripe.js';

/** これ以上解約できない subscription status。DELETE を呼ばない。 */
export const TERMINAL_SUBSCRIPTION_STATUSES = Object.freeze(['canceled', 'incomplete_expired']);

/** 自動回収を止める invoice status。 */
export const INVOICE_STOP_STATUSES = Object.freeze(['draft', 'open']);

/** 触らない invoice status（支払い済み・取り消し済み・回収不能）。 */
export const INVOICE_UNTOUCHED_STATUSES = Object.freeze(['paid', 'void', 'uncollectible']);

/** Stripe の list の 1 ページの件数（上限値）。 */
export const LIST_PAGE_LIMIT = 100;

/** ページ送りの上限。has_more が止まらない異常で無限に回らないための安全弁。 */
export const MAX_LIST_PAGES = 20;

/**
 * Idempotency-Key。同じ対象への再試行は同じキーになる。
 *
 * **削除 API と webhook の孤児処理で同じキーを使う。**
 * 同じ subscription を両方が止めにいっても、Stripe 側で二重処理にならない。
 */
export function cancelSubscriptionKey(subscriptionId) {
  return 'account-delete:cancel:' + subscriptionId;
}

export function stopInvoiceKey(invoiceId) {
  return 'account-delete:invoice-auto-advance-off:' + invoiceId;
}

/**
 * Stripe の後始末が「確認できなかった」ときの失敗。
 * retryable = true  -> 502（時間をおいて再試行すれば収束しうる）
 * retryable = false -> 500（扱い方が決まっていない状態。運用で確認する）
 * ID は保持しない（ログへ出さないため）。
 */
export class BillingCleanupError extends Error {
  constructor(code, retryable) {
    super(code);
    this.name = 'BillingCleanupError';
    this.code = code;
    this.retryable = retryable === true;
  }
}

function isStripeNotFound(e) {
  return e instanceof StripeApiError && e.code === 'request_failed' && e.httpStatus === 404;
}

/**
 * Stripe の list をページ送りで全件読む。
 * 形が想定と違えば推測で進めずに失敗させる。
 */
export async function listAll(ctx, path, params) {
  const out = [];
  let startingAfter = null;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const res = await ctx.stripe({
      env: ctx.env,
      method: 'GET',
      path,
      params: {
        ...params,
        limit: LIST_PAGE_LIMIT,
        ...(startingAfter === null ? {} : { starting_after: startingAfter }),
      },
      fetchImpl: ctx.fetchImpl,
    });
    const data = Array.isArray(res?.data) ? res.data : null;
    if (data === null) throw new BillingCleanupError('unexpected_list_response', true);
    for (const item of data) {
      if (!item || typeof item !== 'object' || typeof item.id !== 'string' || item.id.length === 0) {
        throw new BillingCleanupError('unexpected_list_response', true);
      }
      out.push(item);
    }
    if (res.has_more !== true) return out;
    if (data.length === 0) throw new BillingCleanupError('unexpected_list_response', true);
    startingAfter = data[data.length - 1].id;
  }
  throw new BillingCleanupError('too_many_items', false);
}

/** invoice の status が、扱い方の決まったものだけか。 */
export function assertInvoiceStatusesSupported(invoices) {
  for (const inv of invoices) {
    if (!INVOICE_STOP_STATUSES.includes(inv.status)
        && !INVOICE_UNTOUCHED_STATUSES.includes(inv.status)) {
      throw new BillingCleanupError('unsupported_invoice_status', false);
    }
  }
}

/**
 * 終了していない subscription をすべて即時解約し、GET で終了を確認する。
 * @returns {Promise<number>} 解約した件数
 */
export async function cancelOpenSubscriptions(ctx, subscriptions) {
  let canceled = 0;
  for (const sub of subscriptions) {
    if (TERMINAL_SUBSCRIPTION_STATUSES.includes(sub.status)) continue;
    const path = '/v1/subscriptions/' + sub.id;
    try {
      // params なし = 即時解約・日割りなし・解約時の請求なし（Stripe の既定）。
      await ctx.stripe({
        env: ctx.env,
        method: 'DELETE',
        path,
        idempotencyKey: cancelSubscriptionKey(sub.id),
        fetchImpl: ctx.fetchImpl,
      });
    } catch (e) {
      // 一覧の後に別経路で解約済みになっていると 404 になる。GET の確認へ進む。
      if (!isStripeNotFound(e)) throw e;
    }
    const after = await ctx.stripe({ env: ctx.env, method: 'GET', path, fetchImpl: ctx.fetchImpl });
    if (!TERMINAL_SUBSCRIPTION_STATUSES.includes(after?.status)) {
      throw new BillingCleanupError('subscription_not_terminal', true);
    }
    canceled += 1;
  }
  return canceled;
}

/**
 * draft / open の invoice の自動回収を止め、GET で確認する。
 * paid / void / uncollectible は触らない。
 * @returns {Promise<number>} 回収を止めた（止まっていることを確認した）件数
 */
export async function stopInvoiceCollection(ctx, invoices) {
  assertInvoiceStatusesSupported(invoices);
  let stopped = 0;
  for (const inv of invoices) {
    if (!INVOICE_STOP_STATUSES.includes(inv.status)) continue;
    const path = '/v1/invoices/' + inv.id;
    if (inv.auto_advance !== false) {
      await ctx.stripe({
        env: ctx.env,
        method: 'POST',
        path,
        params: { auto_advance: false },
        idempotencyKey: stopInvoiceKey(inv.id),
        fetchImpl: ctx.fetchImpl,
      });
    }
    const after = await ctx.stripe({ env: ctx.env, method: 'GET', path, fetchImpl: ctx.fetchImpl });
    const status = after?.status;
    if (INVOICE_UNTOUCHED_STATUSES.includes(status)) {
      // 確認までの間に支払い済みなどへ進んだ。以後は触らない。
      continue;
    }
    if (!INVOICE_STOP_STATUSES.includes(status)) {
      throw new BillingCleanupError('unsupported_invoice_status', false);
    }
    if (after.auto_advance !== false) {
      throw new BillingCleanupError('invoice_collection_not_stopped', true);
    }
    if (status === 'open'
        && after.next_payment_attempt !== null && after.next_payment_attempt !== undefined) {
      throw new BillingCleanupError('invoice_collection_not_stopped', true);
    }
    stopped += 1;
  }
  return stopped;
}

/**
 * 解約と invoice の停止を、決められた順序で行う。
 *
 * **順序を変えないこと。**
 *   1. 何かを変更する前に invoice の status を確かめる
 *      （扱い方の決まっていない status があれば、解約もせずに止める）
 *   2. subscription を即時解約し、GET で終了を確認する
 *   3. 解約で invoice の状態が変わりうるので**取り直してから**扱う
 *
 * @param {object} ctx            { env, stripe, fetchImpl }
 * @param {string} customerId     invoice を読む対象の Customer
 * @param {Array}  subscriptions  解約対象（呼び出し側が絞り込んだもの）
 * @returns {Promise<{canceled:number, invoicesStopped:number}>}
 */
async function stopBilling(ctx, customerId, subscriptions) {
  // 何かを変更する前に invoice の status を確かめる。
  // 扱い方の決まっていない status があれば、解約もせずに止める。
  const before = await listAll(ctx, '/v1/invoices', { customer: customerId });
  assertInvoiceStatusesSupported(before);

  const canceled = await cancelOpenSubscriptions(ctx, subscriptions);

  // 解約で invoice の状態が変わりうるので取り直してから扱う。
  const invoices = await listAll(ctx, '/v1/invoices', { customer: customerId });
  const invoicesStopped = await stopInvoiceCollection(ctx, invoices);

  return { canceled, invoicesStopped };
}

/**
 * Customer の課金を止める。**全部成功したときだけ resolve する。**
 *
 * アカウント削除 API が使う。Customer 配下の subscription を
 * **全件**（status=all・ページ送り）対象にする。
 *
 * @returns {Promise<{canceled:number, invoicesStopped:number}>}
 */
export async function stopCustomerBilling(ctx, customerId) {
  const subscriptions = await listAll(ctx, '/v1/subscriptions',
    { customer: customerId, status: 'all' });
  return stopBilling(ctx, customerId, subscriptions);
}

/**
 * **孤児 subscription 1 本だけ**の課金を止める。webhook が使う。
 *
 * `stopCustomerBilling` と違い、**解約するのは渡された subscription だけ**。
 * Customer 配下を列挙して解約しないのは、webhook 側で
 * 「Sukima の Price」「metadata.user_id が UUID」を検証済みなのが
 * **この 1 本だけ**だから。列挙して解約すると、検証していない
 * subscription まで巻き込む余地が生まれる。**誤解約の余地を構造から消す。**
 *
 * 同じ Customer に別の孤児が残っていても、その subscription には
 * その subscription 自身の event が届くので、順に回収される。
 *
 * invoice は **Customer 単位**で見る（削除 API と同じ規則）。
 * 未払いの請求は subscription 単位では取りこぼすことがあるため。
 *
 * @param {object} ctx           { env, stripe, fetchImpl }
 * @param {object} subscription  Stripe から取り直した subscription
 * @param {string} customerId    その subscription の Customer
 * @returns {Promise<{canceled:number, invoicesStopped:number}>}
 */
export async function stopOrphanSubscriptionBilling(ctx, subscription, customerId) {
  return stopBilling(ctx, customerId, [subscription]);
}

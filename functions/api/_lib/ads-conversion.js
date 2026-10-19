// =========================================================
// 有料プラン初回契約のコンバージョン判定
//
//   POST /api/billing/conversion（functions/api/billing/conversion.js）から呼ぶ。
//   **このモジュールは判定だけを行う。DB にも Stripe にも書き込まない。**
//   契約の権限（entitlement）は従来どおり webhook -> DB だけが決める。
//
//   「送ってよい（eligible）」とするのは、次をすべて満たすときだけ:
//     1. Checkout Session がログイン中の利用者のもの（metadata.user_id が一致）
//     2. Session が subscription モード・完了済み・支払い済み・livemode
//        （livemode はコンバージョンの live 設定のときに必須）
//     3. Session 作成から MAX_SESSION_AGE_MS 以内（古い Session を繰り返し使わせない）
//     4. 初回の請求を **Session との関連から**特定できる
//        - 第一候補: Session の `invoice`（Session が作成した請求）
//        - `invoice` が空のときだけ: その subscription の支払い済み請求のうち
//          `billing_reason = subscription_create` がちょうど 1 件
//        - subscription の「最新の請求」を初回とみなすことはしない
//     5. その請求が paid / subscription_create / JPY / 1 円以上で、
//        Session と同じ subscription・customer に属する
//     6. subscription の Price が Sukima 有料プランの Price で、
//        metadata.user_id も一致する
//     7. 請求先の国が販売国（webhook と同じ判定）
//     8. **webhook による反映が済んでいる**: DB の契約行の
//        stripe_subscription_id が今回の subscription と一致し、web_pro・active
//        （読み取り専用 RPC `get_billing_reflection`）
//     9. 同じ Stripe Customer に、今回より前の **Sukima 有料プランの**
//        支払い済み・1 円以上の請求が無い
//        - 返金済みでも「支払い実績あり」として扱う（請求の status は paid のまま）
//        - subscription に属さない請求（単発請求など）は除外理由にしない
//        - subscription に属していても、その Price が Sukima 有料プランでなければ
//          除外理由にしない
//
//   制約（仕様として受け入れているもの）:
//     - 初回が 0 円（100% 割引）で、後日の更新で初めて課金された場合は数えない
//       （更新の課金では決済完了ページを通らないため）
//     - アカウント削除後の再登録は新規として数える（同一人物として追跡しない）
//
//   ログには理由コードだけを出す。Session / Customer / Subscription / Invoice の ID、
//   user_id、金額は出さない。
// =========================================================

import { BillingCleanupError, listAll } from './billing-cleanup.js';
import { priceDefinitionFromPriceId } from './billing-config.js';
import { COUNTRY_STATUS, classifyCustomerCountry } from './billing-country.js';
import { GOOGLE_ADS_CONVERSION_SEND_TO } from './ads-config.js';
import { StripeApiError } from './stripe.js';
import {
  extractPriceId,
  extractSubscriptionId,
  readStripeId,
} from '../billing/webhook.js';

/** 読み取り専用 RPC（migration 20261018090000）。 */
export const RPC_BILLING_REFLECTION = 'get_billing_reflection';

/** Session を受け付ける期間。これより古い Session では送らない。 */
export const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000;

/** 初回請求を表す billing_reason。 */
export const INITIAL_BILLING_REASON = 'subscription_create';

/** 計測する Sukima 有料プランと通貨。 */
export const CONVERSION_PLAN_ID = 'web_pro';
export const CONVERSION_CURRENCY = 'jpy';

/** 判定結果。HTTP 応答の `state` にそのまま使う。 */
export const CONVERSION_STATE = Object.freeze({
  ELIGIBLE: 'eligible',
  PENDING: 'pending',
  NOT_ELIGIBLE: 'not_eligible',
});

/** transaction_id の接頭辞。64 文字以内に収める（11 + 40 = 51 文字）。 */
export const TRANSACTION_ID_PREFIX = 'sukima_sub_';

/** 判定の途中で Stripe / DB が使えなかったことを表す。呼び出し側が 502 / 500 にする。 */
export class ConversionCheckError extends Error {
  /**
   * @param {string} code
   * @param {{retryable?: boolean, cause?: unknown}} [o]
   */
  constructor(code, o = {}) {
    super(code);
    this.name = 'ConversionCheckError';
    this.code = code;
    this.retryable = o.retryable === true;
    this.cause = o.cause;
  }
}

/**
 * subscription ID から、個人情報を含まない安定した transaction_id を作る。
 * SHA-256 の先頭 40 桁（16 進）。Stripe の ID そのものは Google へ渡さない。
 *
 * @param {string} subscriptionId
 * @returns {Promise<string>}
 */
export async function buildTransactionId(subscriptionId) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(subscriptionId),
  );
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < 20; i += 1) hex += bytes[i].toString(16).padStart(2, '0');
  return TRANSACTION_ID_PREFIX + hex;
}

function notEligible(reason) {
  return { state: CONVERSION_STATE.NOT_ELIGIBLE, reason };
}

function pending(reason) {
  return { state: CONVERSION_STATE.PENDING, reason };
}

/**
 * Stripe 呼び出しの失敗を ConversionCheckError へ写す。
 * 404（存在しない ID）は null を返し、呼び出し側が not_eligible にする。
 */
async function stripeGet(ctx, path, params) {
  try {
    return await ctx.stripe({ env: ctx.env, method: 'GET', path, params, fetchImpl: ctx.fetchImpl });
  } catch (e) {
    if (e instanceof StripeApiError) {
      if (e.code === 'request_failed' && e.httpStatus === 404) return null;
      if (e.code === 'not_configured') {
        throw new ConversionCheckError('stripe_not_configured', { cause: e });
      }
      throw new ConversionCheckError('stripe_unavailable', { retryable: e.retryable === true, cause: e });
    }
    throw new ConversionCheckError('stripe_unexpected', { cause: e });
  }
}

async function stripeListAll(ctx, path, params) {
  try {
    return await listAll(ctx, path, params);
  } catch (e) {
    if (e instanceof BillingCleanupError) {
      throw new ConversionCheckError('stripe_list_' + e.code, { retryable: e.retryable === true, cause: e });
    }
    if (e instanceof StripeApiError) {
      if (e.code === 'not_configured') {
        throw new ConversionCheckError('stripe_not_configured', { cause: e });
      }
      throw new ConversionCheckError('stripe_unavailable', { retryable: e.retryable === true, cause: e });
    }
    throw new ConversionCheckError('stripe_unexpected', { cause: e });
  }
}

/**
 * subscription が Sukima 有料プラン（web_pro / JPY）のものか。
 * Price の対応表（billing-config）にある Price だけを Sukima のものとみなす。
 *
 * @returns {boolean}
 */
export function isSukimaPaidSubscription(subscription, env) {
  const price = extractPriceId(subscription);
  if (!price.ok) return false;
  const mapped = priceDefinitionFromPriceId(price.priceId, env);
  return mapped.ok
    && mapped.definition.plan_id === CONVERSION_PLAN_ID
    && mapped.definition.currency === CONVERSION_CURRENCY;
}

/**
 * Session から初回の請求 ID を特定する。
 *
 * @returns {Promise<{ok:true, invoiceId:string}|{ok:false, reason:string}>}
 */
async function resolveInitialInvoiceId(ctx, session, subscriptionId) {
  const direct = readStripeId(session.invoice);
  if (direct) return { ok: true, invoiceId: direct };

  // Session に invoice が無いときだけ、その subscription の請求から
  // subscription_create の 1 件を探す（「最新の請求」は使わない）。
  const invoices = await stripeListAll(ctx, '/v1/invoices', {
    subscription: subscriptionId,
    status: 'paid',
  });
  const initial = invoices.filter((inv) => inv.billing_reason === INITIAL_BILLING_REASON);
  if (initial.length === 0) return { ok: false, reason: 'initial_invoice_not_found' };
  if (initial.length > 1) return { ok: false, reason: 'initial_invoice_ambiguous' };
  return { ok: true, invoiceId: initial[0].id };
}

/**
 * 今回より前に、Sukima 有料プランの支払い済み・1 円以上の請求があるか。
 *
 * @returns {Promise<boolean>}
 */
async function hasPriorSukimaPayment(ctx, customerId, currentInvoice, currentSubscriptionId) {
  const invoices = await stripeListAll(ctx, '/v1/invoices', {
    customer: customerId,
    status: 'paid',
  });
  const subscriptionCache = new Map();

  for (const inv of invoices) {
    if (inv.id === currentInvoice.id) continue;
    if (!(typeof inv.amount_paid === 'number' && inv.amount_paid > 0)) continue;
    // 今回より後の請求（更新の請求など）は「前」ではない。
    if (typeof inv.created !== 'number' || inv.created > currentInvoice.created) continue;

    const subId = extractSubscriptionId('invoice.paid', inv);
    // subscription に属さない請求（単発請求など）は除外理由にしない。
    if (!subId) continue;
    // 同じ subscription の初回より前の支払いは無いはず。念のため除外理由にしない。
    if (subId === currentSubscriptionId) continue;

    let isSukima = subscriptionCache.get(subId);
    if (isSukima === undefined) {
      const sub = await stripeGet(ctx, '/v1/subscriptions/' + subId);
      // 取れない（削除済み等）subscription は Price を確かめられない。
      // 請求の明細に Sukima の Price があればそれで判断する。
      isSukima = sub ? isSukimaPaidSubscription(sub, ctx.env) : invoiceHasSukimaPrice(inv, ctx.env);
      subscriptionCache.set(subId, isSukima);
    }
    if (isSukima) return true;
  }
  return false;
}

/**
 * 請求の明細に Sukima 有料プランの Price があるか（subscription を取れないときの代替）。
 * Stripe の API version で位置が違うため、旧（line.price）と新
 * （line.pricing.price_details.price）の両方を見る。
 */
export function invoiceHasSukimaPrice(invoice, env) {
  const lines = invoice?.lines?.data;
  if (!Array.isArray(lines)) return false;
  for (const line of lines) {
    const priceId = readStripeId(line?.price) ?? readStripeId(line?.pricing?.price_details?.price);
    if (!priceId) continue;
    const mapped = priceDefinitionFromPriceId(priceId, env);
    if (mapped.ok && mapped.definition.plan_id === CONVERSION_PLAN_ID) return true;
  }
  return false;
}

/**
 * 初回契約のコンバージョンを送ってよいかを判定する。
 *
 * Stripe 呼び出しは「反映待ち」の間は Session の取得 1 回だけに抑える
 * （ブラウザの再問い合わせで Stripe へ大量にアクセスしないため）。
 *
 * @param {object} o
 * @param {object} o.env
 * @param {string} o.userId       Cookie session の user_id（**ログへ出さない**）
 * @param {string} o.sessionId    ブラウザから受け取った Checkout Session ID
 * @param {Function} o.stripe     stripeRequest（テストで差し替える）
 * @param {Function} o.rpc        callRpc（テストで差し替える）
 * @param {number} o.nowMs
 * @param {Function} [o.fetchImpl]
 * @returns {Promise<{state:string, reason?:string, value?:number, currency?:string,
 *                    transaction_id?:string, send_to?:string}>}
 * @throws {ConversionCheckError} Stripe / DB が使えないとき
 */
export async function evaluateFirstPaidConversion(o) {
  const { env, userId, sessionId, stripe, rpc, nowMs, fetchImpl } = o;
  const ctx = { env, stripe, fetchImpl };

  // --- 1. Checkout Session ---
  const session = await stripeGet(ctx, '/v1/checkout/sessions/' + sessionId);
  if (!session || typeof session !== 'object') return notEligible('session_not_found');

  // 他人の Session では何も返さない（存在するかどうかも区別しない）。
  if (session?.metadata?.user_id !== userId) return notEligible('session_not_found');
  if (session.mode !== 'subscription') return notEligible('not_subscription');
  if (session.livemode !== true) return notEligible('not_livemode');

  const createdMs = typeof session.created === 'number' ? session.created * 1000 : NaN;
  if (!Number.isFinite(createdMs) || nowMs - createdMs > MAX_SESSION_AGE_MS) {
    return notEligible('session_too_old');
  }

  if (session.status === 'open') return pending('session_open');
  if (session.status !== 'complete') return notEligible('session_not_complete');
  if (session.payment_status === 'unpaid') return pending('session_unpaid');
  if (session.payment_status !== 'paid') return notEligible('no_payment');

  const subscriptionId = readStripeId(session.subscription);
  const customerId = readStripeId(session.customer);
  if (!subscriptionId || !customerId) return pending('session_without_subscription');

  // --- 2. webhook の反映（DB の契約行が今回の subscription か）---
  //   反映前は Stripe へ追加で問い合わせずに pending を返す。
  let rows;
  try {
    rows = await rpc(RPC_BILLING_REFLECTION, {
      p_user_id: userId,
      p_stripe_subscription_id: subscriptionId,
    }, { env });
  } catch (e) {
    throw new ConversionCheckError('database_error', { cause: e });
  }
  const row = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
  if (!row || typeof row.reflected !== 'boolean') {
    throw new ConversionCheckError('reflection_contract_mismatch');
  }
  if (row.reflected !== true) return pending('not_reflected');

  // --- 3. 初回の請求（Session との関連から特定）---
  const resolved = await resolveInitialInvoiceId(ctx, session, subscriptionId);
  if (!resolved.ok) return notEligible(resolved.reason);

  const invoice = await stripeGet(ctx, '/v1/invoices/' + resolved.invoiceId);
  if (!invoice) return notEligible('invoice_not_found');
  if (invoice.status === 'open' || invoice.status === 'draft') return pending('invoice_not_paid');
  if (invoice.status !== 'paid') return notEligible('invoice_not_paid');
  if (invoice.billing_reason !== INITIAL_BILLING_REASON) return notEligible('not_initial_invoice');
  if (typeof invoice.created !== 'number') return notEligible('invalid_invoice');
  if (extractSubscriptionId('invoice.paid', invoice) !== subscriptionId) {
    return notEligible('invoice_subscription_mismatch');
  }
  if (readStripeId(invoice.customer) !== customerId) return notEligible('invoice_customer_mismatch');
  if (invoice.currency !== CONVERSION_CURRENCY) return notEligible('not_jpy');
  const amountPaid = invoice.amount_paid;
  if (!Number.isInteger(amountPaid) || amountPaid < 0) return notEligible('invalid_amount');
  if (amountPaid === 0) return notEligible('zero_amount');

  // --- 4. Sukima 有料プランの subscription か ---
  const subscription = await stripeGet(ctx, '/v1/subscriptions/' + subscriptionId);
  if (!subscription) return notEligible('subscription_not_found');
  if (subscription?.metadata?.user_id !== userId) return notEligible('subscription_user_mismatch');
  if (readStripeId(subscription.customer) !== customerId) {
    return notEligible('subscription_customer_mismatch');
  }
  if (!isSukimaPaidSubscription(subscription, env)) return notEligible('not_sukima_plan');

  // --- 5. 請求先の国（webhook と同じ判定）---
  const customer = await stripeGet(ctx, '/v1/customers/' + customerId);
  if (!customer) return notEligible('customer_not_found');
  const country = classifyCustomerCountry(customer);
  if (country.status !== COUNTRY_STATUS.SELLABLE) return notEligible('country_not_sellable');

  // --- 6. 今回より前の Sukima 有料プランの支払い実績 ---
  if (await hasPriorSukimaPayment(ctx, customerId, invoice, subscriptionId)) {
    return notEligible('prior_paid_subscription');
  }

  return {
    state: CONVERSION_STATE.ELIGIBLE,
    send_to: GOOGLE_ADS_CONVERSION_SEND_TO,
    value: amountPaid,
    currency: 'JPY',
    transaction_id: await buildTransactionId(subscriptionId),
  };
}

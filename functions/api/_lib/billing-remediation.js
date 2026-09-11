// =========================================================
// 販売対象外の国で成立してしまった契約の後始末（解約 + 返金）
//
//   webhook が「請求先国が販売対象外」と判定したときだけ呼ばれる。
//   **entitlement を書かないことは呼び出し側の責務**で、
//   ここは Stripe 側の後始末（即時解約 + 初回決済の全額返金）だけを行う。
//
//   設計上の約束:
//     - **推測で返金しない。** 返金するのは
//       「この subscription の**初回請求**（billing_reason = subscription_create）で
//       実際に支払われた PaymentIntent」だけ。
//       それを一意に特定できないときは **何もせず ambiguous を返す**
//       （呼び出し側が retry させる / 人が見る）。
//     - **retry-safe。** webhook は同じ購入について複数 event を送ってくるうえ、
//       失敗時は Stripe が再送する。したがって:
//         * 解約済みなら解約しない
//         * 返金済みなら返金しない（実 refund 一覧を確認する）
//         * それでも競合したときのために Idempotency-Key も付ける
//     - **金額を指定しない。** `/v1/refunds` に amount を渡さなければ全額返金。
//       端数計算をこちらで持たない。
//     - secret / PII / 金額をログに出さない。出すのは分類コードと Stripe の ID だけ。
//
//   API version による形の違い:
//     2025-09-30.clover では **invoice に charge / payment_intent が無い**。
//     支払いは invoice_payment という別リソースになり、
//     `expand[]=payments` で `payments.data[].payment.payment_intent` として取れる。
//     古い版の `invoice.payment_intent` も読めるようにしてあるので、
//     API version を戻しても壊れない。
// =========================================================

import { StripeApiError, stripeRequest } from './stripe.js';

/** 初回請求を表す billing_reason。**返金対象はこれだけ。** */
export const INITIAL_BILLING_REASON = 'subscription_create';

/** すでに終わっている契約。解約 API を呼ばない。 */
export const TERMINAL_SUBSCRIPTION_STATUSES = Object.freeze(['canceled', 'incomplete_expired']);

/** 返金理由。**fraudulent にはしない**（不正ではなく販売国の問題のため）。 */
export const REFUND_REASON = 'requested_by_customer';

/** 'x' でも { id: 'x' } でも ID を取り出す。 */
function readId(value) {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  if (value && typeof value === 'object' && typeof value.id === 'string' && value.id.length > 0) {
    return value.id;
  }
  return null;
}

/**
 * invoice がこの subscription のものか確認する。
 *
 * 新しい API version では `parent.subscription_details.subscription`、
 * 古い版では `subscription` 直下。**どちらも見る。**
 *
 * @param {object} invoice
 * @param {string} subscriptionId
 * @returns {boolean}
 */
export function invoiceBelongsToSubscription(invoice, subscriptionId) {
  if (!invoice || typeof invoice !== 'object' || typeof subscriptionId !== 'string') return false;
  const fromParent = readId(invoice?.parent?.subscription_details?.subscription);
  if (fromParent !== null) return fromParent === subscriptionId;
  const direct = readId(invoice.subscription);
  return direct !== null && direct === subscriptionId;
}

/**
 * **返金対象の PaymentIntent を一意に決める。**
 *
 * 条件をすべて満たすときだけ返す:
 *   - invoice がこの subscription のものである
 *   - billing_reason が subscription_create（= 初回請求）である
 *   - 支払い済みの invoice_payment がちょうど 1 件で、PaymentIntent を持つ
 *
 * どれか 1 つでも欠けたら `{ ok:false, code }` を返し、**返金しない**。
 *
 * code:
 *   'invalid_invoice'        invoice が取れていない
 *   'invoice_mismatch'       別 subscription の invoice
 *   'not_initial_invoice'    初回請求ではない（更新分を誤って返金しない）
 *   'invoice_not_paid'       支払われていない（返金するものが無い）
 *   'no_payment_intent'      支払いに PaymentIntent が紐づいていない
 *   'ambiguous_payment'      支払い済みが複数あり一意に決まらない
 *
 * @param {object} invoice
 * @param {string} subscriptionId
 * @returns {{ok:true, paymentIntentId:string}|{ok:false, code:string}}
 */
export function resolveInitialPaymentIntent(invoice, subscriptionId) {
  if (!invoice || typeof invoice !== 'object' || Array.isArray(invoice)) {
    return { ok: false, code: 'invalid_invoice' };
  }
  if (!invoiceBelongsToSubscription(invoice, subscriptionId)) {
    return { ok: false, code: 'invoice_mismatch' };
  }
  if (invoice.billing_reason !== INITIAL_BILLING_REASON) {
    // 2 回目以降の請求。ここを返金すると「別の決済を返金する」ことになる。
    return { ok: false, code: 'not_initial_invoice' };
  }

  const candidates = [];

  // 新しい API version: invoice_payment のリスト
  const payments = invoice?.payments?.data;
  if (Array.isArray(payments)) {
    for (const payment of payments) {
      if (payment?.status !== 'paid') continue;
      const intent = readId(payment?.payment?.payment_intent);
      if (intent !== null) candidates.push(intent);
    }
  }

  // 古い API version: invoice 直下
  if (candidates.length === 0) {
    const direct = readId(invoice.payment_intent);
    if (direct !== null && (invoice.status === 'paid' || invoice.paid === true)) {
      candidates.push(direct);
    }
  }

  if (candidates.length === 0) {
    if (invoice.status !== 'paid' && invoice.paid !== true) {
      return { ok: false, code: 'invoice_not_paid' };
    }
    return { ok: false, code: 'no_payment_intent' };
  }

  const unique = [...new Set(candidates)];
  if (unique.length > 1) return { ok: false, code: 'ambiguous_payment' };

  return { ok: true, paymentIntentId: unique[0] };
}

/**
 * 契約が生きていれば即時解約する。**解約済みなら何もしない（retry-safe）。**
 *
 * @returns {Promise<{ok:true, canceled:boolean}|{ok:false, code:string, retryable:boolean}>}
 */
export async function cancelSubscriptionIfLive(o) {
  const { env, subscription, stripe = stripeRequest, fetchImpl, logger = console } = o;

  const subscriptionId = readId(subscription?.id);
  if (subscriptionId === null) return { ok: false, code: 'missing_subscription_id', retryable: false };

  if (TERMINAL_SUBSCRIPTION_STATUSES.includes(subscription?.status)) {
    // 既に終わっている。二重解約しない。
    return { ok: true, canceled: false };
  }

  try {
    await stripe({
      env,
      method: 'DELETE',
      path: '/v1/subscriptions/' + subscriptionId,
      fetchImpl,
    });
    return { ok: true, canceled: true };
  } catch (e) {
    if (e instanceof StripeApiError) {
      logger.error('[billing-remediation] 解約に失敗しました:', e.code, e.stripeCode ?? 'none');
      return { ok: false, code: 'cancel_failed', retryable: e.retryable === true };
    }
    logger.error('[billing-remediation] 解約で想定外のエラーが発生しました。');
    return { ok: false, code: 'cancel_failed', retryable: false };
  }
}

/**
 * PaymentIntent を全額返金する。**既に返金済みなら何もしない（retry-safe）。**
 *
 * 二重返金を 2 段で防ぐ:
 *   1. `/v1/refunds?payment_intent=…` を見て、既存の返金があれば呼ばない
 *   2. それでも競合したときのために Idempotency-Key を付ける
 *
 * @returns {Promise<{ok:true, refunded:boolean}|{ok:false, code:string, retryable:boolean}>}
 */
export async function refundPaymentIntentOnce(o) {
  const {
    env, paymentIntentId, stripe = stripeRequest, fetchImpl, logger = console,
    metadata = {},
  } = o;

  if (typeof paymentIntentId !== 'string' || paymentIntentId.length === 0) {
    return { ok: false, code: 'missing_payment_intent', retryable: false };
  }

  // 1. 既存の返金を確認する
  let existing;
  try {
    existing = await stripe({
      env,
      method: 'GET',
      path: '/v1/refunds',
      params: { payment_intent: paymentIntentId, limit: 100 },
      fetchImpl,
    });
  } catch (e) {
    const retryable = e instanceof StripeApiError && e.retryable === true;
    logger.error('[billing-remediation] 返金状況を確認できませんでした:',
      e instanceof StripeApiError ? e.code : 'unknown');
    // **確認できないときは返金しない。** 二重返金より未返金のほうが回復可能。
    return { ok: false, code: 'refund_lookup_failed', retryable };
  }

  const rows = Array.isArray(existing?.data) ? existing.data : [];
  const alreadyRefunded = rows.some((r) => r?.status === 'succeeded' || r?.status === 'pending');
  if (alreadyRefunded) return { ok: true, refunded: false };

  // 2. 全額返金（amount を渡さない = 全額）
  try {
    await stripe({
      env,
      method: 'POST',
      path: '/v1/refunds',
      params: {
        payment_intent: paymentIntentId,
        reason: REFUND_REASON,
        metadata,
      },
      idempotencyKey: 'refund:country:' + paymentIntentId,
      fetchImpl,
    });
    return { ok: true, refunded: true };
  } catch (e) {
    if (e instanceof StripeApiError) {
      // 既に全額返金済みだと Stripe は charge_already_refunded を返す。
      // これは「望む状態になっている」ので成功として扱う。
      if (e.stripeCode === 'charge_already_refunded') return { ok: true, refunded: false };
      logger.error('[billing-remediation] 返金に失敗しました:', e.code, e.stripeCode ?? 'none');
      return { ok: false, code: 'refund_failed', retryable: e.retryable === true };
    }
    logger.error('[billing-remediation] 返金で想定外のエラーが発生しました。');
    return { ok: false, code: 'refund_failed', retryable: false };
  }
}

/**
 * **販売対象外の国で成立した契約の後始末。**
 *
 * 順序（指示どおり）:
 *   1. entitlement は書かない（**呼び出し側が RPC を呼ばないことで担保**）
 *   2. subscription を即時解約
 *   3. 初回決済を全額返金
 *
 * 解約が成功して返金が失敗した場合は `ok:false` を返す。呼び出し側が
 * retry 可能な失敗として応答すれば、Stripe の再送で返金だけをやり直せる
 * （解約は 2 回目以降スキップされる）。
 *
 * @returns {Promise<{ok:true, canceled:boolean, refunded:boolean}
 *                  |{ok:false, code:string, retryable:boolean}>}
 */
export async function remediateNotSellableCountry(o) {
  const {
    env, subscription, stripe = stripeRequest, fetchImpl, logger = console,
    country, userId,
  } = o;

  const subscriptionId = readId(subscription?.id);
  if (subscriptionId === null) {
    return { ok: false, code: 'missing_subscription_id', retryable: false };
  }

  // --- 2. 解約 ---
  const canceled = await cancelSubscriptionIfLive({ env, subscription, stripe, fetchImpl, logger });
  if (!canceled.ok) return canceled;

  // --- 3. 返金対象の特定 ---
  const invoiceId = readId(subscription?.latest_invoice);
  if (invoiceId === null) {
    // 請求がまだ無い（incomplete のまま等）。返金するものが無いので解約だけで終わり。
    return { ok: true, canceled: canceled.canceled, refunded: false };
  }

  let invoice;
  try {
    invoice = await stripe({
      env,
      method: 'GET',
      path: '/v1/invoices/' + invoiceId,
      params: { 'expand[0]': 'payments' },
      fetchImpl,
    });
  } catch (e) {
    const retryable = e instanceof StripeApiError && e.retryable === true;
    logger.error('[billing-remediation] invoice を取得できませんでした:',
      e instanceof StripeApiError ? e.code : 'unknown');
    return { ok: false, code: 'invoice_lookup_failed', retryable };
  }

  const target = resolveInitialPaymentIntent(invoice, subscriptionId);
  if (!target.ok) {
    if (target.code === 'invoice_not_paid') {
      // 支払われていない。返金するものが無い（解約だけで完了）。
      return { ok: true, canceled: canceled.canceled, refunded: false };
    }
    // **一意に決められないときは返金しない。** 推測で他人の決済を返さない。
    logger.error('[billing-remediation] 返金対象を特定できませんでした:', target.code);
    return { ok: false, code: 'refund_target_' + target.code, retryable: false };
  }

  // --- 3. 返金 ---
  const refunded = await refundPaymentIntentOnce({
    env,
    paymentIntentId: target.paymentIntentId,
    stripe,
    fetchImpl,
    logger,
    metadata: {
      sukima_reason: 'country_not_sellable',
      // 国コードは PII ではない。診断に要るので metadata には残す。
      sukima_country: typeof country === 'string' ? country : 'unknown',
      // user_id は Stripe 側の既存 metadata と同じ粒度。ログには出さない。
      ...(typeof userId === 'string' && userId.length > 0 ? { sukima_user_id: userId } : {}),
    },
  });
  if (!refunded.ok) return refunded;

  return { ok: true, canceled: canceled.canceled, refunded: refunded.refunded };
}

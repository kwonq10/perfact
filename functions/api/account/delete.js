// =========================================================
// POST /api/account/delete — Sukima アカウントの削除
//
//   Cloudflare Pages Functions（ファイルパス = ルート）。
//   functions/api/account/delete.js → /api/account/delete
//
//   **順序がすべて（崩さないこと）**
//     1. method / Origin / body / session（preflight）
//     2. Stripe Customer を server 側で解決（client の値は使わない）
//     3. Customer がある利用者だけ、Stripe の後始末を行う
//          a. Customer の subscription を全件取得（status=all、ページ送り）
//          b. invoice を全件取得し、**扱い方の決まっていない status があれば
//             何も変更せずに止める**
//          c. 終了していない subscription をすべて**即時解約**し、GET で終了を確認
//          d. invoice を取り直し、draft / open の**自動回収を止めて**確認
//     4. **ここまで全部成功したときだけ** DB のアカウントを削除
//     5. Cookie を消して 200
//
//     Stripe のどこかで失敗したら **DB は消さない**（5xx を返し、再試行させる）。
//     DB が先に消えると、Stripe の契約を止める手がかり（Customer）を失うため。
//
//   **Free（Customer が無い）利用者は Stripe を呼ばない。** DB の削除だけ。
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
//     上記以外       **推測で扱わない。** 何も変更せず 500 で止める
//
//   **client から受け取るもの**
//     body は `{ "confirm": true }` だけ。未知フィールドは 400。
//     user_id / customer_id / subscription_id は受け取らない（server が決める）。
//
//   レスポンス:  200 { deleted: true } + Set-Cookie（削除）
//               400 { error: 'unknown_field' | 'invalid_body' | 'confirmation_required' | ... }
//               401 { error: 'unauthenticated' }
//               403 { error: 'forbidden_origin' }
//               405 { error: 'method_not_allowed' }
//               413 { error: 'body_too_large' }
//               500 { error: 'internal_error' | 'server_misconfigured'
//                           | 'billing_state_unsupported' }
//               502 { error: 'database_unavailable' | 'payment_provider_unavailable'
//                           | 'billing_cleanup_incomplete' }
//
//   **応答にもログにも ID を出さない。**
//     user_id / email / Stripe の Customer / Subscription / Invoice の ID は出さない。
//     ログに残すのは分類コードと件数だけ。
//
//   Google 側の連携解除は **client 側で best-effort** に行う（public/index.html）。
//   Sukima のサーバーは Google の token を保存していないため、ここでは扱わない。
// =========================================================

import { getCurrentSubscriptionTermsVersion } from '../_lib/billing-config.js';
import { BillingCleanupError, stopCustomerBilling } from '../_lib/billing-cleanup.js';
import { buildClearSessionCookie } from '../_lib/session.js';
import { stripeRequest } from '../_lib/stripe.js';
import { callRpc } from '../_lib/supabase.js';
import { json, mapRpcError, preflight, readSingleRow } from '../_lib/quota.js';
import { mapStripeError } from '../billing/checkout.js';
import { TERMS_VERSION_FALLBACK, readCustomerId } from '../billing/portal.js';

const TAG = 'account-delete';

/** Customer を引くために再利用する読み取り専用 RPC。 */
export const RPC_CONTEXT = 'get_checkout_context';

/** アカウント削除の RPC（migration 20260911090000）。 */
export const RPC_DELETE = 'delete_user_account';

/**
 * Stripe の後始末の実装は **`_lib/billing-cleanup.js` が唯一の持ち主**。
 *
 * webhook の孤児 subscription 処理と規則を 1 か所で共有するために移した。
 * ここからの re-export は、この API の外部仕様（どの status をどう扱うか）を
 * 読み取れる場所を変えないために残してある。**挙動は移設前と同一。**
 */
export {
  BillingCleanupError,
  INVOICE_STOP_STATUSES,
  INVOICE_UNTOUCHED_STATUSES,
  LIST_PAGE_LIMIT,
  MAX_LIST_PAGES,
  TERMINAL_SUBSCRIPTION_STATUSES,
  assertInvoiceStatusesSupported,
  cancelOpenSubscriptions,
  cancelSubscriptionKey,
  listAll,
  stopCustomerBilling,
  stopInvoiceCollection,
  stopInvoiceKey,
} from '../_lib/billing-cleanup.js';

/** body は `{ confirm: true }` だけ。**未知フィールドは受け付けない。** */
export function validate(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, code: 'invalid_body' };
  }
  const keys = Object.keys(body);
  if (keys.some((k) => k !== 'confirm')) {
    return { ok: false, code: 'unknown_field' };
  }
  if (body.confirm !== true) {
    return { ok: false, code: 'confirmation_required' };
  }
  return { ok: true, value: { confirm: true } };
}

/**
 * アカウントを削除する。
 * テストから直接呼べるよう、request / env / 差し替え可能な依存を引数で受ける。
 */
export async function handleAccountDelete(request, env, deps = {}) {
  const {
    rpc = callRpc,
    stripe = stripeRequest,
    logger = console,
    currentVersion = getCurrentSubscriptionTermsVersion,
  } = deps;

  // 1: method / Origin / body / session
  const pre = await preflight(request, env, deps, { tag: TAG, validate });
  if (pre.response) return pre.response;
  const userId = pre.context.user_id;

  // 2: Customer は **server が決める**（portal と同じ RPC・同じ番兵）。
  let termsVersion;
  try {
    const v = currentVersion();
    termsVersion = (typeof v === 'string' && v.trim().length > 0 && v === v.trim())
      ? v
      : TERMS_VERSION_FALLBACK;
  } catch (e) {
    // 規約が draft でも削除の導線は塞がない。terms_consented は読まない。
    termsVersion = TERMS_VERSION_FALLBACK;
  }

  let rows;
  try {
    rows = await rpc(RPC_CONTEXT, { p_user_id: userId, p_terms_version: termsVersion }, { env });
  } catch (e) {
    return mapRpcError(e, TAG, logger);
  }
  const row = readSingleRow(rows);
  if (row === null) {
    logger.error('[' + TAG + '] RPC の戻り値が契約と異なります。');
    return json(500, { error: 'internal_error' });
  }

  // 3: Customer がある利用者だけ Stripe を止める。
  const customerId = readCustomerId(row);
  let billing = { canceled: 0, invoicesStopped: 0 };
  if (customerId !== null) {
    try {
      billing = await stopCustomerBilling(
        { env, stripe, fetchImpl: deps.fetchImpl },
        customerId,
      );
    } catch (e) {
      // **DB は消さない。** 再試行で続きから収束させる。
      if (e instanceof BillingCleanupError) {
        logger.error('[' + TAG + '] Stripe の後始末を確認できませんでした:', e.code);
        return e.retryable
          ? json(502, { error: 'billing_cleanup_incomplete' })
          : json(500, { error: 'billing_state_unsupported' });
      }
      return mapStripeError(e, TAG, logger);
    }
  }

  // 4: DB のアカウントを削除（CASCADE で sessions も消え、全端末が失効する）。
  let deletedRows;
  try {
    deletedRows = await rpc(RPC_DELETE, { p_user_id: userId }, { env });
  } catch (e) {
    // Stripe の後始末は冪等なので、再試行すればここからやり直せる。
    return mapRpcError(e, TAG, logger);
  }
  const deleted = readSingleRow(deletedRows);
  if (deleted === null || typeof deleted.deleted !== 'boolean') {
    logger.error('[' + TAG + '] 削除 RPC の戻り値が契約と異なります。');
    return json(500, { error: 'internal_error' });
  }

  // 件数だけを残す（ID は出さない）。deleted=false は並行した二重送信で先に消えたとき。
  logger.log('[' + TAG + '] アカウントを削除しました:',
    'canceled=' + billing.canceled,
    'invoices_stopped=' + billing.invoicesStopped,
    'already_deleted=' + (deleted.deleted === false));

  // 5: Cookie を消す。**応答に ID は載せない。**
  return json(200, { deleted: true }, { 'Set-Cookie': buildClearSessionCookie() });
}

/** Cloudflare Pages Functions: POST のエントリポイント */
export async function onRequestPost(context) {
  return handleAccountDelete(context.request, context.env);
}

/**
 * Cloudflare Pages Functions: POST 以外のフォールバック。
 * handleAccountDelete 側でもメソッドを検査している。
 */
export async function onRequest(context) {
  return handleAccountDelete(context.request, context.env);
}

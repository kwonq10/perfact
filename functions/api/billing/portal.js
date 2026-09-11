// =========================================================
// POST /api/billing/portal — Stripe Billing Portal Session
//
//   **なぜ Sukima 側に契約管理画面を作らないのか**
//     解約・解約取り消し・支払い方法変更・請求書閲覧は、いずれも
//     Stripe が正本を持つ操作。自前 UI を作ると
//     「Sukima の表示」と「Stripe の実態」が二重管理になる。
//     Billing Portal へ委譲し、Sukima は**入口だけ**を持つ。
//
//   **client から受け取らないもの（すべて server が決める）**
//     customer_id / subscription_id / user_id / return_url / plan / price
//     -> body は **空オブジェクトだけ**を受け付ける。未知フィールドは 400。
//        他人の Customer を開かせない / open redirect を作らないため。
//
//   **誰が開けるか**
//     ログイン済みで `stripe_customer_id` を持つ利用者。
//     **いま active かどうかでは絞らない。**
//       - `cancel_at_period_end` 中の人は「解約を取り消したい」
//       - 解約済みの人は「過去の請求書を見たい」
//     という正当な用途があるため。Customer が無い人だけ 409 で断る。
//
//   **Customer の解決**
//     既存の `get_checkout_context` RPC を再利用する（migration を足さない）。
//     この RPC は `stripe_customer_id` と `terms_consented` を返すが、
//     **Portal が使うのは `stripe_customer_id` だけ**で、
//     `terms_consented` は読まない。したがって引数の `p_terms_version` は
//     結果に影響しない（版が draft で取得できないときは番兵値を渡す）。
//     session context に stripe_customer_id を足さないのは既存の方針
//     （Stripe の内部 ID を session 経路へ流さない）。
//
//   レスポンス:  200 { url }
//               400 { error: 'unknown_field' | 'invalid_body' }
//               401 { error: 'unauthenticated' }
//               403 { error: 'forbidden_origin' }
//               405 { error: 'method_not_allowed' }
//               409 { error: 'no_billing_account' }
//               413 { error: 'body_too_large' }
//               500 { error: 'internal_error' | 'server_misconfigured' }
//               502 { error: 'database_unavailable' | 'payment_provider_unavailable' }
//
//   **返すのは Portal の URL だけ。** Stripe の Customer / Subscription /
//   Price の ID、金額、メールアドレスは 1 つも返さない。
//
//   ⚠ **Portal Session の URL は一時的な認証情報を含む。**
//     test / live を問わず、**ログ・レポート・ドキュメントへ全文を残さない**こと。
//     この実装は URL をログへ出さない（応答に載せるだけ）。
// =========================================================

import { getCurrentSubscriptionTermsVersion } from '../_lib/billing-config.js';
import { getAllowedOrigins } from '../_lib/origin.js';
import { stripeRequest } from '../_lib/stripe.js';
import { callRpc } from '../_lib/supabase.js';
import { json, mapRpcError, preflight, readSingleRow } from '../_lib/quota.js';
import { mapStripeError, resolveSiteOrigin } from './checkout.js';

const TAG = 'billing-portal';

/** Customer を引くために再利用する読み取り専用 RPC。 */
export const RPC_NAME = 'get_checkout_context';

/** Stripe の Billing Portal Session 作成 endpoint。 */
export const PORTAL_PATH = '/v1/billing_portal/sessions';

/**
 * Portal から戻る先。**server 固定。**
 * client から任意の URL を渡させない（open redirect を作らない）。
 * アプリのトップへ戻すのは、契約状態の反映がページ読み込み時だからでもある。
 */
export const RETURN_PATH = '/';

/**
 * **Sukima 専用 Billing Portal configuration の env キー**。
 *
 * この configuration は `customer_update.allowed_updates` から **`address` を外して**
 * あり、Portal から請求先住所を変更できない。JP-only enforcement（A-1）は
 * Customer の `address.country` を正にしているので、ここが緩むと
 * 「Portal で住所を非 JP へ変える -> 次回更新で remediation」という経路ができる。
 *
 * **未設定なら Portal を開かない（fail closed）。** 既定 configuration へ
 * 黙って fallback すると住所編集が復活してしまうため。
 */
export const PORTAL_CONFIGURATION_ENV_KEY = 'STRIPE_BILLING_PORTAL_CONFIGURATION_ID';

/**
 * env から configuration ID を読む。**client からは受け取らない。**
 * 形だけ検査する（実値はログにもエラーにも出さない）。
 */
export function resolvePortalConfigurationId(env) {
  const raw = env?.[PORTAL_CONFIGURATION_ENV_KEY];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // Stripe の configuration ID は bpc_ で始まる。取り違えを早期に見つける。
  return trimmed.startsWith('bpc_') ? trimmed : null;
}

/**
 * 版が取得できないときに RPC へ渡す番兵。
 * `terms_consented` を読まないので結果に影響しない。
 * RPC 側の検査（前後空白なし・1〜64 文字）だけを満たす値にしてある。
 */
export const TERMS_VERSION_FALLBACK = 'unavailable';

/** body は空オブジェクトだけ。**未知フィールドは受け付けない。** */
export function validate(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, code: 'invalid_body' };
  }
  const keys = Object.keys(body);
  if (keys.length > 0) {
    // customer_id / return_url などを送りつけられても、ここで落とす。
    return { ok: false, code: 'unknown_field' };
  }
  return { ok: true, value: {} };
}

/** RPC の行から Stripe Customer を取り出す。空文字は「無い」と同じ。 */
export function readCustomerId(row) {
  const raw = row?.stripe_customer_id;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** 戻り先 URL。allowlist の先頭 origin + 固定パス。 */
export function buildReturnUrl(env) {
  const origin = resolveSiteOrigin(env);
  if (typeof origin !== 'string' || origin.length === 0) return null;
  return origin + RETURN_PATH;
}

/**
 * Billing Portal Session を作って URL を返す。
 *
 * 順序（崩さないこと）:
 *   1. method / Origin / body / session（preflight）
 *   2. Customer を server 側で解決（client の値は使わない）
 *   3. Customer が無ければ Stripe を呼ばずに 409
 *   4. Portal Session を作成
 *   5. **URL だけ**返す
 */
export async function handleBillingPortal(request, env, deps = {}) {
  const {
    rpc = callRpc,
    stripe = stripeRequest,
    logger = console,
    currentVersion = getCurrentSubscriptionTermsVersion,
  } = deps;

  // 1: method / Origin / body / session
  const pre = await preflight(request, env, deps, { tag: TAG, validate });
  if (pre.response) return pre.response;

  // 2: Customer は **server が決める**。
  //    版は結果に影響しないが、RPC の引数検査を満たす必要がある。
  let termsVersion;
  try {
    const v = currentVersion();
    termsVersion = (typeof v === 'string' && v.trim().length > 0 && v === v.trim())
      ? v
      : TERMS_VERSION_FALLBACK;
  } catch (e) {
    // 規約が draft でも、**既存契約者の解約導線は塞がない。**
    termsVersion = TERMS_VERSION_FALLBACK;
  }

  let rows;
  try {
    rows = await rpc(
      RPC_NAME,
      { p_user_id: pre.context.user_id, p_terms_version: termsVersion },
      { env },
    );
  } catch (e) {
    return mapRpcError(e, TAG, logger);
  }

  const row = readSingleRow(rows);
  if (row === null) {
    logger.error('[' + TAG + '] RPC の戻り値が契約と異なります。');
    return json(500, { error: 'internal_error' });
  }

  // 3: Customer が無い = Stripe 上に請求先が無い。**Stripe を呼ばずに断る。**
  //    active かどうかは見ない（解約予定・解約済みでも Portal は必要）。
  const customerId = readCustomerId(row);
  if (customerId === null) {
    logger.warn('[' + TAG + '] Stripe Customer が無いため Portal を開けません。');
    return json(409, { error: 'no_billing_account' });
  }

  const returnUrl = buildReturnUrl(env);
  if (returnUrl === null) {
    logger.error('[' + TAG + '] 戻り先 origin を解決できません。');
    return json(500, { error: 'server_misconfigured' });
  }

  // **専用 configuration が無ければ開かない（fail closed）。**
  // 既定 configuration は住所編集を許可しているため fallback してはいけない。
  const configurationId = resolvePortalConfigurationId(env);
  if (configurationId === null) {
    logger.error('[' + TAG + '] Portal configuration が未設定です:',
      PORTAL_CONFIGURATION_ENV_KEY);
    return json(500, { error: 'server_misconfigured' });
  }

  // 4: Portal Session。**渡すのは Customer / 戻り先 / configuration だけ。**
  //    configuration は **server の env が正**で、client からは指定できない。
  //    price / plan は渡さない（plan switching は configuration 側で無効）。
  let session;
  try {
    session = await stripe({
      env,
      method: 'POST',
      path: PORTAL_PATH,
      params: {
        customer: customerId,
        return_url: returnUrl,
        configuration: configurationId,
      },
      fetchImpl: deps.fetchImpl,
    });
  } catch (e) {
    return mapStripeError(e, TAG, logger);
  }

  const url = typeof session?.url === 'string' ? session.url : '';
  if (url.length === 0) {
    logger.error('[' + TAG + '] Portal Session に url がありません。');
    return json(500, { error: 'internal_error' });
  }

  // 5: **URL だけ。** Customer / Subscription の ID は返さない。
  return json(200, { url });
}

/** Cloudflare Pages Functions: POST のエントリポイント */
export async function onRequestPost(context) {
  return handleBillingPortal(context.request, context.env);
}

/**
 * Cloudflare Pages Functions: POST 以外のフォールバック。
 * handleBillingPortal 側でもメソッドを検査している。
 */
export async function onRequest(context) {
  return handleBillingPortal(context.request, context.env);
}

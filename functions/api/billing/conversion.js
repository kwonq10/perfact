// =========================================================
// POST /api/billing/conversion — 初回契約のコンバージョン情報を返す
//
//   Cloudflare Pages Functions（ファイルパス = ルート）。
//   決済完了ページ（public/billing/success.html）の計測スクリプトだけが呼ぶ。
//
//   処理の流れ:
//     0. 本番の計測が無効（ADS_CONVERSION_MODE !== 'live'）または
//        日本以外・国が不明 -> 200 { state: 'disabled' }（session も Stripe も触らない）
//     1〜4. method / Origin / body / Cookie session（quota.js の preflight）
//     5. 判定（_lib/ads-conversion.js）。DB にも Stripe にも書き込まない
//
//   設計上の約束:
//     - **権限を変更しない。** entitlement は webhook -> DB だけが決める。
//       この API は読み取りだけで、結果は計測にしか使わない。
//     - **送信先と値はサーバーが決める。** ブラウザから受け取るのは session_id だけ。
//     - 応答は必ず `Cache-Control: no-store`（quota.js の json）。
//     - ログに Session ID / user_id / 金額 / 顧客情報を出さない。
//
//   レスポンス:
//     200 { state: 'disabled' | 'pending' | 'not_eligible' }
//     200 { state: 'eligible', send_to, value, currency: 'JPY', transaction_id }
//     400 { error: 'invalid_session_id' | 'unknown_field' | ... }
//     401 { error: 'unauthenticated' }
//     403 { error: 'forbidden_origin' }
//     405 { error: 'method_not_allowed' }
//     500 { error: 'internal_error' | 'server_misconfigured' }
//     502 { error: 'payment_provider_unavailable' | 'database_unavailable' }
// =========================================================

import { isAdsLive, isAllowedAdsCountry } from '../_lib/ads-config.js';
import { ConversionCheckError, evaluateFirstPaidConversion } from '../_lib/ads-conversion.js';
import { stripeRequest } from '../_lib/stripe.js';
import { callRpc } from '../_lib/supabase.js';
import { json, preflight } from '../_lib/quota.js';

const TAG = 'billing-conversion';

/** body で受け付けるキー。これ以外は拒否する。 */
export const ALLOWED_BODY_KEYS = Object.freeze(['session_id']);

/** Checkout Session ID の形。Stripe へ渡す前に path に使える文字だけに絞る。 */
export const SESSION_ID_PATTERN = /^cs_(live|test)_[A-Za-z0-9]{1,250}$/;

/**
 * @param {object} body
 * @returns {{ok:true,value:{session_id:string}}|{ok:false,code:string}}
 */
export function validate(body) {
  for (const key of Object.keys(body)) {
    if (!ALLOWED_BODY_KEYS.includes(key)) return { ok: false, code: 'unknown_field' };
  }
  if (typeof body.session_id !== 'string' || !SESSION_ID_PATTERN.test(body.session_id)) {
    return { ok: false, code: 'invalid_session_id' };
  }
  return { ok: true, value: { session_id: body.session_id } };
}

/**
 * @param {Request} request
 * @param {object} env
 * @param {object} [deps]
 */
export async function handleBillingConversion(request, env, deps = {}) {
  const {
    rpc = callRpc,
    stripe = stripeRequest,
    logger = console,
    now = Date.now,
    fetchImpl,
  } = deps;

  // 0: 本番以外・日本以外では何もしない（session / DB / Stripe に触れない）。
  if (request.method === 'POST' && (!isAdsLive(env) || !isAllowedAdsCountry(request))) {
    return json(200, { state: 'disabled' });
  }

  // 1〜4: method / Origin / body / session
  const pre = await preflight(request, env, deps, { tag: TAG, validate });
  if (pre.response) return pre.response;

  let result;
  try {
    result = await evaluateFirstPaidConversion({
      env,
      userId: pre.context.user_id,
      sessionId: pre.value.session_id,
      stripe,
      rpc,
      nowMs: now(),
      fetchImpl,
    });
  } catch (e) {
    if (e instanceof ConversionCheckError) {
      if (e.code === 'stripe_not_configured') {
        logger.error('[' + TAG + '] Stripe の設定が不足しています。');
        return json(500, { error: 'server_misconfigured' });
      }
      if (e.code === 'database_error' || e.code === 'reflection_contract_mismatch') {
        logger.error('[' + TAG + '] 契約の反映を確認できませんでした:', e.code);
        return json(502, { error: 'database_unavailable' });
      }
      logger.error('[' + TAG + '] Stripe で確認できませんでした:', e.code);
      return json(502, { error: 'payment_provider_unavailable' });
    }
    logger.error('[' + TAG + '] 想定外のエラーが発生しました。');
    return json(500, { error: 'internal_error' });
  }

  if (result.state !== 'eligible') {
    // 理由コードだけを残す（ID や金額は出さない）。
    logger.warn('[' + TAG + '] 送信対象外:', result.state, result.reason ?? 'none');
    return json(200, { state: result.state });
  }

  return json(200, {
    state: 'eligible',
    send_to: result.send_to,
    value: result.value,
    currency: result.currency,
    transaction_id: result.transaction_id,
  });
}

/** Cloudflare Pages Functions: POST のエントリポイント */
export async function onRequestPost(context) {
  return handleBillingConversion(context.request, context.env);
}

/** POST 以外は preflight が 405 を返す。 */
export async function onRequest(context) {
  return handleBillingConversion(context.request, context.env);
}

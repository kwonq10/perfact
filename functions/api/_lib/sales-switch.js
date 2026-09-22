// =========================================================
// 新規購入の受付停止スイッチ（BILLING_SALES_SUSPENDED）
//
//   異常時に **新しい購入だけ** を止めるための server 側の判定。
//   使うのは購入フローの入口 2 本だけ:
//     - POST /api/terms/consent   （購入前の規約同意。DB に 1 行書く）
//     - POST /api/billing/checkout（Stripe Checkout Session を作る）
//   どちらも **session / RPC / Stripe より前** に判定し、DB にも Stripe にも触れずに断る。
//
//   **止めないもの**（このモジュールを import しない）:
//     webhook / Billing Portal / auth（me・session・logout）/ entitlement /
//     account delete / 無料機能。既存契約の更新・解約・Pro 判定は今までどおり動く。
//
//   値の解釈（trim + 小文字化してから判定）:
//     未設定 / 空文字 / 'false' -> 受付中（既定。現行の本番はこの状態）
//     'true'                   -> 停止中
//     それ以外                 -> **停止中として扱う（fail closed）**
//       停止のつもりで 'yes' や 'on' と書いた場合に、黙って販売が再開する方が危険なため。
//       値そのものはログにも応答にも出さない（分類コードだけを返す）。
//
//   ⚠ Cloudflare Pages の環境変数は **変更後に再デプロイしないと反映されない**。
//     このスイッチは「即時停止」ではない。反映は新しいデプロイが Production になった時点。
// =========================================================

/** Cloudflare Pages の環境変数名。secret ではなく通常の変数でよい。 */
export const SALES_SWITCH_ENV_KEY = 'BILLING_SALES_SUSPENDED';

/** 停止中に返す error コード。 */
export const SALES_SUSPENDED_ERROR = 'sales_suspended';

/** 判定結果の理由（ログと test 用。値そのものは含めない）。 */
export const SALES_SWITCH_REASON = Object.freeze({
  UNSET: 'unset',
  DISABLED: 'false',
  ENABLED: 'true',
  INVALID: 'invalid',
});

/**
 * 新規購入の受付を止めているか。
 *
 * @param {object} env Cloudflare の context.env
 * @returns {{suspended: boolean, reason: string}}
 */
export function readSalesSwitch(env) {
  const raw = env && typeof env === 'object' ? env[SALES_SWITCH_ENV_KEY] : undefined;
  if (raw === undefined || raw === null) {
    return { suspended: false, reason: SALES_SWITCH_REASON.UNSET };
  }
  if (typeof raw !== 'string') {
    return { suspended: true, reason: SALES_SWITCH_REASON.INVALID };
  }
  const value = raw.trim().toLowerCase();
  if (value === '') return { suspended: false, reason: SALES_SWITCH_REASON.UNSET };
  if (value === 'false') return { suspended: false, reason: SALES_SWITCH_REASON.DISABLED };
  if (value === 'true') return { suspended: true, reason: SALES_SWITCH_REASON.ENABLED };
  return { suspended: true, reason: SALES_SWITCH_REASON.INVALID };
}

/**
 * 停止中なら 503 の本文を返す。受付中なら null。
 *
 * **POST のときだけ** 呼ぶこと（POST 以外は各 handler の 405 をそのまま返す）。
 * 値が不正なときは停止扱いにし、設定ミスに気付けるよう error ログを残す。
 *
 * @param {object} env
 * @param {string} tag    ログのタグ
 * @param {object} logger
 * @returns {{status: number, body: {error: string}} | null}
 */
export function salesSuspendedRejection(env, tag, logger) {
  const sw = readSalesSwitch(env);
  if (!sw.suspended) return null;
  if (sw.reason === SALES_SWITCH_REASON.INVALID) {
    logger.error('[' + tag + '] ' + SALES_SWITCH_ENV_KEY
      + ' の値が不正なため、新規購入の受付を停止扱いにしました。');
  } else {
    logger.warn('[' + tag + '] 新規購入の受付を停止中のため拒否しました。');
  }
  return { status: 503, body: { error: SALES_SUSPENDED_ERROR } };
}

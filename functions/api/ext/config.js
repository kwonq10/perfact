// =========================================================
// GET /api/ext/config — 拡張向けの実行時設定
//
//   **quota を有効にするかどうかの唯一の判断元。**
//   拡張のコードには固定の ON/OFF を持たせない。これにより
//   Chrome Web Store の更新なしに、サーバーの環境変数だけで
//   enforcement を切り替えられる。
//
//   設計上の約束:
//     - **認証を要求しない。** Cookie も Bearer も見ない。
//       連携するかどうかを決めるために未連携の拡張も読む必要があり、
//       認証を課すと「連携しないと ON/OFF が分からない」循環になる。
//       返す値はユーザー固有ではないグローバルなロールアウトスイッチで、
//       読み手は Origin allowlist で拡張に限定される。
//     - **Origin は allowlist と完全一致**。未許可には CORS ヘッダを返さない。
//     - `EXTENSION_QUOTA_ENABLED` は trim + 小文字化して **厳密に 'true'** のときだけ有効。
//       未設定・空・'1'・'yes' などはすべて false（**fail safe**。現状維持）。
//     - Cookie を使わないため Web 側の CSRF 前提には一切影響しない。
//
//   カスタムヘッダの無い GET は simple request なので、実際には
//   preflight が飛ばないことが多い。それでも OPTIONS は用意しておく。
//
//   リクエスト:  GET
//               Origin: chrome-extension://<EXTENSION_IDS に含まれる ID>
//
//   レスポンス:  200 { quota_enforced: boolean, free_weekly_limit: 3 }
//               403 { error: 'forbidden_origin' }        ← CORS ヘッダなし
//               405 { error: 'method_not_allowed' }
// =========================================================

import { FREE_WEEKLY_LIMIT } from '../_lib/quota.js';
import { checkExtensionOrigin, extJson, handlePreflight } from '../_lib/ext-cors.js';

const TAG = 'ext-config';

/** このエンドポイントだけが GET を許可する。他の /api/ext/* は POST のまま。 */
export const CONFIG_ALLOWED_METHODS = 'GET, OPTIONS';

/**
 * quota enforcement が有効か。
 *
 * 判定は厳密。'true' 以外はすべて無効として扱う（fail safe）。
 * 未設定なら無効＝拡張は現在と同じ挙動になる。
 *
 * @param {object} env Cloudflare の context.env
 * @returns {boolean}
 */
export function isExtensionQuotaEnabled(env) {
  const raw = env && typeof env.EXTENSION_QUOTA_ENABLED === 'string'
    ? env.EXTENSION_QUOTA_ENABLED
    : '';
  return raw.trim().toLowerCase() === 'true';
}

export async function handleExtConfig(request, env, deps = {}) {
  const { logger = console, origin: checkOrigin = checkExtensionOrigin } = deps;

  // 1. Origin。許可外には CORS ヘッダを付けない（ブラウザ側でも遮断させる）。
  const originResult = checkOrigin(request, env);
  if (!originResult.ok) {
    logger.warn('[' + TAG + '] Origin 検証に失敗しました:', originResult.reason);
    return extJson(403, { error: 'forbidden_origin' }, null);
  }
  const allowedOrigin = originResult.origin;

  // 2. method
  if (request.method !== 'GET') {
    return extJson(
      405,
      { error: 'method_not_allowed' },
      allowedOrigin,
      { 'Access-Control-Allow-Methods': CONFIG_ALLOWED_METHODS },
    );
  }

  // 3. 設定を返す。認証は見ない。
  return extJson(
    200,
    {
      quota_enforced: isExtensionQuotaEnabled(env),
      free_weekly_limit: FREE_WEEKLY_LIMIT,
    },
    allowedOrigin,
    { 'Access-Control-Allow-Methods': CONFIG_ALLOWED_METHODS },
  );
}

/** Cloudflare Pages Functions: preflight（GET を許可する点だけ他と異なる） */
export async function onRequestOptions(context) {
  return handlePreflight(context.request, context.env, CONFIG_ALLOWED_METHODS);
}

/** Cloudflare Pages Functions: GET のエントリポイント */
export async function onRequestGet(context) {
  return handleExtConfig(context.request, context.env);
}

/** GET / OPTIONS 以外のフォールバック。405 は handleExtConfig が返す。 */
export async function onRequest(context) {
  return handleExtConfig(context.request, context.env);
}

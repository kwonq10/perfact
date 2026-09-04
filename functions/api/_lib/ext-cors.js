// =========================================================
// Chrome 拡張向け CORS（Cloudflare Pages Functions 専用）
//
//   /api/ext/* だけで使う。既存の Web 用エンドポイントには一切適用しない。
//
//   なぜ必要か:
//     Cloudflare Pages は「静的アセット」にだけ Access-Control-Allow-Origin: *
//     を自動付与し、Pages Functions の応答には付けない（E2-a で実測）。
//     拡張は host_permissions を持たないため、CORS でオプトインしない限り
//     ブラウザがレスポンスを読ませない。
//
//   設計上の約束:
//     - **ワイルドカードを使わない。** 許可した拡張の origin と完全一致させる。
//     - **Access-Control-Allow-Credentials は付けない。**
//       この経路は Cookie を使わず Authorization: Bearer で認証する。
//       付けると Cookie 認証の経路と混線し、Web 側の CSRF 前提が崩れる。
//     - 許可しない origin には CORS ヘッダを一切返さない（ブラウザ側でも遮断させる）。
//     - _lib/origin.js には触れない。Web の allowlist と完全に独立している。
//
//   環境変数:
//     EXTENSION_IDS  許可する拡張機能 ID のカンマ区切り。
//                    未設定なら許可 0 件（フェイルクローズ）。
//                    秘密値ではないが、コードに焼き込まず env から読む。
// =========================================================

/**
 * Chrome 拡張機能 ID の形式。
 * 32 文字の a〜p（Chrome が公開鍵から導出する固定 ID の形）。
 * これ以外は allowlist に載せない（origin を広げないため）。
 */
export const EXTENSION_ID_RE = /^[a-p]{32}$/;

/** 拡張 origin の scheme。 */
export const EXTENSION_SCHEME = 'chrome-extension://';

/** preflight の結果をブラウザにキャッシュさせる秒数。 */
export const PREFLIGHT_MAX_AGE = 600;

/**
 * env から許可する拡張機能 ID の一覧を取り出す。
 *
 * 形式が不正な要素は無視する（allowlist を広げないため）。
 * 未設定・空なら空配列を返す＝どの拡張も許可しない。
 *
 * @param {object} env Cloudflare の context.env
 * @returns {string[]} 正規化済みの拡張機能 ID（重複なし）
 */
export function getAllowedExtensionIds(env) {
  const raw = env && typeof env.EXTENSION_IDS === 'string' ? env.EXTENSION_IDS : '';
  const ids = [];
  for (const entry of raw.split(',')) {
    const id = entry.trim();
    if (EXTENSION_ID_RE.test(id) && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * 許可する拡張 origin の一覧。
 *
 * @param {object} env
 * @returns {string[]} 例: ['chrome-extension://aaaa…']
 */
export function getAllowedExtensionOrigins(env) {
  return getAllowedExtensionIds(env).map((id) => EXTENSION_SCHEME + id);
}

/**
 * 拡張機能 ID が許可されているか。
 *
 * @param {unknown} id
 * @param {object} env
 * @returns {boolean}
 */
export function isAllowedExtensionId(id, env) {
  return typeof id === 'string' && getAllowedExtensionIds(env).includes(id);
}

/**
 * リクエストの Origin が許可された拡張のものか検証する。
 *
 * chrome-extension:// は非特殊スキームで URL#origin が "null" になるため、
 * _lib/origin.js の normalizeOrigin では扱えない。ここでは URL 解釈を使わず、
 * **allowlist の文字列との完全一致**だけで判定する。
 * 前方一致・後方一致・部分一致はしない。
 *
 * @param {Request} request
 * @param {object} env
 * @returns {{ok:true, origin:string} | {ok:false, reason:'missing_origin'|'forbidden_origin'}}
 */
export function checkExtensionOrigin(request, env) {
  const raw = request?.headers?.get?.('origin');

  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { ok: false, reason: 'missing_origin' };
  }

  const origin = raw.trim();
  const allowed = getAllowedExtensionOrigins(env);

  return allowed.includes(origin)
    ? { ok: true, origin }
    : { ok: false, reason: 'forbidden_origin' };
}

/**
 * 許可済み origin に対する CORS ヘッダ。
 *
 * Access-Control-Allow-Credentials は意図的に付けない。
 *
 * @param {string} origin 検証済みの拡張 origin
 * @returns {object}
 */
export function buildCorsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': String(PREFLIGHT_MAX_AGE),
    Vary: 'Origin',
  };
}

/**
 * 拡張向け JSON レスポンス。
 *
 * origin が null（未許可）のときは CORS ヘッダを付けない。
 * ブラウザ側でも読めなくなるため、拒否がクライアントに正しく伝わる。
 *
 * @param {number} status
 * @param {object} body
 * @param {string|null} origin 検証済みの拡張 origin
 * @param {object} [extraHeaders]
 * @returns {Response}
 */
export function extJson(status, body, origin = null, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...(origin ? buildCorsHeaders(origin) : { Vary: 'Origin' }),
      ...extraHeaders,
    },
  });
}

/**
 * preflight（OPTIONS）への応答。
 *
 * 許可済みなら 204 + CORS ヘッダ。未許可なら 403 で CORS ヘッダを付けない。
 *
 * @param {Request} request
 * @param {object} env
 * @returns {Response}
 */
export function handlePreflight(request, env) {
  const result = checkExtensionOrigin(request, env);
  if (!result.ok) {
    return new Response(null, {
      status: 403,
      headers: { 'Cache-Control': 'no-store', Vary: 'Origin' },
    });
  }

  return new Response(null, {
    status: 204,
    headers: { 'Cache-Control': 'no-store', ...buildCorsHeaders(result.origin) },
  });
}

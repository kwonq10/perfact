// =========================================================
// Sukima サーバーセッション共通ヘルパー（Cloudflare Pages Functions 専用）
//
//   20260901041257_session_schema.sql の sessions テーブル / RPC と対になる。
//
//   設計上の約束:
//     - Cookie に入るのは不透明なランダムトークンのみ。
//       user_id / google_sub / plan_id / status は一切入れない。
//     - DB には生トークンを保存しない。SHA-256 の小文字 hex だけを送る。
//     - 有効期限の判定権限は DB にある。ここで 30日 / 90日を再計算しない。
//       get_session_context が返す idle_expires_at を Cookie 更新に使う。
//     - Google ID Token / Google Calendar access token はここでは扱わない。
//       それらは verifyGoogleIdToken.js とクライアント側の責務。
//     - service_role キーは supabase.js の中だけで使われ、外へ出ない。
//     - 生トークン・トークンハッシュ・キーはログに出さない。
//
//   このモジュールは Response を組み立てない。
//   Set-Cookie 文字列は返すが、いつ付与するかは呼び出し側が決める。
// =========================================================

import { SupabaseError, callRpc } from './supabase.js';

/** Cookie 名。__Host- プレフィックスはブラウザが Secure + Path=/ + Domain なしを強制する。 */
export const SESSION_COOKIE_NAME = '__Host-sukima_session';

/** session token の乱数バイト数。128bit では足りないため 256bit を使う。 */
export const SESSION_TOKEN_BYTES = 32;

/** SHA-256 の小文字 hex（64文字）。sessions.token_hash の CHECK 制約と同じ形式。 */
const TOKEN_HASH_RE = /^[0-9a-f]{64}$/;

/** base64url は英数字と - _ のみ（パディングなし）。 */
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

/**
 * セッションの取得結果。
 * status で「有効 / 無効 / サーバー側の異常」を呼び出し側が区別する。
 *
 *   'valid'          : 有効。context に user_id / plan_id / status などが入る。
 *   'unauthenticated': Cookie が無い・形式不正・DB 上に無い・期限切れ。→ 401
 *   'data_error'     : セッションは引けたが subscriptions が欠落等。→ 5xx（フェイルクローズ）
 *   'unavailable'    : Supabase へ到達できない。→ 502
 *   'misconfigured'  : 環境変数の設定漏れ。→ 500
 */
export const SESSION_RESULT = Object.freeze({
  VALID: 'valid',
  UNAUTHENTICATED: 'unauthenticated',
  DATA_ERROR: 'data_error',
  UNAVAILABLE: 'unavailable',
  MISCONFIGURED: 'misconfigured',
});

/**
 * 暗号学的に安全な session token を生成する。
 *
 * Math.random は使わない。Workers の Web Crypto を使う。
 *
 * @returns {string} 32バイト乱数の base64url（パディングなし・43文字）
 */
export function generateSessionToken() {
  const bytes = new Uint8Array(SESSION_TOKEN_BYTES);
  crypto.getRandomValues(bytes);

  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * session token を SHA-256 でハッシュし、小文字 hex 64文字を返す。
 * DB へ渡すのは常にこの値で、生トークンは渡さない。
 *
 * @param {string} token
 * @returns {Promise<string>} 小文字 hex 64文字
 * @throws {TypeError} token が文字列でない、空、または base64url でない場合
 */
export async function hashSessionToken(token) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new TypeError('session token は空でない文字列である必要があります。');
  }
  if (!BASE64URL_RE.test(token)) {
    throw new TypeError('session token の形式が不正です。');
  }

  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const bytes = new Uint8Array(digest);

  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

/**
 * Cookie ヘッダから session Cookie の値だけを取り出す。
 * 他の Cookie には一切影響しない。
 *
 * @param {Request} request
 * @returns {string|null} 生の session token。無い・壊れている場合は null
 */
export function parseSessionCookie(request) {
  const header = request?.headers?.get?.('cookie');
  if (typeof header !== 'string' || header.length === 0) return null;

  // "a=1; b=2" 形式。値に "=" が含まれ得るので最初の "=" だけで分割する。
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;

    const name = part.slice(0, eq).trim();
    if (name !== SESSION_COOKIE_NAME) continue;

    const raw = part.slice(eq + 1).trim();
    if (raw.length === 0) return null;

    // 値は base64url なのでパーセントエンコードは本来含まれないが、
    // 途中の経路で符号化された場合に備えて復号を試みる。
    // 不正なパーセント記法で decodeURIComponent が投げても落とさない。
    let value = raw;
    if (raw.includes('%')) {
      try {
        value = decodeURIComponent(raw);
      } catch {
        return null;
      }
    }

    return BASE64URL_RE.test(value) ? value : null;
  }

  return null;
}

/**
 * expiresAt を Date へ正規化する。Date / ISO 文字列 / epoch ミリ秒を受ける。
 * 解釈できない場合は null。
 */
function toDate(expiresAt) {
  if (expiresAt instanceof Date) {
    return Number.isNaN(expiresAt.getTime()) ? null : expiresAt;
  }
  if (typeof expiresAt === 'string' || typeof expiresAt === 'number') {
    const d = new Date(expiresAt);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/**
 * Set-Cookie 用の文字列を組み立てる。
 *
 * __Host- プレフィックスの要件により Secure と Path=/ は必須、Domain は付けない。
 *
 * @param {string} token      生の session token
 * @param {Date|string|number} expiresAt 実効有効期限（通常は DB の idle_expires_at）
 * @param {object} [options.now] 現在時刻。テストのため注入可能
 * @returns {string}
 * @throws {TypeError} token が不正、または expiresAt を解釈できない場合
 */
export function buildSessionCookie(token, expiresAt, options = {}) {
  if (typeof token !== 'string' || token.length === 0 || !BASE64URL_RE.test(token)) {
    throw new TypeError('session token の形式が不正です。');
  }

  const expires = toDate(expiresAt);
  if (expires === null) {
    throw new TypeError('expiresAt を日時として解釈できません。');
  }

  const now = toDate(options.now) ?? new Date();
  const maxAge = Math.max(0, Math.floor((expires.getTime() - now.getTime()) / 1000));

  return [
    `${SESSION_COOKIE_NAME}=${token}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${maxAge}`,
    `Expires=${expires.toUTCString()}`,
  ].join('; ');
}

/**
 * セッション Cookie を削除するための Set-Cookie 文字列。
 * 属性は buildSessionCookie と揃える（揃っていないとブラウザが削除しない）。
 *
 * @returns {string}
 */
export function buildClearSessionCookie() {
  return [
    `${SESSION_COOKIE_NAME}=`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Path=/',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ].join('; ');
}

/** RPC 名。migration 20260901041257 で作成した関数。 */
const RPC_GET_SESSION_CONTEXT = 'get_session_context';

/**
 * session token から DB のセッション文脈を取得する。
 *
 * DB が有効期限の authority。ここで 30日 / 90日を再計算しない。
 * get_session_context は検証・idle 延長・subscription 取得を1往復で行う。
 *
 * @param {object} env   Cloudflare の context.env
 * @param {string} token 生の session token
 * @param {object} [deps.rpc]       callRpc 差し替え（テスト用）
 * @param {object} [deps.logger]
 * @returns {Promise<object>} { status, context? , reason? }
 */
export async function getSessionContext(env, token, deps = {}) {
  const { rpc = callRpc, logger = console } = deps;

  let tokenHash;
  try {
    tokenHash = await hashSessionToken(token);
  } catch {
    // 形式不正はそもそも DB に存在し得ない。DB を叩かずに未認証とする。
    return { status: SESSION_RESULT.UNAUTHENTICATED, reason: 'malformed_token' };
  }

  let rows;
  try {
    rows = await rpc(RPC_GET_SESSION_CONTEXT, { p_token_hash: tokenHash }, { env });
  } catch (e) {
    if (e instanceof SupabaseError) {
      if (e.code === 'not_configured') {
        // メッセージに秘密値は含まれない（supabase.js が設定不足のみを報告する）
        logger.error('[session] Supabase 設定エラー:', e.message);
        return { status: SESSION_RESULT.MISCONFIGURED, reason: 'not_configured' };
      }
      // 到達不能もリクエスト失敗も、呼び出し側から見れば「今は使えない」
      logger.error('[session] Supabase エラー(' + e.code + ')');
      return { status: SESSION_RESULT.UNAVAILABLE, reason: e.code };
    }
    logger.error('[session] 予期しない DB エラー:', e);
    return { status: SESSION_RESULT.UNAVAILABLE, reason: 'unexpected' };
  }

  // TABLE を返す RPC なので配列。0行 = セッション無効。
  if (rows === null || rows === undefined) {
    return { status: SESSION_RESULT.UNAUTHENTICATED, reason: 'no_session' };
  }
  if (!Array.isArray(rows)) {
    logger.error('[session] RPC の戻り値が配列ではありません。');
    return { status: SESSION_RESULT.DATA_ERROR, reason: 'unexpected_shape' };
  }
  if (rows.length === 0) {
    return { status: SESSION_RESULT.UNAUTHENTICATED, reason: 'no_session' };
  }
  if (rows.length > 1) {
    // token_hash は PRIMARY KEY なので複数行はあり得ない。DB 異常として扱う。
    logger.error('[session] get_session_context が複数行を返しました。');
    return { status: SESSION_RESULT.DATA_ERROR, reason: 'multiple_rows' };
  }

  const row = rows[0];
  if (row === null || typeof row !== 'object') {
    logger.error('[session] RPC の行が想定と異なります。');
    return { status: SESSION_RESULT.DATA_ERROR, reason: 'unexpected_shape' };
  }

  // plan_id / status が NULL = セッションはあるが subscriptions 行が欠落している。
  // 未認証（401）に丸めるとデータ異常が隠れるため、明確に分ける（フェイルクローズ）。
  if (typeof row.plan_id !== 'string' || typeof row.status !== 'string') {
    logger.error('[session] subscriptions 行が欠落しています。');
    return { status: SESSION_RESULT.DATA_ERROR, reason: 'missing_subscription' };
  }
  if (typeof row.user_id !== 'string' || row.user_id.length === 0) {
    logger.error('[session] user_id を取得できませんでした。');
    return { status: SESSION_RESULT.DATA_ERROR, reason: 'missing_user_id' };
  }

  return {
    status: SESSION_RESULT.VALID,
    context: {
      // user_id はサーバー内部専用。HTTP レスポンスへ出さないこと。
      user_id: row.user_id,
      plan_id: row.plan_id,
      status: row.status,
      // Cookie の Max-Age 更新にはこちらを使う（DB が算出した実効期限）
      idle_expires_at: row.idle_expires_at ?? null,
      absolute_expires_at: row.absolute_expires_at ?? null,
    },
  };
}

/**
 * Request から Cookie を読み、セッションを検証する。
 *
 * この関数は Response を組み立てない。Set-Cookie の更新が必要かどうかは
 * 呼び出し側（/api/auth/me など）が context.idle_expires_at を見て判断する。
 *
 * @param {Request} request
 * @param {object}  env      Cloudflare の context.env
 * @param {object}  [deps]   テスト用の差し替え
 * @returns {Promise<object>} getSessionContext と同じ形
 */
export async function requireSession(request, env, deps = {}) {
  const token = parseSessionCookie(request);
  if (token === null) {
    return { status: SESSION_RESULT.UNAUTHENTICATED, reason: 'no_cookie' };
  }
  return getSessionContext(env, token, deps);
}

/** 結果が有効なセッションかどうかの判定ヘルパー。 */
export function isValidSession(result) {
  return result?.status === SESSION_RESULT.VALID;
}

/** 結果がサーバー側の異常（未認証に丸めてはいけないもの）かどうか。 */
export function isServerError(result) {
  return result?.status === SESSION_RESULT.DATA_ERROR
      || result?.status === SESSION_RESULT.UNAVAILABLE
      || result?.status === SESSION_RESULT.MISCONFIGURED;
}

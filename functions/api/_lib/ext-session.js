// =========================================================
// 拡張機能向けセッション（Cloudflare Pages Functions 専用）
//
//   Web は HttpOnly Cookie（__Host-sukima_session）でセッションを運ぶ。
//   拡張は Cookie を送れないため、**同じ sessions テーブルの行**を
//   Authorization: Bearer で運ぶ。テーブルも RPC も Web と共通で、DB 変更はない。
//
//   設計上の約束:
//     - _lib/session.js は変更しない。generateSessionToken / hashSessionToken /
//       getSessionContext をそのまま再利用する。
//     - 発行するのは Web とは**別のセッション行**。
//       Web セッションのトークンを拡張へ複製しない（失効の巻き添えと
//       漏洩範囲の拡大を避けるため）。
//     - google_sub はこのモジュールの中だけで扱い、戻り値にもログにも出さない。
//     - 生トークンは戻り値でのみ返し、ログには出さない。
// =========================================================

import { SupabaseError, callRpc } from './supabase.js';
import {
  SESSION_RESULT,
  generateSessionToken,
  getSessionContext,
  hashSessionToken,
} from './session.js';
import { fetchGoogleSubByUserId } from './ext-users.js';

/** ログイン時に使う RPC。Web の /api/auth/session と同一。 */
const RPC_UPSERT = 'upsert_user_and_create_session';

/** ログアウト時に使う RPC。Web の /api/auth/logout と同一。 */
export const RPC_DELETE_SESSION = 'delete_session';

/**
 * token_hash 衝突時に張り直す最大試行回数。
 * 256bit 乱数の SHA-256 が衝突することは実質ないため、通常 1 回で終わる。
 */
export const MAX_SESSION_TOKEN_ATTEMPTS = 3;

/** session token は base64url（パディングなし）。_lib/session.js と同じ形式。 */
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

/**
 * sessions.token_hash（PRIMARY KEY）の一意制約違反かどうか。
 *
 * auth/session.js の isTokenHashCollision と同じ判定。
 * あちらを import すると verifyGoogleIdToken 経由で jose まで読み込まれ、
 * 拡張経路が ID Token 検証に依存してしまうため、あえて複製している。
 *
 * 注意: e.message には衝突した token_hash が含まれ得る。ログに出さないこと。
 *
 * @param {unknown} e
 * @returns {boolean}
 */
export function isTokenHashCollision(e) {
  if (!(e instanceof SupabaseError)) return false;
  if (e.code !== 'request_failed') return false;

  const msg = String(e.message ?? '');
  if (!/"code"\s*:\s*"23505"/.test(msg)) return false;

  return /sessions_pkey/.test(msg) || /token_hash/.test(msg);
}

/**
 * Authorization ヘッダから Bearer トークンを取り出す。
 *
 * 形式が違うものは DB を叩かずに null を返す。
 *
 * @param {Request} request
 * @returns {string|null} 生の session token
 */
export function parseBearerToken(request) {
  const header = request?.headers?.get?.('authorization');
  if (typeof header !== 'string') return null;

  const trimmed = header.trim();
  const space = trimmed.indexOf(' ');
  if (space === -1) return null;

  const scheme = trimmed.slice(0, space);
  if (scheme.toLowerCase() !== 'bearer') return null;

  const token = trimmed.slice(space + 1).trim();
  if (token.length === 0) return null;

  return BASE64URL_RE.test(token) ? token : null;
}

/**
 * Bearer トークンからセッションを検証する。
 *
 * 戻り値の形は _lib/session.js の requireSession と同じなので、
 * 呼び出し側は SESSION_RESULT でそのまま分岐できる。
 *
 * @param {Request} request
 * @param {object}  env
 * @param {object}  [deps]
 * @returns {Promise<object>}
 */
export async function requireExtSession(request, env, deps = {}) {
  const token = parseBearerToken(request);
  if (token === null) {
    return { status: SESSION_RESULT.UNAUTHENTICATED, reason: 'no_bearer' };
  }
  return getSessionContext(env, token, deps);
}

/**
 * 既存ユーザーに対して拡張用のセッションを新規発行する。
 *
 * 呼び出し側は「Web セッションで本人確認済み」であることを保証すること。
 * この関数自体は本人確認を行わない。
 *
 * @param {object} env
 * @param {string} userId users.id（Web セッションから得た値のみ）
 * @param {object} [deps.rpc]
 * @param {object} [deps.fetchGoogleSub]
 * @param {object} [deps.generateToken]
 * @param {object} [deps.logger]
 * @returns {Promise<{ok:true, token:string, row:object} | {ok:false, code:string}>}
 *   code: 'user_not_found' | 'server_misconfigured' | 'database_unavailable' | 'internal_error'
 */
export async function issueExtensionSession(env, userId, deps = {}) {
  const {
    rpc = callRpc,
    fetchGoogleSub = fetchGoogleSubByUserId,
    generateToken = generateSessionToken,
    logger = console,
  } = deps;

  // --- 1. google_sub を引く（この値は以降どこにも出さない） ---
  let googleSub;
  try {
    googleSub = await fetchGoogleSub(env, userId);
  } catch (e) {
    if (e instanceof SupabaseError) {
      if (e.code === 'not_configured') {
        logger.error('[ext-link] Supabase 設定エラー:', e.message);
        return { ok: false, code: 'server_misconfigured' };
      }
      logger.error('[ext-link] Supabase エラー(' + e.code + ')');
      return { ok: false, code: 'database_unavailable' };
    }
    logger.error('[ext-link] 予期しない DB エラーです。');
    return { ok: false, code: 'internal_error' };
  }

  if (typeof googleSub !== 'string' || googleSub.length === 0) {
    // セッションがあるのに users 行が無い＝不変条件の破れ。401 に丸めない。
    logger.error('[ext-link] user_id に対応する users 行が見つかりません。');
    return { ok: false, code: 'user_not_found' };
  }

  // --- 2. セッションを発行する（衝突時のみ限定的に張り直す） ---
  let rawToken = null;
  let rows = null;

  for (let attempt = 1; attempt <= MAX_SESSION_TOKEN_ATTEMPTS; attempt += 1) {
    rawToken = generateToken();

    let tokenHash;
    try {
      tokenHash = await hashSessionToken(rawToken);
    } catch {
      logger.error('[ext-link] session token の生成に失敗しました。');
      return { ok: false, code: 'internal_error' };
    }

    try {
      rows = await rpc(
        RPC_UPSERT,
        { p_google_sub: googleSub, p_token_hash: tokenHash },
        { env },
      );
      break;
    } catch (e) {
      // message には衝突した hash が含まれ得るのでログに出さない。
      if (isTokenHashCollision(e)) {
        logger.warn('[ext-link] session token が衝突しました。再生成します。');
        if (attempt < MAX_SESSION_TOKEN_ATTEMPTS) continue;
        logger.error('[ext-link] session token の衝突が続いたため中止しました。');
        return { ok: false, code: 'internal_error' };
      }

      if (e instanceof SupabaseError) {
        if (e.code === 'not_configured') {
          logger.error('[ext-link] Supabase 設定エラー:', e.message);
          return { ok: false, code: 'server_misconfigured' };
        }
        logger.error('[ext-link] Supabase エラー(' + e.code + ')');
        return { ok: false, code: 'database_unavailable' };
      }

      logger.error('[ext-link] 予期しない DB エラーです。');
      return { ok: false, code: 'internal_error' };
    }
  }

  // --- 3. 戻り値の検証（異常は fail closed） ---
  if (!Array.isArray(rows) || rows.length !== 1) {
    logger.error('[ext-link] RPC の戻り行数が想定と異なります。');
    return { ok: false, code: 'internal_error' };
  }

  const row = rows[0];
  if (row === null || typeof row !== 'object'
      || typeof row.plan_id !== 'string'
      || typeof row.status !== 'string'
      || row.idle_expires_at === null || row.idle_expires_at === undefined) {
    logger.error('[ext-link] RPC の戻り値が想定と異なります。');
    return { ok: false, code: 'internal_error' };
  }

  return { ok: true, token: rawToken, row };
}

// =========================================================
// 拡張機能向け quota の共通処理（Cloudflare Pages Functions 専用）
//
//   /api/ext/quota/{reserve,commit,release} が共有する前処理。
//   呼ぶ RPC は Web と**まったく同じ** reserve/commit/release_weekly_usage で、
//   DB 変更は無い。違うのは「誰であるかの運び方」と「無制限判定」だけ。
//
//   Web との違い（意図的）:
//     - 認証は Cookie ではなく Authorization: Bearer
//     - CSRF 対策は Origin allowlist ではなく「カスタムヘッダ必須」という性質
//       （form 経由では Authorization を付けられないため CSRF が原理的に成立しない。
//         /api/auth/session が Origin 検証を持たないのと同じ論拠）
//     - CORS ヘッダを自分で返す
//     - 無制限判定は hasExtensionUnlimited（web_pro は拡張では quota 対象）
//
//   _lib/quota.js と _lib/origin.js は変更しない。
//   json / mapRpcError / readSingleRow は読み取り専用で再利用する。
// =========================================================

import { checkExtensionOrigin, extJson } from './ext-cors.js';
import { readJsonBody } from './request-body.js';
import { requireExtSession } from './ext-session.js';
import { SESSION_RESULT } from './session.js';
import { WEB_UNLIMITED_STATUSES } from './quota.js';

/**
 * 拡張で quota 無制限になる plan_id。
 *
 * 製品仕様:
 *   free          … Web と共有で週3回
 *   web_pro       … Web は無制限だが**拡張では quota 対象**
 *   extension_pro … 拡張は無制限
 *   all_pro       … 両方とも無制限
 */
export const EXTENSION_UNLIMITED_PLAN_IDS = Object.freeze(['extension_pro', 'all_pro']);

/**
 * 拡張の quota が免除されるか。
 *
 * plan_id と status の両方を満たしたときだけ true。
 * status の条件（active / trialing のみ。past_due は Pro 扱いしない）は
 * Web と共通なので _lib/quota.js の定数を再利用する。
 *
 * hasWebUnlimited とは**別関数**であり、あちらは変更しない。
 *
 * @param {object} context requireExtSession が返す session context
 * @returns {boolean}
 */
export function hasExtensionUnlimited(context) {
  if (!context || typeof context !== 'object') return false;
  return EXTENSION_UNLIMITED_PLAN_IDS.includes(context.plan_id)
      && WEB_UNLIMITED_STATUSES.includes(context.status);
}

/** body 検証コード -> HTTP ステータス。サイズ超過だけ 413 にする。 */
function bodyErrorStatus(code) {
  return code === 'body_too_large' ? 413 : 400;
}

/**
 * 拡張 quota API 3 本の共通前処理。
 *
 * 処理順（この順序を変えないこと）:
 *   1. Origin 検証      -> 403（CORS ヘッダを付けずに拒否）
 *   2. method 確認      -> 405
 *   3. JSON body 検証   -> 400 / 413
 *   4. Bearer セッション -> 401 / 500 / 502
 *
 * Web 版（_lib/quota.js の preflight）は method を先に見るが、こちらは
 * Origin を先に見る。CORS ヘッダは許可済み origin にしか付けられないため、
 * 先に origin を確定しないとエラー応答をブラウザが読めなくなる。
 *
 * @returns {Promise<{response:Response}|{context:object,value:any,origin:string}>}
 */
export async function extPreflight(request, env, deps, spec) {
  const {
    logger = console,
    origin: checkOrigin = checkExtensionOrigin,
    session = requireExtSession,
    body: readBody = readJsonBody,
  } = deps;
  const { tag, validate } = spec;

  // 1. Origin。許可外には CORS ヘッダを付けない。
  const originResult = checkOrigin(request, env);
  if (!originResult.ok) {
    logger.warn('[' + tag + '] Origin 検証に失敗しました:', originResult.reason);
    return { response: extJson(403, { error: 'forbidden_origin' }, null) };
  }
  const allowedOrigin = originResult.origin;

  // 2. method
  if (request.method !== 'POST') {
    return { response: extJson(405, { error: 'method_not_allowed' }, allowedOrigin) };
  }

  // 3. body。中身はログに出さない。
  const parsed = await readBody(request);
  if (!parsed.ok) {
    logger.warn('[' + tag + '] body を受け付けられません:', parsed.code);
    return {
      response: extJson(bodyErrorStatus(parsed.code), { error: parsed.code }, allowedOrigin),
    };
  }

  const validated = validate(parsed.value);
  if (!validated.ok) {
    logger.warn('[' + tag + '] body の内容が不正です:', validated.code);
    return { response: extJson(400, { error: validated.code }, allowedOrigin) };
  }

  // 4. session。user_id はここでしか手に入らない。
  const result = await session(request, env, deps);

  switch (result?.status) {
    case SESSION_RESULT.VALID:
      break;

    case SESSION_RESULT.UNAUTHENTICATED:
      // Bearer が無い / 形式不正 / DB に無い / 期限切れ。すべて同じ応答にする。
      // 拡張側はこれを見て保存済みトークンを破棄し、再連携へ誘導する。
      return { response: extJson(401, { error: 'unauthenticated' }, allowedOrigin) };

    case SESSION_RESULT.DATA_ERROR:
      logger.error('[' + tag + '] セッションのデータ異常:', result.reason);
      return { response: extJson(500, { error: 'internal_error' }, allowedOrigin) };

    case SESSION_RESULT.MISCONFIGURED:
      logger.error('[' + tag + '] 設定エラー:', result.reason);
      return { response: extJson(500, { error: 'server_misconfigured' }, allowedOrigin) };

    case SESSION_RESULT.UNAVAILABLE:
      logger.error('[' + tag + '] Supabase エラー:', result.reason);
      return { response: extJson(502, { error: 'database_unavailable' }, allowedOrigin) };

    default:
      logger.error('[' + tag + '] 想定外のセッション結果です。');
      return { response: extJson(500, { error: 'internal_error' }, allowedOrigin) };
  }

  const context = result.context;
  if (!context
      || typeof context.user_id !== 'string' || context.user_id.length === 0
      || typeof context.plan_id !== 'string'
      || typeof context.status !== 'string') {
    logger.error('[' + tag + '] セッション context が想定と異なります。');
    return { response: extJson(500, { error: 'internal_error' }, allowedOrigin) };
  }

  return { context, value: validated.value, origin: allowedOrigin };
}

/**
 * Supabase 呼び出しの失敗を拡張向け HTTP レスポンスへ写す。
 * _lib/quota.js の mapRpcError と同じ分類だが、CORS ヘッダを付ける。
 *
 * @param {unknown} e
 * @param {string} tag
 * @param {object} logger
 * @param {string} origin
 * @returns {Response}
 */
export function mapExtRpcError(e, tag, logger, origin) {
  if (e && e.name === 'SupabaseError') {
    if (e.code === 'not_configured') {
      logger.error('[' + tag + '] Supabase 設定エラー:', e.message);
      return extJson(500, { error: 'server_misconfigured' }, origin);
    }
    logger.error('[' + tag + '] Supabase エラー(' + e.code + ')');
    return extJson(502, { error: 'database_unavailable' }, origin);
  }
  logger.error('[' + tag + '] 予期しない DB エラーです。');
  return extJson(500, { error: 'internal_error' }, origin);
}

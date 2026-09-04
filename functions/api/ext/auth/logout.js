// =========================================================
// POST /api/ext/auth/logout — 拡張のセッションを即時失効させる
//
//   Web の /api/auth/logout と同じ RPC（delete_session）を呼ぶ。
//   違いは「トークンを Cookie ではなく Authorization: Bearer で受け取る」点だけ。
//   DB 変更はない。
//
//   設計上の約束:
//     - 冪等。存在しないトークンでも 200 を返す（存在有無を漏らさない）。
//     - Bearer が無い / 形式不正でも 200 を返す。
//       クライアントは応答に関わらずローカルの保存を消せばよい。
//     - 生トークン・token_hash はログに出さない。
//     - Web のセッションには影響しない（拡張は別のセッション行を持つ）。
//
//   リクエスト:  POST（body 不要）
//               Authorization: Bearer <session token>
//   レスポンス:  200 { ok: true }
//               403 { error: 'forbidden_origin' }
//               405 { error: 'method_not_allowed' }
//               500 / 502
// =========================================================

import { SupabaseError, callRpc } from '../../_lib/supabase.js';
import { hashSessionToken } from '../../_lib/session.js';
import { checkExtensionOrigin, extJson, handlePreflight } from '../../_lib/ext-cors.js';
import { RPC_DELETE_SESSION, parseBearerToken } from '../../_lib/ext-session.js';

const TAG = 'ext-logout';

export async function handleExtLogout(request, env, deps = {}) {
  const {
    rpc = callRpc,
    logger = console,
    origin: checkOrigin = checkExtensionOrigin,
  } = deps;

  // 1. Origin。許可外には CORS ヘッダを付けない。
  const originResult = checkOrigin(request, env);
  if (!originResult.ok) {
    logger.warn('[' + TAG + '] Origin 検証に失敗しました:', originResult.reason);
    return extJson(403, { error: 'forbidden_origin' }, null);
  }
  const allowedOrigin = originResult.origin;

  // 2. method
  if (request.method !== 'POST') {
    return extJson(405, { error: 'method_not_allowed' }, allowedOrigin);
  }

  // 3. トークン。無い / 壊れている場合は DB を叩かずに成功扱いにする。
  const rawToken = parseBearerToken(request);
  if (rawToken === null) {
    return extJson(200, { ok: true }, allowedOrigin);
  }

  let tokenHash;
  try {
    tokenHash = await hashSessionToken(rawToken);
  } catch {
    // parseBearerToken を通っていれば起きないが、念のため。
    return extJson(200, { ok: true }, allowedOrigin);
  }

  // 4. 失効。delete_session は冪等（存在有無を返さない）。
  try {
    await rpc(RPC_DELETE_SESSION, { p_token_hash: tokenHash }, { env });
  } catch (e) {
    if (e instanceof SupabaseError) {
      if (e.code === 'not_configured') {
        logger.error('[' + TAG + '] Supabase 設定エラー:', e.message);
        return extJson(500, { error: 'server_misconfigured' }, allowedOrigin);
      }
      // 失効できたか不明。クライアントには失敗として返す。
      logger.error('[' + TAG + '] Supabase エラー(' + e.code + ')');
      return extJson(502, { error: 'database_unavailable' }, allowedOrigin);
    }
    logger.error('[' + TAG + '] 予期しない DB エラーです。');
    return extJson(500, { error: 'internal_error' }, allowedOrigin);
  }

  return extJson(200, { ok: true }, allowedOrigin);
}

/** Cloudflare Pages Functions: preflight */
export async function onRequestOptions(context) {
  return handlePreflight(context.request, context.env);
}

/** Cloudflare Pages Functions: POST のエントリポイント */
export async function onRequestPost(context) {
  return handleExtLogout(context.request, context.env);
}

/** POST / OPTIONS 以外のフォールバック。 */
export async function onRequest(context) {
  return handleExtLogout(context.request, context.env);
}

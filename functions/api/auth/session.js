// =========================================================
// POST /api/auth/session — ログイン確立
//
//   Cloudflare Pages Functions（ファイルパス = ルート）。
//   functions/api/auth/session.js → /api/auth/session
//
//   Google ID Token を検証し、検証済みの sub で users / subscriptions を upsert する。
//   BILLING_SPEC.md §12-1 / §14-6 / §15-3、HANDOFF §13 に基づく。
//
//   設計上の約束:
//     - クライアントから送られた google_sub は一切受け取らない。
//       users.google_sub には検証済み ID Token の sub のみを使う。
//     - 内部の user_id はクライアントへ返さない。
//       返してしまうと後続 API がそれを送り返す設計に誘導され、
//       クライアント指定の user_id を信用することになりかねないため。
//     - service_role キーはサーバー側のみ。レスポンスにもログにも出さない。
//     - Supabase への操作はこの Function からのみ行う。
//
//   必要な環境変数（Cloudflare Pages の環境変数。context.env から読む）:
//     GOOGLE_CLIENT_IDS          許可する Google OAuth クライアントID（カンマ区切り）
//     SUPABASE_URL
//     SUPABASE_SERVICE_ROLE_KEY  クライアントへは絶対に渡さない
//
//   リクエスト:  POST  Authorization: Bearer <Google ID Token>
//               ボディは読まない（google_sub をクライアントから受け取らないため）
//   レスポンス:  200 { plan_id, status }
//               400 { error: 'missing_token' }
//               401 { error: 'invalid_token' }
//               405 { error: 'method_not_allowed' }
//               500 { error: 'server_misconfigured' | 'internal_error' }
//               502 { error: 'database_unavailable' }
//               503 { error: 'verification_unavailable' }
// =========================================================

import {
  TokenVerificationError,
  extractBearerToken,
  getAllowedAudiences,
  verifyGoogleIdToken,
} from '../_lib/verifyGoogleIdToken.js';
import { SupabaseError, callRpc } from '../_lib/supabase.js';

/** 検証失敗の理由はクライアントへ返さない（総当たりのヒントを与えないため） */
const CLIENT_ERROR_CODES = new Set([
  'missing_token',
  'malformed_token',
  'unsupported_alg',
  'invalid_token',
  'invalid_issuer',
  'audience_mismatch',
  'token_expired',
  'token_not_yet_valid',
  'missing_subject',
]);

const RPC_NAME = 'upsert_user_and_subscription';

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * ログイン確立の本体。
 * テストから直接呼べるよう、request / env / 差し替え可能な依存を引数で受ける。
 */
export async function handleSession(request, env, deps = {}) {
  const {
    verifyToken = verifyGoogleIdToken,
    rpc = callRpc,
    logger = console,
  } = deps;

  if (request.method !== 'POST') {
    return json(405, { error: 'method_not_allowed' });
  }

  const idToken = extractBearerToken(request.headers.get('authorization'));
  if (!idToken) {
    return json(400, { error: 'missing_token' });
  }

  const audiences = getAllowedAudiences(env);
  if (audiences.length === 0) {
    logger.error('[auth-session] 環境変数 GOOGLE_CLIENT_IDS が未設定です。');
    return json(500, { error: 'server_misconfigured' });
  }

  // --- 1. ID Token を検証して sub を得る ---
  let identity;
  try {
    identity = await verifyToken(idToken, { audiences });
  } catch (e) {
    if (e instanceof TokenVerificationError) {
      if (e.code === 'server_misconfigured') {
        logger.error('[auth-session] 設定エラー:', e.message);
        return json(500, { error: 'server_misconfigured' });
      }
      if (e.code === 'verification_unavailable') {
        logger.error('[auth-session] 検証不能:', e.message);
        return json(503, { error: 'verification_unavailable' });
      }
      if (CLIENT_ERROR_CODES.has(e.code)) {
        logger.warn('[auth-session] 検証失敗:', e.code);
        return json(401, { error: 'invalid_token' });
      }
    }
    logger.error('[auth-session] 予期しない検証エラー:', e);
    return json(500, { error: 'internal_error' });
  }

  // --- 2. users / subscriptions を upsert（RPC 内で1トランザクション） ---
  let rows;
  try {
    rows = await rpc(
      RPC_NAME,
      { p_google_sub: identity.sub, p_email: identity.email },
      { env },
    );
  } catch (e) {
    if (e instanceof SupabaseError) {
      if (e.code === 'not_configured') {
        logger.error('[auth-session] Supabase 設定エラー:', e.message);
        return json(500, { error: 'server_misconfigured' });
      }
      // 到達不能もリクエスト失敗も、クライアントから見れば「今は使えない」
      logger.error('[auth-session] Supabase エラー(' + e.code + '):', e.message);
      return json(502, { error: 'database_unavailable' });
    }
    logger.error('[auth-session] 予期しない DB エラー:', e);
    return json(500, { error: 'internal_error' });
  }

  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row || typeof row.plan_id !== 'string' || typeof row.status !== 'string') {
    logger.error('[auth-session] RPC の戻り値が想定と異なります。');
    return json(502, { error: 'database_unavailable' });
  }

  // user_id / google_sub / service_role key は意図的に返さない（冒頭コメント参照）
  return json(200, { plan_id: row.plan_id, status: row.status });
}

/** Cloudflare Pages Functions: POST のエントリポイント */
export async function onRequestPost(context) {
  return handleSession(context.request, context.env);
}

/**
 * Cloudflare Pages Functions: POST 以外のフォールバック。
 * メソッド別ハンドラ（onRequestPost）が優先されるため、ここへ来るのは POST 以外。
 * 念のため handleSession 側でもメソッドを検査している。
 */
export async function onRequest(context) {
  return handleSession(context.request, context.env);
}

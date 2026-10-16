// =========================================================
// POST /api/auth/google-session — 1 回の Google 操作でのログイン確立
//
//   Cloudflare Pages Functions（ファイルパス = ルート）。
//   functions/api/auth/google-session.js → /api/auth/google-session
//
//   Web 版は Google OAuth Token Client の 1 回のポップアップで
//   openid / Calendar 閲覧の scope をまとめて得る（email は要求しない）。
//   ブラウザはその access token をここへ送り、サーバーが Google の tokeninfo で
//   検証してから、検証済みの sub で Sukima セッションを発行する。
//
//   設計上の約束（/api/auth/session と同じ）:
//     - クライアントから送られた google_sub は一切受け取らない。リクエストボディは読まない。
//     - access token は検証にのみ使う。
//       保存しない / Cookie へ入れない / レスポンスへ返さない / ログに出さない。
//     - Cookie は既存の __Host-sukima_session。発行処理は issueSukimaSession を共用する。
//     - Calendar の scope が足りなくても本人確認（openid + sub）が通ればセッションは発行し、
//       calendar_scopes_granted: false を返す。Calendar 連携の成功扱いにはしない。
//
//   必要な環境変数（既存と同じ。追加なし）:
//     GOOGLE_CLIENT_IDS / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
//
//   リクエスト:  POST  Authorization: Bearer <Google OAuth access token>
//   レスポンス:  200 { plan_id, status, calendar_scopes_granted } + Set-Cookie
//               400 { error: 'missing_token' }
//               401 { error: 'invalid_token' }
//               405 { error: 'method_not_allowed' }
//               500 { error: 'server_misconfigured' | 'internal_error' }
//               502 { error: 'database_unavailable' }
//               503 { error: 'verification_unavailable' }
// =========================================================

import { extractBearerToken, getAllowedAudiences } from '../_lib/verifyGoogleIdToken.js';
import { TokenVerificationError, verifyGoogleAccessToken } from '../_lib/verifyGoogleAccessToken.js';
import { issueSukimaSession } from './session.js';

/** 検証失敗として 401 に丸める理由コード（詳細はクライアントへ返さない）。 */
const CLIENT_ERROR_CODES = new Set([
  'missing_token',
  'malformed_token',
  'invalid_token',
  'audience_mismatch',
  'token_expired',
  'missing_subject',
  'insufficient_scope',
]);

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
 * ログイン確立の本体。テストから依存を差し替えられるよう deps を受ける。
 */
export async function handleGoogleSession(request, env, deps = {}) {
  const {
    verifyToken = verifyGoogleAccessToken,
    logger = console,
  } = deps;

  if (request.method !== 'POST') {
    return json(405, { error: 'method_not_allowed' });
  }

  const accessToken = extractBearerToken(request.headers.get('authorization'));
  if (!accessToken) {
    return json(400, { error: 'missing_token' });
  }

  const audiences = getAllowedAudiences(env);
  if (audiences.length === 0) {
    logger.error('[auth-google-session] 環境変数 GOOGLE_CLIENT_IDS が未設定です。');
    return json(500, { error: 'server_misconfigured' });
  }

  // --- 1. access token を Google に対して検証し、sub を得る ---
  let identity;
  try {
    identity = await verifyToken(accessToken, { audiences });
  } catch (e) {
    if (e instanceof TokenVerificationError) {
      if (e.code === 'server_misconfigured') {
        logger.error('[auth-google-session] 設定エラー:', e.message);
        return json(500, { error: 'server_misconfigured' });
      }
      if (e.code === 'verification_unavailable') {
        logger.error('[auth-google-session] 検証不能:', e.message);
        return json(503, { error: 'verification_unavailable' });
      }
      if (CLIENT_ERROR_CODES.has(e.code)) {
        // 理由コードのみ。トークン本体は出さない。
        logger.warn('[auth-google-session] 検証失敗:', e.code);
        return json(401, { error: 'invalid_token' });
      }
    }
    logger.error('[auth-google-session] 予期しない検証エラー:', e);
    return json(500, { error: 'internal_error' });
  }

  // --- 2. 既存と同じ処理でセッションを発行する ---
  return issueSukimaSession(
    { sub: identity.sub, email: identity.email },
    env,
    deps,
    { calendar_scopes_granted: identity.calendarGranted === true },
  );
}

/** Cloudflare Pages Functions: POST のエントリポイント */
export async function onRequestPost(context) {
  return handleGoogleSession(context.request, context.env);
}

/** POST 以外のフォールバック（handleGoogleSession 側で 405 を返す）。 */
export async function onRequest(context) {
  return handleGoogleSession(context.request, context.env);
}

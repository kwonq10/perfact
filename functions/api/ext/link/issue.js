// =========================================================
// POST /api/ext/link/issue — 拡張用セッションを発行する
//
//   **この API は sukimacalendar.com のページからのみ呼ばれる。**
//   /api/ext/link/start が返す確認ページの「連携する」ボタンが送信元。
//   したがって Origin は https://sukimacalendar.com であり、
//   **既存の checkOrigin（_lib/origin.js・無変更）がそのまま通る。**
//   Web の allowlist を 1 文字も広げずに CSRF 対策が成立する。
//
//   CORS ヘッダは付けない（拡張から直接呼ぶ API ではないため）。
//
//   設計上の約束:
//     - 本人確認は Web のセッション Cookie のみ。クライアントの申告は使わない。
//     - 発行するのは Web とは別のセッション行。Web の Cookie は変更しない。
//     - google_sub はサーバー内部だけで扱い、レスポンスにもログにも出さない。
//     - user_id はレスポンスに含めない。
//
//   リクエスト:  POST application/json
//               Cookie: __Host-sukima_session=…
//               { "extension_id": "<32文字の拡張機能ID>" }
//
//   レスポンス:  200 { session_token, expires_at, plan_id, status }
//               400 { error: 'invalid_content_type' | 'malformed_json'
//                            | 'invalid_body' | 'unreadable_body'
//                            | 'invalid_extension_id' }
//               401 { error: 'unauthenticated' }
//               403 { error: 'forbidden_origin' }
//               405 { error: 'method_not_allowed' }
//               413 { error: 'body_too_large' }
//               500 { error: 'server_misconfigured' | 'internal_error' | 'user_not_found' }
//               502 { error: 'database_unavailable' }
// =========================================================

import { checkOrigin } from '../../_lib/origin.js';
import { readJsonBody } from '../../_lib/request-body.js';
import { SESSION_RESULT, buildClearSessionCookie, requireSession } from '../../_lib/session.js';
import { isAllowedExtensionId } from '../../_lib/ext-cors.js';
import { issueExtensionSession } from '../../_lib/ext-session.js';

const TAG = 'ext-link-issue';

/** issue 専用の JSON レスポンス。Cookie 認証なので Vary: Cookie を付ける。 */
function json(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      Vary: 'Cookie',
      ...extraHeaders,
    },
  });
}

/** body 検証コード -> HTTP ステータス。サイズ超過だけ 413 にする。 */
function bodyErrorStatus(code) {
  return code === 'body_too_large' ? 413 : 400;
}

/** 発行結果のエラーコード -> HTTP ステータス。 */
function issueErrorStatus(code) {
  return code === 'database_unavailable' ? 502 : 500;
}

export async function handleLinkIssue(request, env, deps = {}) {
  const {
    logger = console,
    origin = checkOrigin,
    session = requireSession,
    body: readBody = readJsonBody,
    issue = issueExtensionSession,
  } = deps;

  // 1. method
  if (request.method !== 'POST') {
    return json(405, { error: 'method_not_allowed' });
  }

  // 2. Origin（既存の Web allowlist をそのまま使う）
  const originResult = origin(request, env);
  if (!originResult.ok) {
    logger.warn('[' + TAG + '] Origin 検証に失敗しました:', originResult.reason);
    return json(403, { error: 'forbidden_origin' });
  }

  // 3. body
  const parsed = await readBody(request);
  if (!parsed.ok) {
    logger.warn('[' + TAG + '] body を受け付けられません:', parsed.code);
    return json(bodyErrorStatus(parsed.code), { error: parsed.code });
  }

  // 許可された拡張以外へはセッションを発行しない（多層防御）。
  if (!isAllowedExtensionId(parsed.value.extension_id, env)) {
    logger.warn('[' + TAG + '] 許可されていない拡張機能 ID です。');
    return json(400, { error: 'invalid_extension_id' });
  }

  // 4. session（Cookie）。user_id はここでしか手に入らない。
  const result = await session(request, env, deps);

  switch (result?.status) {
    case SESSION_RESULT.VALID:
      break;

    case SESSION_RESULT.UNAUTHENTICATED:
      return json(
        401,
        { error: 'unauthenticated' },
        { 'Set-Cookie': buildClearSessionCookie() },
      );

    case SESSION_RESULT.DATA_ERROR:
      logger.error('[' + TAG + '] セッションのデータ異常:', result.reason);
      return json(500, { error: 'internal_error' });

    case SESSION_RESULT.MISCONFIGURED:
      logger.error('[' + TAG + '] 設定エラー:', result.reason);
      return json(500, { error: 'server_misconfigured' });

    case SESSION_RESULT.UNAVAILABLE:
      logger.error('[' + TAG + '] Supabase エラー:', result.reason);
      return json(502, { error: 'database_unavailable' });

    default:
      logger.error('[' + TAG + '] 想定外のセッション結果です。');
      return json(500, { error: 'internal_error' });
  }

  const context = result.context;
  if (!context || typeof context.user_id !== 'string' || context.user_id.length === 0) {
    logger.error('[' + TAG + '] セッション context が想定と異なります。');
    return json(500, { error: 'internal_error' });
  }

  // 5. 拡張用セッションを発行する
  const issued = await issue(env, context.user_id, deps);
  if (!issued.ok) {
    return json(issueErrorStatus(issued.code), { error: issued.code });
  }

  // session_token は生トークン。ログに出さないこと。
  return json(200, {
    session_token: issued.token,
    expires_at: issued.row.idle_expires_at,
    plan_id: issued.row.plan_id,
    status: issued.row.status,
  });
}

/** Cloudflare Pages Functions: POST のエントリポイント */
export async function onRequestPost(context) {
  return handleLinkIssue(context.request, context.env);
}

/** POST 以外のフォールバック。405 は handleLinkIssue が返す。 */
export async function onRequest(context) {
  return handleLinkIssue(context.request, context.env);
}

// =========================================================
// POST /api/auth/logout — サーバー側でセッションを即時失効させる
//
//   Cloudflare Pages Functions（ファイルパス = ルート）。
//   functions/api/auth/logout.js → /api/auth/logout
//
//   設計上の約束:
//     - 削除するのは「ブラウザが今持っているこの1セッション」だけ。
//       同じユーザーの他端末セッションには触れない（logout-all は別機能）。
//     - users / subscriptions / weekly_usage には一切触れない。
//     - Cookie の解析とハッシュ化は _lib/session.js に一任する。
//       ここで再実装しない。
//     - DB へ送るのは token_hash のみ。生トークンは送らない。
//     - raw token / token hash / user_id / google_sub / email /
//       service_role key はレスポンスにもログにも出さない。
//     - 冪等。Cookie が無くても、DB に行が無くても 204 を返す。
//
//   Cookie 削除の条件（ここが要点）:
//     - 204（成功・Cookie なし・形式不正）→ 削除する
//     - 5xx（DB 障害・設定不備）        → 削除しない
//       Cookie だけ消すとサーバー側の session 行が残り、
//       ブラウザから再試行できなくなるため。
//
//   CSRF: 現状は SameSite=Lax + HttpOnly Cookie + POST 限定に依存する。
//   Origin 検証は cookie 認証を使う変更系 API 全体で後工程として統一実装する。
//
//   必要な環境変数（context.env から読む）:
//     SUPABASE_URL
//     SUPABASE_SERVICE_ROLE_KEY  クライアントへは絶対に渡さない
//
//   リクエスト:  POST  Cookie: __Host-sukima_session=<opaque token>
//   レスポンス:  204 （body なし）+ Set-Cookie（削除）
//               405 { error: 'method_not_allowed' }
//               500 { error: 'server_misconfigured' | 'internal_error' }
//               502 { error: 'database_unavailable' }
// =========================================================

import { SupabaseError, callRpc } from '../_lib/supabase.js';
import {
  buildClearSessionCookie,
  hashSessionToken,
  parseSessionCookie,
} from '../_lib/session.js';

/** migration 20260901041257 で作成した RPC。冪等な単一セッション削除。 */
const RPC_NAME = 'delete_session';

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

/** ログアウト成功。body は空、Cookie を削除する。 */
function noContent() {
  return new Response(null, {
    status: 204,
    headers: {
      'Cache-Control': 'no-store',
      'Set-Cookie': buildClearSessionCookie(),
    },
  });
}

/**
 * ログアウトの本体。
 * テストから直接呼べるよう、request / env / 差し替え可能な依存を引数で受ける。
 */
export async function handleLogout(request, env, deps = {}) {
  const { rpc = callRpc, logger = console } = deps;

  if (request.method !== 'POST') {
    return json(405, { error: 'method_not_allowed' });
  }

  // Cookie が無い / 形式不正なら、DB を叩かずに「すでにログアウト済み」と同じ扱い。
  // ブラウザ側の残骸だけ確実に消す。
  const rawToken = parseSessionCookie(request);
  if (rawToken === null) {
    return noContent();
  }

  let tokenHash;
  try {
    tokenHash = await hashSessionToken(rawToken);
  } catch {
    // parseSessionCookie を通っていれば起きないが、念のため。
    // DB を叩けないだけなので、Cookie は消して 204 にする。
    return noContent();
  }

  try {
    // 冪等。DB に該当行が無くてもエラーにならない。
    await rpc(RPC_NAME, { p_token_hash: tokenHash }, { env });
  } catch (e) {
    // 失効できたか確認できないので Cookie は削除しない（再試行できるようにする）。
    if (e instanceof SupabaseError) {
      if (e.code === 'not_configured') {
        logger.error('[auth-logout] Supabase 設定エラー:', e.message);
        return json(500, { error: 'server_misconfigured' });
      }
      // 到達不能もリクエスト失敗も、クライアントから見れば「今は使えない」
      logger.error('[auth-logout] Supabase エラー(' + e.code + ')');
      return json(502, { error: 'database_unavailable' });
    }
    logger.error('[auth-logout] 予期しない DB エラー:', e);
    return json(500, { error: 'internal_error' });
  }

  return noContent();
}

/** Cloudflare Pages Functions: POST のエントリポイント */
export async function onRequestPost(context) {
  return handleLogout(context.request, context.env);
}

/**
 * Cloudflare Pages Functions: POST 以外のフォールバック。
 * メソッド別ハンドラ（onRequestPost）が優先されるため、ここへ来るのは POST 以外。
 * 念のため handleLogout 側でもメソッドを検査している。
 */
export async function onRequest(context) {
  return handleLogout(context.request, context.env);
}

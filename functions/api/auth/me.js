// =========================================================
// GET /api/auth/me — 現在のログイン状態と subscription を返す
//
//   Cloudflare Pages Functions（ファイルパス = ルート）。
//   functions/api/auth/me.js → /api/auth/me
//
//   ブラウザが持つ __Host-sukima_session Cookie だけで判定する。
//   Google ID Token も Calendar access token も受け取らない。
//
//   設計上の約束:
//     - セッション検証は _lib/session.js に一任する。
//       Cookie の解析も検証ロジックもここには書かない。
//     - 返すのは authenticated / plan_id / status の3つだけ。
//       user_id / google_sub / email / token / token_hash / 有効期限は返さない。
//     - plan_id / status は毎回 DB の subscriptions から読まれる
//       （get_session_context が JOIN する）ため、Stripe webhook による
//       プラン変更が次のリクエストで即反映される。
//     - 有効期限の authority は DB。ここで 30日 / 90日を再計算しない。
//       RPC が返した idle_expires_at をそのまま Cookie の実効期限に使う。
//     - sliding 更新では新しい session token を発行しない。
//       Cookie の値は据え置き、Max-Age だけを延ばす。
//     - DB 異常・Supabase 障害を 401 に丸めない（フェイルクローズ）。
//
//   必要な環境変数（context.env から読む）:
//     SUPABASE_URL
//     SUPABASE_SERVICE_ROLE_KEY  クライアントへは絶対に渡さない
//
//   リクエスト:  GET  Cookie: __Host-sukima_session=<opaque token>
//   レスポンス:  200 { authenticated: true, plan_id, status } + Set-Cookie（延長）
//               401 { authenticated: false }                  + Set-Cookie（削除）
//               405 { error: 'method_not_allowed' }
//               500 { error: 'server_misconfigured' | 'internal_error' }
//               502 { error: 'database_unavailable' }
// =========================================================

import {
  SESSION_RESULT,
  buildClearSessionCookie,
  buildSessionCookie,
  parseSessionCookie,
  requireSession,
} from '../_lib/session.js';

function json(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      // Cookie の有無で内容が変わるため、共有キャッシュに混ぜさせない
      Vary: 'Cookie',
      ...extraHeaders,
    },
  });
}

/** 未認証。Cookie を削除して 401 を返す（Cookie が無くても削除指示を返す）。 */
function unauthenticated() {
  return json(401, { authenticated: false }, { 'Set-Cookie': buildClearSessionCookie() });
}

/**
 * ログイン状態の照会本体。
 * テストから直接呼べるよう、request / env / 差し替え可能な依存を引数で受ける。
 */
export async function handleMe(request, env, deps = {}) {
  const { session = requireSession, logger = console, now } = deps;

  if (request.method !== 'GET') {
    return json(405, { error: 'method_not_allowed' });
  }

  const result = await session(request, env, deps);

  switch (result?.status) {
    case SESSION_RESULT.VALID:
      break;

    case SESSION_RESULT.UNAUTHENTICATED:
      // Cookie なし / 形式不正 / DB に無い / 期限切れ。すべて同じ応答にする。
      return unauthenticated();

    case SESSION_RESULT.DATA_ERROR:
      // セッションは引けたが subscriptions が欠落等。401 に丸めない。
      // 「未認証だから」という理由で Cookie を削除しない。
      logger.error('[auth-me] セッションのデータ異常:', result.reason);
      return json(500, { error: 'internal_error' });

    case SESSION_RESULT.MISCONFIGURED:
      logger.error('[auth-me] 設定エラー:', result.reason);
      return json(500, { error: 'server_misconfigured' });

    case SESSION_RESULT.UNAVAILABLE:
      // Supabase へ到達できない / エラー応答。セッションの有効性は不明なので
      // Cookie は触らず、クライアントには「今は使えない」とだけ伝える。
      logger.error('[auth-me] Supabase エラー:', result.reason);
      return json(502, { error: 'database_unavailable' });

    default:
      logger.error('[auth-me] 想定外のセッション結果です。');
      return json(500, { error: 'internal_error' });
  }

  const context = result.context;
  if (!context || typeof context.plan_id !== 'string' || typeof context.status !== 'string') {
    logger.error('[auth-me] セッション context が想定と異なります。');
    return json(500, { error: 'internal_error' });
  }

  // --- sliding 更新 ---
  //   requireSession は raw token を返さないため、同じ request から
  //   既存 helper で取り出す（Cookie 解析をここで再実装しない）。
  //   新しい token は発行せず、値は据え置きのまま Max-Age だけ延ばす。
  const rawToken = parseSessionCookie(request);
  if (rawToken === null) {
    // VALID なら Cookie は必ず存在する。ここへ来るのは想定外。
    logger.error('[auth-me] 有効セッションなのに Cookie を取り出せませんでした。');
    return json(500, { error: 'internal_error' });
  }

  let cookie;
  try {
    cookie = buildSessionCookie(rawToken, context.idle_expires_at, now ? { now } : {});
  } catch {
    // idle_expires_at が日時として不正。DB 異常なので 401 に丸めない。
    logger.error('[auth-me] Cookie を組み立てられませんでした。');
    return json(500, { error: 'internal_error' });
  }

  // user_id / google_sub / email / token / token_hash / 有効期限は返さない
  return json(
    200,
    { authenticated: true, plan_id: context.plan_id, status: context.status },
    { 'Set-Cookie': cookie },
  );
}

/** Cloudflare Pages Functions: GET のエントリポイント */
export async function onRequestGet(context) {
  return handleMe(context.request, context.env);
}

/**
 * Cloudflare Pages Functions: GET 以外のフォールバック。
 * メソッド別ハンドラ（onRequestGet）が優先されるため、ここへ来るのは GET 以外。
 * 念のため handleMe 側でもメソッドを検査している。
 */
export async function onRequest(context) {
  return handleMe(context.request, context.env);
}

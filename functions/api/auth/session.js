// =========================================================
// POST /api/auth/session — ログイン確立（Sukima サーバーセッション発行）
//
//   Cloudflare Pages Functions（ファイルパス = ルート）。
//   functions/api/auth/session.js → /api/auth/session
//
//   Google ID Token を検証し、検証済みの sub で users / subscriptions を用意し、
//   Sukima 独自のサーバーセッションを発行して HttpOnly Cookie で返す。
//
//   設計上の約束:
//     - クライアントから送られた google_sub は一切受け取らない。
//       users.google_sub には検証済み ID Token の sub のみを使う。
//       リクエストボディは読まない。
//     - Google ID Token は本人確認にのみ使う。
//       保存しない / Cookie へ入れない / レスポンスへ返さない / ログに出さない。
//     - Google Calendar の access token はこの API では一切扱わない。
//     - Cookie に載るのは不透明なランダムトークンのみ。
//       DB へ送るのはその SHA-256 ハッシュだけで、生トークンは送らない。
//     - user_id / google_sub / email / token / token_hash / 有効期限は
//       レスポンスに含めない。
//     - 有効期限の authority は DB。ここで 30日 / 90日を再計算しない。
//       RPC が返す idle_expires_at をそのまま Cookie の実効期限に使う。
//     - service_role キーはサーバー側のみ。レスポンスにもログにも出さない。
//
//   必要な環境変数（Cloudflare Pages の環境変数。context.env から読む）:
//     GOOGLE_CLIENT_IDS          許可する Google OAuth クライアントID（カンマ区切り）
//     SUPABASE_URL
//     SUPABASE_SERVICE_ROLE_KEY  クライアントへは絶対に渡さない
//
//   リクエスト:  POST  Authorization: Bearer <Google ID Token>
//   レスポンス:  200 { plan_id, status } + Set-Cookie: __Host-sukima_session=…
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
import {
  buildSessionCookie,
  generateSessionToken,
  hashSessionToken,
} from '../_lib/session.js';

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

/**
 * ログイン時に使う RPC。
 * users upsert / free subscription 作成 / session 発行を1トランザクションで行う。
 * 旧 upsert_user_and_subscription はこの経路では使わない。
 */
const RPC_NAME = 'upsert_user_and_create_session';

/**
 * session token の衝突時に張り直す最大試行回数。
 * 256bit 乱数の SHA-256 が衝突することは実質ないため、通常 1 回で終わる。
 */
export const MAX_SESSION_TOKEN_ATTEMPTS = 3;

function json(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

/**
 * sessions.token_hash（PRIMARY KEY）の一意制約違反かどうかを判定する。
 *
 * PostgREST は一意制約違反を 409 で返し、本文に Postgres のエラーコードを載せる。
 * supabase.js は 4xx を code='request_failed' とし、本文の先頭300文字を message に含める。
 * そのため message 中の "code":"23505" で識別できる。
 *
 * 誤検知を避けるため、次をすべて満たす場合のみ true とする:
 *   - SupabaseError であること
 *   - code が 'request_failed'（= 4xx。409 はここに入る）
 *   - 本文に JSON のキーとして "code":"23505" が現れる
 *   - 違反した制約が sessions のトークンに関するものである
 *
 * 判定できなければ false を返し、通常のエラー経路（502）へ倒す（フェイルクローズ）。
 *
 * 注意: この message には PostgREST の details が含まれ、
 *       衝突した token_hash が載り得る。この分岐で message をログに出さないこと。
 */
export function isTokenHashCollision(e) {
  if (!(e instanceof SupabaseError)) return false;
  if (e.code !== 'request_failed') return false;

  const msg = String(e.message ?? '');
  if (!/"code"\s*:\s*"23505"/.test(msg)) return false;

  return /sessions_pkey/.test(msg) || /token_hash/.test(msg);
}

/**
 * ログイン確立の本体。
 * テストから直接呼べるよう、request / env / 差し替え可能な依存を引数で受ける。
 */
export async function handleSession(request, env, deps = {}) {
  const {
    verifyToken = verifyGoogleIdToken,
    rpc = callRpc,
    generateToken = generateSessionToken,
    logger = console,
    now,
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

  // --- 1. ID Token を検証して sub を得る（ID Token はここでしか使わない） ---
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
        // 理由コードのみ。トークン本体は出さない。
        logger.warn('[auth-session] 検証失敗:', e.code);
        return json(401, { error: 'invalid_token' });
      }
    }
    logger.error('[auth-session] 予期しない検証エラー:', e);
    return json(500, { error: 'internal_error' });
  }

  // --- 2. セッションを発行する（衝突時のみ限定的に張り直す） ---
  let rawToken = null;
  let rows = null;

  for (let attempt = 1; attempt <= MAX_SESSION_TOKEN_ATTEMPTS; attempt += 1) {
    rawToken = generateToken();

    let tokenHash;
    try {
      tokenHash = await hashSessionToken(rawToken);
    } catch (e) {
      logger.error('[auth-session] session token の生成に失敗しました。');
      return json(500, { error: 'internal_error' });
    }

    try {
      rows = await rpc(
        RPC_NAME,
        {
          p_google_sub: identity.sub,
          p_token_hash: tokenHash,
          p_email: identity.email ?? null,
        },
        { env },
      );
      break;   // 成功
    } catch (e) {
      // token_hash の一意制約違反だけ、新しいトークンで張り直す。
      // message には衝突した hash が含まれ得るのでログに出さない。
      if (isTokenHashCollision(e)) {
        logger.warn('[auth-session] session token が衝突しました。再生成します。');
        if (attempt < MAX_SESSION_TOKEN_ATTEMPTS) continue;
        logger.error('[auth-session] session token の衝突が続いたため中止しました。');
        return json(500, { error: 'internal_error' });
      }

      if (e instanceof SupabaseError) {
        if (e.code === 'not_configured') {
          logger.error('[auth-session] Supabase 設定エラー:', e.message);
          return json(500, { error: 'server_misconfigured' });
        }
        // 到達不能もリクエスト失敗も、クライアントから見れば「今は使えない」
        logger.error('[auth-session] Supabase エラー(' + e.code + ')');
        return json(502, { error: 'database_unavailable' });
      }

      logger.error('[auth-session] 予期しない DB エラー:', e);
      return json(500, { error: 'internal_error' });
    }
  }

  // --- 3. RPC の戻り値を検証（異常は fail closed で 5xx。詳細は返さない） ---
  if (!Array.isArray(rows) || rows.length !== 1) {
    logger.error('[auth-session] RPC の戻り行数が想定と異なります。');
    return json(500, { error: 'internal_error' });
  }

  const row = rows[0];
  if (row === null || typeof row !== 'object'
      || typeof row.plan_id !== 'string'
      || typeof row.status !== 'string'
      || row.idle_expires_at === null || row.idle_expires_at === undefined
      || row.absolute_expires_at === null || row.absolute_expires_at === undefined) {
    logger.error('[auth-session] RPC の戻り値が想定と異なります。');
    return json(500, { error: 'internal_error' });
  }

  // --- 4. Cookie を組み立てる（有効期限は DB が返した idle_expires_at） ---
  let cookie;
  try {
    cookie = buildSessionCookie(rawToken, row.idle_expires_at, now ? { now } : {});
  } catch (e) {
    logger.error('[auth-session] Cookie を組み立てられませんでした。');
    return json(500, { error: 'internal_error' });
  }

  // user_id / google_sub / email / token / token_hash / 有効期限は返さない
  return json(200, { plan_id: row.plan_id, status: row.status }, { 'Set-Cookie': cookie });
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

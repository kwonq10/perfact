// =========================================================
// quota API 共通ヘルパー（Cloudflare Pages Functions 専用）
//
//   /api/quota/{reserve,commit,release} の 3 本が共有する前処理と
//   レスポンス組み立てをここに集約する。
//   migration 20260903015535 の RPC 契約と対になる。
//
//   設計上の約束:
//     - user_id は body から一切受け取らない。
//       requireSession() が返す server-side の session context のみを使う。
//     - RPC が返した code / state を再解釈しない。そのまま透過させる。
//       「allowed=false は 429」のような読み替えをしない。
//     - HTTP ステータスの使い分け:
//         4xx / 5xx = リクエストが RPC まで到達できなかった、
//                     またはサーバー側の異常
//         200       = RPC が答えた（成否は body の allowed / ok と code）
//       quota 超過は「RPC が正しく答えた結果」なので 200 + allowed=false。
//     - user_id / google_sub / email / token / token_hash /
//       service_role key はレスポンスにもログにも出さない。
//     - Cookie の有無で内容が変わるため必ず Vary: Cookie と no-store を付ける。
// =========================================================

import { SupabaseError } from './supabase.js';
import { checkOrigin } from './origin.js';
import {
  SESSION_RESULT,
  buildClearSessionCookie,
  requireSession,
} from './session.js';
import { readJsonBody } from './request-body.js';

/**
 * Free の週あたり上限。migration 側の p_limit 既定値と同じ 3。
 * plan から上限を決めるのは API の責務なので、ここが唯一の定義箇所。
 */
export const FREE_WEEKLY_LIMIT = 3;

/**
 * Web で quota 無制限になる plan_id。
 * extension_pro は拡張機能専用の権利なので Web では quota 対象。
 */
export const WEB_UNLIMITED_PLAN_IDS = Object.freeze(['web_pro', 'all_pro']);

/**
 * Web で quota 無制限になる subscription status。
 * past_due は Pro 扱いしない（支払いが滞っている間は Free と同じ扱い）。
 * canceled / unpaid / incomplete / incomplete_expired も quota 対象。
 */
export const WEB_UNLIMITED_STATUSES = Object.freeze(['active', 'trialing']);

/**
 * Web の quota が免除されるか。
 *
 * plan_id と status の両方を満たしたときだけ true。
 * 片方でも欠ければ quota 対象（フェイルクローズ）。
 *
 * @param {object} context requireSession が返す session context
 * @returns {boolean}
 */
export function hasWebUnlimited(context) {
  if (!context || typeof context !== 'object') return false;
  return WEB_UNLIMITED_PLAN_IDS.includes(context.plan_id)
      && WEB_UNLIMITED_STATUSES.includes(context.status);
}

/**
 * quota API 共通の JSON レスポンス。
 * no-store と Vary: Cookie は例外なく付ける。
 */
export function json(status, body, extraHeaders = {}) {
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

/**
 * TABLE を返す RPC の戻り値から 1 行だけ取り出す。
 *
 * 3 RPC はいずれも「常に 1 行」を返す契約。0 行や複数行は DB 異常なので
 * null を返し、呼び出し側は 500 にする（未認証や quota 超過に丸めない）。
 *
 * @param {unknown} rows
 * @returns {object|null}
 */
export function readSingleRow(rows) {
  if (!Array.isArray(rows) || rows.length !== 1) return null;
  const row = rows[0];
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return null;
  return row;
}

/**
 * Supabase 呼び出しの失敗を HTTP レスポンスへ写す。
 * logout / me と同じ分類にそろえる。エラー本文はクライアントへ返さない。
 *
 * @param {unknown} e
 * @param {string} tag  ログ用のエンドポイント名
 * @param {object} logger
 * @returns {Response}
 */
export function mapRpcError(e, tag, logger) {
  if (e instanceof SupabaseError) {
    if (e.code === 'not_configured') {
      // メッセージに秘密値は含まれない（supabase.js が設定不足のみを報告する）
      logger.error('[' + tag + '] Supabase 設定エラー:', e.message);
      return json(500, { error: 'server_misconfigured' });
    }
    // 到達不能もリクエスト失敗も、クライアントから見れば「今は使えない」
    logger.error('[' + tag + '] Supabase エラー(' + e.code + ')');
    return json(502, { error: 'database_unavailable' });
  }
  logger.error('[' + tag + '] 予期しない DB エラー:', e);
  return json(500, { error: 'internal_error' });
}

/**
 * quota API 3 本の共通前処理。
 *
 * 処理順（この順序を変えないこと）:
 *   1. method 確認          -> 405
 *   2. Origin 検証          -> 403（ここで弾いたら body も Cookie も読まない）
 *   3. JSON body 検証       -> 400 / 413（ここで弾いたら RPC を呼ばない）
 *   4. requireSession()     -> 401 / 500 / 502
 *   5. entitlement 判定は呼び出し側で行う（context を返す）
 *
 * Origin を最初に見るのは、cross-site から送られたリクエストで
 * セッションや DB に触れさせないため。
 *
 * @param {Request} request
 * @param {object} env
 * @param {object} deps         { session, origin, logger, body, ... }
 * @param {object} spec
 * @param {string} spec.tag         ログ用のエンドポイント名
 * @param {Function} spec.validate  (body) => { ok:true, value } | { ok:false, code }
 * @returns {Promise<{response:Response}|{context:object,value:any}>}
 */
export async function preflight(request, env, deps, spec) {
  const {
    logger = console,
    origin = checkOrigin,
    session = requireSession,
    body: readBody = readJsonBody,
  } = deps;
  const { tag, validate } = spec;

  // 1. method
  if (request.method !== 'POST') {
    return { response: json(405, { error: 'method_not_allowed' }) };
  }

  // 2. Origin（CSRF 対策）。失敗したら session にも RPC にも進まない。
  //    missing / null / allowlist 外はレスポンスで区別しない。
  const originResult = origin(request, env);
  if (!originResult.ok) {
    // 理由コードだけを記録する。Origin の実値・Cookie・トークンは出さない。
    logger.warn('[' + tag + '] Origin 検証に失敗しました:', originResult.reason);
    return { response: json(403, { error: 'forbidden_origin' }) };
  }

  // 3. body。中身はログに出さない。
  const parsed = await readBody(request);
  if (!parsed.ok) {
    logger.warn('[' + tag + '] body を受け付けられません:', parsed.code);
    return { response: json(bodyErrorStatus(parsed.code), { error: parsed.code }) };
  }

  const validated = validate(parsed.value);
  if (!validated.ok) {
    logger.warn('[' + tag + '] body の内容が不正です:', validated.code);
    return { response: json(400, { error: validated.code }) };
  }

  // 4. session。user_id はここでしか手に入らない。
  const result = await session(request, env, deps);

  switch (result?.status) {
    case SESSION_RESULT.VALID:
      break;

    case SESSION_RESULT.UNAUTHENTICATED:
      // Cookie なし / 形式不正 / DB に無い / 期限切れ。すべて同じ応答にする。
      // Origin は検証済みなので、cross-site から強制ログアウトさせられることはない。
      return {
        response: json(
          401,
          { error: 'unauthenticated' },
          { 'Set-Cookie': buildClearSessionCookie() },
        ),
      };

    case SESSION_RESULT.DATA_ERROR:
      // セッションは引けたが subscriptions が欠落等。401 に丸めない。
      logger.error('[' + tag + '] セッションのデータ異常:', result.reason);
      return { response: json(500, { error: 'internal_error' }) };

    case SESSION_RESULT.MISCONFIGURED:
      logger.error('[' + tag + '] 設定エラー:', result.reason);
      return { response: json(500, { error: 'server_misconfigured' }) };

    case SESSION_RESULT.UNAVAILABLE:
      // セッションの有効性は不明。Cookie は触らない。
      logger.error('[' + tag + '] Supabase エラー:', result.reason);
      return { response: json(502, { error: 'database_unavailable' }) };

    default:
      logger.error('[' + tag + '] 想定外のセッション結果です。');
      return { response: json(500, { error: 'internal_error' }) };
  }

  const context = result.context;
  if (!context
      || typeof context.user_id !== 'string' || context.user_id.length === 0
      || typeof context.plan_id !== 'string'
      || typeof context.status !== 'string') {
    logger.error('[' + tag + '] セッション context が想定と異なります。');
    return { response: json(500, { error: 'internal_error' }) };
  }

  return { context, value: validated.value };
}

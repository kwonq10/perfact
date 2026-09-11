// =========================================================
// GET /api/quota/status — 今週の残り回数を「消費せずに」返す
//
//   Cloudflare Pages Functions（ファイルパス = ルート）。
//   functions/api/quota/status.js → /api/quota/status
//
//   migration 20260906061545 の get_quota_status(UUID, INT) と対になる。
//
//   設計上の約束:
//     - **quota を絶対に消費しない。** 呼ぶ RPC は get_quota_status だけで、
//       reserve / commit / release は呼ばない。
//       何度読み込んでも quota_reservations は増えない。
//     - **上限はサーバーが持つ。** p_limit にはこの Function が
//       FREE_WEEKLY_LIMIT を渡す。クエリ文字列の limit は読まない。
//       ?limit=999 を付けても無視される。
//     - user_id は body にもクエリにも取らない。session context だけを使う。
//     - **週の計算を JS 側へ複製しない。** week_start / next_reset_at は
//       DB が唯一の正で、ここでは受け取った値をそのまま返す。
//       DST も 7 日ガードも DB 側で解決済み。
//     - Pro（web_pro / all_pro）は Web が無制限なので RPC を呼ばず
//       unlimited を返す。Free と extension_pro は quota 対象。
//       判定は _lib/quota.js の hasWebUnlimited をそのまま使う
//       （past_due の 7 日猶予も entitlement.js に従う）。
//     - Cookie の有無で内容が変わるため no-store と Vary: Cookie を必ず付ける
//       （_lib/quota.js の json が付与する）。
//
//   Origin 検証について:
//     状態を変えない GET なので checkOrigin は**使わない**。
//     _lib/origin.js:24 の方針（GET には適用しない）と /api/auth/me に合わせる。
//     ブラウザは GET に Origin を付けないことがあり、また読み取りしかしないため
//     CSRF で不利益が生じない。
//
//   リクエスト:  GET  Cookie: __Host-sukima_session=<opaque token>
//
//   レスポンス（200・quota 対象）:
//     { unlimited: false, limit: 3, used: 1, remaining: 2,
//       week_start: "2026-08-31", next_reset_at: "2026-09-07T15:00:00+00:00" }
//
//   レスポンス（200・Pro で quota 免除）:
//     { unlimited: true, limit: null, used: null, remaining: null,
//       week_start: null, next_reset_at: null }
//
//   エラー:  401 { error: 'unauthenticated' }
//           405 { error: 'method_not_allowed' }
//           500 { error: 'server_misconfigured' | 'internal_error' }
//           502 { error: 'database_unavailable' }
//
//   ⚠ この API は migration 20260906061545 が適用済みの環境でしか動かない。
//     未適用の環境では RPC が存在せず 502 になる（課金 migration の適用前に
//     production へ deploy しないこと）。
// =========================================================

import { callRpc } from '../_lib/supabase.js';
import {
  SESSION_RESULT,
  buildClearSessionCookie,
  requireSession,
} from '../_lib/session.js';
import {
  FREE_WEEKLY_LIMIT,
  hasWebUnlimited,
  json,
  mapRpcError,
  readSingleRow,
} from '../_lib/quota.js';

/** migration 20260906061545 で作成した RPC。 */
const RPC_NAME = 'get_quota_status';

const TAG = 'quota-status';

/** Pro（quota 免除）の応答。形は quota 対象時とそろえ、値だけ null にする。 */
function unlimited() {
  return json(200, {
    unlimited: true,
    limit: null,
    used: null,
    remaining: null,
    week_start: null,
    next_reset_at: null,
  });
}

/** 0 以上の整数か。PostgREST が文字列で返した場合も弾く（fail closed）。 */
function isCount(v) {
  return Number.isInteger(v) && v >= 0;
}

export async function handleQuotaStatus(request, env, deps = {}) {
  const { rpc = callRpc, session = requireSession, logger = console } = deps;

  if (request.method !== 'GET') {
    return json(405, { error: 'method_not_allowed' });
  }

  const result = await session(request, env, deps);

  switch (result?.status) {
    case SESSION_RESULT.VALID:
      break;

    case SESSION_RESULT.UNAUTHENTICATED:
      // Cookie なし / 形式不正 / DB に無い / 期限切れ。すべて同じ応答にする。
      // 既に無効なセッションなので、Cookie を消しても実害はない（/api/auth/me と同じ）。
      return json(
        401,
        { error: 'unauthenticated' },
        { 'Set-Cookie': buildClearSessionCookie() },
      );

    case SESSION_RESULT.DATA_ERROR:
      // セッションは引けたが subscriptions が欠落等。401 に丸めない。
      logger.error('[' + TAG + '] セッションのデータ異常:', result.reason);
      return json(500, { error: 'internal_error' });

    case SESSION_RESULT.MISCONFIGURED:
      logger.error('[' + TAG + '] 設定エラー:', result.reason);
      return json(500, { error: 'server_misconfigured' });

    case SESSION_RESULT.UNAVAILABLE:
      // セッションの有効性は不明。Cookie は触らない。
      logger.error('[' + TAG + '] Supabase エラー:', result.reason);
      return json(502, { error: 'database_unavailable' });

    default:
      logger.error('[' + TAG + '] 想定外のセッション結果です。');
      return json(500, { error: 'internal_error' });
  }

  const context = result.context;
  if (!context
      || typeof context.user_id !== 'string' || context.user_id.length === 0
      || typeof context.plan_id !== 'string'
      || typeof context.status !== 'string') {
    logger.error('[' + TAG + '] セッション context が想定と異なります。');
    return json(500, { error: 'internal_error' });
  }

  // entitlement。Web が無制限なら RPC を呼ばずに免除を返す。
  if (hasWebUnlimited(context)) {
    return unlimited();
  }

  let rows;
  try {
    rows = await rpc(
      RPC_NAME,
      {
        p_user_id: context.user_id,
        // 上限はサーバーが決める。クライアントの指定は受け付けない。
        p_limit: FREE_WEEKLY_LIMIT,
      },
      { env },
    );
  } catch (e) {
    return mapRpcError(e, TAG, logger);
  }

  const row = readSingleRow(rows);
  if (row === null
      || !isCount(row.used)
      || !isCount(row.remaining)
      || !isCount(row.quota_limit)
      || typeof row.week_start !== 'string'
      || typeof row.next_reset_at !== 'string') {
    // 契約と違う形。0 や null で取り繕わず、明確に失敗させる。
    logger.error('[' + TAG + '] RPC の戻り値が契約と異なります。');
    return json(500, { error: 'internal_error' });
  }

  // DB の値はそのまま透過する。週や次回リセットを JS 側で再計算しない。
  return json(200, {
    unlimited: false,
    limit: row.quota_limit,
    used: row.used,
    remaining: row.remaining,
    week_start: row.week_start,
    next_reset_at: row.next_reset_at,
  });
}

/** Cloudflare Pages Functions: GET のエントリポイント */
export async function onRequestGet(context) {
  return handleQuotaStatus(context.request, context.env);
}

/**
 * Cloudflare Pages Functions: GET 以外のフォールバック。
 * メソッド別ハンドラ（onRequestGet）が優先されるため、ここへ来るのは GET 以外。
 * 念のため handleQuotaStatus 側でもメソッドを検査している。
 */
export async function onRequest(context) {
  return handleQuotaStatus(context.request, context.env);
}

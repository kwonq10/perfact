// =========================================================
// POST /api/quota/reserve — 検索の直前に 1 回分を予約する
//
//   Cloudflare Pages Functions（ファイルパス = ルート）。
//   functions/api/quota/reserve.js → /api/quota/reserve
//
//   migration 20260903015535 の reserve_weekly_usage(UUID, TEXT, INT) と対になる。
//
//   設計上の約束:
//     - user_id は body から受け取らない。session context の user_id だけを使う。
//     - 週の起点（JST 月曜）と TTL（120 秒）は DB 側が決める。
//       クライアントの時計も、この Function の時計も使わない。
//     - 上限（Free = 3）は plan から API が決めて p_limit で渡す。
//     - RPC の code をそのまま透過する。読み替えない。
//     - quota 超過は 200 + allowed:false + code:'limit_reached'。
//       4xx にはしない（RPC は正しく答えているため）。
//
//   リクエスト:  POST application/json
//               { "idempotency_key": "<8〜200文字・空白なし>" }
//
//   レスポンス（200・quota 対象）:
//     { quota_enforced: true, allowed, code, reused,
//       reservation_id, week_start, used, remaining, expires_at }
//
//       code = 'ok'              予約できた（reused=true なら同じ鍵の再送）
//              'limit_reached'   今週の上限に達している
//              'already_settled' その鍵は確定済み。新しい鍵で取り直すこと
//
//       allowed=false のとき reservation_id / expires_at は null。
//
//   レスポンス（200・Pro で quota 免除）:
//     { quota_enforced: false, allowed: true, code: 'unlimited',
//       reused: false, reservation_id: null, week_start: null,
//       used: null, remaining: null, expires_at: null }
//
//     この場合 RPC は呼ばない。reservation_id が null なので、
//     クライアントは commit / release を呼んではいけない。
//
//   エラー:  400 { error: 'invalid_content_type' | 'malformed_json'
//                        | 'invalid_body' | 'unreadable_body'
//                        | 'invalid_idempotency_key' }
//           401 { error: 'unauthenticated' }
//           403 { error: 'forbidden_origin' }
//           405 { error: 'method_not_allowed' }
//           413 { error: 'body_too_large' }
//           500 { error: 'server_misconfigured' | 'internal_error' }
//           502 { error: 'database_unavailable' }
// =========================================================

import { callRpc } from '../_lib/supabase.js';
import { isValidIdempotencyKey } from '../_lib/request-body.js';
import {
  FREE_WEEKLY_LIMIT,
  hasWebUnlimited,
  json,
  mapRpcError,
  preflight,
  readSingleRow,
} from '../_lib/quota.js';

/** migration 20260903015535 で作成した RPC。 */
const RPC_NAME = 'reserve_weekly_usage';

const TAG = 'quota-reserve';

/** body 検証。idempotency_key は migration の CHECK 制約と同じ条件。 */
function validate(body) {
  if (!isValidIdempotencyKey(body.idempotency_key)) {
    return { ok: false, code: 'invalid_idempotency_key' };
  }
  return { ok: true, value: { idempotencyKey: body.idempotency_key } };
}

/** Pro（quota 免除）の応答。形は quota 対象時とそろえ、値だけ null にする。 */
function unlimited() {
  return json(200, {
    quota_enforced: false,
    allowed: true,
    code: 'unlimited',
    reused: false,
    reservation_id: null,
    week_start: null,
    used: null,
    remaining: null,
    expires_at: null,
  });
}

export async function handleReserve(request, env, deps = {}) {
  const { rpc = callRpc, logger = console } = deps;

  const pre = await preflight(request, env, deps, { tag: TAG, validate });
  if (pre.response) return pre.response;

  // entitlement。Pro なら RPC を呼ばずに免除を返す。
  if (hasWebUnlimited(pre.context)) {
    return unlimited();
  }

  let rows;
  try {
    rows = await rpc(
      RPC_NAME,
      {
        p_user_id: pre.context.user_id,
        p_idempotency_key: pre.value.idempotencyKey,
        p_limit: FREE_WEEKLY_LIMIT,
      },
      { env },
    );
  } catch (e) {
    return mapRpcError(e, TAG, logger);
  }

  const row = readSingleRow(rows);
  if (row === null
      || typeof row.allowed !== 'boolean'
      || typeof row.code !== 'string') {
    // 契約と違う形。quota 超過にも未認証にも丸めない。
    logger.error('[' + TAG + '] RPC の戻り値が契約と異なります。');
    return json(500, { error: 'internal_error' });
  }

  // RPC の値はそのまま透過する。再解釈しない。
  return json(200, {
    quota_enforced: true,
    allowed: row.allowed,
    code: row.code,
    reused: row.reused === true,
    reservation_id: row.reservation_id ?? null,
    week_start: row.week_start ?? null,
    used: row.used ?? null,
    remaining: row.remaining ?? null,
    expires_at: row.expires_at ?? null,
  });
}

/** Cloudflare Pages Functions: POST のエントリポイント */
export async function onRequestPost(context) {
  return handleReserve(context.request, context.env);
}

/**
 * Cloudflare Pages Functions: POST 以外のフォールバック。
 * メソッド別ハンドラ（onRequestPost）が優先されるため、ここへ来るのは POST 以外。
 * 念のため handleReserve 側でもメソッドを検査している。
 */
export async function onRequest(context) {
  return handleReserve(context.request, context.env);
}

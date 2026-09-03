// =========================================================
// POST /api/quota/commit — 検索が成功したときに予約を確定する
//
//   Cloudflare Pages Functions（ファイルパス = ルート）。
//   functions/api/quota/commit.js → /api/quota/commit
//
//   migration 20260903015535 の commit_weekly_usage(UUID, UUID) と対になる。
//
//   設計上の約束:
//     - user_id は body から受け取らない。session context の user_id だけを使う。
//       他人の予約を確定できないのは RPC 側でも user_id 条件で保証されている。
//     - RPC の ok / code / state をそのまま透過する。読み替えない。
//     - RPC が答えた結果は常に 200。ok=false でも 4xx にしない。
//       （not_found / already_released は「業務上の結果」であって
//         リクエストが処理できなかったわけではない）
//
//   リクエスト:  POST application/json
//               { "reservation_id": "<uuid>" }
//
//   レスポンス（200・quota 対象）:
//     { quota_enforced: true, ok, code, state, used }
//
//       code = 'ok'                pending → committed、または committed の冪等再送
//              'already_released'  返却済みの予約は確定できない
//              'not_found'         存在しない / 他人の予約
//
//       期限切れ pending の commit も code='ok'。予約は committed('expired')
//       として確定し used に数え続ける（fail closed）。
//
//   レスポンス（200・Pro で quota 免除）:
//     { quota_enforced: false, ok: true, code: 'unlimited',
//       state: null, used: null }
//
//     この場合 RPC は呼ばない。そもそも Pro のクライアントは
//     reserve で reservation_id を受け取らないため commit を呼ばない。
//
//   エラー:  400 { error: 'invalid_content_type' | 'malformed_json'
//                        | 'invalid_body' | 'unreadable_body'
//                        | 'invalid_reservation_id' }
//           401 { error: 'unauthenticated' }
//           403 { error: 'forbidden_origin' }
//           405 { error: 'method_not_allowed' }
//           413 { error: 'body_too_large' }
//           500 { error: 'server_misconfigured' | 'internal_error' }
//           502 { error: 'database_unavailable' }
// =========================================================

import { callRpc } from '../_lib/supabase.js';
import { isValidUuid } from '../_lib/request-body.js';
import {
  hasWebUnlimited,
  json,
  mapRpcError,
  preflight,
  readSingleRow,
} from '../_lib/quota.js';

/** migration 20260903015535 で作成した RPC。 */
const RPC_NAME = 'commit_weekly_usage';

const TAG = 'quota-commit';

/** body 検証。UUID の形でなければ DB を叩かずに弾く。 */
function validate(body) {
  if (!isValidUuid(body.reservation_id)) {
    return { ok: false, code: 'invalid_reservation_id' };
  }
  return { ok: true, value: { reservationId: body.reservation_id } };
}

/** Pro（quota 免除）の応答。形は quota 対象時とそろえ、値だけ null にする。 */
function unlimited() {
  return json(200, {
    quota_enforced: false,
    ok: true,
    code: 'unlimited',
    state: null,
    used: null,
  });
}

export async function handleCommit(request, env, deps = {}) {
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
        p_reservation_id: pre.value.reservationId,
      },
      { env },
    );
  } catch (e) {
    return mapRpcError(e, TAG, logger);
  }

  const row = readSingleRow(rows);
  if (row === null || typeof row.ok !== 'boolean' || typeof row.code !== 'string') {
    logger.error('[' + TAG + '] RPC の戻り値が契約と異なります。');
    return json(500, { error: 'internal_error' });
  }

  // RPC の値はそのまま透過する。再解釈しない。
  return json(200, {
    quota_enforced: true,
    ok: row.ok,
    code: row.code,
    state: row.state ?? null,
    used: row.used ?? null,
  });
}

/** Cloudflare Pages Functions: POST のエントリポイント */
export async function onRequestPost(context) {
  return handleCommit(context.request, context.env);
}

/**
 * Cloudflare Pages Functions: POST 以外のフォールバック。
 * メソッド別ハンドラ（onRequestPost）が優先されるため、ここへ来るのは POST 以外。
 * 念のため handleCommit 側でもメソッドを検査している。
 */
export async function onRequest(context) {
  return handleCommit(context.request, context.env);
}

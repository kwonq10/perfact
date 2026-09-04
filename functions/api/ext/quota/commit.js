// =========================================================
// POST /api/ext/quota/commit — 拡張の検索が成功したときに予約を確定する
//
//   Web の /api/quota/commit と同じ RPC（commit_weekly_usage）を呼ぶ。
//   認証だけが Bearer に変わる。DB 変更はない。
//
//   リクエスト:  POST application/json
//               Authorization: Bearer <session token>
//               { "reservation_id": "<UUID>" }
//
//   レスポンス（200）:
//     { quota_enforced: true, ok, code, state, used }
//     code = 'ok' / 'not_found' / 'already_released'
// =========================================================

import { callRpc } from '../../_lib/supabase.js';
import { isValidUuid } from '../../_lib/request-body.js';
import { readSingleRow } from '../../_lib/quota.js';
import { extJson, handlePreflight } from '../../_lib/ext-cors.js';
import { extPreflight, hasExtensionUnlimited, mapExtRpcError } from '../../_lib/ext-quota.js';

/** migration 20260903015535 で作成した RPC。Web と同一。 */
const RPC_NAME = 'commit_weekly_usage';

const TAG = 'ext-quota-commit';

/** body 検証。UUID の形でなければ DB を叩かずに弾く。 */
function validate(body) {
  if (!isValidUuid(body.reservation_id)) {
    return { ok: false, code: 'invalid_reservation_id' };
  }
  return { ok: true, value: { reservationId: body.reservation_id } };
}

/** Pro（quota 免除）の応答。形は quota 対象時とそろえ、値だけ null にする。 */
function unlimited(origin) {
  return extJson(200, {
    quota_enforced: false,
    ok: true,
    code: 'unlimited',
    state: null,
    used: null,
  }, origin);
}

export async function handleExtCommit(request, env, deps = {}) {
  const { rpc = callRpc, logger = console } = deps;

  const pre = await extPreflight(request, env, deps, { tag: TAG, validate });
  if (pre.response) return pre.response;

  if (hasExtensionUnlimited(pre.context)) {
    return unlimited(pre.origin);
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
    return mapExtRpcError(e, TAG, logger, pre.origin);
  }

  const row = readSingleRow(rows);
  if (row === null || typeof row.ok !== 'boolean' || typeof row.code !== 'string') {
    logger.error('[' + TAG + '] RPC の戻り値が契約と異なります。');
    return extJson(500, { error: 'internal_error' }, pre.origin);
  }

  return extJson(200, {
    quota_enforced: true,
    ok: row.ok,
    code: row.code,
    state: row.state ?? null,
    used: row.used ?? null,
  }, pre.origin);
}

/** Cloudflare Pages Functions: preflight */
export async function onRequestOptions(context) {
  return handlePreflight(context.request, context.env);
}

/** Cloudflare Pages Functions: POST のエントリポイント */
export async function onRequestPost(context) {
  return handleExtCommit(context.request, context.env);
}

/** POST / OPTIONS 以外のフォールバック。 */
export async function onRequest(context) {
  return handleExtCommit(context.request, context.env);
}

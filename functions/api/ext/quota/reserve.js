// =========================================================
// POST /api/ext/quota/reserve — 拡張の検索直前に 1 回分を予約する
//
//   Web の /api/quota/reserve と**同じ RPC**（reserve_weekly_usage）を呼ぶ。
//   DB 変更はない。user_id が同じなら Web と quota プールを共有する。
//
//   Web 版との違い:
//     - 認証は Authorization: Bearer <Sukima セッショントークン>
//     - 無制限判定は hasExtensionUnlimited（web_pro は拡張では quota 対象）
//     - CORS ヘッダを返す / OPTIONS に応答する
//
//   リクエスト:  POST application/json
//               Authorization: Bearer <session token>
//               { "idempotency_key": "<8〜200文字・空白なし>" }
//
//   レスポンス（200・quota 対象）:
//     { quota_enforced: true, allowed, code, reused,
//       reservation_id, week_start, used, remaining, expires_at }
//
//   レスポンス（200・Pro で quota 免除）:
//     { quota_enforced: false, allowed: true, code: 'unlimited', … }
//     この場合 RPC は呼ばない。reservation_id が null なので
//     クライアントは commit / release を呼んではいけない。
// =========================================================

import { callRpc } from '../../_lib/supabase.js';
import { isValidIdempotencyKey } from '../../_lib/request-body.js';
import { FREE_WEEKLY_LIMIT, readSingleRow } from '../../_lib/quota.js';
import { extJson, handlePreflight } from '../../_lib/ext-cors.js';
import { extPreflight, hasExtensionUnlimited, mapExtRpcError } from '../../_lib/ext-quota.js';

/** migration 20260903015535 で作成した RPC。Web と同一。 */
const RPC_NAME = 'reserve_weekly_usage';

const TAG = 'ext-quota-reserve';

/** body 検証。idempotency_key は migration の CHECK 制約と同じ条件。 */
function validate(body) {
  if (!isValidIdempotencyKey(body.idempotency_key)) {
    return { ok: false, code: 'invalid_idempotency_key' };
  }
  return { ok: true, value: { idempotencyKey: body.idempotency_key } };
}

/** Pro（quota 免除）の応答。形は quota 対象時とそろえ、値だけ null にする。 */
function unlimited(origin) {
  return extJson(200, {
    quota_enforced: false,
    allowed: true,
    code: 'unlimited',
    reused: false,
    reservation_id: null,
    week_start: null,
    used: null,
    remaining: null,
    expires_at: null,
  }, origin);
}

export async function handleExtReserve(request, env, deps = {}) {
  const { rpc = callRpc, logger = console } = deps;

  const pre = await extPreflight(request, env, deps, { tag: TAG, validate });
  if (pre.response) return pre.response;

  // entitlement。拡張が無制限なら RPC を呼ばずに免除を返す。
  if (hasExtensionUnlimited(pre.context)) {
    return unlimited(pre.origin);
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
    return mapExtRpcError(e, TAG, logger, pre.origin);
  }

  const row = readSingleRow(rows);
  if (row === null
      || typeof row.allowed !== 'boolean'
      || typeof row.code !== 'string') {
    logger.error('[' + TAG + '] RPC の戻り値が契約と異なります。');
    return extJson(500, { error: 'internal_error' }, pre.origin);
  }

  // RPC の値はそのまま透過する。再解釈しない。
  return extJson(200, {
    quota_enforced: true,
    allowed: row.allowed,
    code: row.code,
    reused: row.reused === true,
    reservation_id: row.reservation_id ?? null,
    week_start: row.week_start ?? null,
    used: row.used ?? null,
    remaining: row.remaining ?? null,
    expires_at: row.expires_at ?? null,
  }, pre.origin);
}

/** Cloudflare Pages Functions: preflight */
export async function onRequestOptions(context) {
  return handlePreflight(context.request, context.env);
}

/** Cloudflare Pages Functions: POST のエントリポイント */
export async function onRequestPost(context) {
  return handleExtReserve(context.request, context.env);
}

/** POST / OPTIONS 以外のフォールバック。405 は handleExtReserve が返す。 */
export async function onRequest(context) {
  return handleExtReserve(context.request, context.env);
}

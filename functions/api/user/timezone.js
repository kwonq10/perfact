// =========================================================
// POST /api/user/timezone — ブラウザの IANA timezone を保存する
//
//   Cloudflare Pages Functions（ファイルパス = ルート）。
//   functions/api/user/timezone.js → /api/user/timezone
//
//   migration 20260906061545 の set_user_timezone(UUID, TEXT) と対になる。
//
//   設計上の約束:
//     - **user_id は body から受け取らない。** session context の user_id だけを使う。
//       body に user_id が入っていても無視する。
//     - **timezone 文字列を正規化しない。** 受け取った値をそのまま RPC へ渡す。
//       IANA として妥当かの最終判断は DB 側（is_valid_timezone）が持つ。
//       ここで allowlist を持つと DB と二重管理になり、必ずどちらかが古くなる。
//     - API が弾くのは**形だけ**（非文字列 / 空 / 長すぎ）。意味は見ない。
//     - SQL へ文字列を埋め込まない。RPC の引数として渡す。
//     - **quota の週は動かさない。** それは DB の set_user_timezone の責務で、
//       週の途中の変更は quota_timezone_pending に溜まる。
//     - 応答には display_timezone だけを返す。
//       quota_timezone / pending / quota_week_start は内部状態なので出さない。
//     - 同じ timezone を何度送っても安全（冪等性は DB 側が保証する）。
//       この Function は状態もキャッシュも持たない。
//
//   前処理（method / Origin / body / session）は _lib/quota.js の preflight を
//   そのまま使う。quota API 3 本とまったく同じ順序・同じエラー形になる。
//
//   リクエスト:  POST application/json
//               { "timezone": "Asia/Tokyo" }
//
//   レスポンス:  200 { ok: true, display_timezone: "Asia/Tokyo" }
//
//   エラー:  400 { error: 'invalid_content_type' | 'malformed_json'
//                        | 'invalid_body' | 'unreadable_body'
//                        | 'invalid_timezone' }
//           401 { error: 'unauthenticated' }
//           403 { error: 'forbidden_origin' }
//           405 { error: 'method_not_allowed' }
//           413 { error: 'body_too_large' }
//           500 { error: 'server_misconfigured' | 'internal_error' }
//           502 { error: 'database_unavailable' }
//
//   ⚠ この API は migration 20260906061545 が適用済みの環境でしか動かない。
//     未適用の環境では RPC が存在せず 502 になる（課金 migration の適用前に
//     production へ deploy しないこと）。
// =========================================================

import { callRpc } from '../_lib/supabase.js';
import { json, mapRpcError, preflight, readSingleRow } from '../_lib/quota.js';

/** migration 20260906061545 で作成した RPC。 */
const RPC_NAME = 'set_user_timezone';

const TAG = 'user-timezone';

/**
 * timezone 文字列として受け付けられる最大長。
 * 実在する IANA 名は最長でも 40 文字弱（例: America/Argentina/ComodRivadavia）。
 * 余裕を見て 64 とし、これを超えるものは DB を叩かずに落とす。
 */
export const MAX_TIMEZONE_LENGTH = 64;

/**
 * body 検証。**形だけ**を見る。
 *
 * IANA として妥当かはここで判定しない（DB が唯一の正）。
 * 値は trim せずそのまま通す。前後空白のある文字列は DB が弾く。
 *
 * @param {object} body
 * @returns {{ok:true,value:{timezone:string}}|{ok:false,code:string}}
 */
export function validate(body) {
  const tz = body.timezone;
  if (typeof tz !== 'string') return { ok: false, code: 'invalid_timezone' };
  if (tz.length === 0 || tz.trim().length === 0) {
    return { ok: false, code: 'invalid_timezone' };
  }
  if (tz.length > MAX_TIMEZONE_LENGTH) return { ok: false, code: 'invalid_timezone' };
  return { ok: true, value: { timezone: tz } };
}

/**
 * Supabase が 400 を返したか。
 *
 * set_user_timezone は不正な timezone を RAISE EXCEPTION で拒否し、
 * PostgREST はそれを HTTP 400 にする。callRpc は 5xx 以外を
 * SupabaseError('request_failed') にまとめてしまうため、
 * ここでステータスだけを見てユーザー入力エラーと切り分ける。
 *
 * RPC 自体が存在しない場合は PostgREST が 404 を返すので 400 にはならず、
 * mapRpcError 側（502）に落ちる。migration 未適用を invalid_timezone と
 * 誤って報告しないための切り分けでもある。
 *
 * @param {unknown} e
 * @returns {boolean}
 */
export function isBadRequest(e) {
  return Boolean(e)
      && e.name === 'SupabaseError'
      && e.code === 'request_failed'
      && /status=400\b/.test(String(e.message ?? ''));
}

export async function handleSetTimezone(request, env, deps = {}) {
  const { rpc = callRpc, logger = console } = deps;

  const pre = await preflight(request, env, deps, { tag: TAG, validate });
  if (pre.response) return pre.response;

  let rows;
  try {
    rows = await rpc(
      RPC_NAME,
      {
        // user_id は必ず session 由来。body の値は見ない。
        p_user_id: pre.context.user_id,
        p_timezone: pre.value.timezone,
      },
      { env },
    );
  } catch (e) {
    if (isBadRequest(e)) {
      // DB が IANA として認識できなかった。SQL の本文は返さない。
      logger.warn('[' + TAG + '] DB が timezone を拒否しました。');
      return json(400, { error: 'invalid_timezone' });
    }
    return mapRpcError(e, TAG, logger);
  }

  const row = readSingleRow(rows);
  if (row === null || typeof row.display_timezone !== 'string') {
    // 契約と違う形。ユーザー入力エラーにも未認証にも丸めない。
    logger.error('[' + TAG + '] RPC の戻り値が契約と異なります。');
    return json(500, { error: 'internal_error' });
  }

  // quota_timezone / quota_timezone_pending / quota_week_start は返さない。
  return json(200, { ok: true, display_timezone: row.display_timezone });
}

/** Cloudflare Pages Functions: POST のエントリポイント */
export async function onRequestPost(context) {
  return handleSetTimezone(context.request, context.env);
}

/**
 * Cloudflare Pages Functions: POST 以外のフォールバック。
 * メソッド別ハンドラ（onRequestPost）が優先されるため、ここへ来るのは POST 以外。
 * 念のため preflight 側でもメソッドを検査している。
 */
export async function onRequest(context) {
  return handleSetTimezone(context.request, context.env);
}

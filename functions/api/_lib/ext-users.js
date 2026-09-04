// =========================================================
// users.google_sub の読み取り（Cloudflare Pages Functions 専用）
//
//   なぜ必要か:
//     セッションを発行できる RPC は upsert_user_and_create_session だけで、
//     引数に p_google_sub（必須）を取る。一方 get_session_context が返すのは
//     user_id / plan_id / status / 期限であり google_sub は含まれない。
//     DB を変更せずに「Web セッションを持つ人へ拡張用セッションを発行する」には、
//     user_id から google_sub を引く経路がどうしても要る。
//
//   なぜ PostgREST の直接 SELECT なのか:
//     新しい RPC を作れば済むが、それは migration = DB 変更になる。
//     users への SELECT は既に service_role へ付与済み（billing_schema.sql:362）
//     なので、**DB を一切変更せずに**読める。
//
//   設計上の約束:
//     - google_sub は**サーバー内部だけ**で扱う。
//       レスポンス・ログ・エラーメッセージへ絶対に出さない。
//     - user_id は必ず UUID 形式を検証してから URL に入れる
//       （PostgREST のクエリ文字列へ任意文字列を差し込まない）。
//     - supabase.js は変更しない。export 済みの関数を読み取り専用で使う。
// =========================================================

import {
  SupabaseError,
  buildHeaders,
  getSupabaseConfig,
  isTransportError,
  scrubKey,
} from './supabase.js';
import { isValidUuid } from './request-body.js';

/**
 * user_id から google_sub を引く。
 *
 * @param {object} env             Cloudflare の context.env
 * @param {string} userId          users.id（UUID）
 * @param {Function} [options.fetchImpl] テスト用の fetch 差し替え
 * @param {number}   [options.timeoutMs]
 * @returns {Promise<string|null>} google_sub。該当行が無ければ null
 * @throws {SupabaseError} not_configured / unavailable / request_failed
 */
export async function fetchGoogleSubByUserId(env, userId, options = {}) {
  const { fetchImpl = fetch, timeoutMs = 10000 } = options;

  if (!isValidUuid(userId)) {
    // セッションから来た値なので通常あり得ない。DB を叩かずに落とす。
    throw new SupabaseError('request_failed', 'user_id の形式が不正です。');
  }

  const { url, key } = getSupabaseConfig(env);
  const endpoint = url
    + '/rest/v1/users?select=google_sub&limit=1&id=eq.'
    + encodeURIComponent(userId);

  let res;
  try {
    res = await fetchImpl(endpoint, {
      method: 'GET',
      headers: buildHeaders(key),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (isTransportError(e)) {
      throw new SupabaseError(
        'unavailable',
        `Supabase へ到達できません: ${scrubKey(String(e?.message ?? e), key)}`,
      );
    }
    throw new SupabaseError('request_failed', scrubKey(String(e?.message ?? e), key));
  }

  const text = await res.text().catch(() => '');
  if (!res.ok) {
    throw new SupabaseError(
      res.status >= 500 ? 'unavailable' : 'request_failed',
      `Supabase が status=${res.status} を返しました: ${scrubKey(text, key).slice(0, 300)}`,
    );
  }

  let rows;
  try {
    rows = JSON.parse(text);
  } catch {
    throw new SupabaseError('request_failed', 'Supabase の応答を JSON として解釈できませんでした。');
  }

  if (!Array.isArray(rows)) {
    throw new SupabaseError('request_failed', 'Supabase の応答が配列ではありません。');
  }
  if (rows.length === 0) return null;

  const sub = rows[0]?.google_sub;
  // ここで値そのものをログへ出さないこと（呼び出し側も同様）。
  return typeof sub === 'string' && sub.length > 0 ? sub : null;
}

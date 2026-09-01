// =========================================================
// Supabase 呼び出しユーティリティ（Cloudflare Pages Functions 専用）
//
//   BILLING_SPEC.md §12-7 / §15-7 / HANDOFF §9 の方針に基づく。
//
//   - service_role キーで PostgREST を叩く。RLS はバイパスされる。
//   - このキーは Cloudflare の環境変数にのみ置き、クライアントへは絶対に渡さない。
//   - 課金・利用回数テーブルへの操作は必ずこの Function を経由する。
//
//   依存パッケージは使わない（fetch で足りる）。
//
//   Netlify 版からの変更点:
//     - process.env を廃止。env は必ず引数で受け取る（Workers は context.env）。
//     - Node/undici 固有のエラーコード判定を廃止し、Workers で実際に起きる
//       fetch 失敗（TypeError）・中断（AbortError / TimeoutError）で分類する。
// =========================================================

/** Supabase 呼び出しの失敗。code で HTTP ステータスの振り分けに使う。 */
export class SupabaseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SupabaseError';
    this.code = code;
  }
}

/**
 * 「Supabase へ到達できなかった」失敗かを判定する。
 *
 * Workers runtime に ENOTFOUND / ECONNREFUSED といった Node のエラーコードは無い。
 * ネットワーク層の失敗は TypeError、タイムアウトは AbortError / TimeoutError で来る。
 */
export function isTransportError(e) {
  if (!e || typeof e !== 'object') return false;
  if (e.name === 'AbortError' || e.name === 'TimeoutError') return true;
  const message = String(e.message ?? '');
  if (e.name === 'TypeError' && /fetch failed|network|Failed to fetch|connection/i.test(message)) {
    return true;
  }
  if (e.cause && e.cause !== e) return isTransportError(e.cause);
  return false;
}

/**
 * 万が一メッセージにキーが混入しても外へ出さない。
 * PostgREST のエラー本文をログへ出す際に必ず通すこと。
 */
export function scrubKey(text, key) {
  if (typeof text !== 'string') return text;
  return key ? text.split(key).join('<REDACTED>') : text;
}

/**
 * env から接続情報を取り出す。
 * 未設定はサーバー側の設定漏れなので呼び出し側で 500 にする。
 *
 * @param {object} env Cloudflare の context.env（process.env は使わない）
 */
export function getSupabaseConfig(env) {
  if (!env || typeof env !== 'object') {
    throw new SupabaseError('not_configured', '環境変数が渡されていません。');
  }
  const url = String(env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY || '');
  if (!url) throw new SupabaseError('not_configured', '環境変数 SUPABASE_URL が未設定です。');
  if (!key) throw new SupabaseError('not_configured', '環境変数 SUPABASE_SERVICE_ROLE_KEY が未設定です。');
  if (key.startsWith('sb_publishable_')) {
    throw new SupabaseError('not_configured', 'publishable key が設定されています。secret key を指定してください。');
  }
  return { url, key };
}

/**
 * 認証ヘッダを組み立てる。
 *
 * 新形式の secret key（sb_secret_…）は JWT ではないため
 * Authorization: Bearer には載せず apikey ヘッダのみで送る。
 * 旧形式の service_role JWT は両方に載せる。
 */
export function buildHeaders(key) {
  const headers = { apikey: key, 'Content-Type': 'application/json' };
  if (!key.startsWith('sb_')) headers.Authorization = 'Bearer ' + key;
  return headers;
}

/**
 * Supabase の RPC を呼ぶ。
 *
 * @param {string} fnName        関数名（public スキーマ）
 * @param {object} args          引数オブジェクト
 * @param {object} options.env   Cloudflare の context.env（必須）
 * @param {Function} [options.fetchImpl] テスト用の fetch 差し替え
 * @param {number} [options.timeoutMs]
 * @returns {Promise<any>} 戻り値の JSON（TABLE を返す関数なら配列）
 * @throws {SupabaseError} not_configured / unavailable / request_failed
 */
export async function callRpc(fnName, args = {}, options = {}) {
  const { env, fetchImpl = fetch, timeoutMs = 10000 } = options;

  const { url, key } = getSupabaseConfig(env);

  let res;
  try {
    res = await fetchImpl(url + '/rest/v1/rpc/' + fnName, {
      method: 'POST',
      headers: buildHeaders(key),
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (isTransportError(e)) {
      throw new SupabaseError('unavailable', `Supabase へ到達できません: ${scrubKey(String(e?.message ?? e), key)}`);
    }
    throw new SupabaseError('request_failed', scrubKey(String(e?.message ?? e), key));
  }

  const text = await res.text().catch(() => '');
  if (!res.ok) {
    // 5xx は一時障害の可能性が高いが、いずれにせよクライアントには詳細を返さない
    throw new SupabaseError(
      res.status >= 500 ? 'unavailable' : 'request_failed',
      `Supabase が status=${res.status} を返しました: ${scrubKey(text, key).slice(0, 300)}`,
    );
  }

  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new SupabaseError('request_failed', 'Supabase の応答を JSON として解釈できませんでした。');
  }
}

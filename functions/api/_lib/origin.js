// =========================================================
// CSRF 対策の Origin 検証（Cloudflare Pages Functions 専用）
//
//   Cookie 認証を使う「変更系」エンドポイント専用のヘルパー。
//   __Host-sukima_session は HttpOnly + SameSite=Lax で守られているが、
//   Lax だけに依存せず、リクエストの出所も allowlist で検証する。
//
//   設計上の約束:
//     - Response は組み立てない。判定結果だけを返す。
//       HTTP ステータスと JSON 形状は呼び出し側が決める（_lib/session.js と同じ方針）。
//     - 例外を通常フローに使わない。常に { ok, reason } を返す。
//     - 比較は「URL として解釈した origin 同士の完全一致」。
//       文字列の切り貼りや前方一致・後方一致では判定しない。
//       （https://sukimacalendar.com.evil.example のようなサフィックス攻撃を防ぐ）
//     - Origin の実値はここでも呼び出し側でもログに出さない前提。
//       返すのは理由コードだけ。
//
//   適用する / しない:
//     ○ Cookie 認証の変更系 POST（/api/auth/logout, 将来の /api/quota/consume）
//     × GET（/api/auth/me）
//         ブラウザは GET に Origin を付けないことがあり、状態も変えないため。
//     × Authorization ヘッダ認証の POST（/api/auth/session）
//         カスタムヘッダが必須なので form 経由の CSRF が原理的に成立しない。
//     × Stripe webhook（未実装）
//         サーバー間 POST で Origin が無い。署名（Stripe-Signature）で検証すべき領域。
//         このヘルパーを import してはいけない。
//
//   www について:
//     www.sukimacalendar.com は Cloudflare の Redirect Rule で apex へ 308 される。
//     加えて __Host- 接頭辞の Cookie は host-only なので www へは送られない。
//     つまり www 由来で Cookie 認証が成立することはない。allowlist に入れない。
// =========================================================

/**
 * 既定の許可オリジン。本番の canonical host のみ。
 * ローカル開発用の origin はここに入れない（env.ALLOWED_ORIGINS で上書きする）。
 */
export const DEFAULT_ALLOWED_ORIGINS = Object.freeze([
  'https://sukimacalendar.com',
]);

/**
 * origin 文字列を URL として解釈し、正規化した origin を返す。
 *
 * URL#origin は scheme を小文字化し、host を正規化し、既定ポートを省き、
 * パスや末尾スラッシュを落とすため、これ自体が安全な正規化になる。
 * 文字列置換による曖昧な正規化はしない。
 *
 * 解釈できない場合、および不透明な origin（"null"）の場合は null を返す。
 * chrome-extension: のような非特殊スキームは URL#origin が "null" になるため、
 * ここで自動的に弾かれる。
 *
 * @param {unknown} value
 * @returns {string|null} 例: 'https://sukimacalendar.com'
 */
export function normalizeOrigin(value) {
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  // 不透明な origin。リダイレクト後の "null" や非特殊スキームがここに入る。
  if (url.origin === 'null') return null;

  return url.origin;
}

/**
 * 許可する origin の一覧を返す。
 *
 * env.ALLOWED_ORIGINS が設定されていれば、それが既定値を「上書き」する（追加ではない）。
 * カンマ区切り。各要素は前後の空白を除いたうえで URL として正規化する。
 * 正規化できない要素は無視する（allowlist を広げないため）。
 *
 * 空文字や空白のみの場合は「未設定」として扱い、既定値を使う。
 * 設定ミスで allowlist が空になり、本番が全滅するのを避けるため。
 *
 * @param {object} env Cloudflare の context.env
 * @returns {string[]} 正規化済み origin の配列（重複なし）
 */
export function getAllowedOrigins(env) {
  const configured = env && typeof env.ALLOWED_ORIGINS === 'string' ? env.ALLOWED_ORIGINS : '';
  const source = configured.trim().length > 0
    ? configured.split(',')
    : DEFAULT_ALLOWED_ORIGINS;

  const allowed = [];
  for (const entry of source) {
    const normalized = normalizeOrigin(entry);
    if (normalized !== null && !allowed.includes(normalized)) allowed.push(normalized);
  }
  return allowed;
}

/**
 * リクエストの出所を検証する。
 *
 * 判定:
 *   Origin ヘッダが無い / 空          -> { ok:false, reason:'missing_origin' }
 *   Origin が "null" や解釈不能        -> { ok:false, reason:'forbidden_origin' }
 *   allowlist に完全一致しない         -> { ok:false, reason:'forbidden_origin' }
 *   完全一致                           -> { ok:true }
 *
 * reason は呼び出し側のログ用。HTTP レスポンスでは区別しないこと
 * （攻撃者に判定理由のヒントを与えないため）。
 *
 * @param {Request} request
 * @param {object} env Cloudflare の context.env
 * @returns {{ok: true} | {ok: false, reason: 'missing_origin'|'forbidden_origin'}}
 */
export function checkOrigin(request, env) {
  const raw = request?.headers?.get?.('origin');

  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { ok: false, reason: 'missing_origin' };
  }

  // ヘッダは送られているので missing ではない。解釈できなければ拒否。
  const origin = normalizeOrigin(raw);
  if (origin === null) {
    return { ok: false, reason: 'forbidden_origin' };
  }

  const allowed = getAllowedOrigins(env);
  return allowed.includes(origin)
    ? { ok: true }
    : { ok: false, reason: 'forbidden_origin' };
}

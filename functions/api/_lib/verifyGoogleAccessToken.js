// =========================================================
// Google OAuth access token 検証ユーティリティ（Cloudflare Pages Functions 版）
//
//   Web 版は Google OAuth Token Client（google.accounts.oauth2.initTokenClient）
//   の 1 回のポップアップで「本人確認」と「Calendar 閲覧権限」を同時に得る。
//   ブラウザから届く access token はそのまま信用せず、
//   Google 公式の tokeninfo エンドポイントへ問い合わせて検証する。
//
//   検証すること（どれか 1 つでも欠けたら拒否）:
//     - Google が有効な token と認めること（tokeninfo が 200 を返す）
//     - aud が許可済みの client_id であること（他アプリ向け token の流用を防ぐ）
//     - azp があれば aud と一致すること
//     - 有効期限内であること（exp / expires_in）
//     - sub（Google の不変ユーザー ID）があること
//     - openid scope を含むこと（本人確認のための scope）
//   Calendar の scope は「有無を報告する」だけで、本人確認の成否には使わない。
//   呼び出し側が Calendar 連携の成功扱いにするかを決める。
//
//   設計上の約束:
//     - access token は URL に載せない（POST の body で送る）。
//     - access token は保存しない / ログに出さない / レスポンスへ返さない。
//     - 検証に失敗した理由はクライアントへ返さない（呼び出し側で 401 に丸める）。
//     - このモジュールは DB へは一切アクセスしない。
// =========================================================

import { TokenVerificationError } from './verifyGoogleIdToken.js';

export { TokenVerificationError };

/** Google 公式の tokeninfo エンドポイント。 */
export const GOOGLE_TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';

/** tokeninfo の応答待ち上限（ミリ秒）。 */
export const TOKENINFO_TIMEOUT_MS = 5000;

/** 本人確認に必須の scope。 */
export const IDENTITY_SCOPE = 'openid';

/** Calendar 連携に必須の scope（フロントの SCOPES と一致させること）。 */
export const CALENDAR_SCOPES = Object.freeze([
  'https://www.googleapis.com/auth/calendar.events.readonly',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
]);

/** access token として受け付ける最大長。明らかに不正な入力で Google へ問い合わせない。 */
export const MAX_ACCESS_TOKEN_LENGTH = 4096;

/** access token に現れ得る文字（RFC 6750 の b64token）。 */
const ACCESS_TOKEN_RE = /^[A-Za-z0-9\-._~+/]+=*$/;

/** 通信失敗・タイムアウトかどうか（Workers で実際に起きる形で判定する）。 */
function isTransportFailure(e) {
  if (!e || typeof e !== 'object') return false;
  if (e.name === 'AbortError' || e.name === 'TimeoutError') return true;
  return e.name === 'TypeError';
}

/** scope 文字列（空白区切り）を Set にする。 */
export function parseScopes(scope) {
  if (typeof scope !== 'string') return new Set();
  return new Set(scope.split(/\s+/).filter(Boolean));
}

/** Calendar の必須 scope がすべて付与されているか。 */
export function hasCalendarScopes(scopes) {
  return CALENDAR_SCOPES.every((s) => scopes.has(s));
}

/**
 * tokeninfo の応答を検証する（ネットワークに出ない純粋関数。単体テスト用に公開）。
 *
 * @param {object} info tokeninfo の JSON
 * @param {object} options
 * @param {string[]} options.audiences 許可する client_id のリスト
 * @param {number} [options.nowSec] 現在時刻（秒）。テスト用。
 * @returns {{sub: string, email: string|null, calendarGranted: boolean}}
 */
export function validateTokenInfo(info, { audiences, nowSec } = {}) {
  if (!Array.isArray(audiences) || audiences.length === 0) {
    throw new TokenVerificationError('server_misconfigured', '許可する client_id がありません。');
  }
  if (info === null || typeof info !== 'object' || Array.isArray(info)) {
    throw new TokenVerificationError('invalid_token', 'tokeninfo の応答が不正です。');
  }

  // aud: このアプリ向けに発行された token であること
  if (typeof info.aud !== 'string' || !audiences.includes(info.aud)) {
    throw new TokenVerificationError('audience_mismatch', 'aud が許可済みの client_id ではありません。');
  }
  // azp: あれば aud と一致すること（別クライアント経由の token を拒否）
  if (info.azp !== undefined && info.azp !== info.aud) {
    throw new TokenVerificationError('audience_mismatch', 'azp が aud と一致しません。');
  }

  // 有効期限
  const now = Number.isFinite(nowSec) ? nowSec : Math.floor(Date.now() / 1000);
  const exp = Number(info.exp);
  if (!Number.isFinite(exp) || exp <= now) {
    throw new TokenVerificationError('token_expired', 'access token の有効期限が切れています。');
  }
  if (info.expires_in !== undefined) {
    const expiresIn = Number(info.expires_in);
    if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new TokenVerificationError('token_expired', 'access token の残り有効期間がありません。');
    }
  }

  // 本人確認: sub と openid scope
  if (typeof info.sub !== 'string' || info.sub.length === 0 || info.sub.length > 255) {
    throw new TokenVerificationError('missing_subject', 'sub がありません。');
  }
  const scopes = parseScopes(info.scope);
  if (!scopes.has(IDENTITY_SCOPE)) {
    throw new TokenVerificationError('insufficient_scope', 'openid scope がありません。');
  }

  // email は Google が確認済みのときだけ使う（tokeninfo では文字列 "true"）
  const emailVerified = info.email_verified === true || info.email_verified === 'true';
  const email = emailVerified && typeof info.email === 'string' && info.email.length > 0
    ? info.email
    : null;

  return { sub: info.sub, email, calendarGranted: hasCalendarScopes(scopes) };
}

/**
 * access token を Google の tokeninfo で検証する。
 *
 * @param {string} accessToken ブラウザから届いた access token
 * @param {object} options
 * @param {string[]} options.audiences 許可する client_id のリスト
 * @param {Function} [options.fetchImpl] テスト用の fetch 差し替え
 * @param {number} [options.nowSec] テスト用の現在時刻（秒）
 * @returns {Promise<{sub: string, email: string|null, calendarGranted: boolean}>}
 */
export async function verifyGoogleAccessToken(accessToken, options = {}) {
  const { audiences, fetchImpl = fetch, nowSec } = options;

  if (!Array.isArray(audiences) || audiences.length === 0) {
    throw new TokenVerificationError('server_misconfigured', '許可する client_id がありません。');
  }
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new TokenVerificationError('missing_token', 'access token が空です。');
  }
  if (accessToken.length > MAX_ACCESS_TOKEN_LENGTH || !ACCESS_TOKEN_RE.test(accessToken)) {
    throw new TokenVerificationError('malformed_token', 'access token の形式が不正です。');
  }

  let res;
  try {
    res = await fetchImpl(GOOGLE_TOKENINFO_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({ access_token: accessToken }).toString(),
      signal: AbortSignal.timeout(TOKENINFO_TIMEOUT_MS),
    });
  } catch (e) {
    if (isTransportFailure(e)) {
      throw new TokenVerificationError('verification_unavailable', 'tokeninfo へ接続できません。');
    }
    throw e;
  }

  // 4xx は「Google が無効と判断した token」。5xx は検証不能。
  if (res.status >= 500) {
    throw new TokenVerificationError('verification_unavailable', 'tokeninfo が ' + res.status + ' を返しました。');
  }
  if (res.status !== 200) {
    throw new TokenVerificationError('invalid_token', 'Google が token を無効と判断しました。');
  }

  let info;
  try {
    info = await res.json();
  } catch {
    throw new TokenVerificationError('verification_unavailable', 'tokeninfo の応答を読めません。');
  }

  return validateTokenInfo(info, { audiences, nowSec });
}

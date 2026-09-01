// =========================================================
// Google ID Token 検証ユーティリティ（Cloudflare Pages Functions 版）
//
//   BILLING_SPEC.md §12-1 / BILLING_HANDOFF.md §5・§6 の確定仕様に基づく。
//
//   - Supabase Auth は使わない。認証は既存の Google OAuth に一任する。
//   - クライアントから送られた google_sub は信用しない。
//     Function 側で ID Token を検証し、検証済みの sub のみを使う。
//   - 署名検証は jose（Web Crypto ベース）に委譲する。
//     クレーム検証は validateClaims でも独立に行う（多層防御・単体テスト用）。
//
//   Netlify 版からの変更点:
//     - google-auth-library を廃止し jose に置き換えた（Workers runtime 非対応のため）。
//     - Buffer を廃止し atob + TextDecoder で base64url を復号する。
//     - process.env を廃止。env は必ず引数で受け取る（Workers は context.env）。
//     - Node/undici 固有のエラーコード判定を廃止し、Workers で実際に起きる
//       fetch 失敗・タイムアウト・jose のエラーコードで分類する。
//
//   このモジュールは DB へは一切アクセスしない。
// =========================================================

import { createRemoteJWKSet, jwtVerify } from 'jose';

/** Google の OpenID 公開鍵（JWKS）エンドポイント。Google 公式仕様。 */
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

/** Google が ID Token の iss に用いる値（2種類とも正当） */
export const GOOGLE_ISSUERS = Object.freeze([
  'accounts.google.com',
  'https://accounts.google.com',
]);

/** Google の ID Token は RS256。alg=none などのダウングレードを拒否する */
export const ALLOWED_ALGS = Object.freeze(['RS256']);

/** exp / iat 判定の許容ずれ（秒）。サーバー間の時刻差を吸収する */
export const DEFAULT_CLOCK_SKEW_SEC = 60;

/**
 * 検証失敗を表すエラー。code で失敗理由を区別する。
 * 呼び出し側はこの code を見て HTTP ステータスを決める。
 * クライアントへは詳細を返さないこと（情報漏洩を避ける）。
 */
export class TokenVerificationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TokenVerificationError';
    this.code = code;
  }
}

// JWKS リゾルバはモジュールスコープで使い回す。
// jose が公開鍵をキャッシュするため、ウォームな実行間で往復を減らせる。
let sharedJwks = null;
export function getSharedJwks() {
  if (!sharedJwks) {
    sharedJwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL), {
      timeoutDuration: 5000,
      cooldownDuration: 30000,
    });
  }
  return sharedJwks;
}

/**
 * 許可する aud（Google OAuth クライアントID）の一覧を env から取得する。
 * Web版・Chrome拡張版で client_id が異なるためカンマ区切りのリスト形式にしている。
 *
 * @param {object} env Cloudflare の context.env（process.env は使わない）
 */
export function getAllowedAudiences(env) {
  return String((env && env.GOOGLE_CLIENT_IDS) || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Authorization ヘッダから Bearer トークンを取り出す。
 * 取り出せない場合は null（呼び出し側で 400 にする）。
 */
export function extractBearerToken(headerValue) {
  if (typeof headerValue !== 'string') return null;
  const m = /^Bearer[ \t]+(.+)$/i.exec(headerValue.trim());
  if (!m) return null;
  const token = m[1].trim();
  return token.length > 0 ? token : null;
}

/**
 * base64url 文字列を UTF-8 文字列へ復号する。
 * Workers に Buffer は無いため atob + TextDecoder を使う。
 */
function base64UrlToText(segment) {
  const b64 = String(segment).replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  const binary = atob(b64 + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function base64UrlToJson(segment, what) {
  let text;
  try {
    text = base64UrlToText(segment);
  } catch {
    throw new TokenVerificationError('malformed_token', `${what} の base64url 復号に失敗しました。`);
  }
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new TokenVerificationError('malformed_token', `${what} が JSON ではありません。`);
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new TokenVerificationError('malformed_token', `${what} が JSON オブジェクトではありません。`);
  }
  return obj;
}

/**
 * 署名を検証せずに JWT の構造を確認し、header / payload を取り出す。
 *
 * ここで得た payload は「まだ信用できない」。
 * 署名検証前の早期リジェクト（明らかに不正な入力で Google へ問い合わせない）が目的。
 */
export function decodeJwtUnsafe(idToken) {
  if (typeof idToken !== 'string' || idToken.trim().length === 0) {
    throw new TokenVerificationError('missing_token', 'ID Token が空です。');
  }
  const parts = idToken.split('.');
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) {
    throw new TokenVerificationError('malformed_token', 'JWT の形式（3セグメント）ではありません。');
  }
  const header = base64UrlToJson(parts[0], 'JWT ヘッダ');
  const payload = base64UrlToJson(parts[1], 'JWT ペイロード');

  if (!ALLOWED_ALGS.includes(header.alg)) {
    throw new TokenVerificationError('unsupported_alg', `alg=${String(header.alg)} は許可されていません。`);
  }
  return { header, payload };
}

/**
 * ID Token のクレームを検証する純粋関数（ネットワークアクセスなし）。
 *
 * jose の jwtVerify も iss / aud / exp を見るが、
 * ここでも独立に検証することで多層防御にし、かつ単体テスト可能にしている。
 * （Netlify 版で google-auth-library に対して行っていた再検証と同じ意図）
 *
 * @param {object} payload             検証対象のクレーム
 * @param {string[]} options.audiences 許可する aud のリスト
 * @param {number} [options.nowSeconds] 現在時刻（UNIX秒）。テストのため注入可能
 * @param {number} [options.clockSkewSeconds] 許容する時刻ずれ（秒）
 */
export function validateClaims(payload, options = {}) {
  const {
    audiences,
    nowSeconds = Math.floor(Date.now() / 1000),
    clockSkewSeconds = DEFAULT_CLOCK_SKEW_SEC,
  } = options;

  if (payload === null || typeof payload !== 'object') {
    throw new TokenVerificationError('malformed_token', 'ペイロードがありません。');
  }
  if (!Array.isArray(audiences) || audiences.length === 0) {
    throw new TokenVerificationError('server_misconfigured', '許可する aud が設定されていません。');
  }

  // iss: Google が発行したものであること
  if (!GOOGLE_ISSUERS.includes(payload.iss)) {
    throw new TokenVerificationError('invalid_issuer', `iss=${String(payload.iss)} は Google ではありません。`);
  }

  // aud: 自分のクライアントID宛であること（他アプリ向けトークンの流用を防ぐ）
  if (typeof payload.aud !== 'string' || !audiences.includes(payload.aud)) {
    throw new TokenVerificationError('audience_mismatch', 'aud が許可リストにありません。');
  }

  // exp: 期限切れでないこと
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
    throw new TokenVerificationError('malformed_token', 'exp がありません。');
  }
  if (nowSeconds > payload.exp + clockSkewSeconds) {
    throw new TokenVerificationError('token_expired', 'ID Token の有効期限が切れています。');
  }

  // iat: 未来に発行されたトークンを拒否する（任意クレーム扱いだが Google は必ず付ける）
  if (typeof payload.iat === 'number' && Number.isFinite(payload.iat)) {
    if (payload.iat > nowSeconds + clockSkewSeconds) {
      throw new TokenVerificationError('token_not_yet_valid', 'iat が未来です。');
    }
  }

  // sub: これが google_sub。無ければユーザーを identify できない
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    throw new TokenVerificationError('missing_subject', 'sub がありません。');
  }

  return {
    sub: payload.sub,
    email: typeof payload.email === 'string' ? payload.email : null,
    email_verified: payload.email_verified === true,
  };
}

/**
 * 「トークンが不正」ではなく「検証できなかった」失敗かを判定する。
 *
 * Google の JWKS エンドポイントが落ちている・ネットワークが切れた等をここで拾い、
 * 401（トークン不正）ではなく 503（一時的に検証不能）へ振り分ける。
 *
 * Workers runtime には Node/undici の ENOTFOUND 等は存在しないため、
 * fetch の失敗形（TypeError）・中断（AbortError / TimeoutError）と
 * jose の JWKS 取得系エラーコードで判定する。
 */
export function isVerificationUnavailable(e) {
  if (!e || typeof e !== 'object') return false;

  // jose: JWKS の取得がタイムアウトした / 取得自体に失敗した
  if (e.code === 'ERR_JWKS_TIMEOUT') return true;
  if (e.name === 'JWKSTimeout') return true;

  // fetch の中断・タイムアウト
  if (e.name === 'AbortError' || e.name === 'TimeoutError') return true;

  // Workers / undici とも、ネットワーク層の失敗は TypeError で来る
  const message = String(e.message ?? '');
  if (e.name === 'TypeError' && /fetch failed|network|Failed to fetch|connection/i.test(message)) {
    return true;
  }

  // 原因が入れ子になっている場合（jose は fetch エラーを cause に載せることがある）
  if (e.cause && e.cause !== e) return isVerificationUnavailable(e.cause);

  return false;
}

/**
 * Google ID Token を検証し、検証済みの sub を返す。
 *
 * 流れ:
 *   1. 構造チェック（ネットワークなしで明らかな不正を弾く。alg は RS256 のみ）
 *   2. jose で署名 + iss + aud + exp を検証（Google 公式 JWKS）
 *   3. validateClaims で iss / aud / exp / iat / sub を独立に再検証
 *
 * @param {string} idToken
 * @param {string[]} options.audiences  許可する aud（必須）
 * @param {object}  [options.keyResolver] 署名鍵リゾルバ。テストで差し替え可能
 * @returns {Promise<{sub: string, email: string|null, email_verified: boolean}>}
 * @throws {TokenVerificationError}
 */
export async function verifyGoogleIdToken(idToken, options = {}) {
  const {
    audiences,
    keyResolver,
    nowSeconds,
    clockSkewSeconds = DEFAULT_CLOCK_SKEW_SEC,
  } = options;

  if (!Array.isArray(audiences) || audiences.length === 0) {
    // 設定漏れはクライアントの責任ではないので、呼び出し側で 500 にする
    throw new TokenVerificationError(
      'server_misconfigured',
      '環境変数 GOOGLE_CLIENT_IDS が未設定です。',
    );
  }

  // 1. 構造チェック（alg=none 等をここで弾く。JWKS へは問い合わせない）
  decodeJwtUnsafe(idToken);

  // 2. 署名検証（Google 公式 JWKS。jose が取得・キャッシュする）
  const key = keyResolver ?? getSharedJwks();
  let payload;
  try {
    ({ payload } = await jwtVerify(idToken, key, {
      issuer: [...GOOGLE_ISSUERS],
      audience: audiences,
      algorithms: [...ALLOWED_ALGS],
      clockTolerance: clockSkewSeconds,
    }));
  } catch (e) {
    // JWKS を取れなかっただけの場合は「トークンが不正」ではない。
    // 401 で返すとクライアントがログアウト処理に進んでしまうため 503 相当に分ける。
    if (isVerificationUnavailable(e)) {
      throw new TokenVerificationError(
        'verification_unavailable',
        `Google の公開鍵を取得できませんでした: ${e?.message ?? e}`,
      );
    }
    throw new TokenVerificationError(
      'invalid_token',
      `署名またはクレームの検証に失敗しました: ${e?.message ?? e}`,
    );
  }

  if (!payload || typeof payload !== 'object') {
    throw new TokenVerificationError('invalid_token', '検証済みペイロードを取得できませんでした。');
  }

  // 3. クレーム再検証（jose の検証とは独立に行う多層防御）
  return validateClaims(payload, { audiences, nowSeconds, clockSkewSeconds });
}

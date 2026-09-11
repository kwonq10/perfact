// =========================================================
// Stripe webhook 署名検証（Cloudflare Pages Functions / Workers 専用）
//
//   `_lib/stripe.js` は**送信側**（Stripe REST を叩く）。
//   こちらは**受信側**（Stripe から来た POST を検証する）。責務が別なので分ける。
//
//   - Node の `crypto` は使わない。Web Crypto（`crypto.subtle`）だけで完結する
//     （`session.js` の `hashSessionToken` と同じ流儀）。
//   - webhook secret は env から注入する。ログにも例外にも載せない。
//
//   Stripe の署名仕様:
//     Stripe-Signature: t=<unix seconds>,v1=<hex>,v1=<hex>,v0=<hex>
//       - signed payload = `${t}.${rawBody}`
//       - HMAC-SHA256（鍵は webhook secret 文字列そのもの）の hex
//       - v1 は複数来ることがある（secret ローテーション中）。**1 つでも一致すれば成功**
//       - v0 は無視する（テスト用の旧スキーム）
//       - t が現在時刻から離れすぎている場合は拒否する（リプレイ対策）
//
//   tolerance は Stripe が公式ライブラリの既定値としている **300 秒**にそろえる。
// =========================================================

/** リプレイ許容幅（秒）。Stripe 公式ライブラリの既定値と同じ。 */
export const STRIPE_SIGNATURE_TOLERANCE_SEC = 300;

/** 署名検証の失敗。理由は内部診断用で、HTTP へはそのまま出さない。 */
export class StripeSignatureError extends Error {
  constructor(reason, message) {
    super(message || reason);
    this.name = 'StripeSignatureError';
    this.reason = reason;
  }
}

/**
 * Stripe-Signature ヘッダを解析する。
 *
 *   't=1757200000,v1=abc,v1=def' -> { timestamp: 1757200000, signatures: ['abc','def'] }
 *
 * - `t` が無い / 数値でない -> missing_timestamp
 * - `v1` が 1 つも無い     -> missing_signature
 * - 未知のスキーム（v0 等） -> 無視する（エラーにしない）
 *
 * @param {string} header
 * @returns {{timestamp:number, signatures:string[]}}
 * @throws {StripeSignatureError}
 */
export function parseStripeSignatureHeader(header) {
  if (typeof header !== 'string' || header.trim().length === 0) {
    throw new StripeSignatureError('missing_header', 'Stripe-Signature ヘッダがありません。');
  }

  let timestamp = null;
  const signatures = [];

  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;                       // 'v1' だけ等の壊れた要素は捨てる
    const scheme = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (value.length === 0) continue;

    if (scheme === 't') {
      // 先頭の t だけを採用する。10 進の整数以外は受け付けない。
      if (timestamp === null && /^\d{1,15}$/.test(value)) timestamp = Number(value);
    } else if (scheme === 'v1') {
      // hex 以外は比較する意味が無いので捨てる。
      if (/^[0-9a-f]+$/i.test(value)) signatures.push(value.toLowerCase());
    }
  }

  if (timestamp === null) {
    throw new StripeSignatureError('missing_timestamp', 'Stripe-Signature に t がありません。');
  }
  if (signatures.length === 0) {
    throw new StripeSignatureError('missing_signature', 'Stripe-Signature に v1 がありません。');
  }
  return { timestamp, signatures };
}

/** バイト列を小文字 hex へ（session.js の hashSessionToken と同じ書き方）。 */
function bytesToHex(bytes) {
  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

/**
 * 長さと内容を一度に比較する定数時間相当の等価判定。
 *
 * 早期 return しないことで、一致した文字数から秘密を推測されるのを防ぐ。
 * 長さが違う場合も同じ回数だけ比較してから false にする。
 */
export function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  let diff = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/**
 * HMAC-SHA256(secret, `${timestamp}.${rawBody}`) の hex を作る。
 *
 * @param {string} secret
 * @param {number} timestamp
 * @param {string} rawBody
 * @returns {Promise<string>}
 */
export async function computeStripeSignature(secret, timestamp, rawBody) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${rawBody}`));
  return bytesToHex(new Uint8Array(mac));
}

/**
 * Stripe webhook の署名を検証する。
 *
 * **rawBody は request.text() の生文字列でなければならない。**
 * JSON.parse -> JSON.stringify を挟むとバイト列が変わり、必ず検証に失敗する。
 *
 * @param {object}  o
 * @param {string}  o.rawBody       生ボディ（未パース）
 * @param {string}  o.header        Stripe-Signature ヘッダの値
 * @param {string}  o.secret        STRIPE_WEBHOOK_SECRET
 * @param {number}  [o.toleranceSec]
 * @param {number|Date} [o.now]     判定基準時刻（省略時はサーバー現在時刻）
 * @returns {Promise<{timestamp:number}>} 検証成功時の情報
 * @throws {StripeSignatureError}
 */
export async function verifyStripeWebhookSignature(o = {}) {
  const {
    rawBody,
    header,
    secret,
    toleranceSec = STRIPE_SIGNATURE_TOLERANCE_SEC,
    now,
  } = o;

  if (typeof secret !== 'string' || secret.length === 0) {
    throw new StripeSignatureError('not_configured', 'webhook secret が設定されていません。');
  }
  if (typeof rawBody !== 'string') {
    throw new StripeSignatureError('invalid_body', 'rawBody は文字列である必要があります。');
  }

  const { timestamp, signatures } = parseStripeSignatureHeader(header);

  // --- リプレイ対策 ---
  //   過去も未来も同じ幅で弾く。未来を許すと、時計をずらした再送で
  //   古い状態をいつまでも適用できてしまう。
  const nowMs = now === undefined ? Date.now() : (now instanceof Date ? now.getTime() : Number(now));
  if (!Number.isFinite(nowMs)) {
    throw new StripeSignatureError('invalid_now', '基準時刻が不正です。');
  }
  const skewSec = Math.abs(Math.floor(nowMs / 1000) - timestamp);
  if (skewSec > toleranceSec) {
    throw new StripeSignatureError('timestamp_out_of_tolerance',
      'Stripe-Signature の t が許容範囲外です。');
  }

  // --- 署名比較 ---
  //   複数の v1 のうち 1 つでも一致すれば成功（secret ローテーション対応）。
  //   早期 return せず全件を比較してから判定する。
  const expected = await computeStripeSignature(secret, timestamp, rawBody);
  let matched = false;
  for (const candidate of signatures) {
    if (timingSafeEqualHex(expected, candidate)) matched = true;
  }
  if (!matched) {
    throw new StripeSignatureError('signature_mismatch', 'Stripe-Signature が一致しません。');
  }

  return { timestamp };
}

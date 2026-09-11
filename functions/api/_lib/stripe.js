// =========================================================
// Stripe REST API ユーティリティ（Cloudflare Pages Functions / Workers 専用）
//
//   - Stripe SDK は**入れない**。fetch と URLSearchParams だけで足りる。
//     依存を増やさないのは Workers の互換性と bundle サイズのため
//     （`package.json` の dependencies は `jose` のみ。ここでも増やさない）。
//   - `process.env` を使わない。env は必ず引数で受け取る（Workers は context.env）。
//   - Node 専用 API を使わない。fetch / URLSearchParams / AbortSignal.timeout のみ。
//   - `_lib/supabase.js` の流儀にそろえる:
//       専用 Error クラス + `code` での分類 / `fetchImpl` 注入 /
//       `AbortSignal.timeout` / text を読んでから JSON.parse /
//       エラー本文は truncate してから保持
//
//   このファイルは Stripe へ**実通信しない**（呼び出されたときだけ通信する）。
//   テストは fetch をすべて mock する。
//
//   必要な server-side env:
//     STRIPE_SECRET_KEY    クライアントへは絶対に渡さない
//     STRIPE_API_VERSION   任意。未設定なら Stripe アカウントの既定版を使う
//
//   このファイルは endpoint 固有のヘルパーを持たない。
//   「Stripe の JSON オブジェクトを返すところまで」が責務で、
//   subscription / checkout / portal の意味づけは呼び出し側が行う。
// =========================================================

import { isTransportError, scrubKey } from './supabase.js';

// `isTransportError` / `scrubKey` は Supabase 固有の知識を持たない汎用処理
// （前者は Workers の fetch 失敗分類、後者は文字列の伏せ字）。
// 2 か所に写すと Workers のエラー分類が将来ずれるため import で共有する。
// もし両者の意味が分かれたら、中立な `_lib/http.js` へ切り出すこと。

/** Stripe REST API のベース URL。テストでは fetchImpl 側で受け止める。 */
export const STRIPE_API_BASE = 'https://api.stripe.com';

/** 既定タイムアウト。supabase.js の callRpc と同じ 10 秒にそろえる。 */
export const STRIPE_TIMEOUT_MS = 10000;

/** 対応する HTTP メソッド。これ以外は呼ぶ前に落とす。 */
export const SUPPORTED_METHODS = Object.freeze(['GET', 'POST', 'DELETE']);

/** Idempotency-Key を付けてよいメソッド（状態を変えるものだけ）。 */
export const IDEMPOTENT_METHODS = Object.freeze(['POST', 'DELETE']);

/** Stripe の Idempotency-Key の最大長。 */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

/** エラー本文をメッセージへ載せるときの上限（supabase.js と同じ）。 */
const MAX_ERROR_BODY = 300;

/** 再送してよい HTTP ステータス。429 と 5xx、および競合の 409。 */
function isRetryableStatus(status) {
  return status === 409 || status === 429 || status >= 500;
}

/**
 * Stripe 呼び出しの失敗。
 *
 * `code` は呼び出し側が HTTP へ振り分けるための分類:
 *   not_configured  env の設定漏れ            -> 500
 *   invalid_request 引数が不正（ローカル検査） -> 500（呼び出し側のバグ）
 *   unavailable     到達不能 / タイムアウト     -> 502（retryable）
 *   request_failed  Stripe がエラーを返した     -> ステータス次第
 *   bad_response    2xx だが解釈できない        -> 502
 *
 * 保持するのは診断に要る最小限だけ。
 * secret / カード情報 / リクエストボディ / レスポンス全文は保持しない。
 */
export class StripeApiError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'StripeApiError';
    this.code = code;
    this.httpStatus = details.httpStatus ?? null;
    this.stripeType = details.stripeType ?? null;
    this.stripeCode = details.stripeCode ?? null;
    this.requestId = details.requestId ?? null;
    this.retryable = details.retryable === true;
  }
}


// =========================================================
// 1. 設定
// =========================================================

/**
 * env から Stripe の接続情報を取り出す。
 * 未設定はサーバー側の設定漏れなので、呼び出し側で 500 にする。
 *
 * `STRIPE_API_VERSION` は任意。**既定値をコードへ焼き込まない**。
 * 未設定なら Stripe アカウントの既定バージョンが使われる。
 * 固定したくなったら env に入れるだけでよい。
 *
 * @param {object} env Cloudflare の context.env（process.env は使わない）
 */
export function getStripeConfig(env) {
  if (!env || typeof env !== 'object') {
    throw new StripeApiError('not_configured', '環境変数が渡されていません。');
  }
  const secretKey = String(env.STRIPE_SECRET_KEY || '');
  if (!secretKey) {
    throw new StripeApiError('not_configured', '環境変数 STRIPE_SECRET_KEY が未設定です。');
  }
  // 公開可能キーを取り違えると client 側に置くべき値でサーバーを動かすことになる。
  // 値そのものはエラーへ載せない（キー名だけ）。
  if (secretKey.startsWith('pk_')) {
    throw new StripeApiError(
      'not_configured',
      'STRIPE_SECRET_KEY に publishable key が設定されています。secret key を指定してください。',
    );
  }

  const rawVersion = env.STRIPE_API_VERSION;
  let apiVersion = null;
  if (rawVersion !== undefined && rawVersion !== null && String(rawVersion) !== '') {
    apiVersion = String(rawVersion);
    // ヘッダへ載せる値なので、改行や制御文字を含むものは受け付けない。
    if (!/^[\x20-\x7E]{1,64}$/.test(apiVersion)) {
      throw new StripeApiError('not_configured', 'STRIPE_API_VERSION の形式が不正です。');
    }
  }

  return { secretKey, apiVersion };
}


// =========================================================
// 2. フォームエンコード
//
//   Stripe REST は application/x-www-form-urlencoded で、
//   入れ子は `a[b][c]=1`、配列は `a[0]=x` の添字形式で表す。
//
//   汎用シリアライザにはしない。Checkout / Portal / Schedule で使う範囲
//   （文字列・数値・真偽値・入れ子オブジェクト・配列）に絞る。
// =========================================================

/**
 * Stripe 用に params を URLSearchParams へ変換する。
 *
 *   { automatic_tax: { enabled: true } }        -> automatic_tax[enabled]=true
 *   { metadata: { user_id: 'u1' } }             -> metadata[user_id]=u1
 *   { subscription_data: { metadata: { a: 1 } } }
 *                                -> subscription_data[metadata][a]=1
 *   { expand: ['customer'] }                    -> expand[0]=customer
 *
 * - null / undefined の値は**送らない**（キーごと落とす）
 * - boolean は 'true' / 'false'
 * - number は有限値のみ。NaN / Infinity は invalid_request
 * - それ以外の型（関数・Symbol・BigInt 等）は invalid_request
 * - 空のオブジェクト / 配列は何も生まない
 *
 * キーの順序は挿入順で決まるため、同じ入力からは常に同じ出力になる。
 *
 * @param {object} params
 * @returns {URLSearchParams}
 */
export function encodeStripeParams(params) {
  const out = new URLSearchParams();
  if (params === null || params === undefined) return out;
  if (typeof params !== 'object' || Array.isArray(params)) {
    throw new StripeApiError('invalid_request', 'params はオブジェクトである必要があります。');
  }
  appendParams(out, null, params, 0);
  return out;
}

/** 入れ子の深さ上限。事故で無限に潜らないための安全弁。 */
const MAX_PARAM_DEPTH = 6;

function appendParams(out, prefix, value, depth) {
  if (depth > MAX_PARAM_DEPTH) {
    throw new StripeApiError('invalid_request', 'params の入れ子が深すぎます。');
  }

  if (value === null || value === undefined) return;   // キーごと送らない

  if (typeof value === 'string') {
    out.append(prefix, value);
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new StripeApiError('invalid_request', `params の数値が不正です: ${prefix}`);
    }
    out.append(prefix, String(value));
    return;
  }
  if (typeof value === 'boolean') {
    out.append(prefix, value ? 'true' : 'false');
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      appendParams(out, prefix === null ? String(i) : `${prefix}[${i}]`, item, depth + 1);
    });
    return;
  }

  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (typeof key !== 'string' || key.length === 0) {
        throw new StripeApiError('invalid_request', 'params のキーが不正です。');
      }
      appendParams(out, prefix === null ? key : `${prefix}[${key}]`, child, depth + 1);
    }
    return;
  }

  throw new StripeApiError('invalid_request', `params に使えない型が含まれています: ${prefix}`);
}


// =========================================================
// 3. 入力の検証
// =========================================================

/**
 * path を検証する。呼び出し側は '/v1/subscriptions/sub_xxx' の形で渡す。
 *
 * Stripe ID の意味（sub_ / cus_ 等）はここでは見ない。それは業務層の責務。
 * ここで防ぐのは「明らかに壊れた path」だけ:
 *   - 文字列でない / 空
 *   - '/' 始まりでない
 *   - 空セグメント（'//'）
 *   - '..'（パス遡り）
 *   - 空白・制御文字
 *   - 'undefined' / 'null' セグメント
 *     （`/v1/subscriptions/${id}` で id が未定義だったときの典型的な事故）
 */
export function assertValidPath(path) {
  if (typeof path !== 'string' || path.length === 0) {
    throw new StripeApiError('invalid_request', 'path は必須です。');
  }
  if (!path.startsWith('/')) {
    throw new StripeApiError('invalid_request', 'path は / で始まる必要があります。');
  }
  if (/[\s\x00-\x1F\x7F]/.test(path)) {
    throw new StripeApiError('invalid_request', 'path に空白または制御文字が含まれています。');
  }
  if (path.includes('?') || path.includes('#')) {
    throw new StripeApiError('invalid_request', 'path にクエリやフラグメントを含めないでください。');
  }
  const segments = path.slice(1).split('/');
  for (const seg of segments) {
    if (seg.length === 0) {
      throw new StripeApiError('invalid_request', 'path に空のセグメントがあります。');
    }
    if (seg === '.' || seg === '..') {
      throw new StripeApiError('invalid_request', 'path に相対セグメントを含めないでください。');
    }
    if (seg === 'undefined' || seg === 'null') {
      throw new StripeApiError('invalid_request', 'path に未定義の ID が含まれています。');
    }
  }
}

/**
 * Idempotency-Key を検証する。
 *
 * utility 側でランダム生成は**しない**。Checkout など呼び出し側が
 * 業務的な idempotency key を管理する前提のため。
 *
 * ヘッダへそのまま載せるので、改行・制御文字は必ず弾く（ヘッダ注入対策）。
 */
export function assertValidIdempotencyKey(key, method) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new StripeApiError('invalid_request', 'idempotencyKey は空でない文字列である必要があります。');
  }
  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new StripeApiError('invalid_request', 'idempotencyKey が長すぎます。');
  }
  if (/[\r\n\x00-\x1F\x7F]/.test(key)) {
    throw new StripeApiError('invalid_request', 'idempotencyKey に制御文字を含められません。');
  }
  if (!IDEMPOTENT_METHODS.includes(method)) {
    throw new StripeApiError('invalid_request', `${method} に idempotencyKey は指定できません。`);
  }
}


// =========================================================
// 4. レスポンスの解釈
// =========================================================

/** Stripe の Request-Id ヘッダ。secret ではないので診断に使ってよい。 */
function readRequestId(res) {
  try {
    return res?.headers?.get?.('Request-Id') ?? null;
  } catch {
    return null;
  }
}

/**
 * エラー応答から Stripe のエラー情報を取り出す。
 *
 * 本文が JSON でない場合もあるため必ず try で囲む。
 * **レスポンス全文は保持しない**。message へ載せるのも先頭 300 文字まで。
 */
function parseStripeError(text, secretKey) {
  const safe = scrubKey(text, secretKey);
  try {
    const body = JSON.parse(text);
    const err = body?.error;
    if (err && typeof err === 'object') {
      return {
        stripeType: typeof err.type === 'string' ? err.type : null,
        stripeCode: typeof err.code === 'string' ? err.code : null,
        message: typeof err.message === 'string'
          ? scrubKey(err.message, secretKey).slice(0, MAX_ERROR_BODY)
          : safe.slice(0, MAX_ERROR_BODY),
      };
    }
  } catch {
    // JSON でない。下の既定へ落ちる。
  }
  return { stripeType: null, stripeCode: null, message: safe.slice(0, MAX_ERROR_BODY) };
}


// =========================================================
// 5. stripeRequest — 中核
// =========================================================

/**
 * Stripe REST API を 1 回呼ぶ。
 *
 * 自動 retry は**しない**。retryable かどうかだけ error に載せ、
 * 再送の判断は呼び出し側（webhook handler 等）に委ねる。
 *
 * @param {object}   o
 * @param {object}   o.env             Cloudflare の context.env（必須）
 * @param {string}   o.method          'GET' | 'POST' | 'DELETE'
 * @param {string}   o.path            '/v1/subscriptions/sub_xxx' 等
 * @param {object}   [o.params]        GET はクエリ、POST/DELETE はフォームボディ
 * @param {string}   [o.idempotencyKey] POST / DELETE のみ
 * @param {Function} [o.fetchImpl]     テスト用の fetch 差し替え
 * @param {number}   [o.timeoutMs]
 * @returns {Promise<object>} Stripe が返した JSON オブジェクト
 * @throws {StripeApiError}
 */
export async function stripeRequest(o = {}) {
  const {
    env,
    method,
    path,
    params,
    idempotencyKey,
    fetchImpl = fetch,
    timeoutMs = STRIPE_TIMEOUT_MS,
  } = o;

  // --- ローカル検査（通信の前に落とす）---
  if (typeof method !== 'string' || !SUPPORTED_METHODS.includes(method)) {
    throw new StripeApiError('invalid_request', `対応していない method です: ${String(method)}`);
  }
  assertValidPath(path);
  if (idempotencyKey !== undefined && idempotencyKey !== null) {
    assertValidIdempotencyKey(idempotencyKey, method);
  }

  const { secretKey, apiVersion } = getStripeConfig(env);
  const encoded = encodeStripeParams(params);
  const query = encoded.toString();

  // --- URL とボディ ---
  //   GET はクエリへ載せ、ボディは付けない。
  //   POST は常にボディを付ける（空でも Stripe は受け付ける）。
  //   DELETE は params があるときだけボディを付ける。
  let url = STRIPE_API_BASE + path;
  let body;
  if (method === 'GET') {
    if (query) url += '?' + query;
  } else if (method === 'POST') {
    body = query;
  } else if (query) {
    body = query;
  }

  const headers = {
    Authorization: 'Bearer ' + secretKey,
    Accept: 'application/json',
  };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }
  if (apiVersion) headers['Stripe-Version'] = apiVersion;
  if (idempotencyKey !== undefined && idempotencyKey !== null) {
    headers['Idempotency-Key'] = idempotencyKey;
  }

  // --- 送信 ---
  let res;
  try {
    res = await fetchImpl(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    // 例外メッセージに secret が混ざっていても外へ出さない。
    const message = scrubKey(String(e?.message ?? e), secretKey).slice(0, MAX_ERROR_BODY);
    if (isTransportError(e)) {
      throw new StripeApiError('unavailable', `Stripe へ到達できません: ${message}`,
        { retryable: true });
    }
    throw new StripeApiError('request_failed', `Stripe の呼び出しに失敗しました: ${message}`,
      { retryable: false });
  }

  const requestId = readRequestId(res);

  let text;
  try {
    text = await res.text();
  } catch (e) {
    throw new StripeApiError('bad_response', 'Stripe の応答を読み取れませんでした。',
      { httpStatus: res?.status ?? null, requestId, retryable: false });
  }

  // --- エラー応答 ---
  if (!res.ok) {
    const { stripeType, stripeCode, message } = parseStripeError(text, secretKey);
    throw new StripeApiError(
      'request_failed',
      `Stripe が status=${res.status} を返しました: ${message}`,
      {
        httpStatus: res.status,
        stripeType,
        stripeCode,
        requestId,
        retryable: isRetryableStatus(res.status),
      },
    );
  }

  // --- 成功応答 ---
  //   2xx でも JSON でない / null / オブジェクトでない場合は安全に失敗させる。
  //   endpoint ごとの schema は焼き込まない。ここは「JSON オブジェクトである」まで。
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new StripeApiError('bad_response', 'Stripe の応答を JSON として解釈できませんでした。',
      { httpStatus: res.status, requestId, retryable: false });
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    throw new StripeApiError('bad_response', 'Stripe の応答が JSON オブジェクトではありません。',
      { httpStatus: res.status, requestId, retryable: false });
  }

  return json;
}

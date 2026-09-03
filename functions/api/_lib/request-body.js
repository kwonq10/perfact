// =========================================================
// JSON リクエストボディの読み取り（Cloudflare Pages Functions 専用）
//
//   既存3エンドポイント（session / me / logout）は body を一切読まない。
//   quota API が初めて body を受けるため、その検証をここに集約する。
//
//   設計上の約束:
//     - Response は組み立てない。判定結果だけを返す。
//       HTTP ステータスと JSON 形状は呼び出し側が決める
//       （_lib/session.js / _lib/origin.js と同じ方針）。
//     - 例外を通常フローに使わない。常に { ok, value } / { ok, code } を返す。
//     - body の中身はログに出さない前提。返すのは理由コードだけ。
//     - 「API が通した値は必ず DB の CHECK 制約も通る」ことを保証する。
//       逆向き（DB は通すが API が弾く）は安全側なので許容する。
// =========================================================

/**
 * 受け付ける body の最大バイト数。
 *
 * quota API の body は {"idempotency_key":"<uuid>"} 程度で 60 バイト前後。
 * 1KB あれば十分に余裕があり、それ以上は誤用か攻撃とみなす。
 */
export const MAX_BODY_BYTES = 1024;

/**
 * idempotency_key の最小 / 最大文字数。
 * migration 20260903015535 の CHECK 制約
 *   length(idempotency_key) BETWEEN 8 AND 200
 * と同じ値。片方だけ変えないこと。
 */
export const IDEMPOTENCY_KEY_MIN = 8;
export const IDEMPOTENCY_KEY_MAX = 200;

/** UUID の形。8-4-4-4-12 の hex。版・variant は問わない（PostgreSQL uuid 型と同じ寛容さ）。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * C0 / C1 制御文字を含むか。
 * DB の CHECK 制約は制御文字を弾かないが、鍵として保存させる理由がないので拒否する。
 * 文字クラスのリテラルを書かずコードポイントで判定する。
 */
function hasControlChar(value) {
  for (const ch of value) {
    const cp = ch.codePointAt(0);
    if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return true;
  }
  return false;
}

/**
 * Content-Type が JSON かどうか。
 * 'application/json' と 'application/json; charset=utf-8' を許す。
 * パラメータ部分は見ない。
 */
export function isJsonContentType(value) {
  if (typeof value !== 'string') return false;
  const type = value.split(';', 1)[0].trim().toLowerCase();
  return type === 'application/json';
}

/**
 * idempotency_key の妥当性。
 *
 * migration の CHECK 制約と同じ条件を JS 側で先に判定する。
 *   - 文字数は「コードポイント数」で数える。
 *     JS の String#length は UTF-16 単位なので、絵文字を含む鍵で
 *     PostgreSQL の length() と食い違い、API が通した値を DB が弾く。
 *   - 空白は JS の \s で判定する。POSIX の \s（空白・タブ・改行など）を
 *     含むため、ここを通れば DB の CHECK も必ず通る。
 *   - 制御文字は DB の CHECK には無いが、追加で拒否する（安全側）。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidIdempotencyKey(value) {
  if (typeof value !== 'string') return false;
  if (/\s/.test(value)) return false;
  if (hasControlChar(value)) return false;

  const length = [...value].length;
  return length >= IDEMPOTENCY_KEY_MIN && length <= IDEMPOTENCY_KEY_MAX;
}

/**
 * reservation_id の妥当性。UUID の形だけを見る。
 * 形が違うものは DB を叩かずに弾く（無駄な RPC と行ロックを避けるため）。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * リクエストボディを JSON オブジェクトとして読む。
 *
 * 判定:
 *   Content-Type が JSON でない       -> { ok:false, code:'invalid_content_type' }
 *   1KB 超                            -> { ok:false, code:'body_too_large' }
 *   JSON として壊れている             -> { ok:false, code:'malformed_json' }
 *   オブジェクトでない（配列/null 等）-> { ok:false, code:'invalid_body' }
 *   読み取り自体に失敗                -> { ok:false, code:'unreadable_body' }
 *   正常                              -> { ok:true, value:<object> }
 *
 * Content-Length は「あれば」読む前に見る。無い場合や偽っている場合に備えて、
 * 実際に読んだテキストのバイト数でも判定する。
 *
 * @param {Request} request
 * @param {object} [options.maxBytes]
 * @returns {Promise<{ok:true,value:object}|{ok:false,code:string}>}
 */
export async function readJsonBody(request, options = {}) {
  const maxBytes = Number.isInteger(options.maxBytes) ? options.maxBytes : MAX_BODY_BYTES;

  if (!isJsonContentType(request?.headers?.get?.('content-type'))) {
    return { ok: false, code: 'invalid_content_type' };
  }

  // Content-Length があるなら読む前に弾く。
  const declared = Number(request?.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, code: 'body_too_large' };
  }

  let text;
  try {
    text = await request.text();
  } catch {
    return { ok: false, code: 'unreadable_body' };
  }

  // Content-Length が無い / 実際と食い違う場合の実測チェック。
  if (new TextEncoder().encode(text).length > maxBytes) {
    return { ok: false, code: 'body_too_large' };
  }

  if (text.trim().length === 0) {
    return { ok: false, code: 'malformed_json' };
  }

  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, code: 'malformed_json' };
  }

  // 配列や null、プリミティブは受け付けない。
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, code: 'invalid_body' };
  }

  return { ok: true, value };
}

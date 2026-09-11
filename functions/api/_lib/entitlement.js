// =========================================================
// entitlement — Pro 権限の判定（Cloudflare Pages Functions 専用）
//
//   plan_id + status（+ past_due の猶予）から
//   「いま Pro として扱ってよいか」だけを決める純粋関数を置く。
//
//   ここには**外部 I/O を一切書かない**。DB も Stripe も fetch も触らない。
//   価格・通貨・Price ID の話は billing-config.js の担当で、
//   このファイルは billing-config を import しない（責務を分ける）。
//
//   設計上の約束:
//     - **allowlist 方式**。ここに挙げた plan / status の組み合わせ以外は
//       すべて Free 扱い。未知の plan_id / status は自動的に false になる
//       （フェイルクローズ）。
//     - context が null / 型違い / 欄欠けでも **throw せず false** を返す。
//       既存の hasWebUnlimited / hasExtensionUnlimited がそう振る舞っており、
//       quota API 3 本がその戻り値だけを見て分岐しているため。
//     - **now は引数で注入できる**。Date.now() をロジックへ埋め込まない。
//     - Web と Extension の違いは「対象 plan の集合」だけ。
//       status の扱いは共通なので判定本体を 1 つにする。
//
//   past_due_since が無い場合（重要）:
//     `past_due_since` が無い / 解釈できないときは、
//     「past_due だが past_due_since が無い」= Free と扱う（fail closed）。
//     これにより列が無い環境でも active / trialing の判定は一切変わらない。
// =========================================================


// =========================================================
// 1. 対象プラン
//    Web と Extension で異なるのはここだけ。
// =========================================================

/** Web を無制限にする plan_id。extension_pro は Web では quota 対象。 */
export const WEB_PRO_PLAN_IDS = Object.freeze(['web_pro', 'all_pro']);

/** Extension を無制限にする plan_id。web_pro は拡張では quota 対象。 */
export const EXTENSION_PRO_PLAN_IDS = Object.freeze(['extension_pro', 'all_pro']);


// =========================================================
// 2. status
//
//   Pro になれる status は 3 つだけ:
//     active / trialing … 無条件で Pro
//     past_due          … past_due_since から 7 日未満のときだけ Pro
//
//   canceled / unpaid / incomplete / incomplete_expired は Pro にしない。
//   incomplete / incomplete_expired を除外していることが
//   「初回決済成功前は Pro にしない」の実体でもある。
// =========================================================

/** 無条件で Pro 扱いする status。 */
export const PRO_STATUSES = Object.freeze(['active', 'trialing']);

/** 猶予期間の判定を要する status。 */
export const GRACE_STATUS = 'past_due';

/** 支払い失敗後に Pro を維持する日数（製品仕様: 7 日）。 */
export const PAST_DUE_GRACE_DAYS = 7;

/** 同ミリ秒。境界は「ちょうど 7 日で終了」= この値**未満**なら猶予内。 */
export const PAST_DUE_GRACE_MS = PAST_DUE_GRACE_DAYS * 24 * 60 * 60 * 1000;


// =========================================================
// 3. 時刻の正規化
//
//   billing-config.js の toEpochMs() とは**意図的に別物**にしている。
//   あちらは「省略時は現在時刻」を返すが、past_due_since に同じ既定を
//   適用すると「値が無い＝いま猶予が始まった」となり猶予が無限に延びる。
//   ここでは省略・不正を必ず null にする厳格版を持つ。
// =========================================================

/**
 * past_due_since 等のタイムスタンプを epoch ミリ秒へ厳格に正規化する。
 * null / undefined / 解釈不能はすべて null（既定値へ倒さない）。
 *
 * @param {Date|number|string|null|undefined} value
 * @returns {number|null}
 */
export function toTimestampMs(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    if (value.trim().length === 0) return null;
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

/**
 * 判定基準時刻を決める。省略時のみサーバー現在時刻を使う。
 *
 * @param {Date|number|string|undefined} now
 * @returns {number|null} 解釈できない now は null
 */
export function resolveNowMs(now) {
  if (now === undefined) return Date.now();
  return toTimestampMs(now);
}


// =========================================================
// 4. past_due の猶予判定
// =========================================================

/**
 * past_due の猶予期間内か。
 *
 * 境界:
 *   経過 <  7 日 -> true
 *   経過 >= 7 日 -> false（ちょうど 7 日に達した瞬間から Free）
 *
 * フェイルクローズにする入力:
 *   - past_due_since が無い / 不正 -> false
 *     （DB 未対応の現状はここに落ちる）
 *   - past_due_since が未来 -> false
 *     誤った DB 値で猶予が不当に延びるのを防ぐ
 *   - now が不正 -> false
 *
 * @param {Date|number|string|null|undefined} pastDueSince
 * @param {Date|number|string|undefined} [now]
 * @returns {boolean}
 */
export function isWithinPastDueGrace(pastDueSince, now) {
  const sinceMs = toTimestampMs(pastDueSince);
  if (sinceMs === null) return false;

  const nowMs = resolveNowMs(now);
  if (nowMs === null) return false;

  const elapsed = nowMs - sinceMs;
  // elapsed < 0 は past_due_since が未来。猶予を与えない。
  return elapsed >= 0 && elapsed < PAST_DUE_GRACE_MS;
}


// =========================================================
// 5. 判定本体
// =========================================================

/**
 * session context が、指定したプラン集合に対して Pro 権限を持つか。
 *
 * Web / Extension の違いは allowedPlanIds だけで表現する。
 *
 * context が壊れていても throw しない（既存 wrapper の契約）。
 *
 * @param {object} context requireSession / requireExtSession が返す context
 * @param {ReadonlyArray<string>} allowedPlanIds 対象の plan_id 集合
 * @param {Date|number|string} [now] 省略時はサーバー現在時刻
 * @returns {boolean}
 */
export function isEntitled(context, allowedPlanIds, now) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) return false;
  if (!Array.isArray(allowedPlanIds)) return false;

  const { plan_id: planId, status } = context;
  if (typeof planId !== 'string' || typeof status !== 'string') return false;
  if (!allowedPlanIds.includes(planId)) return false;

  // active / trialing は now に依存しない。
  // ここで now の妥当性を問わないのは、判定に無関係な引数の不備で
  // 支払い済み利用者の権限を落とさないため。
  if (PRO_STATUSES.includes(status)) return true;

  if (status === GRACE_STATUS) {
    return isWithinPastDueGrace(context.past_due_since, now);
  }

  // canceled / unpaid / incomplete / incomplete_expired / 未知の status
  return false;
}

/**
 * Web の Pro 権限（web_pro / all_pro）。
 *
 * @param {object} context
 * @param {Date|number|string} [now]
 * @returns {boolean}
 */
export function hasWebEntitlement(context, now) {
  return isEntitled(context, WEB_PRO_PLAN_IDS, now);
}

/**
 * Extension の Pro 権限（extension_pro / all_pro）。
 *
 * @param {object} context
 * @param {Date|number|string} [now]
 * @returns {boolean}
 */
export function hasExtensionEntitlement(context, now) {
  return isEntitled(context, EXTENSION_PRO_PLAN_IDS, now);
}

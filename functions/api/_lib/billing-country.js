// =========================================================
// 販売国の判定（Stripe Customer の請求先住所から）
//
//   **なぜ Customer の住所を正にするのか（A-1 の根拠）**
//
//     Checkout には「請求先国の allowlist」が無い（実 API で確認済み）。
//     そのため購入後に server 側で検証するしかない。検証元の候補は 2 つ:
//
//       (a) checkout.session.completed の customer_details.address.country
//       (b) Customer の address.country
//
//     実購入時の event 発生順:
//
//       customer.created              t=293  <- **ここで既に address.country が入る**
//       customer.subscription.created t=296  <- webhook が plan を書く
//       invoice.payment_succeeded     t=296  <- webhook が plan を書く
//       checkout.session.completed    t=297  <- (a) はここでしか読めない
//
//     (a) は **entitlement を書く event より後**に届くため、
//     「一瞬でも非 JP へ Pro を与えない」を満たせない。
//     (b) は Customer 作成時点で入っているので、**どの event を処理するときも
//     entitlement を書く前に読める**。よって (b) を正とする。
//
//     再契約時に住所が古いままになる問題は、checkout.js の
//     `customer_update[address]: 'auto'` で解消してある。
//
//   **判定できないときは「非 JP」と同一視しない。**
//     取得失敗・住所なし・国コードなし・壊れた値はすべて `unknown` にする。
//     unknown で解約や返金をすると、Stripe の一時障害だけで
//     利用者の契約を壊してしまう。unknown は fail closed（Pro を与えない）
//     に留め、金銭操作はしない。
// =========================================================

import { isPurchasableCountry } from './billing-config.js';

/** ISO 3166-1 alpha-2 の形だけを受け付ける。 */
const COUNTRY_RE = /^[A-Z]{2}$/;

/** 判定結果の種類。 */
export const COUNTRY_STATUS = Object.freeze({
  /** いま販売してよい国だった。 */
  SELLABLE: 'sellable',
  /** 国は分かったが、いま販売していない国だった。 */
  NOT_SELLABLE: 'not_sellable',
  /** 国が分からなかった。**非 JP と同一視しない。** */
  UNKNOWN: 'unknown',
});

/**
 * 国コードを正規化する。
 *
 * 形が ISO 3166-1 alpha-2 でなければ null（推測しない）。
 * 大文字化だけは行う（Stripe は大文字で返すが、念のため）。
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function normalizeCountry(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toUpperCase();
  return COUNTRY_RE.test(trimmed) ? trimmed : null;
}

/**
 * Stripe の Customer から販売可否を判定する。
 *
 * code は診断用（ログにだけ出す。応答には出さない）。
 *
 * @param {unknown} customer Stripe API から取り直した Customer
 * @returns {{status:string, country?:string, code?:string}}
 */
export function classifyCustomerCountry(customer) {
  if (!customer || typeof customer !== 'object' || Array.isArray(customer)) {
    return { status: COUNTRY_STATUS.UNKNOWN, code: 'invalid_customer' };
  }
  // 削除済み Customer は住所を持たない。
  if (customer.deleted === true) {
    return { status: COUNTRY_STATUS.UNKNOWN, code: 'customer_deleted' };
  }

  const address = customer.address;
  if (!address || typeof address !== 'object' || Array.isArray(address)) {
    return { status: COUNTRY_STATUS.UNKNOWN, code: 'missing_address' };
  }

  const country = normalizeCountry(address.country);
  if (country === null) {
    return { status: COUNTRY_STATUS.UNKNOWN, code: 'missing_country' };
  }

  // **販売可能国の正は billing-config の 13 節**（いまは JP のみ）。
  // 販売国を広げたら、この判定も自動的に追随する。
  return isPurchasableCountry(country)
    ? { status: COUNTRY_STATUS.SELLABLE, country }
    : { status: COUNTRY_STATUS.NOT_SELLABLE, country };
}

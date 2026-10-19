// =========================================================
// Google 広告のコンバージョン計測の設定
//
//   ここにあるのは **公開識別子だけ**（Google タグ ID と送信先）。
//   タグを読み込んだページの HTML にも現れる値で、秘密情報ではない。
//
//   本番以外から Google 広告へ送らないための仕組み:
//     - サーバーは `ADS_CONVERSION_MODE === 'live'` のときだけ
//       タグ ID と送信先をブラウザへ返す。**本番の環境変数にだけ**設定する。
//       preview・ローカル・自動テストでは未設定なので、常に「無効」を返す。
//     - ブラウザ側（public/assets/ads-measurement.js）は ID を持たない。
//       サーバーが返した値でしかタグを読み込めない。
//     - live のときは Stripe の livemode=true の決済だけを対象にする。
//
//   読み込むのは日本からのアクセスだけ（販売国と同じ）。
//   国はリクエストの `request.cf.country`（Cloudflare が付ける）で判定し、
//   **無い・不明は日本以外と同じに扱う**（読み込まない）。
// =========================================================

/** Google タグ ID（公開識別子）。 */
export const GOOGLE_ADS_TAG_ID = 'AW-18481971668';

/** コンバージョン「Sukima｜有料プラン初回契約」の送信先（公開識別子）。 */
export const GOOGLE_ADS_CONVERSION_SEND_TO = 'AW-18481971668/VxGaCNKJ26AdENSD8uxE';

/** 本番だけに設定する環境変数とその値。 */
export const ADS_MODE_ENV_KEY = 'ADS_CONVERSION_MODE';
export const ADS_MODE_LIVE = 'live';

/** タグを読み込んでよい国（販売国と同じ）。 */
export const ADS_ALLOWED_COUNTRIES = Object.freeze(['JP']);

/**
 * 本番の計測が有効か。**値が厳密に 'live' のときだけ true。**
 * 未設定・空・大文字違いはすべて無効（fail closed）。
 *
 * @param {object} env
 * @returns {boolean}
 */
export function isAdsLive(env) {
  return env?.[ADS_MODE_ENV_KEY] === ADS_MODE_LIVE;
}

/**
 * リクエスト元の国が対象か。`request.cf` が無い（ローカル・テスト）なら false。
 *
 * @param {Request} request
 * @returns {boolean}
 */
export function isAllowedAdsCountry(request) {
  const country = request?.cf?.country;
  return typeof country === 'string' && ADS_ALLOWED_COUNTRIES.includes(country);
}

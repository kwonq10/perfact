// =========================================================
// GET /api/ads/tag-config — Google タグを読み込める環境かを返す
//
//   紹介ページ・決済完了ページの計測スクリプト（public/assets/ads-measurement.js）が
//   **同意の確認より前に**呼ぶ。ここで無効なら、同意の案内も出さず、
//   Google のタグも読み込まない。
//
//   有効になる条件（すべて）:
//     - 本番の環境変数 ADS_CONVERSION_MODE が 'live'
//     - リクエスト元の国が日本（request.cf.country === 'JP'）。無い・不明は無効
//
//   Cookie も body も読まない。応答はキャッシュさせない（国で結果が変わるため）。
//
//   レスポンス:
//     200 { enabled: false }
//     200 { enabled: true, tag_id }
//     405 { error: 'method_not_allowed' }
// =========================================================

import { GOOGLE_ADS_TAG_ID, isAdsLive, isAllowedAdsCountry } from '../_lib/ads-config.js';

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * @param {Request} request
 * @param {object} env
 */
export function handleAdsTagConfig(request, env) {
  if (request.method !== 'GET') return json(405, { error: 'method_not_allowed' });
  if (!isAdsLive(env) || !isAllowedAdsCountry(request)) return json(200, { enabled: false });
  return json(200, { enabled: true, tag_id: GOOGLE_ADS_TAG_ID });
}

export async function onRequest(context) {
  return handleAdsTagConfig(context.request, context.env);
}

// =========================================================
// POST /api/terms/consent — Subscription Terms への同意を記録
//
//   Cloudflare Pages Functions（ファイルパス = ルート）。
//   functions/api/terms/consent.js -> /api/terms/consent
//
//   処理の流れ（preflight が 1〜4 を担当する）:
//     1. POST 以外は 405
//     2. Origin 検証（CSRF）           -> 403
//     3. JSON body 検証                -> 400 / 413
//     4. Cookie session                -> 401 / 500 / 502
//     5. **現行の terms_version を server が決める** -> 取れなければ 503
//     6. `record_terms_consent` を 1 回だけ呼ぶ
//
//   設計上の約束（ここが本 API の肝）:
//     - **client から受け取るのは `locale` だけ。**
//       `terms_version` / `user_id` / `accepted_at` / `id` は受け取らない。
//       body に余計なキーがあれば **400 で拒否する**（黙って無視しない）。
//       「client が版を指名できない」ことを構造で保証する。
//       price 解決（resolvePriceDefinition に phase / price_id 引数が無い）と同じ考え方。
//     - **terms_version の正は server config。**
//       `getCurrentSubscriptionTermsVersion()`（billing-config.js 12 節）から取る。
//       DB も client も現行版を知らない。
//     - **user_id の正は session。** body の値は見ない。
//     - **accepted_at の正は DB の now()。** RPC に引数が無いので
//       client がさかのぼって指定できない。
//     - **draft のあいだは fail closed。**
//       `getCurrentSubscriptionTermsVersion()` が throw するので RPC を呼ばず 503。
//       未確定の規約への同意が記録され得ない。
//     - **冪等性は DB に委ねる。** RPC が
//       `ON CONFLICT DO NOTHING` + 既存行 SELECT なので、
//       同じ同意を何度送っても 200 で 1 行のまま。HTTP 層で重複判定をしない。
//     - **応答にも log にも PII を出さない。**
//       `id` / `user_id` / email / google_sub / session token は返さない。
//       body 全体もログに出さない。
//
//   レスポンス:
//     200 { accepted: true, terms_version, locale, accepted_at }
//     400 { error: 'invalid_locale' | 'unknown_field' | 'invalid_body'
//                 | 'malformed_json' | 'invalid_content_type' }
//     401 { error: 'unauthenticated' }
//     403 { error: 'forbidden_origin' }
//     405 { error: 'method_not_allowed' }
//     413 { error: 'body_too_large' }
//     500 { error: 'internal_error' | 'server_misconfigured' }
//     502 { error: 'database_unavailable' }
//     503 { error: 'terms_not_available' }   規約が未公開（draft）
//
//   ⚠ この API は migration 20260907051255 が適用済みの環境でしか動かない。
//     未適用なら RPC が無く 502 になる。
//   テストは RPC を mock する。
// =========================================================

import {
  getCurrentSubscriptionTermsVersion,
  isSupportedTermsLocale,
} from '../_lib/billing-config.js';
import { callRpc } from '../_lib/supabase.js';
import { json, mapRpcError, preflight, readSingleRow } from '../_lib/quota.js';

/** migration 20260907051255 で作成した RPC。 */
export const RPC_NAME = 'record_terms_consent';

const TAG = 'terms-consent';

/**
 * body で受け付けるキー。**これ以外は拒否する。**
 *
 * 無視ではなく拒否にしたのは、client が `terms_version` を送ってしまう実装ミスを
 * 静かに握り潰すと、「送ったのに効いていない」ことに誰も気付けないため。
 */
export const ALLOWED_BODY_KEYS = Object.freeze(['locale']);

/**
 * body 検証。
 *
 * locale は**正規化しない**。`'JA'` は `'ja'` に寄せずに拒否する
 * （DB の CHECK が小文字のみを許すため。timezone / terms_version と同じ方針）。
 *
 * @param {object} body
 * @returns {{ok:true,value:{locale:string}}|{ok:false,code:string}}
 */
export function validate(body) {
  for (const key of Object.keys(body)) {
    if (!ALLOWED_BODY_KEYS.includes(key)) {
      // どのキーが余計だったかは返さない（キー名だけログに残す）。
      return { ok: false, code: 'unknown_field' };
    }
  }
  if (!isSupportedTermsLocale(body.locale)) {
    return { ok: false, code: 'invalid_locale' };
  }
  return { ok: true, value: { locale: body.locale } };
}

/**
 * 同意を記録する。
 *
 * @param {Request} request
 * @param {object} env
 * @param {object} [deps]
 * @param {Function} [deps.rpc]           Supabase RPC（テストで差し替える）
 * @param {Function} [deps.currentVersion] 現行版の取得（テストで published を再現する）
 * @param {object}   [deps.logger]
 */
export async function handleTermsConsent(request, env, deps = {}) {
  const {
    rpc = callRpc,
    logger = console,
    currentVersion = getCurrentSubscriptionTermsVersion,
  } = deps;

  // 1〜4: method / Origin / body / session
  const pre = await preflight(request, env, deps, { tag: TAG, validate });
  if (pre.response) return pre.response;

  // 5: 現行版は **server が決める**。draft なら例外になり、ここで止まる。
  //    RPC を呼ばないので DB には 1 行も書かれない。
  let termsVersion;
  try {
    termsVersion = currentVersion();
  } catch (e) {
    // 内部の理由コードだけをログに残す。status / version は応答に出さない。
    logger.warn('[' + TAG + '] 規約の現行版を取得できません:', e?.code ?? 'unknown');
    return json(503, { error: 'terms_not_available' });
  }

  if (typeof termsVersion !== 'string' || termsVersion.length === 0) {
    // getCurrentSubscriptionTermsVersion() の契約違反。fail closed。
    logger.error('[' + TAG + '] 現行版が文字列ではありません。');
    return json(503, { error: 'terms_not_available' });
  }

  // 6: RPC を 1 回だけ。渡すのは session の user_id / server の版 / 検証済み locale。
  let rows;
  try {
    rows = await rpc(
      RPC_NAME,
      {
        p_user_id: pre.context.user_id,
        p_terms_version: termsVersion,
        p_locale: pre.value.locale,
      },
      { env },
    );
  } catch (e) {
    return mapRpcError(e, TAG, logger);
  }

  const row = readSingleRow(rows);
  if (row === null
      || typeof row.terms_version !== 'string'
      || typeof row.locale !== 'string'
      || typeof row.accepted_at !== 'string') {
    logger.error('[' + TAG + '] RPC の戻り値が契約と異なります。');
    return json(500, { error: 'internal_error' });
  }

  // DB が別の版 / locale を返したら異常。黙って成功にしない。
  if (row.terms_version !== termsVersion || row.locale !== pre.value.locale) {
    logger.error('[' + TAG + '] RPC の戻り値が要求と一致しません。');
    return json(500, { error: 'internal_error' });
  }

  // **id と user_id は返さない。** 利用者が確認したいのは
  // 「どの版へ、どの言語で、いつ同意したか」だけ。
  return json(200, {
    accepted: true,
    terms_version: row.terms_version,
    locale: row.locale,
    accepted_at: row.accepted_at,
  });
}

/** Cloudflare Pages Functions: POST のエントリポイント */
export async function onRequestPost(context) {
  return handleTermsConsent(context.request, context.env);
}

/**
 * Cloudflare Pages Functions: POST 以外のフォールバック。
 * preflight 側でも method を検査しているので 405 になる。
 */
export async function onRequest(context) {
  return handleTermsConsent(context.request, context.env);
}

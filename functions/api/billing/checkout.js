// =========================================================
// POST /api/billing/checkout — Stripe Checkout Session を作る
//
//   Cloudflare Pages Functions（ファイルパス = ルート）。
//   functions/api/billing/checkout.js -> /api/billing/checkout
//
//   処理の流れ（preflight が 1〜4 を担当する）:
//     1. POST 以外は 405
//     2. Origin 検証（CSRF）                         -> 403
//     3. JSON body 検証                              -> 400 / 413
//     4. Cookie session                              -> 401 / 500 / 502
//     5. **現行の terms_version を server が決める**  -> 取れなければ 503
//     6. **販売可否と Price を server が決める**      -> 売れなければ 503
//     7. get_checkout_context を 1 回だけ呼ぶ         -> 契約状態 / Customer / 同意
//     8. 二重契約と同意未了を弾く                     -> 409
//     9. Stripe へ Checkout Session を 1 回作る
//
//   設計上の約束（ここが本 API の肝）:
//     - **client から受け取るのは `locale` と `age_confirmed` だけ。**
//       price ID / 金額 / 通貨 / 国 / plan / phase / terms_version / user_id は
//       **1 つも受け取らない。** body に余計なキーがあれば 400 で拒否する
//       （consent API と同じ。黙って無視しない）。
//     - **価格解決の入口は `resolvePurchasablePrice()` だけ。**
//       `resolvePriceDefinition()` を直接呼ぶと販売停止国・停止通貨を素通りする
//       （billing-config.js 13 節）。
//     - **国と通貨も client に選ばせない。** いま販売できる組み合わせが
//       1 つに定まらなければ **売らない**（fail closed）。
//       販売地域を広げるときは、ここを意図的に直す必要がある。
//     - **user_id の正は session。** metadata へは session の値だけを載せる。
//     - **entitlement はここで付与しない。** 付与するのは webhook だけ
//       （初回決済の成功前に Pro にしない）。この API は DB を 1 行も書かない。
//     - **subscription_data.metadata.user_id を必ず入れる。**
//       webhook は取り直した subscription の metadata.user_id を
//       正として plan を反映するため、ここが欠けると課金が紐付かない。
//     - **1 user = 1 active subscription。** 既に有効な契約があれば 409。
//     - **1 user = 1 Stripe Customer。** 既知の Customer があれば必ず再利用する。
//       無い場合は customer を渡さない（Checkout の完了時に Stripe が 1 つ作り、
//       webhook が `stripe_customer_id` へ記録する）。中断された Checkout では
//       Customer が作られないため、孤児の Customer は生まれない。
//     - **応答にも log にも PII を出さない。**
//       user_id / customer id / email / session token / Checkout の URL は
//       ログに出さない。返すのは Checkout の URL と有効期限だけ。
//
//   レスポンス:
//     200 { url, expires_at }
//     400 { error: 'invalid_locale' | 'age_confirmation_required' | 'unknown_field'
//                 | 'invalid_body' | 'malformed_json' | 'invalid_content_type' }
//     401 { error: 'unauthenticated' }
//     403 { error: 'forbidden_origin' }
//     405 { error: 'method_not_allowed' }
//     409 { error: 'already_subscribed' | 'terms_consent_required' }
//     413 { error: 'body_too_large' }
//     500 { error: 'internal_error' | 'server_misconfigured' }
//     502 { error: 'database_unavailable' | 'payment_provider_unavailable' }
//     503 { error: 'terms_not_available' | 'sales_unavailable' }
//
//   ⚠ この API は migration 20260909051500（get_checkout_context）が
//     適用済みの環境でしか動かない。未適用なら RPC が無く 502 になる
//     （production では deploy 前に適用する）。
//   成功 / キャンセル後の戻り先ページは public/billing/ にある。
//   ⚠ `automatic_tax` は有効にしない。税の登録判断が未決のため、
//     JPY の税込 Price をそのまま使う。
// =========================================================

import {
  PURCHASABLE_COUNTRIES,
  PURCHASABLE_CURRENCIES,
  getCurrentSubscriptionTermsVersion,
  isSupportedTermsLocale,
  resolvePurchasablePrice,
} from '../_lib/billing-config.js';
import { getAllowedOrigins } from '../_lib/origin.js';
import { StripeApiError, stripeRequest } from '../_lib/stripe.js';
import { callRpc } from '../_lib/supabase.js';
import { json, mapRpcError, preflight, readSingleRow } from '../_lib/quota.js';

/** migration 20260909051500 で作成した読み取り専用 RPC。 */
export const RPC_NAME = 'get_checkout_context';

/** Stripe の Checkout Session 作成エンドポイント。 */
export const CHECKOUT_PATH = '/v1/checkout/sessions';

const TAG = 'billing-checkout';

/** 販売するプランと課金間隔。**client からは受け取らない。** */
export const CHECKOUT_PLAN_ID = 'web_pro';
export const CHECKOUT_INTERVAL = 'month';

/**
 * body で受け付けるキー。**これ以外は拒否する。**
 *
 * `price_id` / `amount` / `currency` / `country` / `plan_id` / `user_id` /
 * `terms_version` を受け取らないことが、この API の安全性の中心。
 */
export const ALLOWED_BODY_KEYS = Object.freeze(['locale', 'age_confirmed']);

/**
 * **再契約してよい status。**
 *
 * Stripe 側に subscription が残っている状態（active / trialing / past_due /
 * unpaid / incomplete）で新しい Checkout を始めると、
 * 1 人が 2 本の subscription を持ってしまう。ここは狭く保つこと。
 */
export const RESUBSCRIBABLE_STATUSES = Object.freeze(['canceled', 'incomplete_expired']);

/** 戻り先（ページ本体は public/billing/）。 */
export const SUCCESS_PATH = '/billing/success';
export const CANCEL_PATH = '/billing/cancel';

/** 購入前に確認できるようにする法定表示のページ。 */
export const TERMS_PATH_BY_LOCALE = Object.freeze({
  ja: '/terms/subscription',
  en: '/terms/subscription/en',
});
export const COMMERCIAL_TRANSACTIONS_PATH = '/legal/commercial-transactions';


// =========================================================
// 1. body 検証
// =========================================================

/**
 * body 検証。
 *
 * locale は**正規化しない**（'JA' は 'ja' へ寄せずに拒否する）。
 * age_confirmed は **厳密に true** のみ受け付ける。
 * 'true' / 1 / 'on' を真として扱わないのは、
 * 「18 歳以上であることを利用者が明示した」以外の入力で
 * 年齢確認が通ってしまう経路を作らないため。
 *
 * @param {object} body
 * @returns {{ok:true,value:{locale:string,age_confirmed:true}}|{ok:false,code:string}}
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
  if (body.age_confirmed !== true) {
    return { ok: false, code: 'age_confirmation_required' };
  }
  return { ok: true, value: { locale: body.locale, age_confirmed: true } };
}


// =========================================================
// 2. 販売できる市場（国 / 通貨）
// =========================================================

/**
 * **いま販売する国と通貨を server が決める。**
 *
 * 現在は「日本 / 日本円」の 1 組だけ（billing-config.js 13 節）。
 * 販売地域が増えて組み合わせが一意でなくなったら、
 * **どう選ぶかを決めるまで売らない**（fail closed）。
 * client に国や通貨を選ばせる形へ勝手に倒さないための構造。
 *
 * @returns {{ok:true,country:string,currency:string}|{ok:false,code:string}}
 */
export function resolveCheckoutMarket() {
  if (PURCHASABLE_COUNTRIES.length !== 1 || PURCHASABLE_CURRENCIES.length !== 1) {
    return { ok: false, code: 'ambiguous_market' };
  }
  return { ok: true, country: PURCHASABLE_COUNTRIES[0], currency: PURCHASABLE_CURRENCIES[0] };
}


// =========================================================
// 3. 契約状態の判定
// =========================================================

/**
 * 新しい Checkout を始めてよいか。
 *
 * 判定材料は **DB（get_checkout_context）の行**。session context ではない。
 * 2 か所を見ると片方が古いときに二重契約が通り得るため、正を 1 つにする。
 *
 * @param {object} row RPC の 1 行
 * @returns {{ok:true}|{ok:false,code:string}}
 */
export function canStartCheckout(row) {
  const planId = row?.plan_id;
  const status = row?.status;
  if (typeof planId !== 'string' || typeof status !== 'string') {
    return { ok: false, code: 'invalid_context' };
  }
  // 無料プランなら Stripe 側に subscription が無い。
  if (planId === 'free') return { ok: true };
  // 有料プランでも、契約が終了していれば再契約できる。
  if (RESUBSCRIBABLE_STATUSES.includes(status)) return { ok: true };
  return { ok: false, code: 'already_subscribed' };
}

/**
 * 既知の Stripe Customer を取り出す。
 *
 * 無い / 空 / 文字列でないときは null（= Checkout に customer を渡さない）。
 * **でっち上げない。**
 *
 * @param {object} row
 * @returns {string|null}
 */
export function readCustomerId(row) {
  const raw = row?.stripe_customer_id;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}


// =========================================================
// 4. Stripe へ渡す params
// =========================================================

/**
 * 戻り先と法定表示ページの絶対 URL の基点。
 *
 * Origin 検証（`checkOrigin`）と**同じ allowlist の先頭**を使う。
 * リクエストの Origin をそのまま使わないのは、
 * 許可済みの origin が複数あるときに戻り先が揺れないようにするため。
 *
 * @param {object} env
 * @returns {string|null}
 */
export function resolveSiteOrigin(env) {
  const origins = getAllowedOrigins(env);
  return origins.length > 0 ? origins[0] : null;
}

/**
 * 購入前に確認できる法定表示ページの URL。
 *
 * **特定商取引法に基づく表記へ導線を張れる構造**にしておくのが目的
 * （公開済み）。Pricing / 確認画面も
 * ここを使うことで、URL が 2 か所に散らばらない。
 *
 * @param {string} origin
 * @param {string} locale
 * @returns {{subscription_terms:string, commercial_transactions:string}}
 */
export function buildLegalUrls(origin, locale) {
  const termsPath = TERMS_PATH_BY_LOCALE[locale] ?? TERMS_PATH_BY_LOCALE.ja;
  return {
    subscription_terms: origin + termsPath,
    commercial_transactions: origin + COMMERCIAL_TRANSACTIONS_PATH,
  };
}

/**
 * Checkout 画面の最終確認文。**表示は Stripe 側で行われる。**
 *
 * @param {string} locale
 * @param {{subscription_terms:string, commercial_transactions:string}} legal
 * @returns {string}
 */
export function buildSubmitMessage(locale, legal) {
  if (locale === 'en') {
    return 'Before you subscribe, please review the Subscription Terms ('
      + legal.subscription_terms + ') and the notice based on the Japanese Act on '
      + 'Specified Commercial Transactions (' + legal.commercial_transactions
      + '). Your subscription renews automatically every month.';
  }
  return 'ご購入の前に、サブスクリプション利用規約（' + legal.subscription_terms
    + '）と特定商取引法に基づく表記（' + legal.commercial_transactions
    + '）をご確認ください。お支払いは毎月自動で更新されます。';
}

/**
 * Checkout Session の params を組み立てる**純粋関数**。
 *
 * Stripe へは送らないので、テストから中身をそのまま検証できる。
 *
 * metadata に載せるもの:
 *   user_id        webhook が契約を利用者へ紐付ける唯一の手掛かり
 *   plan_id        診断用（**plan の正は price mapping**。webhook は見ない）
 *   price_phase    launch / standard の記録（server が決めた値）
 *   terms_version  同意させた版（server config が正）
 *   terms_locale   表示していた言語
 *   age_confirmed  18 歳以上の申告（+ 申告時刻）。DB に列が無いため
 *                  Stripe 側を監査記録の置き場にしている
 *
 * @param {object} o
 * @returns {object}
 */
export function buildCheckoutParams(o) {
  const {
    userId, priceId, planId, phase, termsVersion, locale, origin,
    customerId = null, confirmedAt,
  } = o;

  const legal = buildLegalUrls(origin, locale);
  const metadata = {
    user_id: userId,
    plan_id: planId,
    price_phase: phase,
    terms_version: termsVersion,
    terms_locale: locale,
    age_confirmed: 'true',
    age_confirmed_at: confirmedAt,
  };

  const params = {
    mode: 'subscription',
    locale,
    line_items: [{ price: priceId, quantity: 1 }],
    // 請求先の国を取得しておく（webhook 側で請求先国を検証するため）。
    billing_address_collection: 'required',
    // Stripe の Promotion Code 入力欄を出す。
    // **クーポンの正は Stripe 側**で、独自のクーポン DB もコードへのハードコードも持たない。
    //
    // **Sukima では duration=once のクーポン運用に限定する（継続割引は扱わない）。**
    // launch -> standard の Subscription Schedule は phases を明示指定しており discounts を持たないため
    // （billing-schedule.js の buildDesiredScheduleParams）、
    // repeating / forever の継続割引は schedule 作成時に失われる。
    //
    // plan / phase の判定は price_id だけを見るので、
    // 割引で請求額が下がっても ¥300 -> ¥500 の移行判定は変わらない。
    allow_promotion_codes: true,
    success_url: origin + SUCCESS_PATH + '?session_id={CHECKOUT_SESSION_ID}',
    cancel_url: origin + CANCEL_PATH,
    metadata: { ...metadata },
    // **webhook はこちらの metadata を正とする。**
    subscription_data: { metadata: { ...metadata } },
    custom_text: { submit: { message: buildSubmitMessage(locale, legal) } },
  };
  // 既知の Customer があるときだけ再利用する（1 user = 1 Customer）。
  if (customerId !== null) {
    params.customer = customerId;
    // **再契約時に Stripe Customer の住所を最新化する**。
    //
    // これが無いと、初回に日本の住所で契約した利用者が
    // 再契約時に別の国の請求先住所を入れても Customer 側は古い住所のままになり、
    // 「Customer の住所で販売国を判定する」という守り方が効かなくなる。
    //
    // **`customer_update` は `customer` と一緒でなければ使えない**
    // （Stripe が `customer_update can only be used with customer` を返す）。
    //   新規利用者のときは Checkout が
    //   請求先住所を入れた Customer を作るので、そもそも更新が要らない。
    params.customer_update = { address: 'auto' };
  }

  return params;
}

/**
 * Idempotency-Key。
 *
 * 同じ利用者が同じ日に **まったく同じ内容で**押し直したときは
 * 同じ Checkout Session を返す（二重に作らない）。
 *
 * **キーに params のハッシュを含めるのが肝。**
 * Stripe は「同じキーで違う params」を **エラーにする**。
 * 例えば同じ日のうちに
 *   1 回目: customer 無しで Checkout（新規契約）
 *   -> webhook が stripe_customer_id を記録
 *   2 回目: 解約後の再契約（customer あり）
 * と進むと params が変わるため、日付＋phase＋locale だけのキーでは
 * 2 回目が弾かれて 502 になる。
 * params が 1 文字でも変われば別のキーになる形にしておけば、この事故は起きない。
 *
 * @param {string} userId
 * @param {number} nowMs
 * @param {object} params Stripe へ送る params（buildCheckoutParams の戻り値）
 * @returns {Promise<string>}
 */
export async function buildIdempotencyKey(userId, nowMs, params) {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(params)),
  );
  const bytes = new Uint8Array(digest);
  let hex = '';
  // 先頭 8 バイトで十分（同一利用者・同一日のなかでの区別にしか使わない）。
  for (let i = 0; i < 8; i += 1) hex += bytes[i].toString(16).padStart(2, '0');
  return ['checkout', userId, day, hex].join(':');
}


// =========================================================
// 5. Stripe エラーの写し取り
// =========================================================

/**
 * Stripe 呼び出しの失敗を HTTP レスポンスへ写す。
 *
 * **e.message はログに出さない。** scrub 済みとはいえ Stripe の本文が入るため、
 * 分類コードと Request-Id だけを残す。
 *
 * @param {unknown} e
 * @param {string} tag
 * @param {object} logger
 * @returns {Response}
 */
export function mapStripeError(e, tag, logger) {
  if (e instanceof StripeApiError) {
    if (e.code === 'not_configured') {
      logger.error('[' + tag + '] Stripe 設定エラー。');
      return json(500, { error: 'server_misconfigured' });
    }
    if (e.code === 'invalid_request') {
      // 送る前のローカル検査で落ちた = こちらの実装バグ。
      logger.error('[' + tag + '] Stripe へ渡す引数が不正です。');
      return json(500, { error: 'internal_error' });
    }
    logger.error('[' + tag + '] Stripe エラー(' + e.code + ')',
      'stripe_code=' + (e.stripeCode ?? 'none'),
      'request_id=' + (e.requestId ?? 'none'));
    return json(502, { error: 'payment_provider_unavailable' });
  }
  logger.error('[' + tag + '] 予期しない Stripe エラー:', e);
  return json(500, { error: 'internal_error' });
}


// =========================================================
// 6. ハンドラ
// =========================================================

/**
 * Checkout Session を作る。
 *
 * @param {Request} request
 * @param {object} env
 * @param {object} [deps]
 * @param {Function} [deps.rpc]            Supabase RPC（テストで差し替える）
 * @param {Function} [deps.stripe]         Stripe 呼び出し（テストで差し替える）
 * @param {Function} [deps.currentVersion] 現行版の取得
 * @param {Function} [deps.now]            現在時刻（epoch ms を返す）
 * @param {object}   [deps.logger]
 */
export async function handleBillingCheckout(request, env, deps = {}) {
  const {
    rpc = callRpc,
    stripe = stripeRequest,
    logger = console,
    currentVersion = getCurrentSubscriptionTermsVersion,
    now = Date.now,
  } = deps;

  // 1〜4: method / Origin / body / session
  const pre = await preflight(request, env, deps, { tag: TAG, validate });
  if (pre.response) return pre.response;

  // 5: 現行版は **server が決める**。draft なら例外になり、ここで止まる。
  let termsVersion;
  try {
    termsVersion = currentVersion();
  } catch (e) {
    logger.warn('[' + TAG + '] 規約の現行版を取得できません:', e?.code ?? 'unknown');
    return json(503, { error: 'terms_not_available' });
  }
  if (typeof termsVersion !== 'string' || termsVersion.length === 0) {
    logger.error('[' + TAG + '] 現行版が文字列ではありません。');
    return json(503, { error: 'terms_not_available' });
  }

  // 6: 販売可否と Price。**resolvePurchasablePrice() だけを使う。**
  const market = resolveCheckoutMarket();
  if (!market.ok) {
    logger.error('[' + TAG + '] 販売できる国と通貨が一意に決まりません:', market.code);
    return json(503, { error: 'sales_unavailable' });
  }
  const nowMs = now();
  const price = resolvePurchasablePrice(
    CHECKOUT_PLAN_ID, market.country, market.currency, CHECKOUT_INTERVAL, nowMs,
  );
  if (!price.ok) {
    logger.warn('[' + TAG + '] いま販売できません:', price.code);
    return json(503, { error: 'sales_unavailable' });
  }

  // Price ID の実値は env にしかない。**値はログにもエラーにも出さない。**
  const rawPriceId = env?.[price.definition.price_id_env_key];
  const priceId = typeof rawPriceId === 'string' ? rawPriceId.trim() : '';
  if (priceId.length === 0) {
    logger.error('[' + TAG + '] Price ID の環境変数が未設定です:',
      price.definition.price_id_env_key);
    return json(500, { error: 'server_misconfigured' });
  }

  // 7: 契約状態 / Customer / 同意有無を 1 往復で読む。**書き込みはしない。**
  let rows;
  try {
    rows = await rpc(
      RPC_NAME,
      { p_user_id: pre.context.user_id, p_terms_version: termsVersion },
      { env },
    );
  } catch (e) {
    return mapRpcError(e, TAG, logger);
  }

  const row = readSingleRow(rows);
  if (row === null) {
    logger.error('[' + TAG + '] RPC の戻り値が契約と異なります。');
    return json(500, { error: 'internal_error' });
  }

  // 8: 二重契約と同意未了。**Stripe を呼ぶ前に落とす。**
  const startable = canStartCheckout(row);
  if (!startable.ok) {
    if (startable.code === 'invalid_context') {
      logger.error('[' + TAG + '] 契約状態を判定できません。');
      return json(500, { error: 'internal_error' });
    }
    logger.warn('[' + TAG + '] 既に契約があるため Checkout を開始しません。');
    return json(409, { error: 'already_subscribed' });
  }

  if (row.terms_consented !== true) {
    // 同意はここで記録しない。/api/terms/consent を先に通すこと。
    logger.warn('[' + TAG + '] 現行版の規約へ同意していません。');
    return json(409, { error: 'terms_consent_required' });
  }

  // 9: Checkout Session を 1 回だけ作る。
  const siteOrigin = resolveSiteOrigin(env);
  if (siteOrigin === null) {
    logger.error('[' + TAG + '] 戻り先の origin を決められません。');
    return json(500, { error: 'server_misconfigured' });
  }

  const params = buildCheckoutParams({
    userId: pre.context.user_id,
    priceId,
    planId: CHECKOUT_PLAN_ID,
    phase: price.phase,
    termsVersion,
    locale: pre.value.locale,
    origin: siteOrigin,
    customerId: readCustomerId(row),
    confirmedAt: new Date(nowMs).toISOString(),
  });

  let session;
  try {
    session = await stripe({
      env,
      method: 'POST',
      path: CHECKOUT_PATH,
      params,
      idempotencyKey: await buildIdempotencyKey(pre.context.user_id, nowMs, params),
    });
  } catch (e) {
    return mapStripeError(e, TAG, logger);
  }

  // Checkout の URL が無ければ成功にしない（利用者を行き先の無い画面へ送らない）。
  const url = session?.url;
  if (typeof url !== 'string' || !url.startsWith('https://')) {
    logger.error('[' + TAG + '] Checkout Session の URL を取得できませんでした。');
    return json(502, { error: 'payment_provider_unavailable' });
  }

  // **返すのは URL と有効期限だけ。** session id / customer id / user_id は返さない。
  return json(200, {
    url,
    expires_at: typeof session.expires_at === 'number' ? session.expires_at : null,
  });
}

/** Cloudflare Pages Functions: POST のエントリポイント */
export async function onRequestPost(context) {
  return handleBillingCheckout(context.request, context.env);
}

/**
 * Cloudflare Pages Functions: POST 以外のフォールバック。
 * preflight 側でも method を検査しているので 405 になる。
 */
export async function onRequest(context) {
  return handleBillingCheckout(context.request, context.env);
}

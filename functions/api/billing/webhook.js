// =========================================================
// POST /api/billing/webhook — Stripe webhook 受信
//
//   Cloudflare Pages Functions（ファイルパス = ルート）。
//   functions/api/billing/webhook.js → /api/billing/webhook
//
//   処理の流れ:
//     1. POST 以外は 405
//     2. **生ボディ**を読む（JSON.parse する前）
//     3. Stripe-Signature を検証する（これだけが認証根拠）
//     4. 署名が通ってから JSON.parse する
//     5. 対象 event かを判定。対象外は 200 ignored（DB に記録しない）
//     6. event から subscription ID を取り出す
//     7. **Stripe API から subscription の現在値を取り直す**
//     8. price_id から plan / currency / phase を引く（billing-config）
//     9. metadata から内部 user_id を取り出す
//    10. **Stripe Customer を取り直して請求先国を判定する**
//    11. `apply_stripe_subscription_event` を**1 回だけ**呼ぶ
//    12. **launch -> standard の Subscription Schedule を reconcile する**
//        `_lib/billing-schedule.js`。対象外なら Stripe を追加で呼ばない。
//        収束できなければ 2xx にせず、Stripe の再送でやり直す
//
//   設計上の約束:
//     - **Cookie session を要求しない。** サーバー間 POST なので Cookie は来ない。
//     - **`_lib/origin.js` の checkOrigin を import しない。**
//       Origin が無いのが正常で、認証根拠は署名のみ（origin.js に明記されている方針）。
//     - **webhook payload の subscription 状態をそのまま信用しない。**
//       payload は古いことがあるため、必ず Stripe API から取り直した
//       snapshot を正とする（順不同 event への一次防御）。
//     - **plan の正は price mapping。** metadata.plan_id は診断用にしか見ない。
//     - **販売対象外の国へ entitlement を一瞬も与えない。**
//       DB を書く前に必ず Customer の請求先国を判定する。
//       判定元を checkout.session.completed にしないのは、それが
//       customer.subscription.created / invoice.payment_succeeded より**後**に
//       届くため。Customer の住所なら customer.created の時点で入っており、
//       どの event を処理するときも DB を書く前に読める。
//       国が**分からない**ときは fail closed（Pro を与えない）に留め、
//       解約も返金もしない。retry 可能な失敗として返し、Stripe の再送で再評価する。
//     - **冪等性は DB に委ねる。** HTTP 層で独自の重複管理をしない。
//       `stripe_events` の PK と apply_stripe_subscription_event RPC が最終防衛線。
//     - secret / 生ボディ / user_id / customer id をログに出さない。
//
//   必要な環境変数（context.env から読む）:
//     STRIPE_WEBHOOK_SECRET   署名検証用。クライアントへは絶対に渡さない
//     STRIPE_SECRET_KEY       subscription 再取得用
//     STRIPE_PRICE_*          price_id の逆引き用（billing-config）
//     SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
//
//   レスポンス:
//     200 { received: true, ... }                     受理（適用 / 重複 / 古い / 対象外）
//     400 { error: 'invalid_signature' | 'invalid_payload' | 'invalid_event' }
//     405 { error: 'method_not_allowed' }
//     500 { error: 'server_misconfigured' | 'internal_error' }
//     502 { error: 'stripe_unavailable' | 'database_unavailable'
//                 | 'country_unverified' | 'remediation_failed'
//                 | 'schedule_reconcile_failed' }
//
//   2xx 以外は Stripe が再送する。再送しても直らない失敗（未知の price 等）は
//   500 にして運用で気づけるようにしてある。
// =========================================================

import { priceDefinitionFromPriceId } from '../_lib/billing-config.js';
import { COUNTRY_STATUS, classifyCustomerCountry } from '../_lib/billing-country.js';
import { remediateNotSellableCountry } from '../_lib/billing-remediation.js';
import { ensureLaunchToStandardSchedule } from '../_lib/billing-schedule.js';
import { StripeApiError, stripeRequest } from '../_lib/stripe.js';
import { StripeSignatureError, verifyStripeWebhookSignature } from '../_lib/stripe-webhook.js';
import { SupabaseError, callRpc } from '../_lib/supabase.js';

/** 署名ヘッダ名。 */
export const SIGNATURE_HEADER = 'Stripe-Signature';

/** subscription snapshot を適用する対象の event。これ以外は 200 ignored。 */
export const HANDLED_EVENT_TYPES = Object.freeze([
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.payment_failed',
  'invoice.payment_succeeded',
]);

/** DB RPC 名（migration 20260907052839 で作成）。 */
const RPC_APPLY = 'apply_stripe_subscription_event';

/** UUID v4 に限定せず、内部 user_id の形だけ確認する。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}


// =========================================================
// 1. Stripe オブジェクトの読み取りヘルパー
//
//    Stripe は同じ項目を「ID 文字列」で返すことも「展開したオブジェクト」で
//    返すこともある（expand の有無や API version による）。
//    片方だけを前提にすると壊れるので、両方を安全に扱う。
// =========================================================

/**
 * 'sub_123' でも { id: 'sub_123' } でも ID 文字列を取り出す。
 * 取り出せなければ null。
 */
export function readStripeId(value) {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  if (value && typeof value === 'object' && typeof value.id === 'string' && value.id.length > 0) {
    return value.id;
  }
  return null;
}

/**
 * event から subscription ID を取り出す。
 *
 * event type ごとに位置が違い、さらに Stripe の API version によっても変わる。
 * **1 つの shape へ決め打ちしない**で、既知の場所を順に見る。
 *
 *   customer.subscription.*      -> data.object.id
 *   checkout.session.completed   -> data.object.subscription
 *   invoice.*                    -> data.object.subscription
 *                                   （新しい版では
 *                                     data.object.parent.subscription_details.subscription）
 *                                   最後の保険として lines.data[*].subscription も見る
 *
 * **Stripe API version ごとの位置:**
 *
 *   | 経路                                                   | 2023-08-16 | 2025-03-31.basil 以降 |
 *   | data.object.subscription                               | あり       | **なし**              |
 *   | data.object.parent.subscription_details.subscription   | あり       | あり                  |
 *   | lines.data[0].subscription                             | あり       | **なし**              |
 *   | lines.data[0].parent.subscription_item_details.sub...  | あり       | あり                  |
 *
 *   確認した版: 2023-08-16 / 2025-03-31.basil / 2025-08-27.basil / 2025-09-30.clover
 *   （invoice.payment_succeeded / invoice.payment_failed の両方で同一）
 *
 * **4 経路すべてを残す。** parent 経路は全版で有効で、
 * lines 経路は一度も追加カバレッジを生まなかった。それでも消さないのは、
 * subscription 明細を含むが invoice 自体の parent が subscription ではない invoice
 * （手動作成の invoice に保留中の subscription item が載る等）で
 * 明細行側だけが subscription を持ち得るため。
 * ここで取りこぼすと **500 ではなく 200 ignored** になり、
 * 課金状態のずれに気づけないまま静かに落ちる。誤検知より取りこぼしの方が高くつく。
 *
 * subscription に紐づかない event（買い切りの checkout、
 * subscription 以外の invoice）は null を返し、呼び出し側が 200 ignored にする。
 *
 * @returns {string|null}
 */
export function extractSubscriptionId(eventType, obj) {
  if (!obj || typeof obj !== 'object') return null;

  if (typeof eventType === 'string' && eventType.startsWith('customer.subscription.')) {
    return readStripeId(obj.id);
  }

  // checkout / invoice に共通する一次候補
  const direct = readStripeId(obj.subscription);
  if (direct) return direct;

  // 新しい API version の invoice はここに入る
  const fromParent = readStripeId(obj?.parent?.subscription_details?.subscription);
  if (fromParent) return fromParent;

  // 最後の保険。明細行のどれかが subscription を持っていれば拾う。
  const lines = obj?.lines?.data;
  if (Array.isArray(lines)) {
    for (const line of lines) {
      const fromLine = readStripeId(line?.subscription)
        ?? readStripeId(line?.parent?.subscription_item_details?.subscription);
      if (fromLine) return fromLine;
    }
  }

  return null;
}

/**
 * subscription の items から price_id を取り出す。
 *
 * 複数 item は仕様上あり得るが、Sukima は
 * 「1 user = 1 subscription = 1 plan」なので**ちょうど 1 件**を要求する。
 * 2 件以上なら想定外の構成なので fail closed（呼び出し側が 500 にする）。
 *
 * @returns {{ok:true, priceId:string} | {ok:false, code:string}}
 */
export function extractPriceId(subscription) {
  const items = subscription?.items?.data;
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, code: 'missing_items' };
  }
  if (items.length > 1) {
    return { ok: false, code: 'multiple_items' };
  }
  const priceId = readStripeId(items[0]?.price);
  if (!priceId) return { ok: false, code: 'missing_price' };
  return { ok: true, priceId };
}

/**
 * Stripe の Unix 秒を ISO 8601（UTC）へ。
 * 数値でなければ null（欠落と不正を同じに扱う）。
 */
export function unixToIso(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return null;
  const ms = Math.trunc(seconds) * 1000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * subscription の期間終了時刻を取り出す。
 *
 * `current_period_end` は subscription 直下にある版と、
 * items[0] 側にある版がある。両方を見る。
 *
 * **Stripe API version ごとの位置:**
 *
 *   | 位置                          | 2023-08-16 | 2025-03-31.basil 以降 |
 *   | subscription 直下             | あり       | **なし**              |
 *   | items.data[0]                 | あり       | あり                  |
 *
 * 新しい版では直下が消えるため、**items[0] の経路が実際に効いている**。
 * `STRIPE_API_VERSION=2025-09-30.clover` を固定した状態で
 * 実 webhook -> 実再取得 -> 実 DB まで通し、値が欠落しないことを確認済み。
 */
export function extractCurrentPeriodEnd(subscription) {
  const direct = unixToIso(subscription?.current_period_end);
  if (direct) return direct;
  const items = subscription?.items?.data;
  if (Array.isArray(items) && items.length > 0) {
    return unixToIso(items[0]?.current_period_end);
  }
  return null;
}


// =========================================================
// 2. snapshot -> DB RPC 引数
// =========================================================

/** DB の CHECK と同じ集合。ここで弾いてから RPC へ渡す。 */
const DB_STATUSES = Object.freeze([
  'active', 'trialing', 'past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired',
]);

/**
 * 取り直した subscription snapshot を、apply_stripe_subscription_event の引数へ写す。
 *
 * ここが「Stripe の語彙」から「Sukima の語彙」への唯一の変換点。
 * 欠けているもの・引けないものは**すべて fail closed**（推測で埋めない）。
 *
 * @param {object} subscription Stripe から取り直した subscription
 * @param {object} env          price_id 逆引き用（STRIPE_PRICE_*）
 * @returns {{ok:true, snapshot:object} | {ok:false, code:string}}
 */
export function buildSnapshot(subscription, env) {
  if (!subscription || typeof subscription !== 'object') {
    return { ok: false, code: 'invalid_subscription' };
  }

  const subscriptionId = readStripeId(subscription.id);
  if (!subscriptionId) return { ok: false, code: 'missing_subscription_id' };

  // customer は string でも展開済みオブジェクトでも来る
  const customerId = readStripeId(subscription.customer);
  if (!customerId) return { ok: false, code: 'missing_customer' };

  const status = subscription.status;
  if (typeof status !== 'string' || !DB_STATUSES.includes(status)) {
    return { ok: false, code: 'unsupported_status' };
  }

  // --- price -> plan / currency / phase ---
  //   **plan の正は price mapping**。metadata.plan_id は見ない（診断用にも使わない）。
  const priceResult = extractPriceId(subscription);
  if (!priceResult.ok) return { ok: false, code: priceResult.code };

  const mapped = priceDefinitionFromPriceId(priceResult.priceId, env);
  if (!mapped.ok) return { ok: false, code: mapped.code };
  const { plan_id: planId, currency, phase } = mapped.definition;

  // --- user_id ---
  //   Checkout が subscription.metadata.user_id を必ず設定する前提。
  //   **event payload 側の metadata ではなく、取り直した subscription の
  //   metadata を正とする。**
  const userId = subscription?.metadata?.user_id;
  if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
    return { ok: false, code: 'invalid_metadata_user_id' };
  }

  // --- cancel_at_period_end ---
  //   RPC は BOOLEAN 必須。欠落を勝手に false へ倒さず fail closed にする
  //   （「解約予約が無い」のか「取得できていない」のかを取り違えないため）。
  const cancelAtPeriodEnd = subscription.cancel_at_period_end;
  if (typeof cancelAtPeriodEnd !== 'boolean') {
    return { ok: false, code: 'invalid_cancel_at_period_end' };
  }

  return {
    ok: true,
    snapshot: {
      userId,
      planId,
      status,
      customerId,
      subscriptionId,
      priceId: priceResult.priceId,
      currency,
      phase,
      currentPeriodEnd: extractCurrentPeriodEnd(subscription),
      cancelAtPeriodEnd,
    },
  };
}


// =========================================================
// 3. ハンドラ本体
// =========================================================

/** 対象外 event の応答。Stripe に再送させないため必ず 2xx。 */
const IGNORED = { received: true, ignored: true };

/**
 * webhook 受信の本体。
 * テストから直接呼べるよう、request / env / 差し替え可能な依存を引数で受ける。
 *
 * @param {Request} request
 * @param {object}  env
 * @param {object}  [deps.rpc]       callRpc 差し替え
 * @param {object}  [deps.fetchImpl] Stripe 呼び出しの fetch 差し替え
 * @param {object}  [deps.logger]
 * @param {number|Date} [deps.now]   署名の tolerance 判定に使う基準時刻
 */
export async function handleWebhook(request, env, deps = {}) {
  const { rpc = callRpc, fetchImpl, logger = console, now } = deps;

  if (request.method !== 'POST') {
    return json(405, { error: 'method_not_allowed' });
  }

  const webhookSecret = env?.STRIPE_WEBHOOK_SECRET;
  if (typeof webhookSecret !== 'string' || webhookSecret.length === 0) {
    // 値そのものは出さない。設定漏れであることだけを記録する。
    logger.error('[billing-webhook] STRIPE_WEBHOOK_SECRET が未設定です。');
    return json(500, { error: 'server_misconfigured' });
  }

  // --- 生ボディ ---
  //   署名検証より前に JSON.parse しない。バイト列が変わると必ず失敗する。
  //   _lib/request-body.js は使わない（あちらは JSON 前提で本文を加工するため）。
  let rawBody;
  try {
    rawBody = await request.text();
  } catch {
    logger.error('[billing-webhook] 本文を読み取れませんでした。');
    return json(400, { error: 'invalid_payload' });
  }

  // --- 署名検証（唯一の認証根拠）---
  try {
    await verifyStripeWebhookSignature({
      rawBody,
      header: request.headers.get(SIGNATURE_HEADER),
      secret: webhookSecret,
      now,
    });
  } catch (e) {
    if (e instanceof StripeSignatureError) {
      // 理由は内部ログだけ。応答は一律 invalid_signature にして、
      // 攻撃者に「どこまで合っていたか」を教えない。
      logger.error('[billing-webhook] 署名検証に失敗しました:', e.reason);
      return json(400, { error: 'invalid_signature' });
    }
    logger.error('[billing-webhook] 署名検証で想定外のエラーが発生しました。');
    return json(500, { error: 'internal_error' });
  }

  // --- ここから先は Stripe から来たことが確定している ---
  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    logger.error('[billing-webhook] 本文を JSON として解釈できませんでした。');
    return json(400, { error: 'invalid_payload' });
  }

  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return json(400, { error: 'invalid_event' });
  }
  const eventId = typeof event.id === 'string' && event.id.length > 0 ? event.id : null;
  const eventType = typeof event.type === 'string' && event.type.length > 0 ? event.type : null;
  const eventCreatedAt = unixToIso(event.created);
  if (!eventId || !eventType || !eventCreatedAt) {
    logger.error('[billing-webhook] event の形が想定と異なります。');
    return json(400, { error: 'invalid_event' });
  }

  // --- 対象外 event は DB に触れずに終わる ---
  if (!HANDLED_EVENT_TYPES.includes(eventType)) {
    return json(200, IGNORED);
  }

  const dataObject = event?.data?.object;
  const subscriptionId = extractSubscriptionId(eventType, dataObject);
  if (!subscriptionId) {
    // 買い切りの checkout や subscription に紐づかない invoice。
    // 正常な event なので 200（再送させない）。
    logger.error('[billing-webhook] subscription を含まない event です:', eventType);
    return json(200, IGNORED);
  }

  // --- subscription の現在値を Stripe から取り直す ---
  //   payload の状態は古いことがある。**取り直した snapshot を正とする。**
  let subscription;
  try {
    subscription = await stripeRequest({
      env,
      method: 'GET',
      path: `/v1/subscriptions/${subscriptionId}`,
      fetchImpl,
    });
  } catch (e) {
    if (e instanceof StripeApiError) {
      if (e.code === 'not_configured') {
        logger.error('[billing-webhook] Stripe の設定が不足しています。');
        return json(500, { error: 'server_misconfigured' });
      }
      if (e.retryable) {
        // 一時障害。Stripe に再送してもらう。
        logger.error('[billing-webhook] Stripe が一時的に利用できません:', e.httpStatus);
        return json(502, { error: 'stripe_unavailable' });
      }
      // 4xx（存在しない subscription 等）。再送では直らないが、
      // 黙って 200 にすると取りこぼしに気づけないので 500 にする。
      logger.error('[billing-webhook] Stripe の再取得に失敗しました:', e.code, e.httpStatus);
      return json(500, { error: 'internal_error' });
    }
    logger.error('[billing-webhook] Stripe 呼び出しで想定外のエラーが発生しました。');
    return json(500, { error: 'internal_error' });
  }

  // --- snapshot -> DB 引数 ---
  const built = buildSnapshot(subscription, env);
  if (!built.ok) {
    // 未知の price / metadata 欠落 / 想定外の構成。
    // 推測で埋めずに失敗させる（fail closed）。
    logger.error('[billing-webhook] snapshot を組み立てられませんでした:', built.code);
    return json(500, { error: 'internal_error' });
  }
  const s = built.snapshot;

  // --- 販売国の検証（**DB を書く前に必ず通す**）---
  //   ここより前で entitlement を書かないこと。順序を変えると
  //   「非 JP へ一瞬 Pro が付く」状態が復活する。
  let customer;
  try {
    customer = await stripeRequest({
      env,
      method: 'GET',
      path: `/v1/customers/${s.customerId}`,
      fetchImpl,
    });
  } catch (e) {
    if (e instanceof StripeApiError && e.code === 'not_configured') {
      logger.error('[billing-webhook] Stripe の設定が不足しています。');
      return json(500, { error: 'server_misconfigured' });
    }
    // **取得できない = 国が分からない。** 非 JP と同一視せず、
    // entitlement も与えず、解約も返金もしない。再送で再評価する。
    logger.error('[billing-webhook] 請求先国を確認できませんでした（Customer 取得失敗）。');
    return json(502, { error: 'country_unverified' });
  }

  const classified = classifyCustomerCountry(customer);

  if (classified.status === COUNTRY_STATUS.UNKNOWN) {
    // 住所なし / 国コードなし / 壊れた値。**金銭操作はしない。**
    logger.error('[billing-webhook] 請求先国を判定できません:', classified.code);
    return json(502, { error: 'country_unverified' });
  }

  if (classified.status === COUNTRY_STATUS.NOT_SELLABLE) {
    // **entitlement を書かない。** RPC を呼ばないことがその担保。
    logger.warn('[billing-webhook] 販売対象外の国の契約を検出しました:', classified.country);
    const remedy = await remediateNotSellableCountry({
      env,
      subscription,
      fetchImpl,
      logger,
      country: classified.country,
      userId: s.userId,
    });
    if (!remedy.ok) {
      // 解約 / 返金のどこかで失敗した。**200 にしない**。
      // Stripe の再送でやり直す（解約済み・返金済みはスキップされる）。
      logger.error('[billing-webhook] 販売対象外の契約の後始末に失敗しました:', remedy.code);
      return json(502, { error: 'remediation_failed' });
    }
    return json(200, {
      received: true,
      processed: false,
      rejected: 'country_not_sellable',
      canceled: remedy.canceled,
      refunded: remedy.refunded,
    });
  }

  // --- DB へ 1 回だけ適用する（**販売可能国と確認できたときだけ**）---
  //   冪等性・順不同・past_due の起点はすべて RPC 側の責務。
  //   ここでは結果を HTTP へ写すだけ。
  let rows;
  try {
    rows = await rpc(RPC_APPLY, {
      p_stripe_event_id: eventId,
      p_event_type: eventType,
      p_event_created_at: eventCreatedAt,
      p_user_id: s.userId,
      p_plan_id: s.planId,
      p_status: s.status,
      p_stripe_customer_id: s.customerId,
      p_stripe_subscription_id: s.subscriptionId,
      p_stripe_price_id: s.priceId,
      p_currency: s.currency,
      p_price_phase: s.phase,
      p_current_period_end: s.currentPeriodEnd,
      p_cancel_at_period_end: s.cancelAtPeriodEnd,
    }, { env });
  } catch (e) {
    if (e instanceof SupabaseError) {
      if (e.code === 'not_configured') {
        logger.error('[billing-webhook] Supabase の設定が不足しています。');
        return json(500, { error: 'server_misconfigured' });
      }
      if (e.code === 'unavailable') {
        logger.error('[billing-webhook] Supabase が利用できません。');
        return json(502, { error: 'database_unavailable' });
      }
      // RPC が例外を投げた = トランザクションごと rollback 済み。
      // subscriptions 行の欠落（削除済みアカウント）もここへ来る。
      logger.error('[billing-webhook] RPC が失敗しました。');
      return json(500, { error: 'internal_error' });
    }
    logger.error('[billing-webhook] DB 呼び出しで想定外のエラーが発生しました。');
    return json(500, { error: 'internal_error' });
  }

  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row || typeof row !== 'object') {
    logger.error('[billing-webhook] RPC の戻り値が想定と異なります。');
    return json(500, { error: 'internal_error' });
  }

  // --- launch -> standard の schedule を reconcile する---
  //   **販売可能国と確認でき、DB へ適用した後にだけ行う。**
  //   判定には上で取り直した subscription を使う。対象外なら Stripe を追加で呼ばない。
  //   event id は署名検証済みの event から渡す（Idempotency-Key の世代になる）。
  //   収束できなければ 2xx にしない。DB 適用は冪等なので、Stripe の再送では
  //   RPC が already_processed を返し、ここだけがやり直される。
  //   processed / already_processed / stale のどれでも行う（判定は Stripe の現在値で行うため）。
  const scheduled = await ensureLaunchToStandardSchedule({
    env,
    subscription,
    eventId,
    fetchImpl,
    logger,
  });
  if (!scheduled.ok) {
    if (scheduled.code === 'not_configured'
        || scheduled.code === 'standard_price_not_configured'
        || scheduled.code === 'standard_price_not_defined') {
      logger.error('[billing-webhook] schedule の reconcile に必要な設定が不足しています。');
      return json(500, { error: 'server_misconfigured' });
    }
    if (scheduled.retryable) {
      logger.error('[billing-webhook] schedule を収束できませんでした（再送でやり直す）:', scheduled.code);
      return json(502, { error: 'schedule_reconcile_failed' });
    }
    logger.error('[billing-webhook] schedule の reconcile に失敗しました:', scheduled.code);
    return json(500, { error: 'internal_error' });
  }

  // 適用・重複・古い、いずれも Stripe から見れば「受理」なので 200。
  return json(200, {
    received: true,
    processed: row.processed === true,
    already_processed: row.already_processed === true,
    stale: row.stale === true,
  });
}

/** Cloudflare Pages Functions: POST のエントリポイント */
export async function onRequestPost(context) {
  return handleWebhook(context.request, context.env);
}

/**
 * Cloudflare Pages Functions: POST 以外のフォールバック。
 * メソッド別ハンドラ（onRequestPost）が優先されるため、ここへ来るのは POST 以外。
 * 念のため handleWebhook 側でもメソッドを検査している。
 */
export async function onRequest(context) {
  return handleWebhook(context.request, context.env);
}

// =========================================================
// launch -> standard 価格移行の Subscription Schedule reconcile
//
//   webhook が subscription snapshot を DB へ適用した**後**に呼ばれる。
//   launch 契約のうち「次の更新が LAUNCH_END_AT 以降になるもの」に、
//   次の更新から standard へ移る Subscription Schedule を Stripe 側で予約させる。
//
//   設計上の約束:
//     - **create ではなく reconcile。** Stripe の現在状態を正とし、
//         schedule なし                        -> 作成（from_subscription）
//         schedule あり + desired phase なし   -> 修復（update）
//         schedule あり + desired phase あり   -> 何もしない
//       `subscription.schedule != null` だけで skip しない。
//       from_subscription の後の update が失敗すると launch だけの schedule が残り、
//       期間末に release されて launch 価格が続くため（部分失敗を修復できる形にする）。
//     - **日付を計算しない。** 境界は Stripe の current_period_end をそのまま使い、
//       次 phase は duration 1 month。「2027 年最初の更新日」を自前で作らない。
//     - **API の response を成功の根拠にしない。** mutation のたびに subscription /
//       schedule を取り直し、desired phase が実在することを確かめる。
//       同じ Idempotency-Key の再送は、release 済みの古い schedule の応答を
//       status 'active' のまま返すことがある。
//     - **Idempotency-Key の世代は署名検証済み webhook event の id で分ける。**
//       subscription ID だけのキーや current_period_end 入りのキーは、同一期間内の
//       「作成 -> Portal 解約で release -> resume -> 再作成」で衝突する。
//       event id は呼び出し側（webhook）が署名検証済みの event から渡す。
//       client 入力や metadata からは取らない。
//     - **二重 schedule は Stripe が構造的に防ぐ**（1 subscription につき 1 schedule。
//       2 本目は「already attached to a schedule」で拒否される）。
//     - **invoice には一切触れない。** past_due の未払い invoice を含め、金額・明細・
//       Price・期間・proration を変更する呼び出しを持たない（schedule の作成・更新は
//       既存 invoice を変えない）。
//     - DB を読まない / 書かない。状態はすべて Stripe が正。
//     - secret / user_id / customer id / subscription id をログに出さない。分類コードだけ。
//
//   前提: STRIPE_API_VERSION = 2025-09-30.clover（phase の `duration` 指定を使う）。
//   ⚠ race: 更新処理に間に合わなければ最大 1 更新分 launch 価格が続き得る
//   （過請求・proration・anchor 変更・既存 invoice の遡及変更は無い）。
//   cron / polling / queue は置かない（受容済み）。
// =========================================================

import { LAUNCH_END_MS, PRICE_DEFINITIONS, priceDefinitionFromPriceId } from './billing-config.js';
import { StripeApiError, stripeRequest } from './stripe.js';

/**
 * reconcile の対象にする subscription status。
 * trialing は含めない（Web Pro に無料トライアルが無いため）。
 * past_due は含める（schedule の作成は未払い invoice を変えない）。
 */
export const RECONCILE_STATUSES = Object.freeze(['active', 'past_due']);

/** reconcile の結果。 */
export const RECONCILE_ACTION = Object.freeze({
  NOT_ELIGIBLE: 'not_eligible',
  NOOP: 'noop',
  CREATED: 'created',
  REPAIRED: 'repaired',
});

/** desired schedule の終了時の挙動。standard の 1 phase を終えたら通常の subscription へ戻す。 */
export const DESIRED_END_BEHAVIOR = 'release';

/** 予約として有効な schedule status。 */
const LIVE_SCHEDULE_STATUSES = Object.freeze(['active', 'not_started']);

/** 署名検証済み Stripe event の id。キーへ載せるので形を限定する。 */
const EVENT_ID_RE = /^evt_[A-Za-z0-9_]{1,200}$/;

/** 'x' でも { id: 'x' } でも ID を取り出す。 */
function readId(value) {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  if (value && typeof value === 'object' && typeof value.id === 'string' && value.id.length > 0) {
    return value.id;
  }
  return null;
}

function toSeconds(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

/**
 * 現在の請求期間を取り出す。
 * 直下にある版と items[0] にある版がある（webhook.js の extractCurrentPeriodEnd と同じ理由）。
 *
 * @returns {{start:number|null, end:number|null}}
 */
export function readCurrentPeriod(subscription) {
  const item = subscription?.items?.data?.[0];
  return {
    start: toSeconds(subscription?.current_period_start) ?? toSeconds(item?.current_period_start),
    end: toSeconds(subscription?.current_period_end) ?? toSeconds(item?.current_period_end),
  };
}

/**
 * launch 定義に対応する standard の Price ID を env から引く。
 * 同じ plan / currency / interval の standard 行を PRICE_DEFINITIONS から探す。
 *
 * @returns {{ok:true, priceId:string}|{ok:false, code:string}}
 */
export function standardCounterpartPriceId(definition, env) {
  const target = PRICE_DEFINITIONS.find(
    (d) => d.plan_id === definition?.plan_id
        && d.currency === definition?.currency
        && d.interval === definition?.interval
        && d.phase === 'standard',
  );
  if (!target) return { ok: false, code: 'standard_price_not_defined' };
  const raw = env?.[target.price_id_env_key];
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { ok: false, code: 'standard_price_not_configured' };
  }
  return { ok: true, priceId: raw.trim() };
}

/**
 * reconcile の対象かを判定する。**Stripe から取り直した subscription を渡すこと。**
 *
 * 対象条件（すべて満たすときだけ）:
 *   status in RECONCILE_STATUSES（active / past_due）
 *   cancel_at == null かつ cancel_at_period_end != true
 *     （Portal 解約は classic では両方、flexible では cancel_at だけが立つ）
 *   実際の Price が launch
 *   current_period_end >= LAUNCH_END_AT
 *
 * 対象外は `{ eligible:false, reason }`。設定漏れ（standard の Price 未設定）は
 * `{ eligible:false, error }` で区別する（呼び出し側が 500 にする）。
 *
 * @returns {{eligible:true, subscriptionId:string, scheduleId:string|null,
 *            launchPriceId:string, standardPriceId:string,
 *            periodStart:number|null, periodEnd:number}
 *          |{eligible:false, reason?:string, error?:string}}
 */
export function evaluateScheduleEligibility(subscription, env) {
  if (!subscription || typeof subscription !== 'object') {
    return { eligible: false, reason: 'invalid_subscription' };
  }
  const subscriptionId = readId(subscription.id);
  if (subscriptionId === null) return { eligible: false, reason: 'invalid_subscription' };

  if (!RECONCILE_STATUSES.includes(subscription.status)) {
    return { eligible: false, reason: 'status_not_reconcilable' };
  }
  if (subscription.cancel_at !== null && subscription.cancel_at !== undefined) {
    return { eligible: false, reason: 'cancel_scheduled' };
  }
  if (subscription.cancel_at_period_end === true) {
    return { eligible: false, reason: 'cancel_scheduled' };
  }

  const items = subscription?.items?.data;
  if (!Array.isArray(items) || items.length !== 1) {
    return { eligible: false, reason: 'unexpected_items' };
  }
  const priceId = readId(items[0]?.price);
  if (priceId === null) return { eligible: false, reason: 'unexpected_items' };
  const mapped = priceDefinitionFromPriceId(priceId, env);
  if (!mapped.ok) return { eligible: false, reason: 'unknown_price' };
  if (mapped.definition.phase !== 'launch') return { eligible: false, reason: 'not_launch_price' };

  const period = readCurrentPeriod(subscription);
  if (period.end === null) return { eligible: false, reason: 'missing_period_end' };
  if (period.end * 1000 < LAUNCH_END_MS) {
    return { eligible: false, reason: 'renews_before_launch_end' };
  }

  const standard = standardCounterpartPriceId(mapped.definition, env);
  if (!standard.ok) return { eligible: false, error: standard.code };

  return {
    eligible: true,
    subscriptionId,
    scheduleId: readId(subscription.schedule),
    launchPriceId: priceId,
    standardPriceId: standard.priceId,
    periodStart: period.start,
    periodEnd: period.end,
  };
}

/**
 * schedule が desired 状態か。
 *
 *   - この subscription に付いた、生きている schedule である
 *   - end_behavior が release
 *   - **現在の請求期間の終わり（= 次の更新）から始まる standard phase がある**
 *
 * @returns {boolean}
 */
export function hasDesiredStandardPhase(schedule, target) {
  if (!schedule || typeof schedule !== 'object') return false;
  if (!LIVE_SCHEDULE_STATUSES.includes(schedule.status)) return false;
  if (readId(schedule.subscription) !== target.subscriptionId) return false;
  if (schedule.end_behavior !== DESIRED_END_BEHAVIOR) return false;
  const phases = schedule.phases;
  if (!Array.isArray(phases)) return false;
  return phases.some((p) => toSeconds(p?.start_date) === target.periodEnd
    && Array.isArray(p?.items)
    && p.items.length === 1
    && readId(p.items[0]?.price) === target.standardPriceId);
}

/**
 * desired schedule の update params。
 *
 *   phase[0] = 現在の請求期間（launch）。終わりは Stripe の current_period_end。
 *   phase[1] = standard を 1 か月。終わったら release（通常の subscription として standard が続く）。
 *   proration はどちらも none。
 *
 * @param {{launchPriceId:string, standardPriceId:string, phaseStart:number, periodEnd:number}} o
 */
export function buildDesiredScheduleParams(o) {
  return {
    end_behavior: DESIRED_END_BEHAVIOR,
    proration_behavior: 'none',
    phases: [
      {
        items: [{ price: o.launchPriceId, quantity: 1 }],
        start_date: o.phaseStart,
        end_date: o.periodEnd,
        proration_behavior: 'none',
      },
      {
        items: [{ price: o.standardPriceId, quantity: 1 }],
        duration: { interval: 'month', interval_count: 1 },
        proration_behavior: 'none',
      },
    ],
  };
}

/** schedule 作成の Idempotency-Key。世代 = 署名検証済み event の id。 */
export function scheduleCreateKey(subscriptionId, eventId) {
  return `schedule:create:launch2standard:${subscriptionId}:${eventId}`;
}

/** schedule 修復（update）の Idempotency-Key。世代 = 署名検証済み event の id。 */
export function scheduleRepairKey(scheduleId, eventId) {
  return `schedule:repair:launch2standard:${scheduleId}:${eventId}`;
}

/** update の phase[0] の開始。現在の phase の開始をそのまま使う（変えると Stripe が拒否する）。 */
function currentPhaseStart(schedule, target) {
  return toSeconds(schedule?.current_phase?.start_date)
    ?? toSeconds(schedule?.phases?.[0]?.start_date)
    ?? target.periodStart;
}

function failure(code, retryable) {
  return { ok: false, code, retryable: retryable === true };
}

/**
 * **launch -> standard の schedule を desired 状態へ収束させる。**
 *
 * 1. 渡された subscription（webhook が取り直したもの）で対象判定
 * 2. schedule なし -> from_subscription で作成 -> subscription を取り直す
 * 3. schedule を取得し desired phase を確認
 * 4. 無ければ update（修復）-> subscription / schedule を取り直して最終確認
 *
 * 戻り値:
 *   { ok:true, action }                    収束した（対象外・何もしない・作成・修復）
 *   { ok:false, code, retryable }          収束できなかった。**成功扱いしない**
 *
 * code:
 *   'standard_price_not_configured' / 'standard_price_not_defined'  設定漏れ
 *   'not_configured'          Stripe の設定漏れ
 *   'invalid_event_id'        event id が渡されていない / 形が不正
 *   'schedule_not_attached'   作成後に取り直しても subscription に schedule が無い（retryable）
 *   'schedule_create_rejected' 作成が 4xx で拒否され、取り直しても schedule が無い
 *   'schedule_changed'        修復中に別の schedule に付け替わった
 *   'desired_phase_missing'   修復後に取り直しても standard phase が無い
 *   'stripe_failed'           Stripe の呼び出しが失敗した
 */
export async function ensureLaunchToStandardSchedule(o) {
  const {
    env, subscription, eventId, stripe = stripeRequest, fetchImpl, logger = console,
  } = o;

  let target = evaluateScheduleEligibility(subscription, env);
  if (target.error) {
    logger.error('[billing-schedule] 設定が不足しています:', target.error);
    return failure(target.error, false);
  }
  if (!target.eligible) {
    return { ok: true, action: RECONCILE_ACTION.NOT_ELIGIBLE, reason: target.reason };
  }
  if (typeof eventId !== 'string' || !EVENT_ID_RE.test(eventId)) {
    logger.error('[billing-schedule] event id が不正です。');
    return failure('invalid_event_id', false);
  }

  const subscriptionPath = `/v1/subscriptions/${target.subscriptionId}`;
  const getSubscription = () => stripe({ env, method: 'GET', path: subscriptionPath, fetchImpl });
  const getSchedule = (id) => stripe({
    env, method: 'GET', path: `/v1/subscription_schedules/${id}`, fetchImpl,
  });

  let action = RECONCILE_ACTION.NOOP;

  try {
    // --- schedule が無い -> 作成 ---
    if (target.scheduleId === null) {
      let createRejected = false;
      try {
        await stripe({
          env,
          method: 'POST',
          path: '/v1/subscription_schedules',
          params: { from_subscription: target.subscriptionId },
          idempotencyKey: scheduleCreateKey(target.subscriptionId, eventId),
          fetchImpl,
        });
      } catch (e) {
        // 並行する別 event が先に作ると、Stripe は「already attached to a schedule」で
        // 拒否する。即断せず、取り直して schedule が付いていれば続行する。
        // 一時障害（retryable）と設定漏れはここで握らず外へ投げる。
        if (!(e instanceof StripeApiError) || e.code !== 'request_failed' || e.retryable) throw e;
        logger.warn('[billing-schedule] schedule 作成が拒否されました。状態を取り直します:',
          e.stripeCode ?? 'none');
        createRejected = true;
      }

      // **応答は信用しない。** 取り直して、本当に付いたかを見る。
      const refreshed = evaluateScheduleEligibility(await getSubscription(), env);
      if (refreshed.error) return failure(refreshed.error, false);
      if (!refreshed.eligible) {
        // 取り直したら対象外になっていた（その間に解約された等）。それ以上触らない。
        return { ok: true, action: RECONCILE_ACTION.NOT_ELIGIBLE, reason: refreshed.reason };
      }
      if (refreshed.scheduleId === null) {
        if (createRejected) {
          // 拒否されたうえに schedule も無い。再送しても同じ拒否になる。
          logger.error('[billing-schedule] schedule を作成できませんでした。');
          return failure('schedule_create_rejected', false);
        }
        logger.error('[billing-schedule] 作成後も subscription に schedule が付いていません。');
        return failure('schedule_not_attached', true);
      }
      target = refreshed;
      if (!createRejected) action = RECONCILE_ACTION.CREATED;
    }

    // --- desired phase の確認 ---
    const schedule = await getSchedule(target.scheduleId);
    if (hasDesiredStandardPhase(schedule, target)) {
      return { ok: true, action };
    }

    // --- 修復（作成直後の standard phase 追加もここ）---
    await stripe({
      env,
      method: 'POST',
      path: `/v1/subscription_schedules/${target.scheduleId}`,
      params: buildDesiredScheduleParams({
        launchPriceId: target.launchPriceId,
        standardPriceId: target.standardPriceId,
        phaseStart: currentPhaseStart(schedule, target),
        periodEnd: target.periodEnd,
      }),
      idempotencyKey: scheduleRepairKey(target.scheduleId, eventId),
      fetchImpl,
    });
    if (action === RECONCILE_ACTION.NOOP) action = RECONCILE_ACTION.REPAIRED;

    // --- 取り直して最終確認 ---
    const verified = evaluateScheduleEligibility(await getSubscription(), env);
    if (verified.error) return failure(verified.error, false);
    if (!verified.eligible) {
      return { ok: true, action: RECONCILE_ACTION.NOT_ELIGIBLE, reason: verified.reason };
    }
    if (verified.scheduleId !== target.scheduleId) {
      logger.error('[billing-schedule] 修復中に schedule が変わりました。');
      return failure('schedule_changed', true);
    }
    const finalSchedule = await getSchedule(verified.scheduleId);
    if (!hasDesiredStandardPhase(finalSchedule, verified)) {
      logger.error('[billing-schedule] 修復後も standard phase を確認できません。');
      return failure('desired_phase_missing', true);
    }
    return { ok: true, action };
  } catch (e) {
    if (e instanceof StripeApiError) {
      if (e.code === 'not_configured') {
        logger.error('[billing-schedule] Stripe の設定が不足しています。');
        return failure('not_configured', false);
      }
      logger.error('[billing-schedule] Stripe の呼び出しに失敗しました:', e.code, e.stripeCode ?? 'none');
      return failure('stripe_failed', e.retryable === true);
    }
    logger.error('[billing-schedule] 想定外のエラーが発生しました。');
    return failure('stripe_failed', false);
  }
}

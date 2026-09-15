// =========================================================
// launch -> standard schedule reconcileの単体テスト
//
//   - **api.stripe.com へは一度も通信しない。** Stripe は状態を持つ fake で置き換える。
//   - fake が持つのは Stripe の次の挙動だけ:
//       * from_subscription は現在の請求期間を phase[0] にした schedule を作り、subscription に付ける
//       * 1 subscription につき schedule は 1 つ（2 本目は 400 already attached）
//       * 同じ Idempotency-Key の再送は最初の 2xx 応答をそのまま返す（release 後でも）
//   - 本番の secret / Price ID はフィクスチャに一切保存しない。
// =========================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RECONCILE_ACTION,
  RECONCILE_STATUSES,
  buildDesiredScheduleParams,
  ensureLaunchToStandardSchedule,
  evaluateScheduleEligibility,
  hasDesiredStandardPhase,
  readCurrentPeriod,
  scheduleCreateKey,
  scheduleRepairKey,
} from '../_lib/billing-schedule.js';
import { LAUNCH_END_MS } from '../_lib/billing-config.js';
import { handleWebhook } from '../billing/webhook.js';
import { computeStripeSignature } from '../_lib/stripe-webhook.js';

// --- テスト用のダミー設定（本番値ではない） ---
const WEBHOOK_SECRET = 'whsec_dummy_for_tests_only';
const LAUNCH = 'price_dummy_web_pro_jpy_launch';
const STANDARD = 'price_dummy_jpy_standard';
const ENV = Object.freeze({
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  STRIPE_SECRET_KEY: 'sk_test_dummy_for_tests_only',
  SUPABASE_URL: 'https://example-project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_dummy_for_tests_only',
  STRIPE_PRICE_WEB_PRO_JPY_LAUNCH: LAUNCH,
  STRIPE_PRICE_WEB_PRO_JPY_STANDARD: STANDARD,
  STRIPE_PRICE_WEB_PRO_USD_LAUNCH: 'price_dummy_usd_launch',
  STRIPE_PRICE_WEB_PRO_USD_STANDARD: 'price_dummy_usd_standard',
});

const USER_ID = '11111111-2222-3333-4444-555555555555';
const SUB_ID = 'sub_dummy_sched';
const CUS_ID = 'cus_dummy_sched';
const EVT_1 = 'evt_dummy_sched_1';
const EVT_2 = 'evt_dummy_sched_2';

/** 2026-12-10T01:00:00Z（launch 最終期間の開始） */
const PERIOD_START = 1796864400;
/** 2027-01-10T01:00:00Z（LAUNCH_END_AT より後の更新日） */
const PERIOD_END = 1799542800;
/** LAUNCH_END_AT（2026-12-31T15:00:00Z）の Unix 秒 */
const LAUNCH_END_SEC = LAUNCH_END_MS / 1000;
/** fake が duration 1 month を置き換える長さ（fake 内部だけで使う） */
const FAKE_MONTH = 31 * 86400;

const NOW_SEC = 1788000000;
const NOW_MS = NOW_SEC * 1000;

const quiet = { error() {}, warn() {}, log() {} };

/** Stripe から取り直した launch subscription の既定形（次の更新が LAUNCH_END_AT 以降）。 */
function launchSubscription(over = {}) {
  return {
    id: SUB_ID,
    object: 'subscription',
    customer: CUS_ID,
    status: 'active',
    cancel_at: null,
    cancel_at_period_end: false,
    schedule: null,
    metadata: { user_id: USER_ID },
    items: {
      data: [{
        id: 'si_1',
        price: { id: LAUNCH },
        current_period_start: PERIOD_START,
        current_period_end: PERIOD_END,
      }],
    },
    ...over,
  };
}

/** items の請求期間だけを差し替える。 */
function withPeriod(sub, start, end) {
  const s = structuredClone(sub);
  s.items.data[0].current_period_start = start;
  s.items.data[0].current_period_end = end;
  return s;
}

/** desired 状態の schedule。 */
function desiredSchedule(over = {}) {
  return {
    id: 'sub_sched_existing',
    object: 'subscription_schedule',
    status: 'active',
    subscription: SUB_ID,
    end_behavior: 'release',
    current_phase: { start_date: PERIOD_START, end_date: PERIOD_END },
    phases: [
      { start_date: PERIOD_START, end_date: PERIOD_END, proration_behavior: 'none',
        items: [{ price: LAUNCH, quantity: 1 }] },
      { start_date: PERIOD_END, end_date: PERIOD_END + FAKE_MONTH, proration_behavior: 'none',
        items: [{ price: STANDARD, quantity: 1 }] },
    ],
    ...over,
  };
}

/**
 * 状態を持つ Stripe の fake。
 *
 * o.subscription       初期の subscription
 * o.schedules          初期の schedule（配列）
 * o.failUpdates        schedule update を 500 で失敗させる回数
 * o.ignoreUpdates      schedule update が 200 を返すのに何も変えない
 * o.createDoesNotAttach from_subscription が 200 を返すのに subscription に付けない
 * o.failCreateStatus   schedule 作成を指定ステータスで失敗させる
 * o.country            Customer の請求先国（既定 JP）
 */
function fakeStripe(o = {}) {
  const state = {
    subscription: structuredClone(o.subscription ?? launchSubscription()),
    customer: { id: CUS_ID, object: 'customer', address: { country: o.country ?? 'JP' } },
    schedules: new Map(),
    idempotency: new Map(),
    seq: 0,
    failUpdates: o.failUpdates ?? 0,
    ignoreUpdates: o.ignoreUpdates === true,
    createDoesNotAttach: o.createDoesNotAttach === true,
    failCreateStatus: o.failCreateStatus ?? null,
    calls: [],
  };
  for (const s of o.schedules ?? []) state.schedules.set(s.id, structuredClone(s));

  const clone = (x) => structuredClone(x);
  const stripeError = (message, type = 'invalid_request_error') => ({ error: { type, message } });

  function route(method, path, form) {
    const sub = state.subscription;

    if (path === `/v1/subscriptions/${sub.id}`) {
      if (method === 'GET') return [200, clone(sub)];
      if (method === 'DELETE') {
        sub.status = 'canceled';
        return [200, clone(sub)];
      }
    }
    if (path.startsWith('/v1/customers/') && method === 'GET') return [200, clone(state.customer)];

    if (path === '/v1/subscription_schedules' && method === 'POST') {
      if (state.failCreateStatus !== null) {
        return [state.failCreateStatus, stripeError('create failed', 'api_error')];
      }
      if (form.get('from_subscription') !== sub.id) return [404, stripeError('No such subscription')];
      if (sub.schedule) {
        return [400, stripeError(
          `You cannot migrate a subscription that is already attached to a schedule: \`${sub.schedule}\`.`)];
      }
      const item = sub.items.data[0];
      const id = `sub_sched_fake_${++state.seq}`;
      const schedule = {
        id,
        object: 'subscription_schedule',
        status: 'active',
        subscription: sub.id,
        end_behavior: 'release',
        current_phase: { start_date: item.current_period_start, end_date: item.current_period_end },
        phases: [{
          start_date: item.current_period_start,
          end_date: item.current_period_end,
          proration_behavior: 'create_prorations',
          items: [{ price: item.price.id, quantity: 1 }],
        }],
      };
      state.schedules.set(id, schedule);
      if (!state.createDoesNotAttach) sub.schedule = id;
      return [200, clone(schedule)];
    }

    const m = path.match(/^\/v1\/subscription_schedules\/([^/]+)$/);
    if (m) {
      const schedule = state.schedules.get(m[1]);
      if (!schedule) return [404, stripeError('No such subscription_schedule')];
      if (method === 'GET') return [200, clone(schedule)];
      if (method === 'POST') {
        if (state.failUpdates > 0) {
          state.failUpdates -= 1;
          return [500, stripeError('boom', 'api_error')];
        }
        if (state.ignoreUpdates) return [200, clone(schedule)];
        if (form.has('end_behavior')) schedule.end_behavior = form.get('end_behavior');
        const phases = [];
        for (let i = 0; form.has(`phases[${i}][items][0][price]`); i++) {
          const prev = phases[i - 1];
          const start = form.has(`phases[${i}][start_date]`)
            ? Number(form.get(`phases[${i}][start_date]`)) : prev.end_date;
          const end = form.has(`phases[${i}][end_date]`)
            ? Number(form.get(`phases[${i}][end_date]`)) : start + FAKE_MONTH;
          phases.push({
            start_date: start,
            end_date: end,
            proration_behavior: form.get(`phases[${i}][proration_behavior]`),
            items: [{
              price: form.get(`phases[${i}][items][0][price]`),
              quantity: Number(form.get(`phases[${i}][items][0][quantity]`)),
            }],
          });
        }
        schedule.phases = phases;
        return [200, clone(schedule)];
      }
    }

    // reconcile はここへ来てはならない（invoice を一切触らない）。来たら記録だけ残る。
    if (path.startsWith('/v1/invoices')) return [200, { id: 'in_fake', object: 'invoice' }];
    return [404, stripeError('not found')];
  }

  const fn = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = init.method ?? 'GET';
    const key = init.headers?.['Idempotency-Key'] ?? null;
    const form = new URLSearchParams(init.body ?? '');
    state.calls.push({ method, path: u.pathname, key, form: Object.fromEntries(form) });

    // Stripe と同じく、同じキーの再送は最初の 2xx 応答をそのまま返す（状態は見ない）。
    if (key !== null && state.idempotency.has(key)) {
      const saved = state.idempotency.get(key);
      return new Response(JSON.stringify(saved.body), { status: saved.status });
    }
    const [status, body] = route(method, u.pathname, form);
    if (key !== null && status >= 200 && status < 300) {
      state.idempotency.set(key, { status, body: clone(body) });
    }
    return new Response(JSON.stringify(body), { status });
  };

  fn.state = state;
  fn.count = (method, pathPart) =>
    state.calls.filter((c) => c.method === method && c.path.includes(pathPart)).length;
  fn.posts = () => state.calls.filter((c) => c.method === 'POST');
  /** Portal 解約と同じく schedule を release する（subscription から外れる）。 */
  fn.releaseAttached = () => {
    const sub = state.subscription;
    const schedule = state.schedules.get(sub.schedule);
    schedule.status = 'released';
    schedule.subscription = null;
    sub.schedule = null;
  };
  return fn;
}

/** webhook が取り直した subscription を渡すのと同じ形で reconcile を呼ぶ。 */
function reconcile(fake, eventId = EVT_1, o = {}) {
  return ensureLaunchToStandardSchedule({
    env: o.env ?? ENV,
    subscription: structuredClone(fake.state.subscription),
    eventId,
    fetchImpl: fake,
    logger: quiet,
  });
}

/** fake の subscription に desired schedule が付いていることを確かめる。 */
function assertDesired(fake) {
  const sub = fake.state.subscription;
  assert.ok(sub.schedule, 'subscription に schedule が付いている');
  const sc = fake.state.schedules.get(sub.schedule);
  assert.equal(sc.status, 'active');
  assert.equal(sc.end_behavior, 'release');
  assert.equal(sc.phases.length, 2);
  assert.deepEqual(
    [sc.phases[0].start_date, sc.phases[0].end_date, sc.phases[0].items[0].price],
    [PERIOD_START, PERIOD_END, LAUNCH],
    'phase[0] は現在の請求期間の launch',
  );
  assert.equal(sc.phases[1].start_date, PERIOD_END, 'phase[1] は次の更新から');
  assert.equal(sc.phases[1].items[0].price, STANDARD, 'phase[1] は standard');
  assert.equal(sc.phases[0].proration_behavior, 'none');
  assert.equal(sc.phases[1].proration_behavior, 'none');
}

function liveSchedules(fake) {
  return [...fake.state.schedules.values()].filter((s) => s.status === 'active');
}


// =========================================================
// 1. 対象判定（eligibility）
// =========================================================

test('対象 status は active / past_due だけ（trialing を含めない）', () => {
  assert.deepEqual([...RECONCILE_STATUSES], ['active', 'past_due']);
});

test('A: launch でも次の更新が LAUNCH_END_AT より前なら対象外（Stripe を呼ばない）', async () => {
  const fake = fakeStripe({
    subscription: withPeriod(launchSubscription(), PERIOD_START - 30 * 86400, PERIOD_START),
  });
  const result = await reconcile(fake);
  assert.deepEqual(result, {
    ok: true, action: RECONCILE_ACTION.NOT_ELIGIBLE, reason: 'renews_before_launch_end',
  });
  assert.equal(fake.state.calls.length, 0);
});

test('A: 境界は LAUNCH_END_AT を含む（ちょうどなら対象 / 1 秒前なら対象外）', () => {
  const at = evaluateScheduleEligibility(
    withPeriod(launchSubscription(), PERIOD_START, LAUNCH_END_SEC), ENV);
  assert.equal(at.eligible, true);
  const before = evaluateScheduleEligibility(
    withPeriod(launchSubscription(), PERIOD_START, LAUNCH_END_SEC - 1), ENV);
  assert.deepEqual(before, { eligible: false, reason: 'renews_before_launch_end' });
});

test('B: standard Price は対象外', async () => {
  const sub = launchSubscription();
  sub.items.data[0].price = { id: STANDARD };
  const fake = fakeStripe({ subscription: sub });
  const result = await reconcile(fake);
  assert.equal(result.action, RECONCILE_ACTION.NOT_ELIGIBLE);
  assert.equal(result.reason, 'not_launch_price');
  assert.equal(fake.state.calls.length, 0);
});

test('C: cancel_at があれば対象外（flexible の Portal 解約は cancel_at だけが立つ）', async () => {
  const fake = fakeStripe({
    subscription: launchSubscription({ cancel_at: PERIOD_END, cancel_at_period_end: false }),
  });
  const result = await reconcile(fake);
  assert.equal(result.action, RECONCILE_ACTION.NOT_ELIGIBLE);
  assert.equal(result.reason, 'cancel_scheduled');
  assert.equal(fake.state.calls.length, 0, 'schedule を作り直さない');
});

test('D: cancel_at_period_end=true なら対象外（classic の Portal 解約）', async () => {
  const fake = fakeStripe({
    subscription: launchSubscription({ cancel_at: PERIOD_END, cancel_at_period_end: true }),
  });
  const result = await reconcile(fake);
  assert.equal(result.reason, 'cancel_scheduled');
  assert.equal(fake.state.calls.length, 0);

  const onlyFlag = evaluateScheduleEligibility(
    launchSubscription({ cancel_at: null, cancel_at_period_end: true }), ENV);
  assert.deepEqual(onlyFlag, { eligible: false, reason: 'cancel_scheduled' });
});

test('E: canceled / unpaid / incomplete / incomplete_expired / trialing は対象外', async () => {
  for (const status of ['canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'trialing', 'paused']) {
    const fake = fakeStripe({ subscription: launchSubscription({ status }) });
    const result = await reconcile(fake);
    assert.equal(result.ok, true, status);
    assert.equal(result.action, RECONCILE_ACTION.NOT_ELIGIBLE, status);
    assert.equal(result.reason, 'status_not_reconcilable', status);
    assert.equal(fake.state.calls.length, 0, status);
  }
});

test('未知の Price / 複数 item / 期間不明は対象外（推測で予約しない）', () => {
  const unknown = launchSubscription();
  unknown.items.data[0].price = { id: 'price_unknown' };
  assert.equal(evaluateScheduleEligibility(unknown, ENV).reason, 'unknown_price');

  const multi = launchSubscription();
  multi.items.data.push({ id: 'si_2', price: { id: LAUNCH } });
  assert.equal(evaluateScheduleEligibility(multi, ENV).reason, 'unexpected_items');

  const noPeriod = launchSubscription();
  delete noPeriod.items.data[0].current_period_end;
  assert.equal(evaluateScheduleEligibility(noPeriod, ENV).reason, 'missing_period_end');

  assert.equal(evaluateScheduleEligibility(null, ENV).reason, 'invalid_subscription');
});

test('クーポンの有無で launch -> standard の対象判定は変わらない', () => {
  // Promotion Code を使っても price_id は launch のままなので、
  // 移行予約の対象判定は変わらない。
  const plain = evaluateScheduleEligibility(launchSubscription(), ENV);
  const withCoupon = evaluateScheduleEligibility(
    launchSubscription({
      discounts: ['di_dummy_for_tests_only'],
      discount: { id: 'di_dummy_for_tests_only', coupon: { id: 'co_dummy', duration: 'once' } },
    }),
    ENV,
  );
  assert.equal(plain.eligible, true);
  assert.deepEqual(withCoupon, plain);
});

test('予約する phases は割引を引き継がない（duration=once 運用の根拠）', () => {
  const params = buildDesiredScheduleParams({
    launchPriceId: LAUNCH,
    standardPriceId: STANDARD,
    phaseStart: PERIOD_START,
    periodEnd: PERIOD_END,
  });
  // **継続割引（repeating / forever）はここで失われる。**
  // そのため Sukima は duration=once のクーポン運用に限定している。
  assert.equal('discounts' in params, false);
  for (const phase of params.phases) {
    assert.equal('discounts' in phase, false);
    assert.equal('coupon' in phase, false);
  }
  // 価格自体は launch -> standard のまま
  assert.equal(params.phases[0].items[0].price, LAUNCH);
  assert.equal(params.phases[1].items[0].price, STANDARD);
});

test('standard の Price が未設定なら失敗（設定漏れ。Stripe を呼ばない）', async () => {
  const env = { ...ENV, STRIPE_PRICE_WEB_PRO_JPY_STANDARD: '' };
  const fake = fakeStripe();
  const result = await reconcile(fake, EVT_1, { env });
  assert.deepEqual(result, { ok: false, code: 'standard_price_not_configured', retryable: false });
  assert.equal(fake.state.calls.length, 0);
});

test('請求期間は直下でも items 側でも読める', () => {
  assert.deepEqual(readCurrentPeriod({ current_period_start: 1, current_period_end: 2 }),
    { start: 1, end: 2 });
  assert.deepEqual(readCurrentPeriod(launchSubscription()), { start: PERIOD_START, end: PERIOD_END });
  assert.deepEqual(readCurrentPeriod({}), { start: null, end: null });
});

test('event id が無い / 不正なら失敗（Stripe を呼ばない）', async () => {
  // reconcile() の既定値に倒れないよう、null と「渡さない」を別に確かめる
  for (const eventId of [null, '', 'evt_', 'abc', 'evt_x\r\nX-Evil: 1', 42]) {
    const fake = fakeStripe();
    const result = await reconcile(fake, eventId);
    assert.deepEqual(result, { ok: false, code: 'invalid_event_id', retryable: false }, String(eventId));
    assert.equal(fake.state.calls.length, 0);
  }
  const fake = fakeStripe();
  const omitted = await ensureLaunchToStandardSchedule({
    env: ENV, subscription: structuredClone(fake.state.subscription), fetchImpl: fake, logger: quiet,
  });
  assert.deepEqual(omitted, { ok: false, code: 'invalid_event_id', retryable: false });
  assert.equal(fake.state.calls.length, 0);
});


// =========================================================
// 2. 作成（schedule なし）
// =========================================================

test('F: active + launch + schedule なし -> 作成して standard phase を付ける', async () => {
  const fake = fakeStripe();
  const result = await reconcile(fake);
  assert.deepEqual(result, { ok: true, action: RECONCILE_ACTION.CREATED });
  assertDesired(fake);
  assert.equal(liveSchedules(fake).length, 1);

  // 手順: 作成 -> subscription 取り直し -> schedule 取得 -> update -> 取り直し -> 取得
  const seq = fake.state.calls.map((c) => `${c.method} ${c.path}`);
  const schedId = fake.state.subscription.schedule;
  assert.deepEqual(seq, [
    'POST /v1/subscription_schedules',
    `GET /v1/subscriptions/${SUB_ID}`,
    `GET /v1/subscription_schedules/${schedId}`,
    `POST /v1/subscription_schedules/${schedId}`,
    `GET /v1/subscriptions/${SUB_ID}`,
    `GET /v1/subscription_schedules/${schedId}`,
  ]);
});

test('F: update の params は proration none / release / duration 1 month / Stripe の期間境界', async () => {
  const fake = fakeStripe();
  await reconcile(fake);
  const update = fake.posts().find((c) => c.path.startsWith('/v1/subscription_schedules/'));
  assert.equal(update.form.end_behavior, 'release');
  assert.equal(update.form.proration_behavior, 'none');
  assert.equal(update.form['phases[0][items][0][price]'], LAUNCH);
  assert.equal(update.form['phases[0][start_date]'], String(PERIOD_START));
  assert.equal(update.form['phases[0][end_date]'], String(PERIOD_END), '境界は Stripe の current_period_end');
  assert.equal(update.form['phases[0][proration_behavior]'], 'none');
  assert.equal(update.form['phases[1][items][0][price]'], STANDARD);
  assert.equal(update.form['phases[1][duration][interval]'], 'month');
  assert.equal(update.form['phases[1][duration][interval_count]'], '1');
  assert.equal(update.form['phases[1][proration_behavior]'], 'none');
  assert.equal('phases[1][start_date]' in update.form, false, '次の phase の日付を自前で計算しない');
  assert.equal('phases[1][end_date]' in update.form, false, '次の phase の日付を自前で計算しない');
});

test('G: past_due + launch + schedule なし -> 作成して standard phase を付ける', async () => {
  const fake = fakeStripe({ subscription: launchSubscription({ status: 'past_due' }) });
  const result = await reconcile(fake);
  assert.deepEqual(result, { ok: true, action: RECONCILE_ACTION.CREATED });
  assertDesired(fake);
});


// =========================================================
// 3. schedule あり（no-op / 修復）
// =========================================================

test('H: schedule あり + desired phase あり -> 何もしない（取得 1 回だけ）', async () => {
  const fake = fakeStripe({
    subscription: launchSubscription({ schedule: 'sub_sched_existing' }),
    schedules: [desiredSchedule()],
  });
  const result = await reconcile(fake);
  assert.deepEqual(result, { ok: true, action: RECONCILE_ACTION.NOOP });
  assert.equal(fake.posts().length, 0, 'mutation しない');
  assert.deepEqual(fake.state.calls.map((c) => `${c.method} ${c.path}`),
    ['GET /v1/subscription_schedules/sub_sched_existing']);
});

test('I: schedule あり + standard phase なし（部分失敗）-> 修復する（作り直さない）', async () => {
  const partial = desiredSchedule();
  partial.phases = [partial.phases[0]];
  const fake = fakeStripe({
    subscription: launchSubscription({ schedule: 'sub_sched_existing' }),
    schedules: [partial],
  });
  const result = await reconcile(fake);
  assert.deepEqual(result, { ok: true, action: RECONCILE_ACTION.REPAIRED });
  assert.equal(fake.count('POST', '/v1/subscription_schedules') - fake.count('POST', '/v1/subscription_schedules/'), 0,
    'from_subscription で作り直さない');
  assert.equal(fake.state.subscription.schedule, 'sub_sched_existing');
  assertDesired(fake);
  const update = fake.posts()[0];
  assert.equal(update.key, scheduleRepairKey('sub_sched_existing', EVT_1));
});

test('I: end_behavior が release でない / standard の開始がずれている schedule も修復する', async () => {
  const variants = [
    desiredSchedule({ end_behavior: 'cancel' }),
    (() => { const s = desiredSchedule(); s.phases[1].start_date = PERIOD_END + 86400; return s; })(),
    (() => { const s = desiredSchedule(); s.phases[1].items = [{ price: LAUNCH, quantity: 1 }]; return s; })(),
  ];
  for (const sc of variants) {
    const fake = fakeStripe({
      subscription: launchSubscription({ schedule: 'sub_sched_existing' }),
      schedules: [sc],
    });
    const result = await reconcile(fake);
    assert.equal(result.action, RECONCILE_ACTION.REPAIRED);
    assertDesired(fake);
  }
});

test('desired 判定は別 subscription / 生きていない schedule を認めない', () => {
  const target = { subscriptionId: SUB_ID, standardPriceId: STANDARD, periodEnd: PERIOD_END };
  assert.equal(hasDesiredStandardPhase(desiredSchedule(), target), true);
  assert.equal(hasDesiredStandardPhase(desiredSchedule({ subscription: 'sub_other' }), target), false);
  assert.equal(hasDesiredStandardPhase(desiredSchedule({ status: 'released' }), target), false);
  assert.equal(hasDesiredStandardPhase(desiredSchedule({ status: 'canceled' }), target), false);
  assert.equal(hasDesiredStandardPhase(null, target), false);
});


// =========================================================
// 4. Idempotency-Key と再送
// =========================================================

test('Idempotency-Key は event id で世代を分ける（subscription ID だけ / 期間末入りは使わない）', async () => {
  const fake = fakeStripe();
  await reconcile(fake);
  const [create, update] = fake.posts();
  const schedId = fake.state.subscription.schedule;
  assert.equal(create.key, `schedule:create:launch2standard:${SUB_ID}:${EVT_1}`);
  assert.equal(create.key, scheduleCreateKey(SUB_ID, EVT_1));
  assert.equal(update.key, `schedule:repair:launch2standard:${schedId}:${EVT_1}`);
  for (const c of fake.posts()) {
    assert.notEqual(c.key, `sched:launch2standard:${SUB_ID}`);
    assert.equal(c.key.includes(String(PERIOD_END)), false, 'current_period_end を世代に使わない');
  }
});

test('J: 同じ event の再送（update が失敗した後）は修復だけを行い、schedule を増やさない', async () => {
  const fake = fakeStripe({ failUpdates: 1 });
  const first = await reconcile(fake, EVT_1);
  assert.equal(first.ok, false, '収束していないので成功扱いしない');
  assert.equal(first.retryable, true);
  assert.equal(liveSchedules(fake).length, 1, 'launch だけの schedule が残っている');

  const retry = await reconcile(fake, EVT_1);
  assert.deepEqual(retry, { ok: true, action: RECONCILE_ACTION.REPAIRED });
  assertDesired(fake);
  assert.equal(liveSchedules(fake).length, 1, 'schedule は 1 つのまま');
  assert.equal(fake.count('POST', '/v1/subscription_schedules') - fake.count('POST', '/v1/subscription_schedules/'), 1,
    '作成は 1 回だけ');
});

test('J: 成功後に同じ event が再送されても何もしない', async () => {
  const fake = fakeStripe();
  await reconcile(fake, EVT_1);
  const postsBefore = fake.posts().length;
  const again = await reconcile(fake, EVT_1);
  assert.deepEqual(again, { ok: true, action: RECONCILE_ACTION.NOOP });
  assert.equal(fake.posts().length, postsBefore);
  assert.equal(liveSchedules(fake).length, 1);
});

test('J: 並行する 2 event が同時に来ても schedule は 1 つ（2 本目は already attached で拒否され、続行する）', async () => {
  const fake = fakeStripe();
  const [a, b] = await Promise.all([reconcile(fake, EVT_1), reconcile(fake, EVT_2)]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(liveSchedules(fake).length, 1);
  assertDesired(fake);
});

test('K: resume 等の別 event なら、release 後に新しい schedule を作れる', async () => {
  const fake = fakeStripe();
  await reconcile(fake, EVT_1);
  const firstId = fake.state.subscription.schedule;

  fake.releaseAttached();   // Portal 解約 -> resume で schedule が外れた状態
  const resumed = await reconcile(fake, EVT_2);
  assert.deepEqual(resumed, { ok: true, action: RECONCILE_ACTION.CREATED });
  assert.notEqual(fake.state.subscription.schedule, firstId, '新しい schedule');
  assertDesired(fake);
  assert.equal(liveSchedules(fake).length, 1);
});

test('L: 同じ key の古い応答が返っても、subscription.schedule が null なら成功扱いしない', async () => {
  const fake = fakeStripe();
  await reconcile(fake, EVT_1);
  fake.releaseAttached();

  // 同じ event id で作り直そうとすると、Stripe は release 済み schedule の古い応答を返す
  const replayed = await reconcile(fake, EVT_1);
  assert.deepEqual(replayed, { ok: false, code: 'schedule_not_attached', retryable: true });
  assert.equal(fake.state.subscription.schedule, null);
});

test('L: 作成 API が 200 でも取り直して schedule が無ければ成功扱いしない', async () => {
  const fake = fakeStripe({ createDoesNotAttach: true });
  const result = await reconcile(fake);
  assert.deepEqual(result, { ok: false, code: 'schedule_not_attached', retryable: true });
  assert.equal(fake.count('POST', '/v1/subscription_schedules/'), 0, 'update へ進まない');
});

test('M: 修復後は subscription と schedule を取り直して desired phase を確かめる', async () => {
  const fake = fakeStripe();
  await reconcile(fake);
  const seq = fake.state.calls.map((c) => `${c.method} ${c.path.split('/').slice(0, 3).join('/')}`);
  const updateAt = fake.state.calls.findIndex(
    (c) => c.method === 'POST' && c.path.startsWith('/v1/subscription_schedules/'));
  assert.deepEqual(seq.slice(updateAt + 1),
    ['GET /v1/subscriptions', 'GET /v1/subscription_schedules'], 'update の後に取り直す');
});

test('M: update が 200 でも desired phase が付いていなければ成功扱いしない', async () => {
  const fake = fakeStripe({ ignoreUpdates: true });
  const result = await reconcile(fake);
  assert.deepEqual(result, { ok: false, code: 'desired_phase_missing', retryable: true });
});

test('Stripe の一時障害は retryable、恒久的な拒否は non-retryable で返す', async () => {
  const transient = fakeStripe({ failCreateStatus: 429 });
  assert.deepEqual(await reconcile(transient),
    { ok: false, code: 'stripe_failed', retryable: true });

  const rejected = fakeStripe({ failCreateStatus: 400 });
  assert.deepEqual(await reconcile(rejected),
    { ok: false, code: 'schedule_create_rejected', retryable: false });
});


// =========================================================
// 5. invoice を変えない（past_due）
// =========================================================

test('N: past_due の reconcile は invoice を一切呼ばない（未払い invoice を変更しない）', async () => {
  const fake = fakeStripe({ subscription: launchSubscription({ status: 'past_due' }) });
  const result = await reconcile(fake);
  assert.equal(result.ok, true);
  assert.equal(fake.state.calls.filter((c) => c.path.includes('/v1/invoice')).length, 0);
  for (const c of fake.posts()) {
    assert.ok(c.path.startsWith('/v1/subscription_schedules'), '変更するのは schedule だけ: ' + c.path);
  }
  assert.equal(fake.count('DELETE', '/'), 0);
});

test('N: billing-schedule.js は invoice / 返金 / 解約の API を持たない', async () => {
  const src = await (await import('node:fs/promises')).readFile(
    new URL('../_lib/billing-schedule.js', import.meta.url), 'utf8');
  const code = src.split(String.fromCharCode(10))
    .filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'))
    .join(String.fromCharCode(10));
  for (const forbidden of ['/v1/invoices', '/v1/invoiceitems', '/v1/refunds', "method: 'DELETE'"]) {
    assert.equal(code.includes(forbidden), false, forbidden);
  }
});

test('buildDesiredScheduleParams は日付を phase[0] の境界だけに使う', () => {
  const p = buildDesiredScheduleParams({
    launchPriceId: LAUNCH, standardPriceId: STANDARD, phaseStart: PERIOD_START, periodEnd: PERIOD_END,
  });
  assert.equal(p.end_behavior, 'release');
  assert.equal(p.proration_behavior, 'none');
  assert.deepEqual(p.phases[1].duration, { interval: 'month', interval_count: 1 });
  assert.equal('start_date' in p.phases[1], false);
  assert.equal('end_date' in p.phases[1], false);
});


// =========================================================
// 6. webhook からの呼び出し
// =========================================================

function stripeEvent(type, obj, id = EVT_1) {
  return { id, object: 'event', type, created: NOW_SEC, data: { object: obj } };
}

async function signedRequest(event) {
  const body = JSON.stringify(event);
  const v1 = await computeStripeSignature(WEBHOOK_SECRET, NOW_SEC, body);
  return new Request('https://example.com/api/billing/webhook', {
    method: 'POST', headers: { 'Stripe-Signature': `t=${NOW_SEC},v1=${v1}` }, body,
  });
}

function rpcMock(row = { processed: true, already_processed: false, stale: false }) {
  const calls = [];
  const fn = async (name, args) => {
    calls.push({ name, args });
    return [row];
  };
  fn.calls = calls;
  return fn;
}

async function deliver(fake, event, o = {}) {
  const rpc = o.rpc ?? rpcMock();
  const res = await handleWebhook(await signedRequest(event), o.env ?? ENV,
    { rpc, fetchImpl: fake, logger: quiet, now: NOW_MS });
  return { res, body: await res.json(), rpc };
}

test('webhook: 対象の launch 契約なら DB 適用後に schedule を予約し、応答の形は変えない', async () => {
  const fake = fakeStripe();
  const { res, body, rpc } = await deliver(fake,
    stripeEvent('customer.subscription.updated', { id: SUB_ID }));
  assert.equal(res.status, 200);
  assert.deepEqual(body, { received: true, processed: true, already_processed: false, stale: false });
  assert.equal(rpc.calls.length, 1, 'DB へは従来どおり 1 回');
  assertDesired(fake);
  assert.equal(fake.posts()[0].key, scheduleCreateKey(SUB_ID, EVT_1), 'key の世代は署名検証済み event の id');
});

test('webhook: 収束できなければ 502 で再送させ、再送では修復だけを行う', async () => {
  const fake = fakeStripe({ failUpdates: 1 });
  const event = stripeEvent('customer.subscription.updated', { id: SUB_ID });
  const first = await deliver(fake, event);
  assert.equal(first.res.status, 502);
  assert.deepEqual(first.body, { error: 'schedule_reconcile_failed' });
  assert.equal(first.rpc.calls.length, 1, 'DB 適用は済んでいる（冪等なので再送で困らない）');

  const retry = await deliver(fake, event,
    { rpc: rpcMock({ processed: false, already_processed: true, stale: false }) });
  assert.equal(retry.res.status, 200);
  assert.equal(retry.body.already_processed, true);
  assertDesired(fake);
  assert.equal(liveSchedules(fake).length, 1);
});

test('webhook: 自分の schedule 変更で届いた event は何もしない（無限ループしない）', async () => {
  const fake = fakeStripe();
  await deliver(fake, stripeEvent('customer.subscription.updated', { id: SUB_ID }, EVT_1));
  const postsBefore = fake.posts().length;
  const echo = await deliver(fake, stripeEvent('customer.subscription.updated', { id: SUB_ID }, EVT_2));
  assert.equal(echo.res.status, 200);
  assert.equal(fake.posts().length, postsBefore, 'mutation しない');
});

test('webhook: Portal 解約中は予約せず、resume の event で新しい世代の schedule を作る', async () => {
  const fake = fakeStripe();
  await deliver(fake, stripeEvent('customer.subscription.updated', { id: SUB_ID }, EVT_1));

  // Portal 解約: schedule が release され cancel_at が立つ
  fake.releaseAttached();
  fake.state.subscription.cancel_at = PERIOD_END;
  fake.state.subscription.cancel_at_period_end = true;
  const postsBefore = fake.posts().length;
  const canceled = await deliver(fake,
    stripeEvent('customer.subscription.updated', { id: SUB_ID }, 'evt_dummy_cancel'));
  assert.equal(canceled.res.status, 200);
  assert.equal(fake.posts().length, postsBefore, '解約予定には schedule を作らない');
  assert.equal(fake.state.subscription.schedule, null);

  // Portal resume: cancel 系が戻る
  fake.state.subscription.cancel_at = null;
  fake.state.subscription.cancel_at_period_end = false;
  const resumed = await deliver(fake,
    stripeEvent('customer.subscription.updated', { id: SUB_ID }, 'evt_dummy_resume'));
  assert.equal(resumed.res.status, 200);
  assertDesired(fake);
  const creates = fake.posts().filter((c) => c.path === '/v1/subscription_schedules');
  assert.equal(creates.at(-1).key, scheduleCreateKey(SUB_ID, 'evt_dummy_resume'));
});

test('webhook: past_due の invoice.payment_failed でも予約し、invoice には触れない', async () => {
  const fake = fakeStripe({ subscription: launchSubscription({ status: 'past_due' }) });
  const { res } = await deliver(fake,
    stripeEvent('invoice.payment_failed', { id: 'in_open_1', subscription: SUB_ID }));
  assert.equal(res.status, 200);
  assertDesired(fake);
  assert.equal(fake.state.calls.filter((c) => c.path.includes('/v1/invoice')).length, 0);
});

test('webhook: 販売対象外の国では schedule を作らない（remediation だけ）', async () => {
  const fake = fakeStripe({ country: 'US' });
  const { res, body, rpc } = await deliver(fake,
    stripeEvent('customer.subscription.updated', { id: SUB_ID }));
  assert.equal(res.status, 200);
  assert.equal(body.rejected, 'country_not_sellable');
  assert.equal(rpc.calls.length, 0);
  assert.equal(fake.count('POST', '/v1/subscription_schedules'), 0);
});

test('webhook: standard の Price 未設定は 500 server_misconfigured', async () => {
  const env = { ...ENV, STRIPE_PRICE_WEB_PRO_JPY_STANDARD: '' };
  const fake = fakeStripe();
  const { res, body } = await deliver(fake,
    stripeEvent('customer.subscription.updated', { id: SUB_ID }), { env });
  assert.equal(res.status, 500);
  assert.deepEqual(body, { error: 'server_misconfigured' });
  assert.equal(fake.count('POST', '/v1/subscription_schedules'), 0);
});

test('webhook: 対象外の契約では Stripe を追加で呼ばない（従来の呼び出し回数のまま）', async () => {
  const fake = fakeStripe({
    subscription: withPeriod(launchSubscription(), PERIOD_START - 30 * 86400, PERIOD_START),
  });
  const { res } = await deliver(fake, stripeEvent('customer.subscription.updated', { id: SUB_ID }));
  assert.equal(res.status, 200);
  assert.deepEqual(fake.state.calls.map((c) => `${c.method} ${c.path}`), [
    `GET /v1/subscriptions/${SUB_ID}`,
    `GET /v1/customers/${CUS_ID}`,
  ]);
});

// =========================================================
// Web Pro feature gate（server 側）の横断テスト
//
//   個々の endpoint の詳細は quota-*.test.mjs が見ている。
//   ここで固定するのは **Web Pro gate の不変条件**だけ:
//
//     1. Web Pro は Free quota を **1 度も消費しない**
//        （RPC を呼ばないので、残数が 0 でも検索できる）
//     2. entitlement が Pro でなければ、plan 名がそれらしくても無制限にしない
//     3. reserve / commit / release / status で判定が食い違わない
// =========================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { handleReserve } from '../quota/reserve.js';
import { handleCommit } from '../quota/commit.js';
import { handleRelease } from '../quota/release.js';
import { handleQuotaStatus } from '../quota/status.js';
import { SESSION_COOKIE_NAME, SESSION_RESULT } from '../_lib/session.js';
import { hasWebUnlimited } from '../_lib/quota.js';

const ENV = {
  SUPABASE_URL: 'https://example-project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_dummy_for_tests_only',
};
const ORIGIN = 'https://sukimacalendar.com';
const USER_ID = '11111111-2222-3333-4444-555555555555';
const RESERVATION_ID = 'c9f17da8-e426-46b9-ac84-b1b6159fc53c';
const quiet = { error() {}, warn() {}, log() {} };

function stubSession(context) {
  return async () => ({
    status: SESSION_RESULT.VALID,
    context: { user_id: USER_ID, ...context },
  });
}

/** idempotency_key は 8〜200 文字・空白なし（migration の CHECK と同条件）。 */
const IDEM_KEY = 'step8a-idem-key-0001';

/** **枠が尽きている**ことにする RPC。Pro なら呼ばれてはいけない。 */
function exhaustedRpc() {
  const calls = [];
  const fn = async (name) => {
    calls.push({ name });
    if (name === 'reserve_weekly_usage') {
      return [{ allowed: false, code: 'limit_reached', reused: false, reservation_id: null,
                week_start: '2036-10-06', used: 3, remaining: 0, expires_at: null }];
    }
    if (name === 'get_quota_status') {
      return [{ used: 3, remaining: 0, quota_limit: 3, week_start: '2036-10-06',
                next_reset_at: '2036-10-13T02:00:00+00:00' }];
    }
    return [{ ok: true, code: 'ok', state: 'committed', used: 3 }];
  };
  fn.calls = calls;
  return fn;
}

const bodyOf = (res) => res.json();

function post(path, body) {
  return new Request('https://example.com' + path, {
    method: 'POST',
    headers: {
      origin: ORIGIN,
      'content-type': 'application/json',
      cookie: SESSION_COOKIE_NAME + '=dummytoken',
    },
    body: JSON.stringify(body),
  });
}

function get(path) {
  return new Request('https://example.com' + path, {
    method: 'GET',
    headers: { origin: ORIGIN, cookie: SESSION_COOKIE_NAME + '=dummytoken' },
  });
}

const PRO = { plan_id: 'web_pro', status: 'active' };
const FREE = { plan_id: 'free', status: 'active' };

// ---------------------------------------------------------
// 1. Pro は枠が尽きていても検索できる
// ---------------------------------------------------------

test('**Pro は残数 0 でも reserve が通り、RPC を呼ばない**', async () => {
  const rpc = exhaustedRpc();
  const res = await handleReserve(post('/api/quota/reserve', { idempotency_key: IDEM_KEY }),
    ENV, { rpc, session: stubSession(PRO), logger: quiet });
  const body = await bodyOf(res);

  assert.equal(res.status, 200);
  assert.equal(body.allowed, true, '残数 0 でも allowed');
  assert.equal(body.quota_enforced, false);
  assert.equal(body.code, 'unlimited');
  assert.equal(rpc.calls.length, 0, '**Free quota の RPC を呼んでいる**');
});

test('**Pro の検索は Free quota を消費しない**（reserve/commit/release とも RPC 0 回）', async () => {
  const rpc = exhaustedRpc();
  const deps = { rpc, session: stubSession(PRO), logger: quiet };

  await handleReserve(post('/api/quota/reserve', { idempotency_key: IDEM_KEY }), ENV, deps);
  await handleCommit(post('/api/quota/commit', { reservation_id: RESERVATION_ID }), ENV, deps);
  await handleRelease(post('/api/quota/release', { reservation_id: RESERVATION_ID }), ENV, deps);

  assert.equal(rpc.calls.length, 0, 'Pro なのに quota RPC を呼んでいる');
});

test('Pro の status は unlimited で、残数を露出しない', async () => {
  const rpc = exhaustedRpc();
  const body = await bodyOf(await handleQuotaStatus(get('/api/quota/status'), ENV,
    { rpc, session: stubSession(PRO), logger: quiet }));

  assert.equal(body.unlimited, true);
  assert.equal(body.remaining, null);
  assert.equal(body.limit, null);
  assert.equal(rpc.calls.length, 0);
});

// ---------------------------------------------------------
// 2. Free は従来どおり
// ---------------------------------------------------------

test('Free は残数 0 なら reserve が拒否される', async () => {
  const rpc = exhaustedRpc();
  const body = await bodyOf(await handleReserve(post('/api/quota/reserve', { idempotency_key: IDEM_KEY }),
    ENV, { rpc, session: stubSession(FREE), logger: quiet }));

  assert.equal(body.quota_enforced, true);
  assert.equal(body.allowed, false);
  assert.equal(rpc.calls.length, 1, 'Free は RPC を呼ぶ');
});

test('Free の status は残数を返す（従来仕様を壊さない）', async () => {
  const rpc = exhaustedRpc();
  const body = await bodyOf(await handleQuotaStatus(get('/api/quota/status'), ENV,
    { rpc, session: stubSession(FREE), logger: quiet }));
  assert.equal(body.unlimited, false);
  assert.equal(body.remaining, 0);
  assert.equal(body.limit, 3);
});

// ---------------------------------------------------------
// 3. entitlement が Pro でなければ無制限にしない
// ---------------------------------------------------------

test('**plan 名が web_pro でも status が Pro でなければ無制限にしない**', async () => {
  for (const status of ['canceled', 'unpaid', 'incomplete', 'incomplete_expired']) {
    const rpc = exhaustedRpc();
    const body = await bodyOf(await handleReserve(post('/api/quota/reserve', { idempotency_key: IDEM_KEY }),
      ENV, { rpc, session: stubSession({ plan_id: 'web_pro', status }), logger: quiet }));
    assert.equal(body.quota_enforced, true, 'web_pro/' + status);
    assert.equal(rpc.calls.length, 1, 'web_pro/' + status + ' で RPC を呼ぶべき');
  }
});

test('**extension_pro は Web の無制限にならない**', async () => {
  const rpc = exhaustedRpc();
  const body = await bodyOf(await handleReserve(post('/api/quota/reserve', { idempotency_key: IDEM_KEY }),
    ENV, { rpc, session: stubSession({ plan_id: 'extension_pro', status: 'active' }), logger: quiet }));
  assert.equal(body.quota_enforced, true);
  assert.equal(rpc.calls.length, 1);
});

test('hasWebUnlimited は entitlement core と同じ判定をする', () => {
  assert.equal(hasWebUnlimited({ plan_id: 'web_pro', status: 'active' }), true);
  assert.equal(hasWebUnlimited({ plan_id: 'all_pro', status: 'active' }), true);
  assert.equal(hasWebUnlimited({ plan_id: 'free', status: 'active' }), false);
  assert.equal(hasWebUnlimited({ plan_id: 'extension_pro', status: 'active' }), false);
  assert.equal(hasWebUnlimited({ plan_id: 'web_pro', status: 'canceled' }), false);
  assert.equal(hasWebUnlimited(null), false);
  assert.equal(hasWebUnlimited({}), false);
});

test('reserve / commit / release / status の判定が食い違わない', async () => {
  for (const ctx of [PRO, FREE, { plan_id: 'extension_pro', status: 'active' }]) {
    const expectUnlimited = hasWebUnlimited(ctx);
    const rpc = exhaustedRpc();
    const deps = { rpc, session: stubSession(ctx), logger: quiet };

    const r = await bodyOf(await handleReserve(post('/api/quota/reserve', { idempotency_key: IDEM_KEY }), ENV, deps));
    const c = await bodyOf(await handleCommit(post('/api/quota/commit', { reservation_id: RESERVATION_ID }), ENV, deps));
    const rl = await bodyOf(await handleRelease(post('/api/quota/release', { reservation_id: RESERVATION_ID }), ENV, deps));
    const st = await bodyOf(await handleQuotaStatus(get('/api/quota/status'), ENV, deps));

    assert.equal(r.quota_enforced, !expectUnlimited, 'reserve ' + ctx.plan_id);
    assert.equal(c.quota_enforced, !expectUnlimited, 'commit ' + ctx.plan_id);
    assert.equal(rl.quota_enforced, !expectUnlimited, 'release ' + ctx.plan_id);
    assert.equal(st.unlimited, expectUnlimited, 'status ' + ctx.plan_id);
  }
});

// ---------------------------------------------------------
// 7. 解約フローと entitlement の整合
//
//   Portal での解約は `cancel_at_period_end = true` になるだけで、
//   status は active のまま。期間末に Stripe が canceled へ落とす。
//   その挙動が entitlement と矛盾しないことを固定する。
// ---------------------------------------------------------

test('**解約予定（cancel_at_period_end=true / status=active）でも Pro のまま**', async () => {
  const rpc = exhaustedRpc();
  const ctx = { plan_id: 'web_pro', status: 'active', cancel_at_period_end: true };
  const body = await bodyOf(await handleReserve(post('/api/quota/reserve', { idempotency_key: IDEM_KEY }),
    ENV, { rpc, session: stubSession(ctx), logger: quiet }));

  assert.equal(hasWebUnlimited(ctx), true, '解約予定で権限が落ちている');
  assert.equal(body.quota_enforced, false);
  assert.equal(rpc.calls.length, 0);
});

test('**期間末に canceled になったら Free へ落ちる**', async () => {
  const rpc = exhaustedRpc();
  const ctx = { plan_id: 'free', status: 'canceled', cancel_at_period_end: false };
  const body = await bodyOf(await handleReserve(post('/api/quota/reserve', { idempotency_key: IDEM_KEY }),
    ENV, { rpc, session: stubSession(ctx), logger: quiet }));

  assert.equal(hasWebUnlimited(ctx), false);
  assert.equal(body.quota_enforced, true);
  assert.equal(rpc.calls.length, 1);
});

test('plan_id が web_pro のまま canceled でも Free 扱い', () => {
  assert.equal(hasWebUnlimited({ plan_id: 'web_pro', status: 'canceled' }), false);
});

test('**解約取り消し（resume）で Pro へ戻る**', () => {
  // Portal で「継続」を押すと cancel_at_period_end=false へ戻るだけ。
  // status は active のままなので権限は連続している。
  assert.equal(hasWebUnlimited({ plan_id: 'web_pro', status: 'active', cancel_at_period_end: true }), true);
  assert.equal(hasWebUnlimited({ plan_id: 'web_pro', status: 'active', cancel_at_period_end: false }), true);
});

test('cancel_at_period_end は権限判定に影響しない（status と plan だけで決まる）', () => {
  for (const cancel of [true, false, null, undefined]) {
    assert.equal(hasWebUnlimited({ plan_id: 'web_pro', status: 'active', cancel_at_period_end: cancel }),
      true, 'cancel=' + String(cancel));
    assert.equal(hasWebUnlimited({ plan_id: 'free', status: 'canceled', cancel_at_period_end: cancel }),
      false, 'cancel=' + String(cancel));
  }
});

// ---------------------------------------------------------
// 8. past_due の 7 日 grace（regression）
//
//   **判定は変更していない。** UI が依存する不変条件を固定するだけ。
// ---------------------------------------------------------

test('**grace 中（7 日未満）は Web Pro のまま**', async () => {
  const since = Date.parse('2026-09-10T00:00:00.000Z');
  const ctx = { plan_id: 'web_pro', status: 'past_due',
                past_due_since: new Date(since).toISOString() };
  // 6 日後 = まだ猶予内。**現在時刻に依存させないよう now を明示する。**
  const now = since + 6 * 24 * 60 * 60 * 1000;

  const { hasWebEntitlement, isWithinPastDueGrace, PAST_DUE_GRACE_DAYS } =
    await import('../_lib/entitlement.js');
  assert.equal(PAST_DUE_GRACE_DAYS, 7, 'grace 日数が変わっている');
  assert.equal(isWithinPastDueGrace(ctx.past_due_since, now), true);
  assert.equal(hasWebEntitlement(ctx, now), true);
});

test('**7 日ちょうどで grace が切れる**', async () => {
  const { hasWebEntitlement, PAST_DUE_GRACE_MS } = await import('../_lib/entitlement.js');
  const since = Date.parse('2026-09-10T00:00:00.000Z');
  const ctx = { plan_id: 'web_pro', status: 'past_due',
                past_due_since: new Date(since).toISOString() };

  assert.equal(hasWebEntitlement(ctx, since + PAST_DUE_GRACE_MS - 1), true, '境界直前');
  assert.equal(hasWebEntitlement(ctx, since + PAST_DUE_GRACE_MS), false, '境界ちょうど');
  assert.equal(hasWebEntitlement(ctx, since + PAST_DUE_GRACE_MS + 1), false, '境界直後');
});

test('past_due_since が未来なら猶予を与えない', async () => {
  const { hasWebEntitlement } = await import('../_lib/entitlement.js');
  const now = Date.parse('2026-09-10T00:00:00.000Z');
  const ctx = { plan_id: 'web_pro', status: 'past_due',
                past_due_since: new Date(now + 60000).toISOString() };
  assert.equal(hasWebEntitlement(ctx, now), false);
});

test('past_due_since が無ければ猶予なし', async () => {
  const { hasWebEntitlement } = await import('../_lib/entitlement.js');
  const ctx = { plan_id: 'web_pro', status: 'past_due' };
  assert.equal(hasWebEntitlement(ctx, Date.now()), false);
});

test('**grace 中は quota も無制限のまま**（検索が止まらない）', async () => {
  const { PAST_DUE_GRACE_MS } = await import('../_lib/entitlement.js');
  const since = Date.now() - (PAST_DUE_GRACE_MS - 60000);   // 猶予切れ 1 分前
  const rpc = exhaustedRpc();
  const ctx = { plan_id: 'web_pro', status: 'past_due',
                past_due_since: new Date(since).toISOString() };
  const body = await bodyOf(await handleReserve(post('/api/quota/reserve', { idempotency_key: IDEM_KEY }),
    ENV, { rpc, session: stubSession(ctx), logger: quiet }));

  assert.equal(body.quota_enforced, false, 'grace 中に quota を課している');
  assert.equal(rpc.calls.length, 0);
});

test('**grace 切れ後は quota 対象へ戻る**', async () => {
  const { PAST_DUE_GRACE_MS } = await import('../_lib/entitlement.js');
  const since = Date.now() - (PAST_DUE_GRACE_MS + 60000);   // 猶予切れ 1 分後
  const rpc = exhaustedRpc();
  const ctx = { plan_id: 'web_pro', status: 'past_due',
                past_due_since: new Date(since).toISOString() };
  const body = await bodyOf(await handleReserve(post('/api/quota/reserve', { idempotency_key: IDEM_KEY }),
    ENV, { rpc, session: stubSession(ctx), logger: quiet }));

  assert.equal(body.quota_enforced, true);
  assert.equal(rpc.calls.length, 1);
});

// =========================================================
// GET /api/auth/me の billing 拡張の単体テスト
//
//   - Supabase RPC はすべてスタブに差し替える。ネットワークへは出ない。
//   - 本番の secret / Project URL はフィクスチャに一切保存しない。
//   - session 検証は実物の requireSession を通し、RPC だけを差し替える。
//   - 既存 field の互換性は me.test.mjs が、billing の中身はここが受け持つ。
// =========================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildBillingPayload, graceUntilFrom, handleMe } from '../auth/me.js';
import { PAST_DUE_GRACE_MS } from '../_lib/entitlement.js';
import { SESSION_COOKIE_NAME, generateSessionToken } from '../_lib/session.js';

// --- テスト用のダミー設定（本番値ではない） ---
const ENV = {
  SUPABASE_URL: 'https://example-project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_dummy_for_tests_only',
};

const IDLE = '2026-10-01T00:00:00Z';
const ABS = '2026-11-30T00:00:00Z';
const NOW = new Date('2026-09-01T00:00:00Z');
const USER_ID = '11111111-2222-3333-4444-555555555555';

/** past_due の起点。NOW より前に置く。 */
const PAST_DUE_SINCE = '2026-08-28T10:00:00.000Z';
const GRACE_UNTIL = new Date(Date.parse(PAST_DUE_SINCE) + PAST_DUE_GRACE_MS).toISOString();

const quiet = { error() {}, warn() {}, log() {} };

function row(overrides = {}) {
  return {
    user_id: USER_ID,
    plan_id: 'free',
    status: 'active',
    idle_expires_at: IDLE,
    absolute_expires_at: ABS,
    past_due_since: null,
    current_period_end: null,
    cancel_at_period_end: false,
    currency: null,
    price_phase: null,
    ...overrides,
  };
}

function stubRpc(rows) {
  const calls = [];
  const fn = async (name, args) => { calls.push({ name, args }); return rows; };
  fn.calls = calls;
  return fn;
}

function req(cookie) {
  const headers = cookie === undefined ? {} : { cookie };
  return new Request('https://example.com/api/auth/me', { method: 'GET', headers });
}

const body = (res) => res.json();

/** 有効 session として me を叩き、payload を返す。 */
async function me(overrides = {}, now = NOW) {
  const t = generateSessionToken();
  const res = await handleMe(req(`${SESSION_COOKIE_NAME}=${t}`), ENV,
    { rpc: stubRpc([row(overrides)]), logger: quiet, now });
  return { res, payload: await body(res) };
}


// =========================================================
// 1. 未認証は既存挙動のまま（breaking change を作らない）
// =========================================================

test('未認証 → 401 { authenticated: false } のみ。billing field を足さない', async () => {
  const res = await handleMe(req(), ENV, { rpc: stubRpc([]), logger: quiet });
  assert.equal(res.status, 401);
  const payload = await body(res);
  assert.deepEqual(Object.keys(payload), ['authenticated']);
  assert.equal(payload.authenticated, false);
});

test('未認証 401 に entitlement / grace_until を含めない', async () => {
  const res = await handleMe(req(), ENV, { rpc: stubRpc([]), logger: quiet });
  const text = JSON.stringify(await body(res));
  for (const f of ['entitlement', 'grace_until', 'currency',
                   'current_period_end', 'cancel_at_period_end']) {
    assert.equal(text.includes(f), false, f);
  }
});

// =========================================================
// 2. plan × status の entitlement（entitlement.js の判定と一致させる）
// =========================================================

test('free + active → web false / extension false', async () => {
  const { payload } = await me({ plan_id: 'free', status: 'active' });
  assert.deepEqual(payload.entitlement, { web: false, extension: false });
});

test('web_pro + active → web true / extension false', async () => {
  const { payload } = await me({ plan_id: 'web_pro', status: 'active' });
  assert.deepEqual(payload.entitlement, { web: true, extension: false });
});

test('extension_pro + active → web false / extension true', async () => {
  const { payload } = await me({ plan_id: 'extension_pro', status: 'active' });
  assert.deepEqual(payload.entitlement, { web: false, extension: true });
});

test('all_pro + active → 両方 true', async () => {
  const { payload } = await me({ plan_id: 'all_pro', status: 'active' });
  assert.deepEqual(payload.entitlement, { web: true, extension: true });
});

test('web_pro + trialing → web true', async () => {
  const { payload } = await me({ plan_id: 'web_pro', status: 'trialing' });
  assert.deepEqual(payload.entitlement, { web: true, extension: false });
  assert.equal(payload.grace_until, null, 'trialing に猶予は無い');
});

test('canceled / unpaid / incomplete / incomplete_expired は entitlement false', async () => {
  for (const st of ['canceled', 'unpaid', 'incomplete', 'incomplete_expired']) {
    const { payload } = await me({ plan_id: 'all_pro', status: st });
    assert.deepEqual(payload.entitlement, { web: false, extension: false }, st);
    assert.equal(payload.grace_until, null, st);
  }
});

// =========================================================
// 3. past_due の 7日猶予
// =========================================================

test('past_due + 猶予内 → web true・grace_until あり', async () => {
  const now = new Date(Date.parse(PAST_DUE_SINCE) + PAST_DUE_GRACE_MS - 1000);
  const { payload } = await me(
    { plan_id: 'web_pro', status: 'past_due', past_due_since: PAST_DUE_SINCE }, now);
  assert.deepEqual(payload.entitlement, { web: true, extension: false });
  assert.equal(payload.grace_until, GRACE_UNTIL);
});

test('past_due + 猶予終了 1ms 前 → まだ web true', async () => {
  const now = new Date(Date.parse(PAST_DUE_SINCE) + PAST_DUE_GRACE_MS - 1);
  const { payload } = await me(
    { plan_id: 'web_pro', status: 'past_due', past_due_since: PAST_DUE_SINCE }, now);
  assert.equal(payload.entitlement.web, true);
});

test('past_due + 猶予ちょうど → web false。grace_until は返す', async () => {
  const now = new Date(Date.parse(PAST_DUE_SINCE) + PAST_DUE_GRACE_MS);
  const { payload } = await me(
    { plan_id: 'web_pro', status: 'past_due', past_due_since: PAST_DUE_SINCE }, now);
  assert.equal(payload.entitlement.web, false, '7日ちょうどで Free');
  assert.equal(payload.grace_until, GRACE_UNTIL, 'UI が猶予終了を判断できるよう返す');
});

test('past_due + 猶予超過 → web false。grace_until は過去日時として返す', async () => {
  const now = new Date(Date.parse(PAST_DUE_SINCE) + PAST_DUE_GRACE_MS + 86400000);
  const { payload } = await me(
    { plan_id: 'web_pro', status: 'past_due', past_due_since: PAST_DUE_SINCE }, now);
  assert.equal(payload.entitlement.web, false);
  assert.equal(payload.grace_until, GRACE_UNTIL);
  assert.ok(Date.parse(payload.grace_until) < now.getTime());
});

test('past_due だが past_due_since が無い → entitlement false・grace_until null', async () => {
  const { payload } = await me(
    { plan_id: 'web_pro', status: 'past_due', past_due_since: null });
  assert.equal(payload.entitlement.web, false, 'fail closed');
  assert.equal(payload.grace_until, null);
});

test('all_pro + past_due 猶予内 → web も extension も true', async () => {
  const now = new Date(Date.parse(PAST_DUE_SINCE) + 1000);
  const { payload } = await me(
    { plan_id: 'all_pro', status: 'past_due', past_due_since: PAST_DUE_SINCE }, now);
  assert.deepEqual(payload.entitlement, { web: true, extension: true });
});


// =========================================================
// 4. 猶予計算の安全性（不正な past_due_since で権限を与えない）
// =========================================================

test('past_due_since が不正な値 → entitlement false・grace_until null', async () => {
  for (const bad of ['', 'not-a-date', {}, [], true, NaN]) {
    const { payload } = await me(
      { plan_id: 'web_pro', status: 'past_due', past_due_since: bad });
    assert.equal(payload.entitlement.web, false, String(bad));
    assert.equal(payload.grace_until, null, String(bad));
  }
});

test('past_due_since が未来 → entitlement false（fail closed）。grace_until は返す', async () => {
  const future = new Date(NOW.getTime() + 86400000).toISOString();
  const { payload } = await me(
    { plan_id: 'web_pro', status: 'past_due', past_due_since: future });
  assert.equal(payload.entitlement.web, false, '未来の起点で猶予を与えない');
  assert.equal(payload.grace_until,
    new Date(Date.parse(future) + PAST_DUE_GRACE_MS).toISOString());
});

test('grace_until は entitlement.js の 7日定数から導かれる', () => {
  const until = graceUntilFrom({ status: 'past_due', past_due_since: PAST_DUE_SINCE });
  assert.equal(Date.parse(until) - Date.parse(PAST_DUE_SINCE), PAST_DUE_GRACE_MS);
  assert.equal(PAST_DUE_GRACE_MS, 7 * 24 * 60 * 60 * 1000);
});

test('past_due 以外の status では grace_until を出さない', () => {
  for (const st of ['active', 'trialing', 'canceled', 'unpaid',
                    'incomplete', 'incomplete_expired']) {
    assert.equal(graceUntilFrom({ status: st, past_due_since: PAST_DUE_SINCE }), null, st);
  }
});

// =========================================================
// 5. billing の各 field
// =========================================================

test('current_period_end は ISO 8601 UTC で返る', async () => {
  const { payload } = await me(
    { plan_id: 'web_pro', status: 'active', current_period_end: '2026-10-01T10:00:00+00:00' });
  assert.equal(payload.current_period_end, '2026-10-01T10:00:00.000Z');
});

test('current_period_end が NULL / 不正なら null', async () => {
  for (const v of [null, undefined, '', 'nope', {}]) {
    const { payload } = await me({ current_period_end: v });
    assert.equal(payload.current_period_end, null, String(v));
  }
});

test('cancel_at_period_end は必ず boolean', async () => {
  const t = await me({ plan_id: 'web_pro', status: 'active', cancel_at_period_end: true });
  assert.equal(t.payload.cancel_at_period_end, true);
  for (const v of [false, null, undefined, 'true', 1, 0]) {
    const { payload } = await me({ cancel_at_period_end: v });
    assert.equal(payload.cancel_at_period_end, false, String(v));
    assert.equal(typeof payload.cancel_at_period_end, 'boolean', String(v));
  }
});

test('currency は jpy / usd のみ通し、それ以外は null', async () => {
  for (const c of ['jpy', 'usd']) {
    const { payload } = await me({ plan_id: 'web_pro', status: 'active', currency: c });
    assert.equal(payload.currency, c);
  }
  for (const c of [null, undefined, '', 'JPY', 'eur', 'gbp', 123, {}]) {
    const { payload } = await me({ currency: c });
    assert.equal(payload.currency, null, String(c));
  }
});

test('free では currency / current_period_end が null', async () => {
  const { payload } = await me({ plan_id: 'free', status: 'active' });
  assert.equal(payload.currency, null);
  assert.equal(payload.current_period_end, null);
  assert.equal(payload.cancel_at_period_end, false);
  assert.equal(payload.grace_until, null);
});

test('cancel_at_period_end=true + current_period_end で終了日を示せる', async () => {
  const { payload } = await me({
    plan_id: 'web_pro', status: 'active',
    cancel_at_period_end: true, current_period_end: '2026-10-01T10:00:00Z',
  });
  assert.equal(payload.cancel_at_period_end, true);
  assert.equal(payload.current_period_end, '2026-10-01T10:00:00.000Z');
  assert.equal(payload.entitlement.web, true, '期間終了までは Pro のまま');
});


// =========================================================
// 6. 非公開情報が漏れないこと
// =========================================================

test('Stripe の内部 ID をレスポンスへ出さない', async () => {
  const t = generateSessionToken();
  const leaky = {
    ...row({ plan_id: 'web_pro', status: 'active', currency: 'jpy', price_phase: 'launch' }),
    stripe_customer_id: 'cus_LEAK',
    stripe_subscription_id: 'sub_LEAK',
    stripe_price_id: 'price_LEAK',
    last_stripe_event_at: '2026-09-01T00:00:00Z',
  };
  const res = await handleMe(req(`${SESSION_COOKIE_NAME}=${t}`), ENV,
    { rpc: stubRpc([leaky]), logger: quiet, now: NOW });

  const text = JSON.stringify(await body(res));
  for (const f of ['cus_LEAK', 'sub_LEAK', 'price_LEAK',
                   'stripe_customer_id', 'stripe_subscription_id',
                   'stripe_price_id', 'last_stripe_event_at']) {
    assert.equal(text.includes(f), false, f);
  }
});

test('past_due_since の生値をレスポンスへ出さない（grace_until だけ返す）', async () => {
  const now = new Date(Date.parse(PAST_DUE_SINCE) + 1000);
  const t = generateSessionToken();
  const res = await handleMe(req(`${SESSION_COOKIE_NAME}=${t}`), ENV,
    { rpc: stubRpc([row({ plan_id: 'web_pro', status: 'past_due',
                          past_due_since: PAST_DUE_SINCE })]),
      logger: quiet, now });

  const payload = await body(res);
  const text = JSON.stringify(payload);
  assert.equal(text.includes('past_due_since'), false);
  assert.equal(text.includes(PAST_DUE_SINCE), false);
  assert.equal(payload.grace_until, GRACE_UNTIL);
});

test('user_id / email / google_sub / session 期限を出さない', async () => {
  const t = generateSessionToken();
  const leaky = { ...row({ plan_id: 'all_pro', status: 'active' }),
                  google_sub: 'SUBSUB', email: 'leak@example.com' };
  const res = await handleMe(req(`${SESSION_COOKIE_NAME}=${t}`), ENV,
    { rpc: stubRpc([leaky]), logger: quiet, now: NOW });

  const text = JSON.stringify(await body(res));
  for (const f of ['user_id', USER_ID, 'google_sub', 'SUBSUB', 'leak@example.com',
                   'idle_expires_at', 'absolute_expires_at', IDLE, ABS,
                   ENV.SUPABASE_SERVICE_ROLE_KEY, ENV.SUPABASE_URL]) {
    assert.equal(text.includes(f), false, f);
  }
});

// =========================================================
// 7. レスポンス全体の形と互換性
// =========================================================

test('200 の key 集合が固定されている', async () => {
  const { payload } = await me({ plan_id: 'web_pro', status: 'active' });
  assert.deepEqual(Object.keys(payload).sort(), [
    'amount', 'authenticated', 'cancel_at_period_end', 'currency', 'current_period_end',
    'entitlement', 'grace_until', 'next_phase_amount', 'plan_id', 'price_phase',
    'status', 'tax_behavior',
  ]);
  assert.deepEqual(Object.keys(payload.entitlement).sort(), ['extension', 'web']);
});

test('plan_id / status は top-level のまま（既存 client 互換）', async () => {
  const { payload } = await me({ plan_id: 'all_pro', status: 'trialing' });
  assert.equal(payload.plan_id, 'all_pro');
  assert.equal(payload.status, 'trialing');
  assert.equal(payload.authenticated, true);
});

test('200 に no-store と Vary: Cookie が付く', async () => {
  const { res } = await me({ plan_id: 'web_pro', status: 'active' });
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('vary'), 'Cookie');
});

test('未知の status でも entitlement false で落ちない', async () => {
  const { res, payload } = await me({ plan_id: 'web_pro', status: 'paused' });
  assert.equal(res.status, 200);
  assert.deepEqual(payload.entitlement, { web: false, extension: false });
});

// =========================================================
// 8. webhook の変更が次のリクエストで反映される構造
// =========================================================

test('subscriptions の値が変われば次の request の応答も変わる（キャッシュしない）', async () => {
  const t = generateSessionToken();
  const cookie = `${SESSION_COOKIE_NAME}=${t}`;

  const before = await handleMe(req(cookie), ENV,
    { rpc: stubRpc([row({ plan_id: 'free', status: 'active' })]), logger: quiet, now: NOW });
  const b = await body(before);
  assert.equal(b.plan_id, 'free');
  assert.equal(b.entitlement.web, false);

  // webhook が subscriptions を書き換えた想定で、同じ session token のまま再取得
  const after = await handleMe(req(cookie), ENV,
    { rpc: stubRpc([row({ plan_id: 'web_pro', status: 'active',
                          currency: 'jpy', current_period_end: '2026-10-01T10:00:00Z' })]),
      logger: quiet, now: NOW });
  const a = await body(after);
  assert.equal(a.plan_id, 'web_pro');
  assert.equal(a.entitlement.web, true);
  assert.equal(a.currency, 'jpy');
  assert.equal(a.current_period_end, '2026-10-01T10:00:00.000Z');
});

test('RPC へ渡すのは p_token_hash だけ（生 token を渡さない）', async () => {
  const t = generateSessionToken();
  const rpc = stubRpc([row()]);
  await handleMe(req(`${SESSION_COOKIE_NAME}=${t}`), ENV, { rpc, logger: quiet, now: NOW });
  assert.equal(rpc.calls.length, 1);
  assert.deepEqual(Object.keys(rpc.calls[0].args), ['p_token_hash']);
  assert.notEqual(rpc.calls[0].args.p_token_hash, t);
});

// =========================================================
// 9. buildBillingPayload を直接呼ぶ（context が壊れていても落ちない）
// =========================================================

test('context が null / 空でも例外にならず安全側へ倒れる', () => {
  for (const ctx of [null, undefined, {}, [], 'x', 42]) {
    const p = buildBillingPayload(ctx);
    assert.deepEqual(p.entitlement, { web: false, extension: false }, String(ctx));
    assert.equal(p.current_period_end, null);
    assert.equal(p.cancel_at_period_end, false);
    assert.equal(p.currency, null);
    assert.equal(p.grace_until, null);
  }
});

test('**buildBillingPayload は price_phase と表示金額を返す**', () => {
  const p = buildBillingPayload({ plan_id: 'web_pro', status: 'active',
                                  currency: 'jpy', price_phase: 'launch' });
  assert.equal(p.price_phase, 'launch');
  assert.equal(p.amount, 300);
  assert.equal(p.currency, 'jpy');
  assert.equal(p.tax_behavior, 'inclusive');
});

test('standard 契約者には standard の金額を返す', () => {
  const p = buildBillingPayload({ plan_id: 'web_pro', status: 'active',
                                  currency: 'jpy', price_phase: 'standard' });
  assert.equal(p.price_phase, 'standard');
  assert.equal(p.amount, 500);
});

test('**金額を引けない組み合わせでは null**（推測で金額を作らない）', () => {
  for (const ctx of [
    { plan_id: 'free', status: 'active' },
    { plan_id: 'web_pro', status: 'active', currency: 'jpy' },
    { plan_id: 'web_pro', status: 'active', price_phase: 'launch' },
    { plan_id: 'web_pro', status: 'active', currency: 'jpy', price_phase: 'unknown_phase' },
    { plan_id: 'extension_pro', status: 'active', currency: 'jpy', price_phase: 'launch' },
    { plan_id: 'web_pro', status: 'active', currency: 'eur', price_phase: 'launch' },
  ]) {
    const p = buildBillingPayload(ctx);
    assert.equal(p.amount, null, JSON.stringify(ctx));
    assert.equal(p.tax_behavior, null, JSON.stringify(ctx));
  }
});

test('price_phase が文字列でなければ null', () => {
  const p = buildBillingPayload({ plan_id: 'web_pro', status: 'active',
                                  currency: 'jpy', price_phase: 123 });
  assert.equal(p.price_phase, null);
  assert.equal(p.amount, null);
});

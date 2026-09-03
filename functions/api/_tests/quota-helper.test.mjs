// =========================================================
// _lib/quota.js の単体テスト（entitlement 判定 / 行の取り出し / エラー分類）
//
//   - Supabase RPC はすべてスタブに差し替える。ネットワークへは出ない。
//   - 本番の secret / Project URL はフィクスチャに一切保存しない。
// =========================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FREE_WEEKLY_LIMIT,
  WEB_UNLIMITED_PLAN_IDS,
  WEB_UNLIMITED_STATUSES,
  hasWebUnlimited,
  json,
  mapRpcError,
  readSingleRow,
} from '../_lib/quota.js';
import { SupabaseError } from '../_lib/supabase.js';

const quiet = { error() {}, warn() {}, log() {} };

const ALL_PLAN_IDS = ['free', 'web_pro', 'extension_pro', 'all_pro'];
const ALL_STATUSES = [
  'active', 'trialing', 'past_due',
  'canceled', 'unpaid', 'incomplete', 'incomplete_expired',
];

// =========================================================
// 定数
// =========================================================

test('Free の上限は 3（migration の p_limit 既定値と同じ）', () => {
  assert.equal(FREE_WEEKLY_LIMIT, 3);
});

test('Web 無制限の条件は web_pro / all_pro かつ active / trialing のみ', () => {
  assert.deepEqual([...WEB_UNLIMITED_PLAN_IDS].sort(), ['all_pro', 'web_pro']);
  assert.deepEqual([...WEB_UNLIMITED_STATUSES].sort(), ['active', 'trialing']);
});

// =========================================================
// entitlement
// =========================================================

test('web_pro / all_pro × active / trialing だけが無制限', () => {
  for (const plan_id of ALL_PLAN_IDS) {
    for (const status of ALL_STATUSES) {
      const expected = (plan_id === 'web_pro' || plan_id === 'all_pro')
                    && (status === 'active' || status === 'trialing');
      assert.equal(hasWebUnlimited({ plan_id, status }), expected, `${plan_id} / ${status}`);
    }
  }
});

test('past_due は Pro 扱いしない', () => {
  assert.equal(hasWebUnlimited({ plan_id: 'web_pro', status: 'past_due' }), false);
  assert.equal(hasWebUnlimited({ plan_id: 'all_pro', status: 'past_due' }), false);
});

test('extension_pro は Web では quota 対象', () => {
  for (const status of ALL_STATUSES) {
    assert.equal(hasWebUnlimited({ plan_id: 'extension_pro', status }), false, status);
  }
});

test('context が壊れていたら quota 対象（フェイルクローズ）', () => {
  for (const v of [null, undefined, 'web_pro', 123, {}, { plan_id: 'web_pro' }, { status: 'active' }]) {
    assert.equal(hasWebUnlimited(v), false, String(v));
  }
});

test('未知の plan_id / status は quota 対象', () => {
  assert.equal(hasWebUnlimited({ plan_id: 'super_pro', status: 'active' }), false);
  assert.equal(hasWebUnlimited({ plan_id: 'web_pro', status: 'paused' }), false);
});

// =========================================================
// readSingleRow
// =========================================================

test('readSingleRow: 1 行だけ取り出す', () => {
  assert.deepEqual(readSingleRow([{ ok: true }]), { ok: true });
});

test('readSingleRow: 0 行 / 複数行 / 配列でない / 行がオブジェクトでないは null', () => {
  for (const v of [[], [{}, {}], null, undefined, {}, 'x', [null], [[]], [1]]) {
    assert.equal(readSingleRow(v), null, JSON.stringify(v));
  }
});

// =========================================================
// エラー分類
// =========================================================

test('mapRpcError: not_configured は 500 server_misconfigured', async () => {
  const res = mapRpcError(new SupabaseError('not_configured', 'x'), 'tag', quiet);
  assert.equal(res.status, 500);
  assert.deepEqual(JSON.parse(await res.text()), { error: 'server_misconfigured' });
});

test('mapRpcError: unavailable / request_failed は 502 database_unavailable', async () => {
  for (const code of ['unavailable', 'request_failed']) {
    const res = mapRpcError(new SupabaseError(code, 'x'), 'tag', quiet);
    assert.equal(res.status, 502, code);
    assert.deepEqual(JSON.parse(await res.text()), { error: 'database_unavailable' });
  }
});

test('mapRpcError: 想定外の例外は 500 internal_error', async () => {
  const res = mapRpcError(new Error('boom'), 'tag', quiet);
  assert.equal(res.status, 500);
  assert.deepEqual(JSON.parse(await res.text()), { error: 'internal_error' });
});

test('mapRpcError: Supabase のエラー本文をクライアントへ返さない', async () => {
  const secretish = 'sb_secret_should_not_leak';
  const res = mapRpcError(new SupabaseError('request_failed', secretish), 'tag', quiet);
  assert.equal((await res.text()).includes(secretish), false);
});

// =========================================================
// レスポンスヘッダ
// =========================================================

test('json(): no-store と Vary: Cookie を必ず付ける', () => {
  const res = json(200, { a: 1 });
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('vary'), 'Cookie');
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
});

test('json(): 追加ヘッダを載せられる', () => {
  const res = json(401, { error: 'unauthenticated' }, { 'Set-Cookie': 'x=1' });
  assert.equal(res.headers.get('set-cookie'), 'x=1');
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

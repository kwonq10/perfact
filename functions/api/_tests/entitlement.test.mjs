// =========================================================
// _lib/entitlement.js の単体テスト（Pro 判定 / past_due 7 日猶予 / 互換性）
//
//   - 外部 I/O は無い。DB にも Stripe にもネットワークにも出ない。
//   - now はすべて引数で注入する。実時刻に依存させない。
//   - 既存の hasWebUnlimited / hasExtensionUnlimited の互換もここで固定する。
// =========================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EXTENSION_PRO_PLAN_IDS,
  GRACE_STATUS,
  PAST_DUE_GRACE_DAYS,
  PAST_DUE_GRACE_MS,
  PRO_STATUSES,
  WEB_PRO_PLAN_IDS,
  hasExtensionEntitlement,
  hasWebEntitlement,
  isEntitled,
  isWithinPastDueGrace,
  resolveNowMs,
  toTimestampMs,
} from '../_lib/entitlement.js';

import {
  WEB_UNLIMITED_PLAN_IDS,
  WEB_UNLIMITED_STATUSES,
  hasWebUnlimited,
} from '../_lib/quota.js';

import {
  EXTENSION_UNLIMITED_PLAN_IDS,
  hasExtensionUnlimited,
} from '../_lib/ext-quota.js';

/** 猶予テストの基準。仕様書の例と同じ値。 */
const SINCE = '2026-09-01T10:00:00.000Z';
const SINCE_MS = Date.parse(SINCE);

/** 判定に now を使わないケースで渡す固定時刻。 */
const T = '2026-09-01T12:00:00.000Z';

const ALL_STATUSES = [
  'active', 'trialing', 'past_due',
  'canceled', 'unpaid', 'incomplete', 'incomplete_expired',
];

// =========================================================
// 1. 定数
// =========================================================

test('対象プランは Web が web_pro / all_pro、Extension が extension_pro / all_pro', () => {
  assert.deepEqual([...WEB_PRO_PLAN_IDS].sort(), ['all_pro', 'web_pro']);
  assert.deepEqual([...EXTENSION_PRO_PLAN_IDS].sort(), ['all_pro', 'extension_pro']);
});

test('無条件で Pro になる status は active / trialing のみ', () => {
  assert.deepEqual([...PRO_STATUSES].sort(), ['active', 'trialing']);
  assert.equal(PRO_STATUSES.includes('past_due'), false, 'past_due は猶予判定を経る');
  assert.equal(GRACE_STATUS, 'past_due');
});

test('猶予期間は 7 日', () => {
  assert.equal(PAST_DUE_GRACE_DAYS, 7);
  assert.equal(PAST_DUE_GRACE_MS, 7 * 24 * 60 * 60 * 1000);
  assert.equal(PAST_DUE_GRACE_MS, 604800000);
});

// =========================================================
// 2. Web entitlement（要件 1-5）
// =========================================================

test('web_pro + active -> Web true', () => {
  assert.equal(hasWebEntitlement({ plan_id: 'web_pro', status: 'active' }, T), true);
});

test('web_pro + trialing -> Web true', () => {
  assert.equal(hasWebEntitlement({ plan_id: 'web_pro', status: 'trialing' }, T), true);
});

test('all_pro + active -> Web true', () => {
  assert.equal(hasWebEntitlement({ plan_id: 'all_pro', status: 'active' }, T), true);
});

test('extension_pro + active -> Web false', () => {
  assert.equal(hasWebEntitlement({ plan_id: 'extension_pro', status: 'active' }, T), false);
});

test('free + active -> Web false', () => {
  assert.equal(hasWebEntitlement({ plan_id: 'free', status: 'active' }, T), false);
});

// =========================================================
// 3. Extension entitlement（要件 6-10）
// =========================================================

test('extension_pro + active -> Extension true', () => {
  assert.equal(hasExtensionEntitlement({ plan_id: 'extension_pro', status: 'active' }, T), true);
});

test('extension_pro + trialing -> Extension true', () => {
  assert.equal(hasExtensionEntitlement({ plan_id: 'extension_pro', status: 'trialing' }, T), true);
});

test('all_pro + active -> Extension true', () => {
  assert.equal(hasExtensionEntitlement({ plan_id: 'all_pro', status: 'active' }, T), true);
});

test('web_pro + active -> Extension false', () => {
  assert.equal(hasExtensionEntitlement({ plan_id: 'web_pro', status: 'active' }, T), false);
});

test('free + active -> Extension false', () => {
  assert.equal(hasExtensionEntitlement({ plan_id: 'free', status: 'active' }, T), false);
});

// =========================================================
// 4. Web / Extension の分離（要件 7）
// =========================================================

test('plan ごとに Web / Extension の権限が独立している', () => {
  const cases = [
    { plan_id: 'web_pro', web: true, ext: false },
    { plan_id: 'extension_pro', web: false, ext: true },
    { plan_id: 'all_pro', web: true, ext: true },
    { plan_id: 'free', web: false, ext: false },
  ];
  for (const c of cases) {
    const ctx = { plan_id: c.plan_id, status: 'active' };
    assert.equal(hasWebEntitlement(ctx, T), c.web, c.plan_id + ' / web');
    assert.equal(hasExtensionEntitlement(ctx, T), c.ext, c.plan_id + ' / extension');
  }
});

test('free は status が何であっても Pro にならない', () => {
  for (const status of ALL_STATUSES) {
    const ctx = { plan_id: 'free', status, past_due_since: SINCE };
    assert.equal(hasWebEntitlement(ctx, SINCE), false, 'web / ' + status);
    assert.equal(hasExtensionEntitlement(ctx, SINCE), false, 'extension / ' + status);
  }
});

// =========================================================
// 5. past_due の猶予（要件 11-19）
//    past_due_since = 2026-09-01T10:00:00.000Z を基準に境界を固定する。
// =========================================================

test('web_pro + past_due + 猶予開始直後 -> Web true', () => {
  const ctx = { plan_id: 'web_pro', status: 'past_due', past_due_since: SINCE };
  assert.equal(hasWebEntitlement(ctx, SINCE), true, '同時刻でも猶予内');
  assert.equal(hasWebEntitlement(ctx, '2026-09-01T10:00:01.000Z'), true);
});

test('extension_pro + past_due + 猶予開始直後 -> Extension true', () => {
  const ctx = { plan_id: 'extension_pro', status: 'past_due', past_due_since: SINCE };
  assert.equal(hasExtensionEntitlement(ctx, SINCE), true);
  assert.equal(hasExtensionEntitlement(ctx, '2026-09-01T10:00:01.000Z'), true);
});

test('all_pro + past_due は猶予内なら Web / Extension 両方 true', () => {
  const ctx = { plan_id: 'all_pro', status: 'past_due', past_due_since: SINCE };
  assert.equal(hasWebEntitlement(ctx, '2026-09-05T00:00:00.000Z'), true);
  assert.equal(hasExtensionEntitlement(ctx, '2026-09-05T00:00:00.000Z'), true);
});

test('7 日直前（2026-09-08T09:59:59.999Z）はまだ Pro', () => {
  const ctx = { plan_id: 'web_pro', status: 'past_due', past_due_since: SINCE };
  assert.equal(hasWebEntitlement(ctx, '2026-09-08T09:59:59.999Z'), true);
  assert.equal(isWithinPastDueGrace(SINCE, '2026-09-08T09:59:59.999Z'), true);
});

test('7 日ちょうど（2026-09-08T10:00:00.000Z）から Free', () => {
  const ctx = { plan_id: 'web_pro', status: 'past_due', past_due_since: SINCE };
  assert.equal(hasWebEntitlement(ctx, '2026-09-08T10:00:00.000Z'), false);
  assert.equal(isWithinPastDueGrace(SINCE, '2026-09-08T10:00:00.000Z'), false);
});

test('7 日超過は Free', () => {
  const ctx = { plan_id: 'all_pro', status: 'past_due', past_due_since: SINCE };
  assert.equal(hasWebEntitlement(ctx, '2026-09-08T10:00:00.001Z'), false);
  assert.equal(hasExtensionEntitlement(ctx, '2026-10-01T00:00:00.000Z'), false);
});

test('境界は epoch ミリ秒でも同じ', () => {
  assert.equal(isWithinPastDueGrace(SINCE_MS, SINCE_MS + PAST_DUE_GRACE_MS - 1), true);
  assert.equal(isWithinPastDueGrace(SINCE_MS, SINCE_MS + PAST_DUE_GRACE_MS), false);
});

test('past_due_since が無ければ Free（DB 未対応の現状はここに落ちる）', () => {
  for (const plan_id of ['web_pro', 'extension_pro', 'all_pro']) {
    assert.equal(hasWebEntitlement({ plan_id, status: 'past_due' }, T), false, plan_id);
    assert.equal(hasExtensionEntitlement({ plan_id, status: 'past_due' }, T), false, plan_id);
  }
  assert.equal(isWithinPastDueGrace(undefined, T), false);
  assert.equal(isWithinPastDueGrace(null, T), false);
});

test('past_due_since が不正な値なら Free', () => {
  for (const bad of ['not-a-date', '', '   ', Number.NaN, {}, [], true, new Date('nope')]) {
    assert.equal(isWithinPastDueGrace(bad, T), false, String(bad));
    const ctx = { plan_id: 'web_pro', status: 'past_due', past_due_since: bad };
    assert.equal(hasWebEntitlement(ctx, T), false, String(bad));
  }
});

test('past_due_since が未来なら Free（誤った DB 値で猶予を延ばさない）', () => {
  const future = '2026-09-02T10:00:00.000Z';
  assert.equal(isWithinPastDueGrace(future, SINCE), false);
  const ctx = { plan_id: 'all_pro', status: 'past_due', past_due_since: future };
  assert.equal(hasWebEntitlement(ctx, SINCE), false);
  assert.equal(hasExtensionEntitlement(ctx, SINCE), false);
});

test('now が不正なら猶予を与えない', () => {
  assert.equal(isWithinPastDueGrace(SINCE, 'not-a-date'), false);
  const ctx = { plan_id: 'web_pro', status: 'past_due', past_due_since: SINCE };
  assert.equal(hasWebEntitlement(ctx, 'not-a-date'), false);
});

test('past_due_since は active / trialing の判定に影響しない', () => {
  const ancient = '2020-01-01T00:00:00.000Z';
  for (const status of ['active', 'trialing']) {
    const ctx = { plan_id: 'web_pro', status, past_due_since: ancient };
    assert.equal(hasWebEntitlement(ctx, T), true, status);
  }
});

test('active / trialing は now が不正でも Pro のまま', () => {
  // 判定に無関係な引数の不備で支払い済み利用者の権限を落とさない。
  assert.equal(hasWebEntitlement({ plan_id: 'web_pro', status: 'active' }, 'not-a-date'), true);
  assert.equal(
    hasExtensionEntitlement({ plan_id: 'all_pro', status: 'trialing' }, 'not-a-date'),
    true,
  );
});

// =========================================================
// 6. Pro 扱いしない status（要件 20-23）
// =========================================================

test('incomplete / incomplete_expired / unpaid / canceled は Pro にならない', () => {
  for (const status of ['incomplete', 'incomplete_expired', 'unpaid', 'canceled']) {
    for (const plan_id of ['web_pro', 'extension_pro', 'all_pro']) {
      const ctx = { plan_id, status, past_due_since: SINCE };
      assert.equal(hasWebEntitlement(ctx, SINCE), false, plan_id + ' / ' + status + ' / web');
      assert.equal(
        hasExtensionEntitlement(ctx, SINCE), false,
        plan_id + ' / ' + status + ' / extension',
      );
    }
  }
});

// =========================================================
// 7. フェイルクローズ（要件 24-27）
// =========================================================

test('未知の plan は Pro にならない', () => {
  for (const plan_id of ['super_pro', 'WEB_PRO', 'pro', '']) {
    assert.equal(hasWebEntitlement({ plan_id, status: 'active' }, T), false, plan_id);
    assert.equal(hasExtensionEntitlement({ plan_id, status: 'active' }, T), false, plan_id);
  }
});

test('未知の status は Pro にならない', () => {
  for (const status of ['paused', 'ACTIVE', 'past-due', '']) {
    assert.equal(hasWebEntitlement({ plan_id: 'web_pro', status }, T), false, status);
    assert.equal(hasExtensionEntitlement({ plan_id: 'all_pro', status }, T), false, status);
  }
});

test('null / undefined / 壊れた context は throw せず false', () => {
  const broken = [
    null, undefined, 'web_pro', 123, true, [],
    {}, { plan_id: 'web_pro' }, { status: 'active' },
    { plan_id: 123, status: 'active' }, { plan_id: 'web_pro', status: 456 },
  ];
  for (const ctx of broken) {
    assert.equal(hasWebEntitlement(ctx, T), false, String(ctx));
    assert.equal(hasExtensionEntitlement(ctx, T), false, String(ctx));
    assert.equal(isEntitled(ctx, WEB_PRO_PLAN_IDS, T), false, String(ctx));
  }
});

test('allowedPlanIds が配列でなければ false', () => {
  const ctx = { plan_id: 'web_pro', status: 'active' };
  for (const plans of [null, undefined, 'web_pro', {}, 123]) {
    assert.equal(isEntitled(ctx, plans, T), false, String(plans));
  }
});

// =========================================================
// 8. 時刻ヘルパー
// =========================================================

test('toTimestampMs は Date / number / ISO 文字列を同じに扱う', () => {
  assert.equal(toTimestampMs(SINCE), SINCE_MS);
  assert.equal(toTimestampMs(new Date(SINCE)), SINCE_MS);
  assert.equal(toTimestampMs(SINCE_MS), SINCE_MS);
});

test('toTimestampMs は省略・不正を必ず null にする（現在時刻へ倒さない）', () => {
  for (const bad of [null, undefined, '', '  ', 'nope', Number.NaN, {}, [], new Date('nope')]) {
    assert.equal(toTimestampMs(bad), null, String(bad));
  }
});

test('resolveNowMs は省略時だけ現在時刻を使う', () => {
  const before = Date.now();
  const ms = resolveNowMs(undefined);
  assert.ok(ms >= before && ms <= Date.now());

  assert.equal(resolveNowMs(SINCE), SINCE_MS);
  assert.equal(resolveNowMs(null), null, 'null は現在時刻へ倒さない');
  assert.equal(resolveNowMs('nope'), null);
});

test('now を省略しても active は Pro のまま（wrapper 経路と同じ）', () => {
  assert.equal(hasWebEntitlement({ plan_id: 'web_pro', status: 'active' }), true);
  assert.equal(hasExtensionEntitlement({ plan_id: 'all_pro', status: 'active' }), true);
});

// =========================================================
// 9. 既存 wrapper の互換性（要件 28-30）
// =========================================================

test('hasWebUnlimited のシグネチャが維持されている（引数 1 / boolean を返す）', () => {
  assert.equal(typeof hasWebUnlimited, 'function');
  assert.equal(hasWebUnlimited.length, 1, 'context だけを取る');
  assert.equal(typeof hasWebUnlimited({ plan_id: 'web_pro', status: 'active' }), 'boolean');
});

test('hasExtensionUnlimited のシグネチャが維持されている（引数 1 / boolean を返す）', () => {
  assert.equal(typeof hasExtensionUnlimited, 'function');
  assert.equal(hasExtensionUnlimited.length, 1, 'context だけを取る');
  assert.equal(
    typeof hasExtensionUnlimited({ plan_id: 'extension_pro', status: 'active' }),
    'boolean',
  );
});

test('active / trialing の既存挙動が変わっていない（Web）', () => {
  for (const plan_id of ['free', 'web_pro', 'extension_pro', 'all_pro']) {
    for (const status of ALL_STATUSES) {
      const expected = (plan_id === 'web_pro' || plan_id === 'all_pro')
                    && (status === 'active' || status === 'trialing');
      assert.equal(
        hasWebUnlimited({ plan_id, status }), expected,
        plan_id + ' / ' + status,
      );
    }
  }
});

test('active / trialing の既存挙動が変わっていない（Extension）', () => {
  for (const plan_id of ['free', 'web_pro', 'extension_pro', 'all_pro']) {
    for (const status of ALL_STATUSES) {
      const expected = (plan_id === 'extension_pro' || plan_id === 'all_pro')
                    && (status === 'active' || status === 'trialing');
      assert.equal(
        hasExtensionUnlimited({ plan_id, status }), expected,
        plan_id + ' / ' + status,
      );
    }
  }
});

test('past_due_since を持たない context では wrapper は従来どおり Free', () => {
  // DB に past_due_since が無い現在の本番構造での挙動を固定する。
  assert.equal(hasWebUnlimited({ plan_id: 'web_pro', status: 'past_due' }), false);
  assert.equal(hasWebUnlimited({ plan_id: 'all_pro', status: 'past_due' }), false);
  assert.equal(hasExtensionUnlimited({ plan_id: 'extension_pro', status: 'past_due' }), false);
  assert.equal(hasExtensionUnlimited({ plan_id: 'all_pro', status: 'past_due' }), false);
});

test('wrapper も壊れた context で throw しない', () => {
  for (const ctx of [null, undefined, 'web_pro', 123, {}, { plan_id: 'web_pro' }]) {
    assert.equal(hasWebUnlimited(ctx), false, String(ctx));
    assert.equal(hasExtensionUnlimited(ctx), false, String(ctx));
  }
});

test('互換 export の定数が entitlement core と同じ値を指す', () => {
  assert.deepEqual([...WEB_UNLIMITED_PLAN_IDS], [...WEB_PRO_PLAN_IDS]);
  assert.deepEqual([...WEB_UNLIMITED_STATUSES], [...PRO_STATUSES]);
  assert.deepEqual([...EXTENSION_UNLIMITED_PLAN_IDS], [...EXTENSION_PRO_PLAN_IDS]);
});

test('互換 export の定数は凍結されたまま', () => {
  assert.equal(Object.isFrozen(WEB_UNLIMITED_PLAN_IDS), true);
  assert.equal(Object.isFrozen(WEB_UNLIMITED_STATUSES), true);
  assert.equal(Object.isFrozen(EXTENSION_UNLIMITED_PLAN_IDS), true);
});

test('wrapper 経由でも past_due_since があれば猶予が効く', () => {
  // wrapper は now を渡さないためサーバー現在時刻で判定される。
  // 「いま」から 1 分前に past_due になった context は猶予内。
  const justNow = new Date(Date.now() - 60 * 1000).toISOString();
  assert.equal(
    hasWebUnlimited({ plan_id: 'web_pro', status: 'past_due', past_due_since: justNow }),
    true,
  );
  // 8 日前なら猶予切れ。
  const longAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  assert.equal(
    hasWebUnlimited({ plan_id: 'web_pro', status: 'past_due', past_due_since: longAgo }),
    false,
  );
});

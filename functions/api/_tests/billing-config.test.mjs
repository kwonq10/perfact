// =========================================================
// _lib/billing-config.js の単体テスト（設定表 / 価格解決 / 逆引き）
//
//   - 外部 I/O は一切無い。Stripe にも Supabase にもネットワークにも出ない。
//   - **実際の Stripe Price ID はフィクスチャに書かない。**
//     env はテスト内で組み立てたダミー値のみを使う。
//   - 本番の secret / Project URL / webhook secret は一切登場しない。
// =========================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CURRENCIES,
  DEFAULT_CURRENCY_BY_LOCALE,
  INTERVALS,
  LAUNCH_END_AT,
  LAUNCH_END_MS,
  PLANS,
  PLAN_IDS,
  PRICE_DEFINITIONS,
  PRICE_ENV_KEYS,
  PRICE_PHASES,
  PURCHASABLE_COUNTRIES,
  PURCHASABLE_CURRENCIES,
  SUBSCRIPTION_TERMS_CONFIG,
  SUBSCRIPTION_TERMS_LOCALES,
  SUBSCRIPTION_TERMS_STATUSES,
  SUPPORTED_COUNTRIES,
  SUPPORTED_CURRENCIES,
  SUPPORTED_INTERVALS,
  SubscriptionTermsConfigError,
  TERMS_VERSION_MAX_LENGTH,
  defaultCurrencyForLocale,
  getCurrentSubscriptionTermsVersion,
  getPublicPlanConfig,
  getPublicSubscriptionTermsConfig,
  isKnownPlan,
  isPurchasableCountry,
  isPurchasableCurrency,
  isPurchasablePlan,
  isSupportedCountry,
  isSupportedCurrency,
  isSupportedInterval,
  isSupportedTermsLocale,
  isValidTermsVersion,
  phaseAt,
  planFromPriceId,
  priceDefinitionFromPriceId,
  resolvePriceDefinition,
  resolvePurchasablePrice,
  resolveTermsVersion,
  toEpochMs,
  validateBillingConfig,
  validateEnvPriceIds,
  validateSalesAvailability,
  validateSubscriptionTermsConfig,
  PRICE_DISPLAY_AMOUNTS,
  resolveDisplayAmount,
} from '../_lib/billing-config.js';

/** テスト用のダミー env。実際の Stripe Price ID ではない。 */
const ENV = Object.freeze({
  STRIPE_PRICE_WEB_PRO_JPY_LAUNCH: 'price_test_jpy_launch',
  STRIPE_PRICE_WEB_PRO_JPY_STANDARD: 'price_test_jpy_standard',
  STRIPE_PRICE_WEB_PRO_USD_LAUNCH: 'price_test_usd_launch',
  STRIPE_PRICE_WEB_PRO_USD_STANDARD: 'price_test_usd_standard',
});

// =========================================================
// 1. Plans
// =========================================================

test('plan は DB の CHECK 制約と同じ 4 値', () => {
  assert.deepEqual([...PLAN_IDS], ['free', 'web_pro', 'extension_pro', 'all_pro']);
  assert.deepEqual(Object.keys(PLANS).sort(), [...PLAN_IDS].sort());
});

test('今回購入できるのは web_pro だけ', () => {
  assert.equal(isPurchasablePlan('web_pro'), true);
  assert.equal(isPurchasablePlan('free'), false);
  assert.equal(isPurchasablePlan('extension_pro'), false);
  assert.equal(isPurchasablePlan('all_pro'), false);
});

test('extension_pro / all_pro は Coming Soon として既知だが購入不可', () => {
  for (const planId of ['extension_pro', 'all_pro']) {
    assert.equal(isKnownPlan(planId), true, planId + ' は既知のプラン');
    assert.equal(PLANS[planId].coming_soon, true, planId + ' は Coming Soon');
    assert.equal(PLANS[planId].purchasable, false, planId + ' は購入不可');
  }
});

test('未知の plan_id は既知にも購入可能にもならない', () => {
  for (const bad of ['', 'pro', 'WEB_PRO', null, undefined, 0, {}]) {
    assert.equal(isKnownPlan(bad), false);
    assert.equal(isPurchasablePlan(bad), false);
  }
});

// =========================================================
// 2. Countries
// =========================================================

test('初期有料販売国は JP / US / GB / CA / AU', () => {
  assert.deepEqual([...SUPPORTED_COUNTRIES].sort(), ['AU', 'CA', 'GB', 'JP', 'US']);
});

test('国コードは大小文字と前後空白を正規化して判定する', () => {
  assert.equal(isSupportedCountry('JP'), true);
  assert.equal(isSupportedCountry('jp'), true);
  assert.equal(isSupportedCountry(' us '), true);
  assert.equal(isSupportedCountry('DE'), false);
  assert.equal(isSupportedCountry(''), false);
  assert.equal(isSupportedCountry(null), false);
});

// =========================================================
// 3. Currencies
// =========================================================

test('今回有効な通貨は jpy / usd のみ', () => {
  assert.deepEqual([...SUPPORTED_CURRENCIES].sort(), ['jpy', 'usd']);
  assert.equal(isSupportedCurrency('jpy'), true);
  assert.equal(isSupportedCurrency('usd'), true);
});

test('gbp / cad / aud は将来用に定義済みだが今回は無効', () => {
  for (const code of ['gbp', 'cad', 'aud']) {
    assert.ok(CURRENCIES[code], code + ' は定義されている');
    assert.equal(CURRENCIES[code].enabled, false, code + ' は無効');
    assert.equal(isSupportedCurrency(code), false);
  }
});

test('tax_behavior は JPY=inclusive / USD=exclusive', () => {
  assert.equal(CURRENCIES.jpy.tax_behavior, 'inclusive');
  assert.equal(CURRENCIES.usd.tax_behavior, 'exclusive');
});

test('locale の既定通貨は ja→jpy / en→usd、未知は usd', () => {
  assert.deepEqual({ ...DEFAULT_CURRENCY_BY_LOCALE }, { ja: 'jpy', en: 'usd' });
  assert.equal(defaultCurrencyForLocale('ja'), 'jpy');
  assert.equal(defaultCurrencyForLocale('en'), 'usd');
  assert.equal(defaultCurrencyForLocale('en-GB'), 'usd');
  assert.equal(defaultCurrencyForLocale('ja-JP'), 'jpy');
  assert.equal(defaultCurrencyForLocale('fr'), 'usd');
  assert.equal(defaultCurrencyForLocale(null), 'usd');
});

// =========================================================
// 4. Intervals
// =========================================================

test('今回有効な課金間隔は month のみ。year は無効で Price も持たない', () => {
  assert.deepEqual([...SUPPORTED_INTERVALS], ['month']);
  assert.equal(isSupportedInterval('month'), true);
  assert.equal(INTERVALS.year.enabled, false);
  assert.equal(isSupportedInterval('year'), false);
  assert.equal(
    PRICE_DEFINITIONS.some((d) => d.interval === 'year'),
    false,
    'year の Price 定義は今回作らない',
  );
});

// =========================================================
// 5. Launch 期限の境界（**JST 基準**）
//
//    規約と特商法表記の「2026 年 12 月 31 日まで」は、
//    日本のみへ販売している以上 **JST の 12 月 31 日**を指す。
//    境界は JST の年替わり = 2026-12-31T15:00:00.000Z。
// =========================================================

/** JST の壁時計を UTC の epoch ms へ直すヘルパー（テスト内の可読性のため）。 */
function jst(iso) {
  // '2026-12-31T23:59:59.999' を JST として解釈する
  return Date.parse(iso + '+09:00');
}

test('launch 終了時刻は JST の年替わり（2026-12-31T15:00:00.000Z）', () => {
  assert.equal(LAUNCH_END_AT, '2026-12-31T15:00:00.000Z');
  assert.equal(LAUNCH_END_MS, Date.parse('2026-12-31T15:00:00.000Z'));
  // JST で表すと 2027-01-01 00:00:00 ちょうど
  assert.equal(LAUNCH_END_MS, jst('2027-01-01T00:00:00.000'));
});

test('JST 2026-12-31 23:59:59.999 までは launch（境界直前）', () => {
  assert.equal(phaseAt(jst('2026-12-31T23:59:59.999')), 'launch');
  assert.equal(phaseAt(jst('2026-12-31T23:59:59.000')), 'launch');
  assert.equal(phaseAt(jst('2026-12-31T00:00:00.000')), 'launch');
});

test('JST 2027-01-01 00:00:00.000 ちょうどから standard（境界は含まない）', () => {
  assert.equal(phaseAt(jst('2027-01-01T00:00:00.000')), 'standard');
});

test('JST 2027-01-01 00:00:00.001 以降は standard（境界直後）', () => {
  assert.equal(phaseAt(jst('2027-01-01T00:00:00.001')), 'standard');
  assert.equal(phaseAt(jst('2027-01-01T09:00:00.000')), 'standard');
});

test('UTC 表記でも同じ境界になる（1 ミリ秒単位で固定）', () => {
  assert.equal(phaseAt('2026-12-31T14:59:59.999Z'), 'launch');
  assert.equal(phaseAt('2026-12-31T15:00:00.000Z'), 'standard');
  assert.equal(phaseAt('2026-12-31T15:00:00.001Z'), 'standard');
});

test('旧 UTC 基準の 9 時間ぶんは standard になった（JST 元日は launch ではない）', () => {
  // 以前は 2027-01-01T00:00:00Z が境界で、JST 元日の 0:00〜9:00 が launch だった。
  // 規約の「12 月 31 日まで」と食い違うため修正した。
  assert.equal(phaseAt('2026-12-31T20:00:00.000Z'), 'standard');  // JST 1/1 05:00
  assert.equal(phaseAt('2027-01-01T00:00:00.000Z'), 'standard');
});

test('日付だけの文字列は UTC 解釈なので JST の朝 9 時に相当する', () => {
  // '2026-12-31' は UTC 0 時 = JST 12/31 09:00 -> launch
  assert.equal(phaseAt('2026-12-31'), 'launch');
  // '2027-01-01' は UTC 0 時 = JST 1/1 09:00 -> standard
  assert.equal(phaseAt('2027-01-01'), 'standard');
});

test('phaseAt は Date / number / ISO 文字列を同じに扱う', () => {
  const iso = '2026-12-31T12:00:00.000Z';
  assert.equal(phaseAt(iso), 'launch');
  assert.equal(phaseAt(new Date(iso)), 'launch');
  assert.equal(phaseAt(Date.parse(iso)), 'launch');
});

test('解釈できない now は null（勝手に launch へ倒さない）', () => {
  assert.equal(phaseAt('not-a-date'), null);
  assert.equal(phaseAt(new Date('not-a-date')), null);
  assert.equal(phaseAt(Number.NaN), null);
  assert.equal(phaseAt({}), null);
  assert.equal(toEpochMs('not-a-date'), null);
});

test('now 省略時はサーバー現在時刻を使う', () => {
  const before = Date.now();
  const ms = toEpochMs(undefined);
  assert.ok(ms >= before && ms <= Date.now());
  assert.ok(PRICE_PHASES.includes(phaseAt(undefined)));
});

// =========================================================
// 6. Price resolution
// =========================================================

test('web_pro / jpy / month / 2026-12-31 -> launch', () => {
  const r = resolvePriceDefinition('web_pro', 'jpy', 'month', '2026-12-31');
  assert.equal(r.ok, true);
  assert.equal(r.phase, 'launch');
  assert.equal(r.definition.price_id_env_key, 'STRIPE_PRICE_WEB_PRO_JPY_LAUNCH');
  assert.equal(r.definition.tax_behavior, 'inclusive');
});

test('web_pro / usd / month / 2026-12-31 -> launch', () => {
  const r = resolvePriceDefinition('web_pro', 'usd', 'month', '2026-12-31');
  assert.equal(r.ok, true);
  assert.equal(r.phase, 'launch');
  assert.equal(r.definition.price_id_env_key, 'STRIPE_PRICE_WEB_PRO_USD_LAUNCH');
  assert.equal(r.definition.tax_behavior, 'exclusive');
});

test('web_pro / jpy / month / 2027-01-01 -> standard', () => {
  const r = resolvePriceDefinition('web_pro', 'jpy', 'month', '2027-01-01');
  assert.equal(r.ok, true);
  assert.equal(r.phase, 'standard');
  assert.equal(r.definition.price_id_env_key, 'STRIPE_PRICE_WEB_PRO_JPY_STANDARD');
});

test('web_pro / usd / month / 2027-01-01 -> standard', () => {
  const r = resolvePriceDefinition('web_pro', 'usd', 'month', '2027-01-01');
  assert.equal(r.ok, true);
  assert.equal(r.phase, 'standard');
  assert.equal(r.definition.price_id_env_key, 'STRIPE_PRICE_WEB_PRO_USD_STANDARD');
});

test('extension_pro は販売不可', () => {
  const r = resolvePriceDefinition('extension_pro', 'jpy', 'month', '2026-12-31');
  assert.deepEqual(r, { ok: false, code: 'plan_not_purchasable' });
});

test('all_pro は販売不可', () => {
  const r = resolvePriceDefinition('all_pro', 'usd', 'month', '2026-12-31');
  assert.deepEqual(r, { ok: false, code: 'plan_not_purchasable' });
});

test('free は販売不可', () => {
  const r = resolvePriceDefinition('free', 'jpy', 'month', '2026-12-31');
  assert.deepEqual(r, { ok: false, code: 'plan_not_purchasable' });
});

test('未知の plan は unknown_plan', () => {
  const r = resolvePriceDefinition('super_pro', 'jpy', 'month', '2026-12-31');
  assert.deepEqual(r, { ok: false, code: 'unknown_plan' });
});

test('unsupported currency は失敗する', () => {
  for (const currency of ['gbp', 'cad', 'aud', 'eur', 'JPY', '']) {
    const r = resolvePriceDefinition('web_pro', currency, 'month', '2026-12-31');
    assert.deepEqual(r, { ok: false, code: 'unsupported_currency' }, currency);
  }
});

test('unsupported interval は失敗する', () => {
  for (const interval of ['year', 'week', 'day', 'MONTH', '']) {
    const r = resolvePriceDefinition('web_pro', 'jpy', interval, '2026-12-31');
    assert.deepEqual(r, { ok: false, code: 'unsupported_interval' }, interval);
  }
});

test('解釈できない now は invalid_now で失敗する（既定で launch にしない）', () => {
  const r = resolvePriceDefinition('web_pro', 'jpy', 'month', 'not-a-date');
  assert.deepEqual(r, { ok: false, code: 'invalid_now' });
});

test('resolvePriceDefinition は phase も price_id も引数に取らない', () => {
  // 引数は (planId, currency, interval, now) の 4 つだけ。
  // client から phase / price_id を渡す口が構造的に存在しないことを固定する。
  assert.equal(resolvePriceDefinition.length, 4);

  // 5 番目に phase らしき値を足しても結果は変わらない。
  const withExtra = resolvePriceDefinition('web_pro', 'jpy', 'month', '2027-06-01', 'launch');
  assert.equal(withExtra.ok, true);
  assert.equal(withExtra.phase, 'standard', '2027 年は必ず standard');
});

// =========================================================
// 7. Reverse mapping（webhook 用）
// =========================================================

test('Web Pro の 4 つの Price はすべて web_pro へ逆引きされる', () => {
  const priceIds = [
    ENV.STRIPE_PRICE_WEB_PRO_JPY_LAUNCH,
    ENV.STRIPE_PRICE_WEB_PRO_JPY_STANDARD,
    ENV.STRIPE_PRICE_WEB_PRO_USD_LAUNCH,
    ENV.STRIPE_PRICE_WEB_PRO_USD_STANDARD,
  ];
  assert.equal(new Set(priceIds).size, 4, '4 つとも別の price_id');
  for (const priceId of priceIds) {
    assert.equal(planFromPriceId(priceId, ENV), 'web_pro', priceId);
  }
});

test('逆引きは通貨と phase まで復元できる', () => {
  const r = priceDefinitionFromPriceId(ENV.STRIPE_PRICE_WEB_PRO_USD_LAUNCH, ENV);
  assert.equal(r.ok, true);
  assert.equal(r.definition.plan_id, 'web_pro');
  assert.equal(r.definition.currency, 'usd');
  assert.equal(r.definition.interval, 'month');
  assert.equal(r.definition.phase, 'launch');
});

test('未知の price_id は安全に失敗する', () => {
  assert.equal(planFromPriceId('price_unknown', ENV), null);
  assert.deepEqual(
    priceDefinitionFromPriceId('price_unknown', ENV),
    { ok: false, code: 'unknown_price_id' },
  );
});

test('空・非文字列の price_id は invalid_price_id', () => {
  for (const bad of ['', '   ', null, undefined, 123, {}]) {
    assert.deepEqual(
      priceDefinitionFromPriceId(bad, ENV),
      { ok: false, code: 'invalid_price_id' },
    );
    assert.equal(planFromPriceId(bad, ENV), null);
  }
});

test('env が空・未指定でも例外にせず unknown_price_id を返す', () => {
  assert.equal(planFromPriceId('price_test_jpy_launch', {}), null);
  assert.equal(planFromPriceId('price_test_jpy_launch', undefined), null);
  assert.equal(planFromPriceId('price_test_jpy_launch', null), null);
});

test('同じ price_id が複数の env キーに入っていたら ambiguous で拒否する', () => {
  const broken = { ...ENV, STRIPE_PRICE_WEB_PRO_JPY_STANDARD: 'price_test_jpy_launch' };
  assert.deepEqual(
    priceDefinitionFromPriceId('price_test_jpy_launch', broken),
    { ok: false, code: 'ambiguous_price_id' },
  );
  assert.equal(planFromPriceId('price_test_jpy_launch', broken), null);
});

test('price_id の前後空白は正規化して引ける', () => {
  const padded = { ...ENV, STRIPE_PRICE_WEB_PRO_JPY_LAUNCH: '  price_test_jpy_launch  ' };
  assert.equal(planFromPriceId('price_test_jpy_launch', padded), 'web_pro');
  assert.equal(planFromPriceId('  price_test_jpy_launch  ', ENV), 'web_pro');
});

// =========================================================
// 8. Public configuration
// =========================================================

test('public 設定に Stripe の情報が一切含まれない', () => {
  const serialized = JSON.stringify(getPublicPlanConfig());
  assert.equal(serialized.includes('price_id_env_key'), false);
  assert.equal(serialized.includes('STRIPE'), false);
  for (const key of PRICE_ENV_KEYS) {
    assert.equal(serialized.includes(key), false, key + ' が漏れている');
  }
  for (const value of Object.values(ENV)) {
    assert.equal(serialized.includes(value), false, 'price id の実値が漏れている');
  }
});

test('public 設定は 4 プランを display_order 順に返す', () => {
  const config = getPublicPlanConfig();
  assert.equal(config.length, 4);
  assert.deepEqual(config.map((p) => p.plan_id), ['free', 'web_pro', 'extension_pro', 'all_pro']);
});

test('public 設定の web_pro は jpy / usd の month を持つ', () => {
  const webPro = getPublicPlanConfig().find((p) => p.plan_id === 'web_pro');
  assert.equal(webPro.purchasable, true);
  assert.equal(webPro.coming_soon, false);
  assert.deepEqual([...webPro.currencies].sort(), ['jpy', 'usd']);
  assert.deepEqual(webPro.intervals, ['month']);
});

test('public 設定の Coming Soon プランは通貨も間隔も空にする', () => {
  for (const planId of ['extension_pro', 'all_pro']) {
    const plan = getPublicPlanConfig().find((p) => p.plan_id === planId);
    assert.equal(plan.coming_soon, true);
    assert.equal(plan.purchasable, false);
    assert.deepEqual(plan.currencies, [], planId);
    assert.deepEqual(plan.intervals, [], planId);
  }
});

// =========================================================
// 9. Validation
// =========================================================

test('同梱の設定表は検証を通る', () => {
  assert.deepEqual(validateBillingConfig(), { ok: true });
});

test('Price 定義に重複した組み合わせが無い', () => {
  const combos = PRICE_DEFINITIONS.map(
    (d) => d.plan_id + '/' + d.currency + '/' + d.interval + '/' + d.phase,
  );
  assert.equal(new Set(combos).size, combos.length);
});

test('Price 定義の env キーは 4 本で重複が無い', () => {
  assert.equal(PRICE_ENV_KEYS.length, 4);
  assert.deepEqual([...PRICE_ENV_KEYS].sort(), [
    'STRIPE_PRICE_WEB_PRO_JPY_LAUNCH',
    'STRIPE_PRICE_WEB_PRO_JPY_STANDARD',
    'STRIPE_PRICE_WEB_PRO_USD_LAUNCH',
    'STRIPE_PRICE_WEB_PRO_USD_STANDARD',
  ]);
});

test('Price 定義の phase は launch / standard のみ', () => {
  for (const d of PRICE_DEFINITIONS) {
    assert.ok(PRICE_PHASES.includes(d.phase), d.price_id_env_key);
  }
});

test('env が揃っていれば validateEnvPriceIds は通る', () => {
  assert.deepEqual(validateEnvPriceIds(ENV), { ok: true });
});

test('env が欠けていたらキー名だけを報告する（値は出さない）', () => {
  const partial = { STRIPE_PRICE_WEB_PRO_JPY_LAUNCH: 'price_test_jpy_launch' };
  const result = validateEnvPriceIds(partial);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 3);
  for (const message of result.errors) {
    assert.ok(message.startsWith('missing env: '), message);
    assert.equal(message.includes('price_test_jpy_launch'), false, '値が漏れている');
  }
});

test('空文字の env は未設定として扱う', () => {
  const blank = { ...ENV, STRIPE_PRICE_WEB_PRO_USD_STANDARD: '   ' };
  const result = validateEnvPriceIds(blank);
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, ['missing env: STRIPE_PRICE_WEB_PRO_USD_STANDARD']);
});

test('env の重複はキー名だけで報告し、値を出さない', () => {
  const dup = { ...ENV, STRIPE_PRICE_WEB_PRO_USD_STANDARD: 'price_test_jpy_launch' };
  const result = validateEnvPriceIds(dup);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.ok(result.errors[0].includes('STRIPE_PRICE_WEB_PRO_JPY_LAUNCH'));
  assert.ok(result.errors[0].includes('STRIPE_PRICE_WEB_PRO_USD_STANDARD'));
  assert.equal(result.errors[0].includes('price_test_jpy_launch'), false, '値が漏れている');
});

test('validateEnvPriceIds は env が無くても例外にならない', () => {
  for (const env of [undefined, null, {}, 'nope']) {
    const result = validateEnvPriceIds(env);
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 4);
  }
});

// =========================================================
// 10. 設定表に Stripe Price ID の実値が混入していないこと
// =========================================================

test('設定表は env キー名だけを持ち、Price ID の実値を持たない', () => {
  for (const d of PRICE_DEFINITIONS) {
    assert.ok(
      d.price_id_env_key.startsWith('STRIPE_PRICE_'),
      d.price_id_env_key + ' は env キー名の形',
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(d, 'price_id'),
      false,
      'price_id の実値を設定表に置かない',
    );
  }
});


// =========================================================
// 12. Subscription Terms
//
//   **本番設定は published。**
//   本番設定を書き換えるテストは書かない。draft 側の fail closed は
//   純粋関数 resolveTermsVersion / validateSubscriptionTermsConfig に
//   draft の設定オブジェクトを渡して検証する（本番が published でも
//   「draft なら同意を記録しない」性質そのものは守り続ける）。
// =========================================================

test('Terms 設定は published で、版は YYYY-MM-DD 形式', () => {
  assert.equal(SUBSCRIPTION_TERMS_CONFIG.status, 'published');
  assert.equal(isValidTermsVersion(SUBSCRIPTION_TERMS_CONFIG.version), true,
    '版が形式を満たしていない: ' + String(SUBSCRIPTION_TERMS_CONFIG.version));
});

test('本番の Terms 設定そのものが検証を通る', () => {
  assert.deepEqual(validateSubscriptionTermsConfig(), { ok: true });
});

test('Terms の locale は ja / en の 2 つ（DB の CHECK と一致）', () => {
  assert.deepEqual([...SUBSCRIPTION_TERMS_CONFIG.locales], ['ja', 'en']);
  assert.deepEqual([...SUBSCRIPTION_TERMS_LOCALES], ['ja', 'en']);
});

test('取り得る status は draft / published だけ', () => {
  assert.deepEqual([...SUBSCRIPTION_TERMS_STATUSES], ['draft', 'published']);
});

test('Terms 設定は凍結されていて書き換えられない', () => {
  assert.equal(Object.isFrozen(SUBSCRIPTION_TERMS_CONFIG), true);
  assert.equal(Object.isFrozen(SUBSCRIPTION_TERMS_CONFIG.locales), true);
  assert.equal(Object.isFrozen(SUBSCRIPTION_TERMS_LOCALES), true);
  assert.equal(Object.isFrozen(SUBSCRIPTION_TERMS_STATUSES), true);
  const version = SUBSCRIPTION_TERMS_CONFIG.version;
  assert.throws(() => { SUBSCRIPTION_TERMS_CONFIG.status = 'draft'; }, TypeError);
  assert.throws(() => { SUBSCRIPTION_TERMS_CONFIG.version = '2026-12-01'; }, TypeError);
  assert.throws(() => { SUBSCRIPTION_TERMS_CONFIG.locales.push('fr'); }, TypeError);
  assert.equal(SUBSCRIPTION_TERMS_CONFIG.status, 'published');
  assert.equal(SUBSCRIPTION_TERMS_CONFIG.version, version);
  assert.equal(SUBSCRIPTION_TERMS_CONFIG.locales.length, 2);
});

test('版の最大長は DB の CHECK（1〜64）と同じ 64', () => {
  assert.equal(TERMS_VERSION_MAX_LENGTH, 64);
});

test('妥当な版: YYYY-MM-DD', () => {
  assert.equal(isValidTermsVersion('2026-12-01'), true);
  assert.equal(isValidTermsVersion('2027-01-01'), true);
});

test('妥当な版: YYYY-MM-DD-<連番>（同日に複数回出す場合）', () => {
  assert.equal(isValidTermsVersion('2026-12-01-1'), true);
  assert.equal(isValidTermsVersion('2026-12-01-2'), true);
  assert.equal(isValidTermsVersion('2026-12-01-10'), true);
});

test('版: 空文字を拒否する', () => {
  assert.equal(isValidTermsVersion(''), false);
});

test('版: 空白のみを拒否する', () => {
  assert.equal(isValidTermsVersion(' '), false);
  assert.equal(isValidTermsVersion('   '), false);
});

test('版: 前後の空白を正規化せず拒否する（DB が別行として扱うのを防ぐ）', () => {
  assert.equal(isValidTermsVersion(' 2026-12-01'), false);
  assert.equal(isValidTermsVersion('2026-12-01 '), false);
  assert.equal(isValidTermsVersion(' 2026-12-01 '), false);
});

test('版: 長すぎる値を拒否する（DB の 64 文字上限と一致）', () => {
  const prefix = '2026-12-01-';
  const tooLong = prefix + '9'.repeat(TERMS_VERSION_MAX_LENGTH);
  assert.ok(tooLong.length > TERMS_VERSION_MAX_LENGTH);
  assert.equal(isValidTermsVersion(tooLong), false);

  const exact = prefix + '9'.repeat(TERMS_VERSION_MAX_LENGTH - prefix.length);
  assert.equal(exact.length, TERMS_VERSION_MAX_LENGTH);
  assert.equal(isValidTermsVersion(exact), true);
});

test('版: 文字列でない値を拒否する', () => {
  for (const v of [null, undefined, 0, 1, true, false, {}, [], new Date()]) {
    assert.equal(isValidTermsVersion(v), false, String(v));
  }
});

test('版: 日付ベースでない形を拒否する', () => {
  const bad = ['v1', '1', '2026', '2026-12', '20261201', '2026/12/01',
               '2026-12-01-', '2026-12-01-a', 'a2026-12-01', '2026-12-01x'];
  for (const v of bad) {
    assert.equal(isValidTermsVersion(v), false, v);
  }
});

test('版: 暦の妥当性までは見ない（DB と同じ範囲に留める）', () => {
  assert.equal(isValidTermsVersion('2026-02-30'), true);
  assert.equal(isValidTermsVersion('2026-13-01'), true);
});

test('locale: ja / en を受け付ける', () => {
  assert.equal(isSupportedTermsLocale('ja'), true);
  assert.equal(isSupportedTermsLocale('en'), true);
});

test('locale: 大文字を寄せずに拒否する（DB の CHECK が小文字のみのため）', () => {
  assert.equal(isSupportedTermsLocale('JA'), false);
  assert.equal(isSupportedTermsLocale('EN'), false);
  assert.equal(isSupportedTermsLocale('Ja'), false);
});

test('locale: 未対応の言語を拒否する', () => {
  for (const v of ['fr', 'de', 'zh', 'ja-JP', 'en-US']) {
    assert.equal(isSupportedTermsLocale(v), false, v);
  }
});

test('locale: 空 / 空白 / 非文字列を拒否する', () => {
  for (const v of ['', ' ', ' ja', 'ja ', null, undefined, 0, {}, []]) {
    assert.equal(isSupportedTermsLocale(v), false, String(v));
  }
});

test('published なので現行版を取得できる（consent の成功経路が開く）', () => {
  assert.equal(getCurrentSubscriptionTermsVersion(), SUBSCRIPTION_TERMS_CONFIG.version);
});

test('本番設定に対する resolveTermsVersion は現行版を返す', () => {
  assert.deepEqual(
    resolveTermsVersion(SUBSCRIPTION_TERMS_CONFIG),
    { ok: true, version: SUBSCRIPTION_TERMS_CONFIG.version },
  );
});

test('draft へ戻せば fail closed に戻る（純粋関数で検証）', () => {
  // **published にしたあとも、この性質を失っていないことを固定する。**
  // 版を取り下げたい状況（重大な誤りの発見など）で draft へ戻せば、
  // 未確定の規約への同意が記録され得ない状態へ戻せる。
  assert.deepEqual(
    resolveTermsVersion({ status: 'draft', version: null, locales: ['ja', 'en'] }),
    { ok: false, code: 'not_published' },
  );
});

test('SubscriptionTermsConfigError は not_published を code で運べる', () => {
  const e = new SubscriptionTermsConfigError('not_published', 'x');
  assert.equal(e instanceof SubscriptionTermsConfigError, true);
  assert.equal(e.code, 'not_published');
});

test('published + 妥当な版なら現行版を返せる（純粋関数で検証）', () => {
  assert.deepEqual(
    resolveTermsVersion({ status: 'published', version: '2026-12-01', locales: ['ja', 'en'] }),
    { ok: true, version: '2026-12-01' },
  );
  assert.deepEqual(
    resolveTermsVersion({ status: 'published', version: '2026-12-01-1', locales: ['ja', 'en'] }),
    { ok: true, version: '2026-12-01-1' },
  );
});

test('published なのに版が不正なら fail closed', () => {
  for (const version of [null, undefined, '', ' ', ' 2026-12-01', 'v1', 123]) {
    assert.deepEqual(
      resolveTermsVersion({ status: 'published', version, locales: ['ja', 'en'] }),
      { ok: false, code: 'invalid_version' },
      String(version),
    );
  }
});

test('未知の status は fail closed', () => {
  for (const status of ['PUBLISHED', 'live', 'review', '', null, undefined, 1]) {
    assert.deepEqual(
      resolveTermsVersion({ status, version: '2026-12-01', locales: ['ja', 'en'] }),
      { ok: false, code: 'unknown_status' },
      String(status),
    );
  }
});

test('設定がオブジェクトでなければ fail closed', () => {
  for (const config of [null, undefined, '', 'draft', 0, true]) {
    assert.deepEqual(
      resolveTermsVersion(config),
      { ok: false, code: 'invalid_config' },
      String(config),
    );
  }
});

test('本番の Terms 設定は validateSubscriptionTermsConfig を通る', () => {
  assert.deepEqual(validateSubscriptionTermsConfig(), { ok: true });
});

test('validateSubscriptionTermsConfig: draft なのに版が入っていたら弾く', () => {
  const r = validateSubscriptionTermsConfig({
    status: 'draft', version: '2026-12-01', locales: ['ja', 'en'],
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('draft')), JSON.stringify(r.errors));
});

test('validateSubscriptionTermsConfig: published + 妥当な版は通る', () => {
  assert.deepEqual(
    validateSubscriptionTermsConfig({
      status: 'published', version: '2026-12-01', locales: ['ja', 'en'],
    }),
    { ok: true },
  );
});

test('validateSubscriptionTermsConfig: published なのに版が不正なら弾く', () => {
  const r = validateSubscriptionTermsConfig({
    status: 'published', version: null, locales: ['ja', 'en'],
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('invalid version')), JSON.stringify(r.errors));
});

test('validateSubscriptionTermsConfig: locales の異常を弾く', () => {
  const empty = validateSubscriptionTermsConfig({ status: 'draft', version: null, locales: [] });
  assert.equal(empty.ok, false);

  const unknown = validateSubscriptionTermsConfig({
    status: 'draft', version: null, locales: ['ja', 'fr'],
  });
  assert.equal(unknown.ok, false);
  assert.ok(unknown.errors.some((e) => e.includes('unsupported terms locale: fr')));

  const dup = validateSubscriptionTermsConfig({
    status: 'draft', version: null, locales: ['ja', 'ja'],
  });
  assert.equal(dup.ok, false);
  assert.ok(dup.errors.some((e) => e.includes('duplicate terms locale: ja')));

  const notArray = validateSubscriptionTermsConfig({
    status: 'draft', version: null, locales: 'ja',
  });
  assert.equal(notArray.ok, false);
});

test('public 設定は渡してよいものだけを写し、本体を参照させない', () => {
  const pub = getPublicSubscriptionTermsConfig();
  assert.deepEqual(pub, {
    status: 'published',
    version: SUBSCRIPTION_TERMS_CONFIG.version,
    locales: ['ja', 'en'],
  });
  assert.notEqual(pub.locales, SUBSCRIPTION_TERMS_CONFIG.locales);
  pub.locales.push('fr');
  assert.equal(SUBSCRIPTION_TERMS_CONFIG.locales.length, 2);
  assert.deepEqual([...getPublicSubscriptionTermsConfig().locales], ['ja', 'en']);
});

test('published なので public 設定も現行版を含む', () => {
  assert.equal(getPublicSubscriptionTermsConfig().version, SUBSCRIPTION_TERMS_CONFIG.version);
});

test('draft の設定を渡せば public 側でも版は null のまま（純粋性の確認）', () => {
  // getPublicSubscriptionTermsConfig() は本番設定を写すだけの関数なので、
  // draft 時の挙動は resolveTermsVersion 側の分岐で担保されている。
  assert.deepEqual(
    resolveTermsVersion({ status: 'draft', version: null, locales: ['ja'] }),
    { ok: false, code: 'not_published' },
  );
});


// =========================================================
// 13. Sales availability
//
//   **「認識できる国・通貨」と「いま購入できる国・通貨」を分けた**ことを固定する。
//   初期の有料販売は日本のみ。US / GB / CA / AU と USD は
//   定義を残したまま販売停止。
// =========================================================

test('認識できる国は 5 か国のまま（既存 API を壊していない）', () => {
  assert.deepEqual([...SUPPORTED_COUNTRIES].sort(), ['AU', 'CA', 'GB', 'JP', 'US']);
  for (const c of ['JP', 'US', 'GB', 'CA', 'AU']) {
    assert.equal(isSupportedCountry(c), true, c);
  }
});

test('いま購入できる国は日本のみ', () => {
  assert.deepEqual([...PURCHASABLE_COUNTRIES], ['JP']);
  assert.equal(isPurchasableCountry('JP'), true);
  assert.equal(isPurchasableCountry('jp'), true);
  assert.equal(isPurchasableCountry(' jp '), true);
});

test('US / GB / CA / AU は購入不可（定義は残っている）', () => {
  for (const c of ['US', 'GB', 'CA', 'AU']) {
    assert.equal(isSupportedCountry(c), true, c + ' は認識できる');
    assert.equal(isPurchasableCountry(c), false, c + ' は購入できない');
  }
});

test('未知の国 / 非文字列は購入不可', () => {
  for (const c of ['DE', 'FR', '', ' ', null, undefined, 0, {}, []]) {
    assert.equal(isPurchasableCountry(c), false, String(c));
  }
});

test('いま購入できる通貨は JPY のみ（USD の定義は残す）', () => {
  assert.deepEqual([...PURCHASABLE_CURRENCIES], ['jpy']);
  assert.equal(isPurchasableCurrency('jpy'), true);
  assert.equal(isPurchasableCurrency('JPY'), true);
  assert.equal(isPurchasableCurrency('usd'), false);
  assert.equal(isSupportedCurrency('usd'), true, 'USD は認識できるまま');
});

test('USD の Price 定義と逆引きは維持されている（将来再開用）', () => {
  const usd = PRICE_DEFINITIONS.filter((d) => d.currency === 'usd');
  assert.equal(usd.length, 2, 'USD の launch / standard が残っている');
  assert.deepEqual(usd.map((d) => d.phase).sort(), ['launch', 'standard']);
  // resolvePriceDefinition（webhook の逆引きが依存）は挙動を変えていない
  const r = resolvePriceDefinition('web_pro', 'usd', 'month', new Date('2026-09-08T00:00:00Z'));
  assert.equal(r.ok, true, 'USD の Price は今も解決できる');
});

test('JPY の価格定義は維持されている', () => {
  const jpy = PRICE_DEFINITIONS.filter((d) => d.currency === 'jpy');
  assert.equal(jpy.length, 2);
  for (const d of jpy) assert.equal(d.tax_behavior, 'inclusive');
});

test('resolvePurchasablePrice は日本 + 日本円だけを通す', () => {
  const now = new Date('2026-09-08T00:00:00Z');
  const ok = resolvePurchasablePrice('web_pro', 'JP', 'jpy', 'month', now);
  assert.equal(ok.ok, true);
  assert.equal(ok.phase, 'launch');

  for (const c of ['US', 'GB', 'CA', 'AU', 'DE']) {
    assert.deepEqual(resolvePurchasablePrice('web_pro', c, 'jpy', 'month', now),
      { ok: false, code: 'country_not_purchasable' }, c);
  }
  assert.deepEqual(resolvePurchasablePrice('web_pro', 'JP', 'usd', 'month', now),
    { ok: false, code: 'currency_not_purchasable' });
});

test('resolvePurchasablePrice は販売可否を先に見る（国が不可なら plan も見ない）', () => {
  assert.deepEqual(resolvePurchasablePrice('unknown_plan', 'US', 'usd', 'month'),
    { ok: false, code: 'country_not_purchasable' });
});

test('resolvePurchasablePrice は resolvePriceDefinition の code をそのまま返す', () => {
  const now = new Date('2026-09-08T00:00:00Z');
  assert.deepEqual(resolvePurchasablePrice('nope', 'JP', 'jpy', 'month', now),
    { ok: false, code: 'unknown_plan' });
  assert.deepEqual(resolvePurchasablePrice('extension_pro', 'JP', 'jpy', 'month', now),
    { ok: false, code: 'plan_not_purchasable' });
  assert.deepEqual(resolvePurchasablePrice('web_pro', 'JP', 'jpy', 'year', now),
    { ok: false, code: 'unsupported_interval' });
});

test('Extension Pro / All Pro は引き続き購入不可', () => {
  for (const plan of ['extension_pro', 'all_pro']) {
    assert.equal(isPurchasablePlan(plan), false, plan);
    assert.deepEqual(resolvePurchasablePrice(plan, 'JP', 'jpy', 'month'),
      { ok: false, code: 'plan_not_purchasable' }, plan);
  }
});

test('販売可否の設定そのものが整合している', () => {
  assert.deepEqual(validateSalesAvailability(), { ok: true });
});

test('購入可能国 / 通貨は認識できる集合の部分集合', () => {
  for (const c of PURCHASABLE_COUNTRIES) assert.equal(isSupportedCountry(c), true, c);
  for (const c of PURCHASABLE_CURRENCIES) assert.equal(isSupportedCurrency(c), true, c);
});

test('既存の設定検証は引き続き通る（breaking change なし）', () => {
  assert.deepEqual(validateBillingConfig(), { ok: true });
  assert.deepEqual(validateSubscriptionTermsConfig(), { ok: true });
});


// =========================================================
// 表示専用の金額表
//
//   **請求額の正は Stripe の Price。** ここは画面表示のためだけの表で、
//   ずれると「画面の金額」と「請求額」が食い違うので検証で縛る。
// =========================================================

test('JPY の launch / standard が Pricing・Terms の金額と一致する', () => {
  assert.equal(resolveDisplayAmount('web_pro', 'jpy', 'launch').amount, 300);
  assert.equal(resolveDisplayAmount('web_pro', 'jpy', 'standard').amount, 500);
});

test('JPY は税込、USD は税別として返す', () => {
  assert.equal(resolveDisplayAmount('web_pro', 'jpy', 'launch').tax_behavior, 'inclusive');
  assert.equal(resolveDisplayAmount('web_pro', 'usd', 'launch').tax_behavior, 'exclusive');
});

test('**知らない組み合わせは null**（推測で金額を作らない）', () => {
  assert.equal(resolveDisplayAmount('free', 'jpy', 'launch'), null);
  assert.equal(resolveDisplayAmount('extension_pro', 'jpy', 'launch'), null);
  assert.equal(resolveDisplayAmount('all_pro', 'jpy', 'launch'), null);
  assert.equal(resolveDisplayAmount('web_pro', 'eur', 'launch'), null);
  assert.equal(resolveDisplayAmount('web_pro', 'jpy', 'unknown'), null);
  assert.equal(resolveDisplayAmount('web_pro', 'jpy', 'launch', 'year'), null);
  assert.equal(resolveDisplayAmount(null, 'jpy', 'launch'), null);
  assert.equal(resolveDisplayAmount('web_pro', null, 'launch'), null);
});

test('**表示金額に Stripe の Price ID を持たせない**', () => {
  for (const row of PRICE_DISPLAY_AMOUNTS) {
    assert.equal(Object.prototype.hasOwnProperty.call(row, 'price_id_env_key'), false);
    assert.deepEqual(Object.keys(row).sort(),
      ['amount', 'currency', 'interval', 'phase', 'plan_id']);
  }
});

test('金額はその通貨の最小単位の正の整数', () => {
  for (const row of PRICE_DISPLAY_AMOUNTS) {
    assert.ok(Number.isInteger(row.amount), JSON.stringify(row));
    assert.ok(row.amount > 0, JSON.stringify(row));
  }
});

test('**PRICE_DEFINITIONS のすべてに表示金額がある**', () => {
  for (const d of PRICE_DEFINITIONS) {
    const found = resolveDisplayAmount(d.plan_id, d.currency, d.phase, d.interval);
    assert.notEqual(found, null,
      '表示金額が無い: ' + d.plan_id + '/' + d.currency + '/' + d.interval + '/' + d.phase);
  }
});

test('**売っていない金額を表に持たない**', () => {
  for (const a of PRICE_DISPLAY_AMOUNTS) {
    const sold = PRICE_DEFINITIONS.some(
      (d) => d.plan_id === a.plan_id && d.currency === a.currency
          && d.interval === a.interval && d.phase === a.phase);
    assert.ok(sold, '定義の無い表示金額: ' + JSON.stringify(a));
  }
});

test('validateBillingConfig が表示金額の欠落も見る', () => {
  assert.deepEqual(validateBillingConfig(), { ok: true });
});

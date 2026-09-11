// =========================================================
// billing-config — 課金の設定表と純粋ロジック（Cloudflare Pages Functions 専用）
//
//   ここには**外部 I/O を一切書かない**。
//   Stripe API も Supabase も fetch も呼ばず、env の**実値も読まない**。
//   checkout / webhook / portal / Pricing UI の 4 つがすべてこの表に依存する。
//
//   設計上の約束:
//     - **Stripe Price ID の実値をこのファイルに書かない。**
//       保持するのは「実値が入る環境変数の名前」だけ。
//     - **client から phase / price_id を受け取らない。**
//       phase はサーバー時刻から決める。resolvePriceDefinition の引数に
//       phase も price_id も存在しないため、古い launch 価格を client 側から
//       指名する経路が構造的に作れない。
//     - **plan と price/currency/interval/phase を分離する。**
//       plan は DB の subscriptions.plan_id CHECK と 1:1。
//       price は「同じ plan に複数ある」ことを前提にした配列。
//     - public 用と server-only 用を分離する。
//       getPublicPlanConfig() は price_id_env_key を**絶対に含めない**。
//     - env の値はログにもエラーにも出さない。出すのは**キー名だけ**。
//     - 検証は import 時に走らせない。純粋関数として呼び出し側が実行する。
//
//   entitlement 判定（plan + status → Pro か）は **_lib/entitlement.js** の担当であり、
//   このファイルには置かない。
// =========================================================


// =========================================================
// 1. Plans
//    DB の subscriptions.plan_id CHECK 制約と同じ 4 値。順序も揃える。
//
//    purchasable = false / coming_soon = true のプランは Pricing に
//    「Coming Soon」として並ぶが購入導線を出さない。
//    販売を開始するときは **この表の purchasable を true にするだけ**でよい
//    （そのプランの PRICE_DEFINITIONS を足すことが前提）。
// =========================================================

/** 全 plan_id。DB の CHECK 制約と一致させること。 */
export const PLAN_IDS = Object.freeze(['free', 'web_pro', 'extension_pro', 'all_pro']);

/**
 * プランの静的メタデータ。
 * 表示文言そのものは持たない（i18n はフロント側の責務）。
 */
export const PLANS = Object.freeze({
  free: Object.freeze({
    plan_id: 'free',
    purchasable: false,
    coming_soon: false,
    display_order: 1,
  }),
  web_pro: Object.freeze({
    plan_id: 'web_pro',
    purchasable: true,
    coming_soon: false,
    display_order: 2,
  }),
  extension_pro: Object.freeze({
    plan_id: 'extension_pro',
    purchasable: false,
    coming_soon: true,
    display_order: 3,
  }),
  all_pro: Object.freeze({
    plan_id: 'all_pro',
    purchasable: false,
    coming_soon: true,
    display_order: 4,
  }),
});

/** 既知の plan_id か。 */
export function isKnownPlan(planId) {
  return typeof planId === 'string' && Object.prototype.hasOwnProperty.call(PLANS, planId);
}

/** 現在購入できる plan_id か。Coming Soon は false。 */
export function isPurchasablePlan(planId) {
  return isKnownPlan(planId) && PLANS[planId].purchasable === true;
}


// =========================================================
// 2. Supported countries
//    **認識できる国**（将来対応を含む）。Stripe が返した請求先国の解釈と
//    webhook 側の検証がこの 1 箇所を参照する（二重管理を作らない）。
//    ISO 3166-1 alpha-2 の大文字で持つ。
//
//    ⚠ **「いま購入できる国」ではない。** 現在の販売可否は
//    13 節の PURCHASABLE_COUNTRIES が持つ。
// =========================================================

/** 認識できる国。将来対応も含む。現在の販売可否は 13 節を見ること。 */
export const SUPPORTED_COUNTRIES = Object.freeze(['JP', 'US', 'GB', 'CA', 'AU']);

/**
 * 有料販売の対象国か。
 * Stripe が返す country は大文字だが、比較前に正規化して取り違いを防ぐ。
 */
export function isSupportedCountry(country) {
  if (typeof country !== 'string') return false;
  return SUPPORTED_COUNTRIES.includes(country.trim().toUpperCase());
}


// =========================================================
// 3. Currencies
//    enabled を false から true にするだけで通貨を増やせる形にする。
//    gbp / cad / aud は将来用の予約。**今回は無効**で、対応する
//    PRICE_DEFINITIONS も持たせない。
//
//    tax_behavior は通貨ごとに決まる（JPY は税込表示、USD は税別表示）。
//    ここを唯一のルールとし、PRICE_DEFINITIONS 側の宣言が一致するかを
//    validateBillingConfig() で突き合わせる。
// =========================================================

/** 通貨の定義。code は Stripe に合わせて小文字。 */
export const CURRENCIES = Object.freeze({
  jpy: Object.freeze({ code: 'jpy', enabled: true, tax_behavior: 'inclusive' }),
  usd: Object.freeze({ code: 'usd', enabled: true, tax_behavior: 'exclusive' }),
  gbp: Object.freeze({ code: 'gbp', enabled: false, tax_behavior: 'exclusive' }),
  cad: Object.freeze({ code: 'cad', enabled: false, tax_behavior: 'exclusive' }),
  aud: Object.freeze({ code: 'aud', enabled: false, tax_behavior: 'exclusive' }),
});

/** 今回有効な通貨。 */
export const SUPPORTED_CURRENCIES = Object.freeze(
  Object.values(CURRENCIES).filter((c) => c.enabled).map((c) => c.code),
);

/** locale ごとの既定通貨。ja→JPY / en→USD。 */
export const DEFAULT_CURRENCY_BY_LOCALE = Object.freeze({ ja: 'jpy', en: 'usd' });

/** 今回有効な通貨か。 */
export function isSupportedCurrency(currency) {
  return typeof currency === 'string'
      && Object.prototype.hasOwnProperty.call(CURRENCIES, currency)
      && CURRENCIES[currency].enabled === true;
}

/**
 * locale の既定通貨。未知の locale は 'usd' に寄せる。
 * 契約前の Pricing でのみ手動変更でき、契約中は変更できない（製品仕様）。
 */
export function defaultCurrencyForLocale(locale) {
  if (typeof locale !== 'string') return 'usd';
  const key = locale.trim().toLowerCase().split('-')[0];
  return DEFAULT_CURRENCY_BY_LOCALE[key] || 'usd';
}


// =========================================================
// 4. Billing intervals
//    month のみ有効。year は将来用の予約で、有効な Price を持たせない。
// =========================================================

/** 課金間隔の定義。 */
export const INTERVALS = Object.freeze({
  month: Object.freeze({ code: 'month', enabled: true }),
  year: Object.freeze({ code: 'year', enabled: false }),
});

/** 今回有効な課金間隔。 */
export const SUPPORTED_INTERVALS = Object.freeze(
  Object.values(INTERVALS).filter((i) => i.enabled).map((i) => i.code),
);

/** 今回有効な課金間隔か。 */
export function isSupportedInterval(interval) {
  return typeof interval === 'string'
      && Object.prototype.hasOwnProperty.call(INTERVALS, interval)
      && INTERVALS[interval].enabled === true;
}


// =========================================================
// 5. Price phases
// =========================================================

/** 価格フェーズ。launch = ローンチ価格、standard = 通常価格。 */
export const PRICE_PHASES = Object.freeze(['launch', 'standard']);


// =========================================================
// 6. Launch eligibility
//
//   **境界の定義（ここが唯一の判断基準）**
//
//     LAUNCH_END_AT = 2026-12-31T15:00:00.000Z
//                   = 2027-01-01 00:00:00 JST（UTC+9）
//     now <  LAUNCH_END_AT  -> 'launch'
//     now >= LAUNCH_END_AT  -> 'standard'
//
//   **なぜ JST 基準なのか**
//     Subscription Terms と特商法表記は
//     「**2026 年 12 月 31 日まで**にご契約を開始された方が launch 価格」
//     と書いてある。そして **有料販売は日本のみ**（13 節 PURCHASABLE_COUNTRIES）。
//     読む人が全員 JST の生活者である以上、この「12 月 31 日」は
//     **JST の 12 月 31 日**を指す。
//     以前は UTC の 2027-01-01T00:00:00Z を境界にしていたが、それだと
//     **JST では 1 月 1 日 9 時まで launch が続き、規約の文言より 9 時間長かった。**
//     規約どおりの意味へそろえるため、境界を JST の年替わりに一致させた。
//
//   境界の帰結:
//     JST 2026-12-31 23:59:59.999  -> launch   （大晦日の最後の 1 ミリ秒まで）
//     JST 2027-01-01 00:00:00.000  -> standard （年が明けた瞬間から）
//
//   **「1 つの絶対時刻で判定する」という方針自体は変えていない。**
//     利用者ごとの timezone で判定すると、同じ瞬間に申し込んだ 2 人へ
//     別の価格を出すことになり、再現も検証もできなくなる。
//     ここが持つのは「JST の年替わりに相当する 1 つの絶対時刻」であって、
//     利用者の timezone ではない。
//
//   ⚠ **US / GB / CA / AU で販売を再開するときは、この境界を再検討すること。**
//     いまは日本以外へ売っていないので JST 基準で不都合が無いが、
//     販売国が増えると「どの国の 12 月 31 日か」を決め直す必要がある
//     （英語版 Terms の December 31, 2026 の解釈も同時に見直す）。
//
//   判定は必ずサーバー時刻で行う。client から phase を受け取らない。
// =========================================================

/**
 * ローンチ価格の終了時刻（この瞬間を含まない）。
 * **2027-01-01 00:00:00 JST = 2026-12-31T15:00:00Z。**
 * 値は UTC で持つが、意味は「JST の年替わり」。
 */
export const LAUNCH_END_AT = '2026-12-31T15:00:00.000Z';

/** LAUNCH_END_AT の epoch ミリ秒。比較はこの数値で行う。 */
export const LAUNCH_END_MS = Date.parse(LAUNCH_END_AT);

/**
 * now を epoch ミリ秒へ正規化する。
 * Date / number / ISO 文字列を受け取り、解釈できなければ null を返す。
 *
 * @param {Date|number|string|undefined} now 省略時はサーバー現在時刻
 * @returns {number|null}
 */
export function toEpochMs(now) {
  if (now === undefined || now === null) return Date.now();
  if (now instanceof Date) {
    const ms = now.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof now === 'number') {
    return Number.isFinite(now) ? now : null;
  }
  if (typeof now === 'string') {
    const ms = Date.parse(now);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

/**
 * サーバー時刻から価格フェーズを決める。
 * client の入力は一切参照しない。
 *
 * @param {Date|number|string|undefined} now
 * @returns {'launch'|'standard'|null} 解釈できない now は null
 */
export function phaseAt(now) {
  const ms = toEpochMs(now);
  if (ms === null) return null;
  return ms < LAUNCH_END_MS ? 'launch' : 'standard';
}


// =========================================================
// 7. Price definitions
//
//   **実際の Stripe Price ID はここに書かない。**
//   保持するのは price_id_env_key（実値が入る環境変数の名前）だけ。
//   実値の読み取りは webhook / checkout 側が env から行う。
//
//   extension_pro / all_pro は Coming Soon のため定義を持たない。
//   販売開始時は **この配列へ行を足し、PLANS の purchasable を true にする**
//   だけでよい（関数の変更は不要）。
//
//   「同じ plan に複数の price」を前提にした配列構造にしてある。
//   通貨・間隔・フェーズが増えても行が増えるだけで形は変わらない。
// =========================================================

/**
 * 販売可能な Price の定義。
 * @type {ReadonlyArray<{plan_id:string,currency:string,interval:string,phase:string,price_id_env_key:string,tax_behavior:string}>}
 */
export const PRICE_DEFINITIONS = Object.freeze([
  Object.freeze({
    plan_id: 'web_pro',
    currency: 'jpy',
    interval: 'month',
    phase: 'launch',
    price_id_env_key: 'STRIPE_PRICE_WEB_PRO_JPY_LAUNCH',
    tax_behavior: 'inclusive',
  }),
  Object.freeze({
    plan_id: 'web_pro',
    currency: 'jpy',
    interval: 'month',
    phase: 'standard',
    price_id_env_key: 'STRIPE_PRICE_WEB_PRO_JPY_STANDARD',
    tax_behavior: 'inclusive',
  }),
  Object.freeze({
    plan_id: 'web_pro',
    currency: 'usd',
    interval: 'month',
    phase: 'launch',
    price_id_env_key: 'STRIPE_PRICE_WEB_PRO_USD_LAUNCH',
    tax_behavior: 'exclusive',
  }),
  Object.freeze({
    plan_id: 'web_pro',
    currency: 'usd',
    interval: 'month',
    phase: 'standard',
    price_id_env_key: 'STRIPE_PRICE_WEB_PRO_USD_STANDARD',
    tax_behavior: 'exclusive',
  }),
]);

/**
 * **表示専用の金額表**。
 *
 * ⚠ **これは請求される金額の正ではない。** 実際に請求されるのは
 * Stripe 側の Price（`price_id_env_key` が指す Price ID）であって、
 * この表ではない。ここは「契約概要の画面に何円と出すか」だけを決める。
 *
 * それでもここへ置くのは、**client に金額をハードコードさせないため**。
 * 画面の金額は server が決め、`/api/auth/me` 経由で配る。
 *
 * ⚠ **Stripe 側の Price を変えたらこの表も直すこと。**
 * ずれると「画面の金額」と「請求額」が食い違う。
 * `validateBillingConfig()` が PRICE_DEFINITIONS との対応漏れを検出する。
 *
 * `amount` は**その通貨の最小単位**（JPY は円、USD はセント）。
 * `tax_behavior` は PRICE_DEFINITIONS と同じ意味（JPY=税込 / USD=税別）。
 *
 * @type {ReadonlyArray<{plan_id:string,currency:string,interval:string,phase:string,amount:number}>}
 */
export const PRICE_DISPLAY_AMOUNTS = Object.freeze([
  Object.freeze({ plan_id: 'web_pro', currency: 'jpy', interval: 'month', phase: 'launch', amount: 300 }),
  Object.freeze({ plan_id: 'web_pro', currency: 'jpy', interval: 'month', phase: 'standard', amount: 500 }),
  Object.freeze({ plan_id: 'web_pro', currency: 'usd', interval: 'month', phase: 'launch', amount: 299 }),
  Object.freeze({ plan_id: 'web_pro', currency: 'usd', interval: 'month', phase: 'standard', amount: 499 }),
]);

/**
 * 契約中の金額を表示用に引く。
 *
 * **見つからなければ null。** 推測で 0 円や既定価格を返さない
 * （知らない組み合わせを黙って安い金額で見せない）。
 *
 * @param {unknown} planId
 * @param {unknown} currency
 * @param {unknown} phase
 * @param {string} [interval]
 * @returns {{amount:number, currency:string, tax_behavior:string}|null}
 */
export function resolveDisplayAmount(planId, currency, phase, interval = 'month') {
  if (typeof planId !== 'string' || typeof currency !== 'string' || typeof phase !== 'string') {
    return null;
  }
  const row = PRICE_DISPLAY_AMOUNTS.find(
    (d) => d.plan_id === planId
        && d.currency === currency
        && d.phase === phase
        && d.interval === interval,
  );
  if (!row) return null;
  const currencyRow = CURRENCIES[row.currency];
  if (!currencyRow) return null;
  return {
    amount: row.amount,
    currency: row.currency,
    tax_behavior: currencyRow.tax_behavior,
  };
}

/** PRICE_DEFINITIONS が参照する環境変数名の一覧（重複なし）。 */
export const PRICE_ENV_KEYS = Object.freeze(
  [...new Set(PRICE_DEFINITIONS.map((d) => d.price_id_env_key))],
);


// =========================================================
// 8. Price resolution
//
//   **引数に phase も price_id も無い。**
//   これが「client が古い launch 価格を指名できない」ことの構造的な保証で、
//   checkout API はこの関数以外から price を決めてはならない。
// =========================================================

/**
 * 購入すべき Price 定義を決める。
 *
 * 失敗は例外ではなく { ok:false, code } で返す（quota API 群と同じ流儀）。
 * code:
 *   'unknown_plan'          既知でない plan_id
 *   'plan_not_purchasable'  Coming Soon 等で現在購入できない
 *   'unsupported_currency'  今回有効でない通貨
 *   'unsupported_interval'  今回有効でない課金間隔
 *   'invalid_now'           now を時刻として解釈できない
 *   'price_not_available'   組み合わせに対応する Price 定義が無い
 *
 * @param {string} planId
 * @param {string} currency
 * @param {string} interval
 * @param {Date|number|string} [now] 省略時はサーバー現在時刻
 * @returns {{ok:true,phase:string,definition:object}|{ok:false,code:string}}
 */
export function resolvePriceDefinition(planId, currency, interval, now) {
  if (!isKnownPlan(planId)) return { ok: false, code: 'unknown_plan' };
  if (!isPurchasablePlan(planId)) return { ok: false, code: 'plan_not_purchasable' };
  if (!isSupportedCurrency(currency)) return { ok: false, code: 'unsupported_currency' };
  if (!isSupportedInterval(interval)) return { ok: false, code: 'unsupported_interval' };

  const phase = phaseAt(now);
  if (phase === null) return { ok: false, code: 'invalid_now' };

  const definition = PRICE_DEFINITIONS.find(
    (d) => d.plan_id === planId
        && d.currency === currency
        && d.interval === interval
        && d.phase === phase,
  );
  if (!definition) return { ok: false, code: 'price_not_available' };

  return { ok: true, phase, definition };
}


// =========================================================
// 9. Reverse mapping（webhook 用）
//
//   Stripe から届いた price_id が「どの plan か」を引く。
//   env を引数で受け取るため、テストで実 env を汚さずに検証できる。
//
//   **env の値はログにもエラーにも出さない。** 返すのは定義とコードだけ。
// =========================================================

/**
 * env から「price_id の実値 -> 定義」の索引を作る。
 *
 * 同じ実値が 2 つ以上の env キーに入っていたら設定ミスなので、
 * その price_id は ambiguous として引けなくする（誤った plan を付けない）。
 *
 * @param {object} env
 * @returns {Map<string, {definition:object|null, ambiguous:boolean}>}
 */
function buildPriceIdIndex(env) {
  const index = new Map();
  if (!env || typeof env !== 'object') return index;

  for (const definition of PRICE_DEFINITIONS) {
    const raw = env[definition.price_id_env_key];
    if (typeof raw !== 'string') continue;
    const priceId = raw.trim();
    if (priceId.length === 0) continue;

    const existing = index.get(priceId);
    if (existing === undefined) {
      index.set(priceId, { definition, ambiguous: false });
    } else if (existing.definition !== definition) {
      index.set(priceId, { definition: null, ambiguous: true });
    }
  }
  return index;
}

/**
 * Stripe の price_id から Price 定義を引く。
 *
 * code:
 *   'invalid_price_id'   文字列でない / 空
 *   'unknown_price_id'   env のどのキーにも一致しない
 *   'ambiguous_price_id' 同じ実値が複数の env キーに入っている（設定ミス）
 *
 * @param {string} priceId
 * @param {object} env
 * @returns {{ok:true,definition:object}|{ok:false,code:string}}
 */
export function priceDefinitionFromPriceId(priceId, env) {
  if (typeof priceId !== 'string' || priceId.trim().length === 0) {
    return { ok: false, code: 'invalid_price_id' };
  }
  const hit = buildPriceIdIndex(env).get(priceId.trim());
  if (hit === undefined) return { ok: false, code: 'unknown_price_id' };
  if (hit.ambiguous) return { ok: false, code: 'ambiguous_price_id' };
  return { ok: true, definition: hit.definition };
}

/**
 * Stripe の price_id から plan_id を引く。
 * 複数の Price が同じ plan を指すことを前提にしている。
 * 引けなければ null（webhook 側で「未知の price」として扱う）。
 *
 * @param {string} priceId
 * @param {object} env
 * @returns {string|null}
 */
export function planFromPriceId(priceId, env) {
  const result = priceDefinitionFromPriceId(priceId, env);
  return result.ok ? result.definition.plan_id : null;
}


// =========================================================
// 10. Public configuration
//
//    **client へ渡してよい情報だけ**を組み立てる。
//    price_id_env_key は絶対に含めない（含めないことをテストで固定する）。
//    Pricing ページはここだけを参照する。
// =========================================================

/**
 * Pricing 等へ渡せるプラン設定。Stripe の情報は一切含まない。
 *
 * @returns {Array<{plan_id:string,purchasable:boolean,coming_soon:boolean,display_order:number,currencies:string[],intervals:string[]}>}
 */
export function getPublicPlanConfig() {
  return Object.values(PLANS)
    .slice()
    .sort((a, b) => a.display_order - b.display_order)
    .map((plan) => {
      const rows = plan.purchasable
        ? PRICE_DEFINITIONS.filter(
            (d) => d.plan_id === plan.plan_id
                && isSupportedCurrency(d.currency)
                && isSupportedInterval(d.interval),
          )
        : [];
      return {
        plan_id: plan.plan_id,
        purchasable: plan.purchasable,
        coming_soon: plan.coming_soon,
        display_order: plan.display_order,
        currencies: [...new Set(rows.map((d) => d.currency))],
        intervals: [...new Set(rows.map((d) => d.interval))],
      };
    });
}


// =========================================================
// 11. Validation
//
//    import 時には走らせない。呼び出し側が明示的に実行する純粋関数にする。
//    静的な設定表の検証（validateBillingConfig）と、
//    実 env の検証（validateEnvPriceIds）を分ける。
//
//    **どちらのエラー文にも env の値を入れない。入れるのはキー名だけ。**
// =========================================================

/**
 * 設定表そのものの整合を検証する。env は見ない。
 *
 * 検出するもの:
 *   - 同じ (plan_id, currency, interval, phase) の重複定義
 *   - 未知の plan_id / currency / interval / phase
 *   - price_id_env_key の欠落・重複
 *   - tax_behavior が通貨のルール（JPY=inclusive / USD=exclusive）と不一致
 *   - purchasable なのに有効な Price が 1 本も無いプラン
 *
 * @returns {{ok:true}|{ok:false,errors:string[]}}
 */
export function validateBillingConfig() {
  const errors = [];
  const seenCombo = new Set();
  const seenEnvKey = new Set();

  for (const d of PRICE_DEFINITIONS) {
    const where = d.plan_id + '/' + d.currency + '/' + d.interval + '/' + d.phase;

    if (!isKnownPlan(d.plan_id)) errors.push('unknown plan: ' + where);
    if (!Object.prototype.hasOwnProperty.call(CURRENCIES, d.currency)) {
      errors.push('unknown currency: ' + where);
    }
    if (!Object.prototype.hasOwnProperty.call(INTERVALS, d.interval)) {
      errors.push('unknown interval: ' + where);
    }
    if (!PRICE_PHASES.includes(d.phase)) errors.push('invalid phase: ' + where);

    if (seenCombo.has(where)) errors.push('duplicate price definition: ' + where);
    seenCombo.add(where);

    if (typeof d.price_id_env_key !== 'string' || d.price_id_env_key.length === 0) {
      errors.push('missing price_id_env_key: ' + where);
    } else if (seenEnvKey.has(d.price_id_env_key)) {
      errors.push('duplicate price_id_env_key: ' + d.price_id_env_key);
    } else {
      seenEnvKey.add(d.price_id_env_key);
    }

    const expected = CURRENCIES[d.currency] && CURRENCIES[d.currency].tax_behavior;
    if (expected && d.tax_behavior !== expected) {
      errors.push('tax_behavior mismatch: ' + where + ' expected ' + expected);
    }
  }

  for (const plan of Object.values(PLANS)) {
    if (!plan.purchasable) continue;
    const usable = PRICE_DEFINITIONS.some(
      (d) => d.plan_id === plan.plan_id
          && isSupportedCurrency(d.currency)
          && isSupportedInterval(d.interval),
    );
    if (!usable) errors.push('purchasable plan without usable price: ' + plan.plan_id);
  }

  // **表示金額の取りこぼしを検出する**。
  //   PRICE_DEFINITIONS にあるのに表示金額が無い = 契約概要が金額を出せない。
  //   表示金額にあるのに PRICE_DEFINITIONS に無い = 売っていない金額を見せる。
  for (const d of PRICE_DEFINITIONS) {
    const where = d.plan_id + '/' + d.currency + '/' + d.interval + '/' + d.phase;
    const shown = PRICE_DISPLAY_AMOUNTS.find(
      (a) => a.plan_id === d.plan_id && a.currency === d.currency
          && a.interval === d.interval && a.phase === d.phase,
    );
    if (!shown) {
      errors.push('missing display amount: ' + where);
    } else if (!Number.isInteger(shown.amount) || shown.amount <= 0) {
      errors.push('invalid display amount: ' + where);
    }
  }
  for (const a of PRICE_DISPLAY_AMOUNTS) {
    const where = a.plan_id + '/' + a.currency + '/' + a.interval + '/' + a.phase;
    const sold = PRICE_DEFINITIONS.some(
      (d) => d.plan_id === a.plan_id && d.currency === a.currency
          && d.interval === a.interval && d.phase === a.phase,
    );
    if (!sold) errors.push('display amount without price definition: ' + where);
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/**
 * 実 env に Price ID が揃っているかを検証する。
 *
 * **値そのものは返さない・書かない。** 報告するのはキー名だけ。
 * 起動時チェックではなく、checkout / webhook が必要になった時点で呼ぶ。
 *
 * @param {object} env
 * @returns {{ok:true}|{ok:false,errors:string[]}}
 */
export function validateEnvPriceIds(env) {
  const errors = [];
  const seenValue = new Map();

  for (const key of PRICE_ENV_KEYS) {
    const raw = env && typeof env === 'object' ? env[key] : undefined;
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      errors.push('missing env: ' + key);
      continue;
    }
    const value = raw.trim();
    const first = seenValue.get(value);
    if (first !== undefined) {
      errors.push('duplicate price id shared by env: ' + first + ' and ' + key);
    } else {
      seenValue.set(value, key);
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

// =========================================================
// 12. Subscription Terms
//
//    **「現行の Subscription Terms は何版か」の単一の正はここ。**
//
//    migration `20260907051255_terms_consents.sql` が
//    「現行版の正は server config が持つ」と明記しており、DB は現行版を知らない。
//    `terms_consents.terms_version` は **同意した版の記録**であって、
//    **現行版の定義ではない**。両者を取り違えないこと。
//
//    設計上の約束:
//      - **client から terms_version を受け取らない。** consent API は
//        ここから現行版を取り、それを RPC へ渡す。price 解決
//        （resolvePriceDefinition に phase / price_id 引数が無い）のと同じ構造で、
//        「古い版へ同意したことにする」経路を作らせない。
//      - **DB を現行版の正にしない。** DB の CHECK は形式の下限を守るだけ。
//      - **draft のうちは有効な版を絶対に返さない（fail closed）。**
//        法務本文が未確定の段階で consent を記録すると、
//        「未確定の規約に同意した」という取り消せない記録が残ってしまう。
//
//    版の運用ルール（published 後）:
//      - 版は**日付ベース**。YYYY-MM-DD、同日に複数回出すなら YYYY-MM-DD-1
//      - **実質的な変更**（権利義務・料金・解約条件に影響する変更）
//          -> 版を上げる -> 既存利用者は**再同意の対象**になる
//          （UNIQUE (user_id, terms_version, locale) により別行として記録される）
//      - **誤字・表記・レイアウトのみの修正**
//          -> 版は上げない -> 再同意を求めない
//      - 迷ったら上げる。上げ過ぎは再同意の手間で済むが、
//        上げ忘れは「同意していない条項で課金している」状態を作る
//
//    公開手順（法務確定後）:
//      1. SUBSCRIPTION_TERMS_CONFIG.status を 'published' にする
//      2. version に YYYY-MM-DD を入れる
//      3. Terms ページ（ja / en）の版表記を同じ値に合わせる
//      4. validateSubscriptionTermsConfig() が ok を返すことを確認する
//
//    **1〜4 を実施し、版 2026-09-09 で公開済み。**
//    次に版を上げるときも同じ 4 手順を踏むこと（config だけ直すと ja / en の
//    版表記とずれ、tests/frontend/terms-page.test.mjs が落ちる）。
// =========================================================

/** 取り得る公開状態。draft のうちは同意を受け付けない。 */
export const SUBSCRIPTION_TERMS_STATUSES = Object.freeze(['draft', 'published']);

/**
 * Subscription Terms を提供する言語。
 *
 * **terms_consents.locale の CHECK IN ('ja','en') と一致させること。**
 * 増やすときは DB の CHECK と record_terms_consent の検証も直す（3 箇所）。
 */
export const SUBSCRIPTION_TERMS_LOCALES = Object.freeze(['ja', 'en']);

/**
 * 版文字列の最大長。
 * terms_consents_terms_version_format の
 * length(terms_version) BETWEEN 1 AND 64 と同じ値。
 */
export const TERMS_VERSION_MAX_LENGTH = 64;

/**
 * 版文字列の形。YYYY-MM-DD または YYYY-MM-DD-<連番>。
 *
 * **暦としての妥当性（2026-02-30 等）は検査しない。**
 * DB 側も検査しておらず、ここだけ暦を知っていると
 * 「config は通すが DB は落ちる」「その逆」という二重管理の齟齬が生まれる。
 * 形だけを固定し、実在する日付かどうかは公開手順の人間の確認に委ねる。
 */
export const TERMS_VERSION_PATTERN = /^\d{4}-\d{2}-\d{2}(?:-\d+)?$/;

/**
 * **Subscription Terms の設定。ここが単一の正。**
 *
 * **現在は published（版 2026-09-09）。**
 * getCurrentSubscriptionTermsVersion() はこの版を返し、
 * consent API はこの版だけを RPC へ渡す（client からは受け取らない）。
 *
 * **版を上げるときは ja / en の HTML の版表記も同時に直すこと。**
 * 版を上げる基準は本節冒頭の「版の運用ルール」を参照。
 * draft へ戻せば（version を null にすれば）再び fail closed になり、
 * 同意を記録できなくなる。この性質は resolveTermsVersion 側で維持している。
 *
 * @type {Readonly<{status:string, version:string|null, locales:ReadonlyArray<string>}>}
 */
export const SUBSCRIPTION_TERMS_CONFIG = Object.freeze({
  status: 'published',
  version: '2026-09-09',
  locales: SUBSCRIPTION_TERMS_LOCALES,
});

/**
 * 版文字列として妥当か。
 *
 * 形（YYYY-MM-DD(-N)）に加えて、**DB の CHECK と同じ不変条件**も確認する。
 * 形の正規表現だけでも自動的に満たされるが、
 * 片方だけ緩めたときに気付けるよう明示的に確認する。
 *
 * 正規化（trim）は**しない**。前後に空白が付いた版は別物として弾く
 * （timezone / terms_version の検証と同じ方針）。
 *
 * @param {unknown} version
 * @returns {boolean}
 */
export function isValidTermsVersion(version) {
  if (typeof version !== 'string') return false;
  if (version !== version.trim()) return false;
  if (version.length < 1 || version.length > TERMS_VERSION_MAX_LENGTH) return false;
  return TERMS_VERSION_PATTERN.test(version);
}

/**
 * Terms を提供している言語か。
 *
 * **大文字小文字を寄せない。** 'JA' は拒否する。
 * DB の CHECK が小文字のみを許すため、ここで寄せると
 * 「config は通ったのに DB で落ちる」経路ができる。
 *
 * @param {unknown} locale
 * @returns {boolean}
 */
export function isSupportedTermsLocale(locale) {
  return typeof locale === 'string' && SUBSCRIPTION_TERMS_LOCALES.includes(locale);
}

/**
 * 設定から現行版を解く**純粋関数**。
 *
 * 本番設定を書き換えずに published 側の挙動をテストできるよう、
 * 設定をここだけ引数で受け取る。getCurrentSubscriptionTermsVersion() は
 * これを本番設定に対して呼ぶ薄いラッパ。
 *
 * code:
 *   'invalid_config'   設定がオブジェクトでない
 *   'unknown_status'   status が draft / published のどちらでもない
 *   'not_published'    まだ公開していない（draft）
 *   'invalid_version'  published なのに版が不正 / 欠落している
 *
 * @param {unknown} config
 * @returns {{ok:true, version:string}|{ok:false, code:string}}
 */
export function resolveTermsVersion(config) {
  if (!config || typeof config !== 'object') return { ok: false, code: 'invalid_config' };

  const { status, version } = config;
  if (!SUBSCRIPTION_TERMS_STATUSES.includes(status)) {
    return { ok: false, code: 'unknown_status' };
  }
  if (status !== 'published') return { ok: false, code: 'not_published' };
  if (!isValidTermsVersion(version)) return { ok: false, code: 'invalid_version' };

  return { ok: true, version };
}

/** 現行版を取れないときに投げる。code で理由を分類する。 */
export class SubscriptionTermsConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SubscriptionTermsConfigError';
    this.code = code;
  }
}

/**
 * **現行の Subscription Terms 版を返す。取れないときは throw する。**
 *
 * consent API（/api/terms/consent）はこの関数だけを使い、
 * 版を自前で組み立てたり client から受け取ったりしない。
 *
 * draft のうちは必ず not_published で throw する。
 * これが「未確定の規約への同意を記録しない」構造的な保証になっている。
 *
 * @returns {string}
 * @throws {SubscriptionTermsConfigError}
 */
export function getCurrentSubscriptionTermsVersion() {
  const result = resolveTermsVersion(SUBSCRIPTION_TERMS_CONFIG);
  if (result.ok) return result.version;
  throw new SubscriptionTermsConfigError(
    result.code,
    'Subscription Terms の現行版を取得できません: ' + result.code,
  );
}

/**
 * client へ渡してよい Terms 設定。
 *
 * secret は元々含まれないが、10 節と同じく
 * **「渡してよいものだけを組み立てる」形**を守る
 * （設定表をそのまま公開せず、明示的に写す）。
 * draft のあいだ version は null のままで、client も版を知らない。
 *
 * @returns {{status:string, version:string|null, locales:string[]}}
 */
export function getPublicSubscriptionTermsConfig() {
  return {
    status: SUBSCRIPTION_TERMS_CONFIG.status,
    version: SUBSCRIPTION_TERMS_CONFIG.version,
    locales: [...SUBSCRIPTION_TERMS_CONFIG.locales],
  };
}

/**
 * Terms 設定そのものの整合を検証する。
 *
 * validateBillingConfig() とは別関数にしてある。あちらは price まわりの
 * 検証で、シグネチャも戻り値も既に他所から使われているため触らない。
 *
 * 検出するもの:
 *   - status が未知
 *   - draft なのに version が入っている（公開手順の取り違え）
 *   - published なのに version が不正 / 欠落
 *   - locales が空 / 未知の locale を含む / 重複がある
 *
 * @param {object} [config] 省略時は本番設定
 * @returns {{ok:true}|{ok:false,errors:string[]}}
 */
export function validateSubscriptionTermsConfig(config = SUBSCRIPTION_TERMS_CONFIG) {
  const errors = [];

  if (!config || typeof config !== 'object') {
    return { ok: false, errors: ['terms config is not an object'] };
  }

  const { status, version, locales } = config;

  if (!SUBSCRIPTION_TERMS_STATUSES.includes(status)) {
    errors.push('unknown terms status: ' + String(status));
  } else if (status === 'draft') {
    if (version !== null) {
      errors.push('draft terms config must keep version null');
    }
  } else if (!isValidTermsVersion(version)) {
    errors.push('published terms config has an invalid version');
  }

  if (!Array.isArray(locales) || locales.length === 0) {
    errors.push('terms locales must be a non-empty array');
  } else {
    const seen = new Set();
    for (const locale of locales) {
      if (!isSupportedTermsLocale(locale)) {
        errors.push('unsupported terms locale: ' + String(locale));
      } else if (seen.has(locale)) {
        errors.push('duplicate terms locale: ' + locale);
      } else {
        seen.add(locale);
      }
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}


// =========================================================
// 13. Sales availability（現在購入できるかどうか）
//
//    **「認識できる国・通貨」と「今このタイミングで購入できる国・通貨」を分ける。**
//
//    2 節の SUPPORTED_COUNTRIES / 3 節の CURRENCIES は
//    **将来対応も含めて認識できる集合**であり、Stripe が返した国・通貨を
//    解釈したり、既存の Price 定義を逆引きしたりするために使う。
//    これらを削ると、既に発行済みの USD Price を webhook が解釈できなくなる。
//
//    一方こちらは **今このタイミングで新規購入を受け付けてよいか**だけを持つ。
//    販売地域を広げるときは、ここの配列に足すだけでよい
//    （Price 定義・通貨定義・migration を作り直す必要が無い）。
//
//    事業判断:
//      - **初期の有料販売は日本のみ**
//      - US / GB / CA / AU は**定義を残したまま販売停止**
//      - USD の Price 定義と Stripe の Price mapping も**残す**（将来再開用）
//
//    **checkoutはこの節の resolvePurchasablePrice() だけを使うこと。**
//    resolvePriceDefinition() を直接呼ぶと販売停止国・停止通貨を素通りする。
// =========================================================

/**
 * **現在、新規購入を受け付ける国。**
 *
 * SUPPORTED_COUNTRIES の部分集合であること（validateSalesAvailability が確認する）。
 * 販売地域を広げるときはここへ追加する。
 */
export const PURCHASABLE_COUNTRIES = Object.freeze(['JP']);

/**
 * **現在、新規購入を受け付ける通貨。**
 *
 * SUPPORTED_CURRENCIES の部分集合であること。
 * USD は定義を残したまま、いまは購入対象から外している。
 */
export const PURCHASABLE_CURRENCIES = Object.freeze(['jpy']);

/**
 * 現在購入できる国か。
 *
 * isSupportedCountry() は「認識できる国か」を見る**別の関数**で、
 * こちらは「いま売ってよい国か」を見る。両方を取り違えないこと。
 *
 * @param {unknown} country
 * @returns {boolean}
 */
export function isPurchasableCountry(country) {
  if (typeof country !== 'string') return false;
  return PURCHASABLE_COUNTRIES.includes(country.trim().toUpperCase());
}

/**
 * 現在購入できる通貨か。
 *
 * isSupportedCurrency() は「認識できる通貨か」を見る**別の関数**。
 *
 * @param {unknown} currency
 * @returns {boolean}
 */
export function isPurchasableCurrency(currency) {
  if (typeof currency !== 'string') return false;
  return PURCHASABLE_CURRENCIES.includes(currency.trim().toLowerCase());
}

/**
 * **checkout が使う唯一の入口。** 販売可否を確認したうえで Price を解決する。
 *
 * resolvePriceDefinition() に販売可否の判定を足しただけで、
 * あちらのシグネチャも戻り値も変えていない
 * （webhook の逆引きは従来どおり全 Price を解釈できる必要があるため）。
 *
 * code:
 *   'country_not_purchasable'   いま販売していない国
 *   'currency_not_purchasable'  いま販売していない通貨
 *   その他                       resolvePriceDefinition() の code をそのまま返す
 *
 * @param {string} planId
 * @param {string} country   ISO 3166-1 alpha-2
 * @param {string} currency
 * @param {string} interval
 * @param {Date|number|string} [now]
 * @returns {{ok:true,phase:string,definition:object}|{ok:false,code:string}}
 */
export function resolvePurchasablePrice(planId, country, currency, interval, now) {
  if (!isPurchasableCountry(country)) return { ok: false, code: 'country_not_purchasable' };
  if (!isPurchasableCurrency(currency)) return { ok: false, code: 'currency_not_purchasable' };
  return resolvePriceDefinition(planId, currency, interval, now);
}

/**
 * 販売可否の設定そのものを検証する。
 *
 * 検出するもの:
 *   - 購入可能国が空 / 認識できない国を含む / 重複
 *   - 購入可能通貨が空 / 認識できない通貨を含む / 重複
 *   - 購入可能な組み合わせで販売できる Price が 1 本も無い
 *
 * @returns {{ok:true}|{ok:false,errors:string[]}}
 */
export function validateSalesAvailability() {
  const errors = [];

  const checkList = (label, list, isRecognized) => {
    if (!Array.isArray(list) || list.length === 0) {
      errors.push(label + ' must be a non-empty array');
      return;
    }
    const seen = new Set();
    for (const value of list) {
      if (!isRecognized(value)) errors.push('unrecognized ' + label + ': ' + String(value));
      else if (seen.has(value)) errors.push('duplicate ' + label + ': ' + value);
      else seen.add(value);
    }
  };

  checkList('purchasable country', PURCHASABLE_COUNTRIES, isSupportedCountry);
  checkList('purchasable currency', PURCHASABLE_CURRENCIES, isSupportedCurrency);

  const sellable = PRICE_DEFINITIONS.some(
    (d) => isPurchasablePlan(d.plan_id)
        && isPurchasableCurrency(d.currency)
        && isSupportedInterval(d.interval),
  );
  if (!sellable) errors.push('no price is sellable with the current purchasable currencies');

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

// =========================================================
// 料金プラン / 購入導線のテスト
//
//   対象: public/pricing.html -> /pricing
//
//   このテストが守るもの:
//     - 4 プランが並び、購入できるのは Web Pro だけであること
//       （Extension Pro / All Pro は Coming Soon で購入ボタンを持たない）
//     - 価格表示（¥300 税込 / 2027 年の更新から ¥500）が消えないこと
//     - **18 歳確認と規約同意の両方が無ければ購入を始められないこと**
//     - **consent が 200 になるまで checkout を呼ばないこと**
//     - **client が price / country / currency / user_id / terms_version を送らないこと**
//     - 二重送信できないこと
//     - already_subscribed 等が日本語になり、生のエラーが出ないこと
//     - 規約 / 特商法へのリンクがあること
//     - 日本国内向けである旨の表示があること
//
//   inline script は vm で実行し、addEventListener を記録する要素スタブへ
//   イベントを流し込む。**テスト用の window フックは使わない**
//   （本物の配線をそのまま検証するため）。
// =========================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import { getPublicPlanConfig } from '../../functions/api/_lib/billing-config.js';

const HTML_URL = new URL('../../public/pricing.html', import.meta.url);
const html = fs.readFileSync(HTML_URL, 'utf8');

const INDEX_URL = new URL('../../public/index.html', import.meta.url);
const indexHtml = fs.readFileSync(INDEX_URL, 'utf8');

const stripComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '');
const bodyOf = (s) => stripComments(s).split('<body>')[1] || '';
const visibleText = (s) => bodyOf(s).replace(/<script[\s\S]*?<\/script>/g, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const text = visibleText(html);

/** inline script を取り出す。 */
function extractScript(source) {
  const m = source.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('inline <script> が見つかりません。');
  return m[1];
}

/**
 * 実 HTML の初期属性をスタブへ反映する。
 * `hidden` / `disabled` は初期状態が挙動に効くので、決め打ちにしない。
 */
function initialAttrs(id) {
  const m = html.match(new RegExp('<[^>]*id="' + id + '"[^>]*>'));
  const tag = m ? m[0] : '';
  return {
    hidden: /\shidden(\s|>|=)/.test(tag),
    disabled: /\sdisabled(\s|>|=)/.test(tag),
  };
}

/** 最小の要素スタブ。addEventListener を記録して fire で呼べるようにする。 */
function makeEl(id) {
  const listeners = new Map();
  const attrs = initialAttrs(id);
  return {
    id,
    checked: false,
    disabled: attrs.disabled,
    hidden: attrs.hidden,
    textContent: '',
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener() {},
    _fire(type) {
      const fns = listeners.get(type) || [];
      return Promise.all(fns.map((fn) => fn({ type, preventDefault() {} })));
    },
    _has(type) { return (listeners.get(type) || []).length > 0; },
  };
}

/** JSON 応答スタブ。 */
function res(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      if (body === undefined) throw new SyntaxError('no body');
      return body;
    },
  };
}

/**
 * pricing.html の inline script を読み込む。
 * routes は [判定関数, 応答] の配列。
 */
function load(routes = []) {
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) els.set(id, makeEl(id));
    return els.get(id);
  };

  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    let body = null;
    try { body = init.body ? JSON.parse(init.body) : null; } catch { body = init.body; }
    calls.push({ url: u, method: (init.method || 'GET').toUpperCase(), body, init });
    for (const [match, respond] of routes) {
      if (match(u)) return respond(u, init);
    }
    return res(404, { error: 'not_stubbed' });
  };

  const location = { href: 'https://sukimacalendar.com/pricing' };

  const sandbox = {
    document: { getElementById: el, addEventListener() {} },
    fetch: fetchImpl,
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, Promise, JSON, Object, String,
  };
  sandbox.window = sandbox;
  sandbox.location = location;
  sandbox.window.location = location;
  sandbox.globalThis = sandbox;

  const ctx = vm.createContext(sandbox);
  vm.runInContext(extractScript(html), ctx, { filename: 'public/pricing.html (inline)' });

  return { el, calls, location, ctx };
}

/** 両方チェックして購入を押す。 */
async function purchase(page) {
  page.el('ageConfirm').checked = true;
  page.el('termsAgree').checked = true;
  await page.el('ageConfirm')._fire('change');
  await page.el('buyWebPro')._fire('click');
  // fetch チェーンが解決しきるのを待つ
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

/** 購入フローの呼び出しだけを取り出す（init の /api/auth/me を除く）。 */
function flowCalls(page) {
  return page.calls.filter((c) => c.url.includes('/api/terms/consent')
    || c.url.includes('/api/billing/checkout'));
}

const okConsent = [(u) => u.includes('/api/terms/consent'),
  () => res(200, { accepted: true, terms_version: '2026-09-09', locale: 'ja' })];
const okCheckout = [(u) => u.includes('/api/billing/checkout'),
  () => res(200, { url: 'https://checkout.stripe.com/c/pay/cs_test_123', expires_at: 1 })];


// ---------------------------------------------------------
// 1. Pricing の表示
// ---------------------------------------------------------

test('4 つのプランカードが並んでいる', () => {
  for (const plan of ['free', 'web_pro', 'extension_pro', 'all_pro']) {
    assert.ok(html.includes('data-plan="' + plan + '"'), plan + ' のカードが無い');
  }
});

test('billing-config の公開プラン構成と 1 対 1 で対応している', () => {
  const config = getPublicPlanConfig();
  assert.equal(config.length, 4);
  for (const plan of config) {
    assert.ok(html.includes('data-plan="' + plan.plan_id + '"'),
      plan.plan_id + ' が Pricing に無い');
  }
});

test('購入できるのは Web Pro だけ（購入ボタンは 1 つ）', () => {
  const buttons = bodyOf(html).match(/<button[^>]*id="buyWebPro"/g) || [];
  assert.equal(buttons.length, 1);
  // button は「購入」と「契約管理」の 2 つだけ。
  // プランごとの購入ボタンを増やしていないことを固定する。
  const ids = (bodyOf(html).match(/<button[^>]*id="([^"]+)"/g) || [])
    .map((tag) => tag.match(/id="([^"]+)"/)[1]).sort();
  assert.deepEqual(ids, ['buyWebPro', 'managePlanBtn']);
  const allButtons = bodyOf(html).match(/<button/g) || [];
  assert.equal(allButtons.length, ids.length, 'id の無い button が増えている');
});

/** data-plan="x" のカード 1 枚ぶんの markup を切り出す。 */
function cardMarkup(planId) {
  const body = bodyOf(html);
  const start = body.indexOf('data-plan="' + planId + '"');
  assert.notEqual(start, -1, planId + ' のカードが無い');
  // 次のカードの直前まで（最後のカードは </section> まで）
  const rest = body.slice(start + 1);
  const nextCard = rest.indexOf('data-plan="');
  const endSection = rest.indexOf('</section>');
  let end = nextCard === -1 ? endSection : Math.min(nextCard, endSection === -1 ? nextCard : endSection);
  if (end === -1) end = rest.length;
  return rest.slice(0, end);
}

test('Extension Pro / All Pro は Coming Soon で購入導線を持たない', () => {
  const soon = bodyOf(html).match(/Coming Soon/g) || [];
  assert.ok(soon.length >= 2, 'Coming Soon 表示が 2 つ未満');
  for (const planId of ['extension_pro', 'all_pro']) {
    const card = cardMarkup(planId);
    assert.match(card, /Coming Soon/, planId + ' に Coming Soon が無い');
    assert.ok(!card.includes('<button'), planId + ' のカードに button がある');
    assert.ok(!card.includes('/api/billing/checkout'), planId + ' に購入導線がある');
  }
});

test('Free カードにも購入ボタンが無い', () => {
  assert.ok(!cardMarkup('free').includes('<button'));
});

test('Free プランの内容が書いてある（週3回 / 共通枠）', () => {
  assert.match(text, /週3回/);
  assert.match(text, /共通枠/);
});

test('Web Pro は ¥300 税込 / 月額で表示している', () => {
  assert.match(text, /¥300/);
  assert.match(text, /税込/);
  assert.match(text, /月/);
});

test('2027 年の更新から ¥500 になることが書いてある', () => {
  assert.match(text, /¥500/);
  assert.match(text, /2027/);
  assert.match(text, /更新/);
});

test('launch 価格の対象が 2026 年 12 月 31 日までだと書いてある', () => {
  assert.match(text, /2026年12月31日/);
});

test('USD / ドル価格は表示しない', () => {
  assert.ok(!/USD/i.test(text), 'USD が表示されている');
  assert.ok(!/\$\d/.test(text), 'ドル価格が表示されている');
});

test('日本国内向けである旨を明示している', () => {
  assert.match(text, /日本国内向け/);
});

// ---------------------------------------------------------
// 2. 規約 / 特商法 / 購入直前の説明
// ---------------------------------------------------------

test('有料プラン利用規約へのリンクがある', () => {
  assert.ok(html.includes('href="/terms/subscription"'));
});

test('特定商取引法に基づく表記へのリンクがある', () => {
  assert.ok(html.includes('href="/legal/commercial-transactions"'));
  assert.match(text, /特定商取引法に基づく表記/);
});

test('購入直前に自動更新・解約条件が書いてある', () => {
  assert.match(text, /自動更新/);
  assert.match(text, /次回更新日/);
  assert.match(text, /末日まで/);
});

test('18 歳確認と規約同意の checkbox がある', () => {
  assert.ok(html.includes('id="ageConfirm"'));
  assert.ok(html.includes('id="termsAgree"'));
  assert.match(text, /18歳以上/);
  assert.match(text, /同意します/);
});

// ---------------------------------------------------------
// 3. index.html からの導線
// ---------------------------------------------------------

test('index.html から /pricing への導線がある', () => {
  assert.ok(indexHtml.includes('href="/pricing"'), 'index.html に /pricing リンクが無い');
});

test('index.html は購入処理そのものを持たない（導線だけ）', () => {
  assert.ok(!indexHtml.includes('/api/billing/checkout'),
    'index.html が checkout API を直接呼んでいる');
});


// ---------------------------------------------------------
// 4. 購入フローの挙動
// ---------------------------------------------------------

test('初期状態では購入ボタンが disabled', () => {
  const page = load();
  assert.equal(page.el('buyWebPro').disabled, true);
});

test('18 歳確認だけでは押せない', async () => {
  const page = load();
  page.el('ageConfirm').checked = true;
  await page.el('ageConfirm')._fire('change');
  assert.equal(page.el('buyWebPro').disabled, true);
});

test('規約同意だけでは押せない', async () => {
  const page = load();
  page.el('termsAgree').checked = true;
  await page.el('termsAgree')._fire('change');
  assert.equal(page.el('buyWebPro').disabled, true);
});

test('両方チェックすると押せるようになる', async () => {
  const page = load();
  page.el('ageConfirm').checked = true;
  page.el('termsAgree').checked = true;
  await page.el('ageConfirm')._fire('change');
  assert.equal(page.el('buyWebPro').disabled, false);
});

test('チェックを外すと再び disabled に戻る', async () => {
  const page = load();
  page.el('ageConfirm').checked = true;
  page.el('termsAgree').checked = true;
  await page.el('ageConfirm')._fire('change');
  page.el('termsAgree').checked = false;
  await page.el('termsAgree')._fire('change');
  assert.equal(page.el('buyWebPro').disabled, true);
});

test('未チェックのまま click しても API を呼ばない', async () => {
  const page = load([okConsent, okCheckout]);
  await page.el('buyWebPro')._fire('click');
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  assert.equal(flowCalls(page).length, 0);
});

test('consent -> checkout の順に呼ぶ', async () => {
  const page = load([okConsent, okCheckout]);
  await purchase(page);
  const flow = flowCalls(page);
  assert.equal(flow.length, 2);
  assert.ok(flow[0].url.includes('/api/terms/consent'));
  assert.ok(flow[1].url.includes('/api/billing/checkout'));
  assert.equal(flow[0].method, 'POST');
  assert.equal(flow[1].method, 'POST');
});

test('成功すると Stripe Checkout の URL へ遷移する', async () => {
  const page = load([okConsent, okCheckout]);
  await purchase(page);
  assert.equal(page.location.href, 'https://checkout.stripe.com/c/pay/cs_test_123');
});

test('**consent が失敗したら checkout を呼ばない**', async () => {
  const page = load([
    [(u) => u.includes('/api/terms/consent'), () => res(503, { error: 'terms_not_available' })],
    okCheckout,
  ]);
  await purchase(page);
  const flow = flowCalls(page);
  assert.equal(flow.length, 1);
  assert.ok(flow[0].url.includes('/api/terms/consent'));
  assert.equal(page.location.href, 'https://sukimacalendar.com/pricing');
});

test('consent が 401 でも checkout を呼ばない', async () => {
  const page = load([
    [(u) => u.includes('/api/terms/consent'), () => res(401, { error: 'unauthenticated' })],
    okCheckout,
  ]);
  await purchase(page);
  assert.equal(page.calls.filter((c) => c.url.includes('checkout')).length, 0);
});

// ---------------------------------------------------------
// 5. client が送ってはいけないもの
// ---------------------------------------------------------

test('consent が送るのは locale だけ', async () => {
  const page = load([okConsent, okCheckout]);
  await purchase(page);
  assert.deepEqual(flowCalls(page)[0].body, { locale: 'ja' });
});

test('checkout が送るのは locale と age_confirmed だけ', async () => {
  const page = load([okConsent, okCheckout]);
  await purchase(page);
  const checkout = flowCalls(page)[1];
  assert.deepEqual(Object.keys(checkout.body).sort(), ['age_confirmed', 'locale']);
  assert.equal(checkout.body.age_confirmed, true);
  assert.equal(checkout.body.locale, 'ja');
});

test('**price / country / currency / user_id / terms_version を送らない**', async () => {
  const page = load([okConsent, okCheckout]);
  await purchase(page);
  const forbidden = ['price', 'price_id', 'country', 'currency', 'user_id',
    'terms_version', 'plan', 'plan_id', 'amount', 'phase'];
  for (const call of flowCalls(page)) {
    const sent = JSON.stringify(call.body || {});
    for (const key of forbidden) {
      assert.ok(!Object.prototype.hasOwnProperty.call(call.body || {}, key),
        key + ' を送っている: ' + sent);
    }
  }
});

test('inline script に Stripe の price ID / 金額の決め打ちが無い', () => {
  const script = extractScript(html);
  assert.ok(!/price_[A-Za-z0-9]{6,}/.test(script), 'price ID が埋め込まれている');
  assert.ok(!/sk_(test|live)_/.test(script));
  assert.ok(!/pk_(test|live)_/.test(script));
});

test('Cookie 認証のため credentials を明示している', () => {
  assert.match(extractScript(html), /credentials:\s*'same-origin'/);
});


// ---------------------------------------------------------
// 6. 二重送信 / ボタン状態
// ---------------------------------------------------------

test('送信中はボタンが disabled になり「処理中…」になる', async () => {
  let release;
  const pending = new Promise((r) => { release = r; });
  const page = load([
    [(u) => u.includes('/api/terms/consent'), () => pending],
    okCheckout,
  ]);
  page.el('ageConfirm').checked = true;
  page.el('termsAgree').checked = true;
  await page.el('ageConfirm')._fire('change');
  page.el('buyWebPro')._fire('click');
  for (let i = 0; i < 5; i += 1) await Promise.resolve();

  assert.equal(page.el('buyWebPro').disabled, true);
  assert.equal(page.el('buyWebPro').textContent, '処理中…');

  release(res(200, { accepted: true }));
});

test('**二重クリックしても API を 2 回ぶん送らない**', async () => {
  let release;
  const pending = new Promise((r) => { release = r; });
  const page = load([
    [(u) => u.includes('/api/terms/consent'), () => pending],
    okCheckout,
  ]);
  page.el('ageConfirm').checked = true;
  page.el('termsAgree').checked = true;
  await page.el('ageConfirm')._fire('change');

  page.el('buyWebPro')._fire('click');
  page.el('buyWebPro')._fire('click');
  page.el('buyWebPro')._fire('click');
  for (let i = 0; i < 5; i += 1) await Promise.resolve();

  assert.equal(page.calls.filter((c) => c.url.includes('/api/terms/consent')).length, 1);
  release(res(200, { accepted: true }));
});

test('失敗したらボタンが再び押せる状態に戻る', async () => {
  const page = load([
    [(u) => u.includes('/api/terms/consent'), () => res(500, { error: 'internal_error' })],
  ]);
  await purchase(page);
  assert.equal(page.el('buyWebPro').textContent, 'Web Proを始める');
  assert.equal(page.el('buyWebPro').disabled, false);
});

// ---------------------------------------------------------
// 7. エラー表示
// ---------------------------------------------------------

async function errorTextFor(status, code, which) {
  const consentRes = which === 'consent' ? () => res(status, { error: code }) : okConsent[1];
  const page = load([
    [(u) => u.includes('/api/terms/consent'), consentRes],
    [(u) => u.includes('/api/billing/checkout'), () => res(status, { error: code })],
  ]);
  await purchase(page);
  return page.el('purchaseError').textContent;
}

test('already_subscribed は「すでに有料プランをご利用中です」', async () => {
  const msg = await errorTextFor(409, 'already_subscribed', 'checkout');
  assert.match(msg, /すでに有料プランをご利用中です/);
});

test('未ログインは日本語で案内する', async () => {
  const msg = await errorTextFor(401, 'unauthenticated', 'consent');
  assert.match(msg, /ログイン/);
});

test('age_confirmation_required は 18 歳確認の案内になる', async () => {
  const msg = await errorTextFor(400, 'age_confirmation_required', 'checkout');
  assert.match(msg, /18歳以上/);
});

test('sales_unavailable は販売していない旨になる', async () => {
  const msg = await errorTextFor(503, 'sales_unavailable', 'checkout');
  assert.match(msg, /販売していません/);
});

test('terms_consent_required は同意の再試行を促す', async () => {
  const msg = await errorTextFor(409, 'terms_consent_required', 'checkout');
  assert.match(msg, /利用規約/);
});

test('payment_provider_unavailable は決済サービスの案内になる', async () => {
  const msg = await errorTextFor(502, 'payment_provider_unavailable', 'checkout');
  assert.match(msg, /決済サービス/);
});

test('server error は一般的な日本語になる', async () => {
  const msg = await errorTextFor(500, 'internal_error', 'checkout');
  assert.match(msg, /エラーが発生しました/);
});

test('consent 側の失敗は同意保存の失敗として案内する', async () => {
  const page = load([
    [(u) => u.includes('/api/terms/consent'), () => res(500, { error: 'not_mapped_code' })],
  ]);
  await purchase(page);
  assert.match(page.el('purchaseError').textContent, /利用規約への同意を保存できませんでした/);
});

test('**未知の error コードでも生の文字列を表示しない**', async () => {
  const page = load([
    okConsent,
    [(u) => u.includes('/api/billing/checkout'),
      () => res(500, { error: 'StripeInvalidRequestError: No such price: price_1ABC' })],
  ]);
  await purchase(page);
  const msg = page.el('purchaseError').textContent;
  assert.ok(!msg.includes('price_1ABC'), 'Stripe の内部 ID が表示された');
  assert.ok(!msg.includes('Stripe'), 'Stripe の生エラーが表示された');
  assert.match(msg, /エラーが発生しました/);
});

test('JSON が壊れていても生の本文を出さない', async () => {
  const page = load([
    okConsent,
    [(u) => u.includes('/api/billing/checkout'), () => res(500, undefined)],
  ]);
  await purchase(page);
  assert.match(page.el('purchaseError').textContent, /エラーが発生しました/);
});

test('checkout が 200 でも url が無ければ遷移しない', async () => {
  const page = load([
    okConsent,
    [(u) => u.includes('/api/billing/checkout'), () => res(200, { expires_at: 1 })],
  ]);
  await purchase(page);
  assert.equal(page.location.href, 'https://sukimacalendar.com/pricing');
  assert.match(page.el('purchaseError').textContent, /エラーが発生しました/);
});

test('エラー表示は成功時には出ない', async () => {
  const page = load([okConsent, okCheckout]);
  await purchase(page);
  assert.equal(page.el('purchaseError').hidden, true);
});


// ---------------------------------------------------------
// 8. 契約中ユーザーの表示
// ---------------------------------------------------------

const meRes = (status, body) => [(u) => u.includes('/api/auth/me'), () => res(status, body)];

function meBody(entitlement) {
  return {
    authenticated: true,
    plan_id: entitlement && entitlement.web ? 'web_pro' : 'free',
    status: 'active',
    entitlement,
  };
}

/** init の /api/auth/me が解決するのを待つ。 */
async function settle() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

test('契約中なら「ご利用中」を表示し購入フォームを隠す', async () => {
  const page = load([meRes(200, meBody({ web: true, extension: false })), okConsent, okCheckout]);
  await settle();
  assert.equal(page.el('activeNotice').hidden, false);
  assert.equal(page.el('purchaseControls').hidden, true);
  assert.equal(page.el('buyWebPro').disabled, true);
});

test('Free 契約者には購入フォームを出したままにする', async () => {
  const page = load([meRes(200, meBody({ web: false, extension: false })), okConsent, okCheckout]);
  await settle();
  assert.equal(page.el('activeNotice').hidden, true);
  assert.notEqual(page.el('purchaseControls').hidden, true);
});

test('**extension だけ true でも契約中扱いしない**', async () => {
  const page = load([meRes(200, meBody({ web: false, extension: true })), okConsent, okCheckout]);
  await settle();
  assert.equal(page.el('activeNotice').hidden, true);
});

test('未ログイン（401）では契約中と誤表示しない', async () => {
  const page = load([meRes(401, { authenticated: false }), okConsent, okCheckout]);
  await settle();
  assert.equal(page.el('activeNotice').hidden, true);
  assert.notEqual(page.el('purchaseControls').hidden, true);
});

test('**auth/me が 500 でも購入フローを壊さない**（fail open）', async () => {
  const page = load([meRes(500, { error: 'internal_error' }), okConsent, okCheckout]);
  await settle();
  assert.equal(page.el('activeNotice').hidden, true);
  await purchase(page);
  assert.equal(flowCalls(page).length, 2);
  assert.equal(page.location.href, 'https://checkout.stripe.com/c/pay/cs_test_123');
});

test('entitlement の形が不正なら契約中扱いしない', async () => {
  const page = load([meRes(200, meBody({ web: 'true', extension: false })), okConsent, okCheckout]);
  await settle();
  assert.equal(page.el('activeNotice').hidden, true);
});

test('auth/me は GET で 1 回だけ、Cookie 付きで呼ぶ', async () => {
  const page = load([meRes(200, meBody({ web: false, extension: false })), okConsent, okCheckout]);
  await settle();
  const meCalls = page.calls.filter((c) => c.url.includes('/api/auth/me'));
  assert.equal(meCalls.length, 1);
  assert.equal(meCalls[0].method, 'GET');
  assert.equal(meCalls[0].init.credentials, 'same-origin');
});

test('pricing 側でも Stripe の内部 ID を扱わない', () => {
  const script = extractScript(html);
  assert.ok(!/cus_|sub_1|stripe_customer_id|stripe_subscription_id/.test(script));
});


// ---------------------------------------------------------
// 9. FAQ / comparison / currency
// ---------------------------------------------------------

const termsJa = fs.readFileSync(new URL('../../public/terms/subscription.html', import.meta.url), 'utf8');
const faqSection = (() => {
  const b = bodyOf(html);
  const start = b.indexOf('class="faq"');
  assert.notEqual(start, -1, 'FAQ セクションが無い');
  return b.slice(start, b.indexOf('</section>', start));
})();
const faqText = faqSection.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

test('FAQ セクションがある', () => {
  assert.match(text, /よくあるご質問/);
  const dts = faqSection.match(/<dt>/g) || [];
  assert.ok(dts.length >= 5, 'FAQ が 5 問未満: ' + dts.length);
  const dds = faqSection.match(/<dd>/g) || [];
  assert.equal(dts.length, dds.length, '質問と回答の数が合わない');
});

test('FAQ の価格が billing-config の launch 期限と矛盾しない', () => {
  // LAUNCH_END_AT = 2026-12-31T15:00:00Z = 2027-01-01 00:00 JST
  assert.match(faqText, /2026年12月31日/);
  assert.match(faqText, /¥300/);
  assert.match(faqText, /¥500/);
  assert.match(faqText, /2027年/);
});

test('FAQ の価格表記が Terms と同じ税込表記になっている', () => {
  assert.match(faqText, /税込/);
  assert.ok(termsJa.includes('300') && termsJa.includes('500'),
    'Terms 側に価格が書かれていない');
});

test('FAQ に無料プランの週3回・共通枠が書いてある', () => {
  assert.match(faqText, /週3回/);
  assert.match(faqText, /共通/);
});

test('FAQ に解約条件（次回更新日前まで / 期間末まで利用可）が書いてある', () => {
  assert.match(faqText, /次回更新日/);
  assert.match(faqText, /末日まで/);
});

test('**FAQ で無料トライアルが無いと明記している**', () => {
  assert.match(faqText, /無料トライアル/);
  assert.match(faqText, /ありません/);
});

test('FAQ で Extension Pro / All Pro が Coming Soon だと書いてある', () => {
  assert.match(faqText, /Extension Pro/);
  assert.match(faqText, /All Pro/);
  assert.match(faqText, /Coming Soon/);
});

test('FAQ で日本国内向けのみと書いてある', () => {
  assert.match(faqText, /日本国内向け/);
});

test('**FAQ が Terms より優先されると読めない**（優先順位を明記）', () => {
  assert.match(faqText, /優先/);
  assert.ok(faqSection.includes('/terms/subscription'));
  assert.ok(faqSection.includes('/legal/commercial-transactions'));
});

test('**FAQ に新しい契約条件を作っていない**（返金・日割り・トライアル期間など）', () => {
  // Terms に無い独自の約束を FAQ で作らない
  assert.ok(!/日割り/.test(faqText), 'FAQ が日割りを約束している');
  assert.ok(!/いつでも全額返金|返金します/.test(faqText), 'FAQ が独自の返金を約束している');
  assert.ok(!/\d+日間無料|無料期間/.test(faqText), 'FAQ が無料期間を作っている');
});

test('comparison: Free と Web Pro の差がカード内で比較できる', () => {
  const free = cardMarkup('free');
  const pro = cardMarkup('web_pro');
  assert.match(free, /週3回/);
  assert.match(free, /共通枠/);
  assert.match(pro, /無制限/);
  assert.match(pro, /背景/);
  assert.match(pro, /ホワイトレンジ/);
});

test('**currency selector を作っていない**（JP / JPY のみ販売）', () => {
  // inline script は除く（「currency を送らない」というコメント自体を拾わないため）。
  const markup = bodyOf(html).replace(/<script>[\s\S]*?<\/script>/g, '');
  assert.ok(!/<select/i.test(markup), 'select 要素がある');
  assert.ok(!/name="currency"|id="currency"|data-currency/i.test(markup), 'currency の入力欄がある');
  assert.ok(!/通貨/.test(text), '通貨切替の表示がある');
  assert.ok(!/radio/i.test(markup), '通貨/プラン選択の radio がある');
});

test('checkout は server が決めた単一市場だけを使う（currency 切替が成立しない根拠）', async () => {
  const { PURCHASABLE_COUNTRIES, PURCHASABLE_CURRENCIES } =
    await import('../../functions/api/_lib/billing-config.js');
  // resolveCheckoutMarket() は 1 国 1 通貨でなければ ambiguous_market で失敗する。
  assert.deepEqual([...PURCHASABLE_COUNTRIES], ['JP']);
  assert.deepEqual([...PURCHASABLE_CURRENCIES], ['jpy']);
});

test('FAQ にも USD / ドル価格を出さない', () => {
  assert.ok(!/USD/i.test(faqText));
  assert.ok(!/\$\d/.test(faqText));
});


// ---------------------------------------------------------
// 12. 契約管理（Billing Portal）導線
// ---------------------------------------------------------

const okPortal = [(u) => u.includes('/api/billing/portal'),
  () => res(200, { url: 'https://billing.stripe.com/p/session/test_dummy' })];

test('契約中なら「契約を管理」CTA が出る', async () => {
  const page = load([meRes(200, meBody({ web: true, extension: false })), okPortal]);
  await settle();
  assert.equal(page.el('manageRow').hidden, false);
});

test('**Free には契約管理 CTA を出さない**', async () => {
  const page = load([meRes(200, meBody({ web: false, extension: false })), okPortal]);
  await settle();
  assert.equal(page.el('manageRow').hidden, true);
});

test('未ログインでは契約管理 CTA を出さない', async () => {
  const page = load([meRes(401, { authenticated: false }), okPortal]);
  await settle();
  assert.equal(page.el('manageRow').hidden, true);
});

test('契約管理を押すと Portal API を呼び、返った URL へ遷移する', async () => {
  const page = load([meRes(200, meBody({ web: true, extension: false })), okPortal]);
  await settle();
  await page.el('managePlanBtn')._fire('click');
  await settle();

  const calls = page.calls.filter((c) => c.url.includes('/api/billing/portal'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].init.credentials, 'same-origin');
  assert.equal(page.location.href, 'https://billing.stripe.com/p/session/test_dummy');
});

test('**Portal API へ customer_id / return_url を送らない**', async () => {
  const page = load([meRes(200, meBody({ web: true, extension: false })), okPortal]);
  await settle();
  await page.el('managePlanBtn')._fire('click');
  await settle();
  const call = page.calls.filter((c) => c.url.includes('/api/billing/portal'))[0];
  assert.deepEqual(call.body, {}, 'body が空でない: ' + JSON.stringify(call.body));
});

test('**二重クリックしても Portal API を 1 回しか呼ばない**', async () => {
  let release;
  const pending = new Promise((r) => { release = r; });
  const page = load([
    meRes(200, meBody({ web: true, extension: false })),
    [(u) => u.includes('/api/billing/portal'), () => pending],
  ]);
  await settle();
  page.el('managePlanBtn')._fire('click');
  page.el('managePlanBtn')._fire('click');
  page.el('managePlanBtn')._fire('click');
  for (let i = 0; i < 6; i += 1) await Promise.resolve();

  assert.equal(page.calls.filter((c) => c.url.includes('/api/billing/portal')).length, 1);
  assert.equal(page.el('managePlanBtn').disabled, true);
  release(res(200, { url: 'https://billing.stripe.com/p/session/x' }));
});

test('Portal API が 409 なら日本語で案内する', async () => {
  const page = load([
    meRes(200, meBody({ web: true, extension: false })),
    [(u) => u.includes('/api/billing/portal'), () => res(409, { error: 'no_billing_account' })],
  ]);
  await settle();
  await page.el('managePlanBtn')._fire('click');
  await settle();
  assert.match(page.el('portalError').textContent, /お支払い情報/);
  assert.equal(page.el('portalError').hidden, false);
});

test('Portal API が 401 ならログインを促す', async () => {
  const page = load([
    meRes(200, meBody({ web: true, extension: false })),
    [(u) => u.includes('/api/billing/portal'), () => res(401, { error: 'unauthenticated' })],
  ]);
  await settle();
  await page.el('managePlanBtn')._fire('click');
  await settle();
  assert.match(page.el('portalError').textContent, /ログイン/);
});

test('**Portal API のエラーでも生の Stripe 文言を出さない**', async () => {
  const page = load([
    meRes(200, meBody({ web: true, extension: false })),
    [(u) => u.includes('/api/billing/portal'),
      () => res(502, { error: 'StripeError: No such customer cus_LEAK' })],
  ]);
  await settle();
  await page.el('managePlanBtn')._fire('click');
  await settle();
  const msg = page.el('portalError').textContent;
  assert.ok(!msg.includes('cus_LEAK'));
  assert.ok(!msg.includes('Stripe'));
  assert.match(msg, /契約管理画面を開けませんでした/);
});

test('Portal 失敗後はボタンが押せる状態へ戻る', async () => {
  const page = load([
    meRes(200, meBody({ web: true, extension: false })),
    [(u) => u.includes('/api/billing/portal'), () => res(500, { error: 'internal_error' })],
  ]);
  await settle();
  await page.el('managePlanBtn')._fire('click');
  await settle();
  assert.equal(page.el('managePlanBtn').disabled, false);
  assert.equal(page.el('managePlanBtn').textContent, 'お支払い・契約を管理');
});

test('契約中でも購入フォームは隠れたまま', async () => {
  const page = load([meRes(200, meBody({ web: true, extension: false })), okPortal]);
  await settle();
  assert.equal(page.el('purchaseControls').hidden, true);
  assert.equal(page.el('buyWebPro').disabled, true);
});

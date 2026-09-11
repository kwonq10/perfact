// =========================================================
// アプリ内のプラン表示 / アップグレード導線のテスト
//
//   対象: public/index.html の renderPlanInfo() / renderQuotaInfo() /
//         readEntitlement() / refreshBillingContextIfUnknown()
//
//   このテストが守るもの:
//     - **プラン判定の正は /api/auth/me の entitlement だけ**であること。
//       query parameter / localStorage / plan_id 文字列から判定しない
//     - entitlement が **不明のときに Free と断定して購入を勧めない**こと
//     - Web Pro 契約者に Free 向けのアップグレード導線を出さないこと
//     - 無料枠 0 回でも **Checkout を自動で開始せず /pricing へ誘導する**こと
//     - Stripe の内部 ID を表示しないこと
// =========================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { jsonResponse, loadPage, makeFetch } from './page-harness.mjs';

const TZ_URL = '/api/user/timezone';
const STATUS_URL = '/api/quota/status';
const ME_URL = '/api/auth/me';

const INDEX_URL = new URL('../../public/index.html', import.meta.url);
const indexHtml = fs.readFileSync(INDEX_URL, 'utf8');

function statusBody({ unlimited = false, used = 1, remaining = 2, limit = 3,
                      week_start = '2036-10-06',
                      next_reset_at = '2036-10-13T02:00:00+00:00' } = {}) {
  if (unlimited) {
    return { unlimited: true, limit: null, used: null, remaining: null,
             week_start: null, next_reset_at: null };
  }
  return { unlimited: false, limit, used, remaining, week_start, next_reset_at };
}

function meBody(entitlement, extra = {}) {
  return {
    authenticated: true,
    plan_id: entitlement && entitlement.web ? 'web_pro' : 'free',
    status: 'active',
    entitlement,
    current_period_end: null,
    cancel_at_period_end: false,
    currency: null,
    grace_until: null,
    ...extra,
  };
}

/**
 * ページを読み込む。
 * entitlement: undefined = 不明のまま / オブジェクト = その値を設定
 */
function setup(opts = {}) {
  const meRes = opts.me || (() => jsonResponse(401, { authenticated: false }));
  const fetchImpl = makeFetch([
    [(u) => u.includes(TZ_URL), () => jsonResponse(200, { ok: true, display_timezone: 'Asia/Tokyo' })],
    [(u) => u.includes(STATUS_URL), () => jsonResponse(200, statusBody(opts.status || {}))],
    [(u) => u.includes(ME_URL), meRes],
  ]);
  const page = loadPage({ fetchImpl });
  if (opts.authenticated !== false) page.run('sukimaAuthenticated = true;');
  if (opts.entitlement !== undefined) {
    page.run('sukimaEntitlement = ' + JSON.stringify(opts.entitlement) + ';');
  }
  if (opts.lang) page.run('currentLang = ' + JSON.stringify(opts.lang) + ';');
  return { page, fetchImpl };
}

const planEl = (page) => page.el('planInfo');
const quotaEl = (page) => page.el('quotaInfo');

/** 要素ツリーから textContent を集める（スタブは innerHTML を持たないため）。 */
function collectText(el) {
  let out = String(el.textContent || '');
  for (const child of el.children || []) out += ' ' + collectText(child);
  return out;
}

/** 子孫から href を集める。 */
function collectHrefs(el) {
  const out = [];
  for (const child of el.children || []) {
    if (child.href) out.push(child.href);
    out.push(...collectHrefs(child));
  }
  return out;
}


// =========================================================
// 1. プラン表示
// =========================================================

test('未ログインではプランを表示しない', () => {
  const { page } = setup({ authenticated: false, entitlement: { web: true, extension: false } });
  page.call('renderPlanInfo');
  assert.equal(planEl(page).style.display, 'none');
});

test('**entitlement が不明なら何も表示しない**（Free と断定しない）', () => {
  const { page } = setup();
  page.call('renderPlanInfo');
  assert.equal(planEl(page).style.display, 'none');
  assert.equal(collectText(planEl(page)).trim(), '');
});

test('Free と確認できたら「無料プラン」と表示する', () => {
  const { page } = setup({ entitlement: { web: false, extension: false } });
  page.call('renderPlanInfo');
  const el = planEl(page);
  assert.notEqual(el.style.display, 'none');
  assert.match(collectText(el), /現在のプラン/);
  assert.match(collectText(el), /無料プラン/);
});

test('Web Pro と確認できたら「Web Pro ご利用中」と表示する', () => {
  const { page } = setup({ entitlement: { web: true, extension: false } });
  page.call('renderPlanInfo');
  const el = planEl(page);
  assert.notEqual(el.style.display, 'none');
  assert.match(collectText(el), /Web Pro/);
  assert.match(collectText(el), /ご利用中/);
});

test('英語表示にも追従する', () => {
  const { page } = setup({ entitlement: { web: true, extension: false }, lang: 'en' });
  page.call('renderPlanInfo');
  assert.match(collectText(planEl(page)), /Current plan/);
  assert.match(collectText(planEl(page)), /Active/);
});

// =========================================================
// 2. アップグレード導線
// =========================================================

test('Free には /pricing への導線が出る', () => {
  const { page } = setup({ entitlement: { web: false, extension: false } });
  page.call('renderPlanInfo');
  assert.deepEqual(collectHrefs(planEl(page)), ['/pricing']);
  assert.match(collectText(planEl(page)), /Web Proを見る/);
});

test('**Web Pro にはアップグレード導線を出さない**', () => {
  const { page } = setup({ entitlement: { web: true, extension: false } });
  page.call('renderPlanInfo');
  assert.deepEqual(collectHrefs(planEl(page)), []);
  assert.ok(!collectText(planEl(page)).includes('Web Proを見る'));
});

test('entitlement 不明のときは導線を出さない', () => {
  const { page } = setup();
  page.call('renderPlanInfo');
  assert.deepEqual(collectHrefs(planEl(page)), []);
});

test('**extension だけ true でも Web Pro 扱いしない**', () => {
  const { page } = setup({ entitlement: { web: false, extension: true } });
  page.call('renderPlanInfo');
  assert.match(collectText(planEl(page)), /無料プラン/);
  assert.ok(!collectText(planEl(page)).includes('ご利用中'));
  assert.deepEqual(collectHrefs(planEl(page)), ['/pricing']);
});

// =========================================================
// 3. quota 残り 0 回
// =========================================================

async function exhausted(opts = {}) {
  const { page, fetchImpl } = setup({ status: { remaining: 0, used: 3 }, ...opts });
  await page.call('refreshQuotaStatus');
  page.call('renderQuotaInfo');
  return { page, fetchImpl };
}

test('Free で残り 0 回なら /pricing への導線が出る', async () => {
  const { page } = await exhausted({ entitlement: { web: false, extension: false } });
  const el = quotaEl(page);
  assert.notEqual(el.style.display, 'none');
  assert.match(collectText(el), /使い切りました/);
  assert.ok(collectHrefs(el).includes('/pricing'), '/pricing 導線が無い');
});

test('**残り 0 回でも Checkout を自動で開始しない**', async () => {
  const { page, fetchImpl } = await exhausted({ entitlement: { web: false, extension: false } });
  const checkoutCalls = fetchImpl.calls.filter((c) => c.url.includes('/api/billing/checkout'));
  assert.equal(checkoutCalls.length, 0);
  const consentCalls = fetchImpl.calls.filter((c) => c.url.includes('/api/terms/consent'));
  assert.equal(consentCalls.length, 0);
  // 導線はあくまでリンク
  assert.ok(collectHrefs(quotaEl(page)).includes('/pricing'));
});

test('**entitlement 不明なら残り 0 でも購入を勧めない**', async () => {
  const { page } = await exhausted();
  assert.ok(!collectHrefs(quotaEl(page)).includes('/pricing'));
});

test('**Web Pro には残数表示自体を出さない**', async () => {
  const { page } = await exhausted({ entitlement: { web: true, extension: false } });
  assert.equal(quotaEl(page).style.display, 'none');
});

test('unlimited が落ちていても entitlement が Pro なら残数を出さない', async () => {
  const { page } = setup({ entitlement: { web: true, extension: false }, status: { remaining: 0 } });
  await page.call('refreshQuotaStatus');
  page.call('renderQuotaInfo');
  assert.equal(quotaEl(page).style.display, 'none');
});

test('残り 1 回以上なら購入を強制しない（導線を足さない）', async () => {
  const { page } = setup({ entitlement: { web: false, extension: false }, status: { remaining: 2 } });
  await page.call('refreshQuotaStatus');
  page.call('renderQuotaInfo');
  assert.match(collectText(quotaEl(page)), /今週あと2回/);
  assert.ok(!collectHrefs(quotaEl(page)).includes('/pricing'));
});


// =========================================================
// 4. entitlement の取り込み（server の値だけを信じる）
// =========================================================

test('readEntitlement は boolean が 2 つそろったときだけ採用する', () => {
  const { page } = setup();
  const call = (data) => page.call('readEntitlement', data);
  // vm コンテキスト内で作られたオブジェクトなので prototype 実体が異なる。
  // deepStrictEqual ではなく値を 1 つずつ確認する。
  const ok = call({ entitlement: { web: true, extension: false } });
  assert.equal(ok.web, true);
  assert.equal(ok.extension, false);
  assert.equal(call({}), null);
  assert.equal(call({ entitlement: null }), null);
  assert.equal(call({ entitlement: { web: true } }), null);
  assert.equal(call({ entitlement: { web: 'true', extension: false } }), null);
  assert.equal(call({ entitlement: { web: 1, extension: 0 } }), null);
});

test('plan_id が web_pro でも entitlement が無ければ Pro 扱いしない', () => {
  const { page } = setup();
  page.run("sukimaPlanId = 'web_pro'; sukimaSubscriptionStatus = 'active';");
  page.call('renderPlanInfo');
  assert.equal(planEl(page).style.display, 'none');
  assert.equal(page.call('hasWebProEntitlement'), false);
});

test('/api/auth/me が 200 なら entitlement を取り込む', async () => {
  const { page } = setup({ me: () => jsonResponse(200, meBody({ web: true, extension: false })) });
  await page.call('refreshBillingContextIfUnknown');
  assert.equal(page.call('hasWebProEntitlement'), true);
  assert.match(collectText(planEl(page)), /ご利用中/);
});

test('**/api/auth/me が 401 なら Pro と誤表示しない**', async () => {
  const { page } = setup({ me: () => jsonResponse(401, { authenticated: false }) });
  await page.call('refreshBillingContextIfUnknown');
  assert.equal(page.call('hasWebProEntitlement'), false);
  page.call('renderPlanInfo');
  assert.equal(planEl(page).style.display, 'none');
});

test('**/api/auth/me が 500 でも Free と断定しない**', async () => {
  const { page } = setup({ me: () => jsonResponse(500, { error: 'internal_error' }) });
  await page.call('refreshBillingContextIfUnknown');
  assert.equal(page.call('isConfirmedFreeUser'), false);
  page.call('renderPlanInfo');
  assert.equal(planEl(page).style.display, 'none');
});

test('通信そのものが失敗しても Free と断定しない', async () => {
  const fetchImpl = async () => { throw new Error('network down'); };
  const page = loadPage({ fetchImpl });
  page.run('sukimaAuthenticated = true;');
  await page.call('refreshBillingContextIfUnknown');
  assert.equal(page.call('isConfirmedFreeUser'), false);
  assert.equal(page.call('hasWebProEntitlement'), false);
});

test('すでに判っているときは /api/auth/me を引き直さない', async () => {
  const { page, fetchImpl } = setup({ entitlement: { web: false, extension: false } });
  await page.call('refreshBillingContextIfUnknown');
  assert.equal(fetchImpl.calls.filter((c) => c.url.includes(ME_URL)).length, 0);
});

test('ログアウト相当の状態リセットで entitlement も消える', () => {
  const { page } = setup({ entitlement: { web: true, extension: false } });
  assert.equal(page.call('hasWebProEntitlement'), true);
  page.call('clearSukimaSessionState');
  assert.equal(page.call('hasWebProEntitlement'), false);
  page.call('renderPlanInfo');
  assert.equal(planEl(page).style.display, 'none');
});

// =========================================================
// 5. セキュリティ（静的検査）
// =========================================================

test('**query parameter で有料判定をしていない**', () => {
  assert.ok(!/searchParams[^\n]*\b(plan|paid|pro|entitlement)\b/i.test(indexHtml),
    'query parameter から plan を読んでいる');
});

test('**localStorage で有料判定をしていない**', () => {
  const suspicious = indexHtml.match(/localStorage\.(getItem|setItem)\([^)]*\)/g) || [];
  for (const line of suspicious) {
    assert.ok(!/\b(paid|pro|plan|entitlement|subscription)\b/i.test(line),
      'localStorage で課金状態を扱っている: ' + line);
  }
});

test('entitlement は /api/auth/me からしか代入されない', () => {
  const assigns = indexHtml.match(/sukimaEntitlement\s*=\s*[^;]+;/g) || [];
  assert.ok(assigns.length > 0);
  for (const a of assigns) {
    assert.ok(/null|readEntitlement\(/.test(a),
      'entitlement を client 側で組み立てている: ' + a);
  }
});

test('Stripe の内部 ID を画面に出さない', () => {
  assert.ok(!/stripe_customer_id|stripe_subscription_id|cus_|sub_1/.test(indexHtml));
});

test('アプリ側に価格や購入処理を重複実装していない', () => {
  assert.ok(!indexHtml.includes('/api/billing/checkout'), 'checkout を直接呼んでいる');
  assert.ok(!/¥300|¥500/.test(indexHtml), '価格をアプリ側へ重複させている');
});

test('プラン導線のリンク先は /pricing だけ', () => {
  const hrefs = (indexHtml.match(/href="\/pricing[^"]*"/g) || []);
  assert.ok(hrefs.length >= 1);
  for (const h of hrefs) assert.equal(h, 'href="/pricing"');
});


// =========================================================
// 6. 背景の位置調整 / ホワイトレンジの Pro gate
// =========================================================

/** 保存済みの「Pro が設定した値」を localStorage へ置く。 */
function seedProSettings(page, { x = 12, y = 88, white = 2 } = {}) {
  page.run(
    "localStorage.setItem('sukima_bg_position_x', '" + x + "');"
    + "localStorage.setItem('sukima_bg_position_y', '" + y + "');"
    + "localStorage.setItem('sukima_bg_white_range', '" + white + "');"
    + "bgPositionX = " + x + "; bgPositionY = " + y + "; bgWhiteRange = " + white + ";"
  );
}

const storedSettings = (page) => ({
  x: page.run("localStorage.getItem('sukima_bg_position_x')"),
  y: page.run("localStorage.getItem('sukima_bg_position_y')"),
  white: page.run("localStorage.getItem('sukima_bg_white_range')"),
});

test('Pro は保存済みの位置とホワイトレンジがそのまま使われる', () => {
  const { page } = setup({ entitlement: { web: true, extension: false } });
  seedProSettings(page);
  assert.equal(page.call('canCustomizeBackground'), true);
  assert.equal(page.call('effectiveBgPositionX'), 12);
  assert.equal(page.call('effectiveBgPositionY'), 88);
  assert.equal(page.call('effectiveBgWhiteRange'), 2);
});

test('**Free は既定値で表示する**（50 / 50 / 0）', () => {
  const { page } = setup({ entitlement: { web: false, extension: false } });
  seedProSettings(page);
  assert.equal(page.call('canCustomizeBackground'), false);
  assert.equal(page.call('effectiveBgPositionX'), 50);
  assert.equal(page.call('effectiveBgPositionY'), 50);
  assert.equal(page.call('effectiveBgWhiteRange'), 0);
});

test('**Free でも保存済みの Pro 設定を消さない**', () => {
  const { page } = setup({ entitlement: { web: false, extension: false } });
  seedProSettings(page);
  // Free の状態で描画経路をひととおり通す
  page.call('applyBackgroundEntitlement');
  page.call('updateBackgroundPosition');
  page.call('applyBgWhiteRange');
  const stored = storedSettings(page);
  assert.equal(stored.x, '12', '位置 X が書き換えられた');
  assert.equal(stored.y, '88', '位置 Y が書き換えられた');
  assert.equal(stored.white, '2', 'ホワイトレンジが書き換えられた');
});

test('**Free では保存関数を呼んでも localStorage を書き換えない**', () => {
  const { page } = setup({ entitlement: { web: false, extension: false } });
  seedProSettings(page);
  page.run('bgPositionX = 99; bgPositionY = 99; bgWhiteRange = 0;');
  page.call('saveBgPositionToStorage');
  page.call('saveBgWhiteRangeToStorage');
  const stored = storedSettings(page);
  assert.equal(stored.x, '12');
  assert.equal(stored.y, '88');
  assert.equal(stored.white, '2');
});

test('Pro なら保存関数は従来どおり書き込む', () => {
  const { page } = setup({ entitlement: { web: true, extension: false } });
  seedProSettings(page);
  page.run('bgPositionX = 30; bgPositionY = 70; bgWhiteRange = 1;');
  page.call('saveBgPositionToStorage');
  page.call('saveBgWhiteRangeToStorage');
  const stored = storedSettings(page);
  assert.equal(stored.x, '30');
  assert.equal(stored.y, '70');
  assert.equal(stored.white, '1');
});

test('**再契約すると以前の Pro 設定が復元される**', () => {
  const { page } = setup({ entitlement: { web: true, extension: false } });
  seedProSettings(page);

  // Pro -> Free（解約相当）。表示は既定値へ落ちる
  page.run('sukimaEntitlement = { web: false, extension: false };');
  page.call('applyBackgroundEntitlement');
  assert.equal(page.call('effectiveBgPositionX'), 50);
  assert.equal(page.call('effectiveBgWhiteRange'), 0);

  // Free -> Pro（再契約相当）。保存値がそのまま戻る
  page.run('sukimaEntitlement = { web: true, extension: false };');
  page.call('applyBackgroundEntitlement');
  assert.equal(page.call('effectiveBgPositionX'), 12);
  assert.equal(page.call('effectiveBgPositionY'), 88);
  assert.equal(page.call('effectiveBgWhiteRange'), 2);

  // localStorage も無傷
  const stored = storedSettings(page);
  assert.equal(stored.x, '12');
  assert.equal(stored.white, '2');
});


// ---------------------------------------------------------
// 7. 操作ガードと Free 向け案内
// ---------------------------------------------------------

test('**Free ではホワイトレンジのスライダーが disabled**', () => {
  const { page } = setup({ entitlement: { web: false, extension: false } });
  page.call('setBgWhiteRangeControlEnabled', true);   // 背景画像がある想定
  assert.equal(page.el('bgWhiteRangeSlider').disabled, true);
});

test('Pro なら背景画像があるときにスライダーが有効になる', () => {
  const { page } = setup({ entitlement: { web: true, extension: false } });
  page.call('setBgWhiteRangeControlEnabled', true);
  assert.equal(page.el('bgWhiteRangeSlider').disabled, false);
});

test('背景画像が無ければ Pro でもスライダーは disabled（従来仕様）', () => {
  const { page } = setup({ entitlement: { web: true, extension: false } });
  page.call('setBgWhiteRangeControlEnabled', false);
  assert.equal(page.el('bgWhiteRangeSlider').disabled, true);
});

test('**Free がスライダーを動かしても値が変わらない**（UI だけに頼らない）', () => {
  const { page } = setup({ entitlement: { web: false, extension: false } });
  seedProSettings(page, { white: 2 });
  page.el('bgWhiteRangeSlider').value = 1;
  page.call('handleBgWhiteRangeSliderInput');
  assert.equal(page.run('bgWhiteRange'), 2, '保存値が書き換えられた');
  assert.equal(page.call('effectiveBgWhiteRange'), 0, 'Free の表示は既定値のまま');
  assert.equal(storedSettings(page).white, '2');
});

test('Pro がスライダーを動かすと値が変わる', () => {
  const { page } = setup({ entitlement: { web: true, extension: false } });
  page.el('bgWhiteRangeSlider').value = 2;
  page.call('handleBgWhiteRangeSliderInput');
  assert.equal(page.run('bgWhiteRange'), 2);
  assert.equal(storedSettings(page).white, '2');
});

test('**Free では位置調整のドラッグが始まらない**', () => {
  const { page } = setup({ entitlement: { web: false, extension: false } });
  page.run('bgPreviewMovableBounds = { renderLeft: 0, renderTop: 0, movableW: 100, movableH: 100 };');
  page.call('handleBgPreviewHighlightPointerDown',
    { isPrimary: true, pointerType: 'touch', pointerId: 1, clientX: 10, clientY: 10, preventDefault() {} });
  assert.equal(page.run('bgPreviewDragState'), null, 'ドラッグが開始された');
});

test('Pro では位置調整のドラッグが始まる', () => {
  const { page } = setup({ entitlement: { web: true, extension: false } });
  page.run('bgPreviewMovableBounds = { renderLeft: 0, renderTop: 0, movableW: 100, movableH: 100 };');
  page.call('handleBgPreviewHighlightPointerDown',
    { isPrimary: true, pointerType: 'touch', pointerId: 1, clientX: 10, clientY: 10, preventDefault() {} });
  assert.notEqual(page.run('bgPreviewDragState'), null);
});

test('entitlement 不明でも Pro 扱いしない（ドラッグ不可・既定表示）', () => {
  const { page } = setup();   // entitlement は null
  seedProSettings(page);
  assert.equal(page.call('canCustomizeBackground'), false);
  assert.equal(page.call('effectiveBgPositionX'), 50);
  page.run('bgPreviewMovableBounds = { renderLeft: 0, renderTop: 0, movableW: 100, movableH: 100 };');
  page.call('handleBgPreviewHighlightPointerDown',
    { isPrimary: true, pointerType: 'touch', pointerId: 1, clientX: 10, clientY: 10, preventDefault() {} });
  assert.equal(page.run('bgPreviewDragState'), null);
  // それでも保存値は無傷
  assert.equal(storedSettings(page).x, '12');
});

test('**保存値があるだけでは Pro と判定しない**', () => {
  const { page } = setup({ entitlement: { web: false, extension: false } });
  seedProSettings(page);
  assert.equal(page.call('canCustomizeBackground'), false);
});

test('Free には控えめな案内と /pricing リンクを出す', () => {
  const { page } = setup({ entitlement: { web: false, extension: false } });
  page.call('renderBackgroundProUi');
  const el = page.el('bgProNotice');
  assert.notEqual(el.style.display, 'none');
  assert.match(collectText(el), /Web Pro/);
  assert.deepEqual(collectHrefs(el), ['/pricing']);
});

test('**Pro には案内を出さない**（ロック演出をしない）', () => {
  const { page } = setup({ entitlement: { web: true, extension: false } });
  page.call('renderBackgroundProUi');
  assert.equal(page.el('bgProNotice').style.display, 'none');
  assert.deepEqual(collectHrefs(page.el('bgProNotice')), []);
});

test('案内に煽り文句やロック絵文字を使っていない', () => {
  const { page } = setup({ entitlement: { web: false, extension: false } });
  page.call('renderBackgroundProUi');
  const msg = collectText(page.el('bgProNotice'));
  assert.ok(!/🔒|今すぐ|お得|限定|急/.test(msg), '煽り表現がある: ' + msg);
});

test('extension だけ true でも背景カスタマイズは解放しない', () => {
  const { page } = setup({ entitlement: { web: false, extension: true } });
  assert.equal(page.call('canCustomizeBackground'), false);
});


// =========================================================
// 8. 背景画像そのものは Free のまま
// =========================================================

/** 画像選択を模す。IndexedDB はサンドボックスに無いので保存は失敗するが、
 *  表示と localStorage への影響だけを見たいので問題ない。 */
function selectImage(page) {
  page.run("applyBackgroundImage(new Blob(['x'], { type: 'image/png' }));");
}

test('**Free でも背景画像を設定できる**（アップロードを gate しない）', () => {
  const { page } = setup({ entitlement: { web: false, extension: false } });
  selectImage(page);
  assert.notEqual(page.run('bgImageObjectUrl'), null, 'Free で画像が適用されなかった');
});

test('Pro でも従来どおり背景画像を設定できる', () => {
  const { page } = setup({ entitlement: { web: true, extension: false } });
  selectImage(page);
  assert.notEqual(page.run('bgImageObjectUrl'), null);
});

test('entitlement 不明でも背景画像は設定できる（画像は有料機能ではない）', () => {
  const { page } = setup();
  selectImage(page);
  assert.notEqual(page.run('bgImageObjectUrl'), null);
});

test('**Free が新しい画像を設定しても保存済みの Pro 調整値を壊さない**', () => {
  const { page } = setup({ entitlement: { web: false, extension: false } });
  seedProSettings(page, { x: 12, y: 88, white: 2 });
  selectImage(page);
  const stored = storedSettings(page);
  assert.equal(stored.x, '12');
  assert.equal(stored.y, '88');
  assert.equal(stored.white, '2');
});

test('Pro が新しい画像を設定すると位置は既定へ戻り保存される（従来仕様）', () => {
  const { page } = setup({ entitlement: { web: true, extension: false } });
  seedProSettings(page, { x: 12, y: 88, white: 2 });
  selectImage(page);
  assert.equal(storedSettings(page).x, '50');
});

test('背景画像のアップロード経路は entitlement を参照しない（静的確認）', () => {
  // 正規表現のエスケープに依存しないよう indexOf で関数本体を切り出す。
  const body = (fn) => {
    const head = 'function ' + fn + '(';
    const at = indexHtml.indexOf(head);
    assert.notEqual(at, -1, fn + ' が見つからない');
    let i = indexHtml.indexOf('{', at);
    assert.notEqual(i, -1, fn + ' の本体が見つからない');
    const from = i;
    let depth = 1;
    i += 1;
    while (depth > 0 && i < indexHtml.length) {
      if (indexHtml[i] === '{') depth += 1;
      else if (indexHtml[i] === '}') depth -= 1;
      i += 1;
    }
    return indexHtml.slice(from, i);
  };
  for (const fn of ['applyBackgroundImage', 'handleBgImageChange', 'restoreSavedBackground']) {
    const src = body(fn);
    assert.ok(src.length > 20, fn + ' の本体が空');
    assert.ok(!src.includes('canCustomizeBackground'),
      fn + ' が背景画像を entitlement で gate している');
  }
});

// ---------------------------------------------------------
// 9. Free 化・再契約でデータを壊さない
// ---------------------------------------------------------

test('**Pro -> Free で背景画像も保存値も消えない**', () => {
  const { page } = setup({ entitlement: { web: true, extension: false } });
  seedProSettings(page, { x: 12, y: 88, white: 2 });
  selectImage(page);
  const urlBefore = page.run('bgImageObjectUrl');

  page.run('sukimaEntitlement = { web: false, extension: false };');
  page.call('applyBackgroundEntitlement');

  assert.equal(page.run('bgImageObjectUrl'), urlBefore, '画像が消えた');
  const stored = storedSettings(page);
  assert.notEqual(stored.x, null, '位置の保存値が消えた');
  assert.notEqual(stored.white, null, 'ホワイトレンジの保存値が消えた');
});

test('**契約状態が変わっても localStorage の key を remove しない**', () => {
  const { page } = setup({ entitlement: { web: true, extension: false } });
  seedProSettings(page, { x: 12, y: 88, white: 2 });
  for (const e of ['{ web: false, extension: false }', 'null',
                   '{ web: true, extension: false }', '{ web: false, extension: true }']) {
    page.run('sukimaEntitlement = ' + e + ';');
    page.call('applyBackgroundEntitlement');
  }
  const stored = storedSettings(page);
  assert.equal(stored.x, '12');
  assert.equal(stored.y, '88');
  assert.equal(stored.white, '2');
});

test('malformed entitlement でも保存値が無傷', () => {
  const { page } = setup({ entitlement: { web: true, extension: false } });
  seedProSettings(page, { x: 12, y: 88, white: 2 });
  page.run("sukimaEntitlement = readEntitlement({ entitlement: { web: 'yes' } });");
  assert.equal(page.run('sukimaEntitlement'), null);
  page.call('applyBackgroundEntitlement');
  assert.equal(storedSettings(page).x, '12');
  assert.equal(page.call('canCustomizeBackground'), false);
});

// ---------------------------------------------------------
// 10. 新規 Free ユーザー（保存値が一度も無い）
// ---------------------------------------------------------

test('保存値が無い Free ユーザーは既定値 50/50/0 になる', () => {
  const { page } = setup({ entitlement: { web: false, extension: false } });
  assert.equal(page.run("localStorage.getItem('sukima_bg_position_x')"), null);
  assert.equal(page.call('effectiveBgPositionX'), 50);
  assert.equal(page.call('effectiveBgPositionY'), 50);
  assert.equal(page.call('effectiveBgWhiteRange'), 0);
});

test('保存値が無い Free ユーザーにも /pricing 導線が出る', () => {
  const { page } = setup({ entitlement: { web: false, extension: false } });
  page.call('renderBackgroundProUi');
  assert.deepEqual(collectHrefs(page.el('bgProNotice')), ['/pricing']);
});

test('保存値が無い Free ユーザーは Pro 調整 UI を操作できない', () => {
  const { page } = setup({ entitlement: { web: false, extension: false } });
  page.call('setBgWhiteRangeControlEnabled', true);
  assert.equal(page.el('bgWhiteRangeSlider').disabled, true);
});


// ---------------------------------------------------------
// 11. Pricing 表記と gate 実装の一致
// ---------------------------------------------------------

const pricingHtml = fs.readFileSync(
  new URL('../../public/pricing.html', import.meta.url), 'utf8');

/** pricing.html の 1 プランぶんの markup。 */
function pricingCard(planId) {
  const body = pricingHtml.split('<body>')[1] || '';
  const start = body.indexOf('data-plan="' + planId + '"');
  assert.notEqual(start, -1, planId + ' のカードが無い');
  const rest = body.slice(start + 1);
  const nextCard = rest.indexOf('data-plan="');
  const endSection = rest.indexOf('</section>');
  let end = nextCard === -1 ? endSection : Math.min(nextCard, endSection === -1 ? nextCard : endSection);
  if (end === -1) end = rest.length;
  return rest.slice(0, end);
}

test('**Pricing が Pro 機能として挙げているのは無制限検索・位置調整・ホワイトレンジ**', () => {
  const card = pricingCard('web_pro');
  assert.match(card, /無制限/, 'Web 検索無制限が書かれていない');
  assert.match(card, /位置調整/, '背景の位置調整が書かれていない');
  assert.match(card, /ホワイトレンジ/, 'ホワイトレンジが書かれていない');
});

test('**Pricing は背景画像そのものを Pro 機能として売っていない**', () => {
  const card = pricingCard('web_pro');
  // 「背景画像の位置調整」は Pro、「背景画像を設定できる」は Pro ではない
  assert.ok(!/背景画像を設定|背景画像が使え|背景画像の設定が/.test(card),
    'Pricing が背景画像の設定自体を Pro 機能として書いている');
});

test('Free カードは背景画像を制限として挙げていない', () => {
  const card = pricingCard('free');
  assert.ok(!/背景/.test(card), 'Free カードが背景を制限として書いている');
});

test('gate 実装と Pricing の対象がそろっている', () => {
  // 実装側で gate されているのは position / white range だけ
  assert.ok(indexHtml.includes('effectiveBgPositionX'), '位置の gate が無い');
  assert.ok(indexHtml.includes('effectiveBgWhiteRange'), 'ホワイトレンジの gate が無い');
  // 画像そのものには gate が無い（アップロード関数が entitlement を見ない）
  assert.ok(!indexHtml.includes('canCustomizeBackgroundImage'),
    '画像自体を gate する関数が増えている');
});


// =========================================================
// 12. アプリ内の契約管理導線
// =========================================================

// ⚠ ハーネスの `document.createElement()` は `getElementById` の id マップへ
//    登録されない（実 DOM では同一ノードだが、スタブでは別物）。
//    そのため:
//      - **要素が planInfo へ足されたか**の確認は findById()
//      - **openBillingPortal() が書き換えた内容**の確認は page.el(id)
//    と使い分ける。

/** planInfo の子要素を id で探す。 */
function findById(el, id) {
  for (const child of el.children || []) {
    if (child.id === id) return child;
    const deeper = findById(child, id);
    if (deeper) return deeper;
  }
  return null;
}

function setupPortal(opts = {}) {
  const portal = opts.portal
    || (() => jsonResponse(200, { url: 'https://billing.stripe.com/p/session/test_dummy' }));
  const fetchImpl = makeFetch([
    [(u) => u.includes(TZ_URL), () => jsonResponse(200, { ok: true, display_timezone: 'Asia/Tokyo' })],
    [(u) => u.includes(STATUS_URL), () => jsonResponse(200, statusBody())],
    [(u) => u.includes('/api/billing/portal'), portal],
    [(u) => u.includes(ME_URL), () => jsonResponse(401, { authenticated: false })],
  ]);
  const page = loadPage({ fetchImpl });
  page.run('sukimaAuthenticated = true;');
  page.run('sukimaEntitlement = ' + JSON.stringify(opts.entitlement || { web: true, extension: false }) + ';');
  if (opts.billing !== undefined) {
    page.run('sukimaBilling = ' + JSON.stringify(opts.billing) + ';');
  }
  page.call('renderPlanInfo');
  return { page, fetchImpl };
}

const portalCalls = (f) => f.calls.filter((c) => c.url.includes('/api/billing/portal'));

test('Web Pro には契約管理ボタンが出る', () => {
  const { page } = setupPortal();
  assert.notEqual(findById(planEl(page), 'planManageBtn'), null);
});

test('**Free には契約管理ボタンを出さない**', () => {
  const { page } = setupPortal({ entitlement: { web: false, extension: false } });
  assert.equal(findById(planEl(page), 'planManageBtn'), null);
});

test('entitlement 不明では契約管理ボタンを出さない', () => {
  const fetchImpl = makeFetch([]);
  const page = loadPage({ fetchImpl });
  page.run('sukimaAuthenticated = true;');
  page.call('renderPlanInfo');
  assert.equal(findById(planEl(page), 'planManageBtn'), null);
});

test('契約管理を押すと Portal API を POST する', async () => {
  const { page, fetchImpl } = setupPortal();
  await page.call('openBillingPortal');
  assert.equal(portalCalls(fetchImpl).length, 1);
  assert.equal(portalCalls(fetchImpl)[0].method, 'POST');
});

test('**Portal API へ customer_id / return_url を送らない**', async () => {
  const { page, fetchImpl } = setupPortal();
  await page.call('openBillingPortal');
  assert.equal(portalCalls(fetchImpl)[0].init.body, '{}');
});

test('成功したら Portal の URL へ遷移する', async () => {
  const { page } = setupPortal();
  await page.call('openBillingPortal');
  assert.equal(page.context.location.href, 'https://billing.stripe.com/p/session/test_dummy');
});

test('**二重実行しても Portal API を 1 回しか呼ばない**', async () => {
  let release;
  const pending = new Promise((r) => { release = r; });
  const { page, fetchImpl } = setupPortal({ portal: () => pending });
  page.call('openBillingPortal');
  page.call('openBillingPortal');
  page.call('openBillingPortal');
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
  assert.equal(portalCalls(fetchImpl).length, 1);
  assert.equal(page.el('planManageBtn').disabled, true, '送信中に押せてしまう');
  release(jsonResponse(200, { url: 'https://billing.stripe.com/p/x' }));
});

test('409 は日本語で案内し、生のエラーを出さない', async () => {
  const { page } = setupPortal({ portal: () => jsonResponse(409, { error: 'no_billing_account' }) });
  await page.call('openBillingPortal');
  assert.match(page.el('planPortalError').textContent, /お支払い情報/);
  assert.notEqual(findById(planEl(page), 'planPortalError'), null, 'エラー枠が planInfo に無い');
});

test('**502 でも Stripe の生文言を出さない**', async () => {
  const { page } = setupPortal({
    portal: () => jsonResponse(502, { error: 'StripeError: No such customer cus_LEAK' }),
  });
  await page.call('openBillingPortal');
  const msg = page.el('planPortalError').textContent;
  assert.ok(!msg.includes('cus_LEAK'));
  assert.ok(!msg.includes('Stripe'));
  assert.match(msg, /契約管理画面を開けませんでした/);
});

test('失敗後はボタンが再び押せる', async () => {
  const { page } = setupPortal({ portal: () => jsonResponse(500, { error: 'internal_error' }) });
  await page.call('openBillingPortal');
  assert.equal(page.el('planManageBtn').disabled, false);
  assert.equal(page.el('planManageBtn').textContent, 'お支払い・契約を管理');
});

// ---------------------------------------------------------
// 13. 解約予定の表示（表示専用・権限には使わない）
// ---------------------------------------------------------

test('解約予定なら「解約予定」と期限を出す', () => {
  const { page } = setupPortal({
    billing: { cancelAtPeriodEnd: true, currentPeriodEnd: '2036-10-13T02:00:00+00:00' },
  });
  const notice = findById(planEl(page), 'planCancelNotice');
  assert.notEqual(notice, null, '解約予定の表示が無い');
  assert.match(notice.textContent, /解約予定/);
  assert.match(notice.textContent, /Web Pro/);
});

test('解約予定でなければ出さない', () => {
  const { page } = setupPortal({ billing: { cancelAtPeriodEnd: false, currentPeriodEnd: null } });
  assert.equal(findById(planEl(page), 'planCancelNotice'), null);
});

test('**解約予定中でも entitlement は維持される**（期間末まで Pro）', () => {
  const { page } = setupPortal({
    billing: { cancelAtPeriodEnd: true, currentPeriodEnd: '2036-10-13T02:00:00+00:00' },
  });
  assert.equal(page.call('hasWebProEntitlement'), true);
  assert.equal(page.call('canCustomizeBackground'), true);
  assert.equal(findById(planEl(page), 'planUpgradeCta'), null, '解約予定中に購入導線を出している');
});

test('readBillingState は boolean が無ければ null', () => {
  const { page } = setupPortal();
  assert.equal(page.call('readBillingState', {}), null);
  assert.equal(page.call('readBillingState', null), null);
  const ok = page.call('readBillingState',
    { cancel_at_period_end: true, current_period_end: '2036-10-13T02:00:00+00:00' });
  assert.equal(ok.cancelAtPeriodEnd, true);
});

test('契約情報が不明なら解約予定を表示しない', () => {
  const { page } = setupPortal({ billing: null });
  assert.equal(findById(planEl(page), 'planCancelNotice'), null);
  assert.notEqual(findById(planEl(page), 'planManageBtn'), null, '管理導線は出す');
});


// =========================================================
// 14. 契約概要の表示
// =========================================================

function billingBody(over = {}) {
  return {
    cancelAtPeriodEnd: false,
    currentPeriodEnd: '2026-10-10T04:21:35.000Z',
    amount: 300,
    currency: 'jpy',
    pricePhase: 'launch',
    nextPhaseAmount: 500,
    graceUntil: null,
    status: 'active',
    ...over,
  };
}

const rowText = (page, id) => {
  const el = findById(planEl(page), id);
  return el === null ? null : collectText(el).replace(/\s+/g, ' ').trim();
};

test('active / launch は ¥300（税込）を表示する', () => {
  const { page } = setupPortal({ billing: billingBody() });
  assert.match(rowText(page, 'planAmountRow'), /月額料金/);
  assert.match(rowText(page, 'planAmountRow'), /¥300/);
  assert.match(rowText(page, 'planAmountRow'), /税込/);
});

test('**standard 契約者は ¥500 を表示する**（現在の契約料金）', () => {
  const { page } = setupPortal({
    billing: billingBody({ pricePhase: 'standard', amount: 500, nextPhaseAmount: null }),
  });
  assert.match(rowText(page, 'planAmountRow'), /¥500/);
  assert.equal(findById(planEl(page), 'planLaunchNote'), null,
    'standard 契約者に将来価格の注記を出している');
});

test('次回更新日を JST の日付で表示する', () => {
  const { page } = setupPortal({ billing: billingBody() });
  const text = rowText(page, 'planRenewalRow');
  assert.match(text, /次回更新日/);
  assert.match(text, /2026年10月10日/);
});

test('**UTC 深夜でも JST で前日にならない**', () => {
  // 2026-10-10T15:30:00Z = JST 2026-10-11 00:30 -> 11 日と出るべき
  const { page } = setupPortal({
    billing: billingBody({ currentPeriodEnd: '2026-10-10T15:30:00.000Z' }),
  });
  assert.match(rowText(page, 'planRenewalRow'), /2026年10月11日/);
});

test('**UTC 早朝でも JST で翌日にならない**', () => {
  // 2026-10-09T20:00:00Z = JST 2026-10-10 05:00 -> 10 日
  const { page } = setupPortal({
    billing: billingBody({ currentPeriodEnd: '2026-10-09T20:00:00.000Z' }),
  });
  assert.match(rowText(page, 'planRenewalRow'), /2026年10月10日/);
});

test('契約状態は「継続中」', () => {
  const { page } = setupPortal({ billing: billingBody() });
  assert.match(rowText(page, 'planStateRow'), /継続中/);
});

test('launch 契約者には将来価格の注記が出る（金額は server 由来）', () => {
  const { page } = setupPortal({ billing: billingBody() });
  const note = findById(planEl(page), 'planLaunchNote');
  assert.notEqual(note, null);
  assert.match(collectText(note), /2027年に入って最初の更新日/);
  assert.match(collectText(note), /¥500/);
});

test('**next_phase_amount が無ければ将来価格の注記を出さない**', () => {
  const { page } = setupPortal({ billing: billingBody({ nextPhaseAmount: null }) });
  assert.equal(findById(planEl(page), 'planLaunchNote'), null);
});

// ---------------------------------------------------------
// 15. 解約予定 / past_due
// ---------------------------------------------------------

test('解約予定なら「次回更新日」を出さない（更新されないため）', () => {
  const { page } = setupPortal({ billing: billingBody({ cancelAtPeriodEnd: true }) });
  assert.equal(findById(planEl(page), 'planRenewalRow'), null);
  assert.match(collectText(findById(planEl(page), 'planCancelNotice')), /解約予定/);
});

test('解約予定でも料金は表示する', () => {
  const { page } = setupPortal({ billing: billingBody({ cancelAtPeriodEnd: true }) });
  assert.match(rowText(page, 'planAmountRow'), /¥300/);
});

test('解約予定なら将来価格の注記を出さない', () => {
  const { page } = setupPortal({ billing: billingBody({ cancelAtPeriodEnd: true }) });
  assert.equal(findById(planEl(page), 'planLaunchNote'), null);
});

test('past_due は「お支払いの確認が必要です」と出す（grace 仕様は変えない）', () => {
  const { page } = setupPortal({ billing: billingBody({ status: 'past_due' }) });
  // 契約状態の行ではなく、専用の警告行として出す。
  assert.match(collectText(findById(planEl(page), 'planPastDueNotice')),
    /お支払いの確認が必要です/);
  assert.equal(findById(planEl(page), 'planStateRow'), null, '通常の契約状態行を出している');
  // 権限は entitlement が正。past_due の 7 日 grace は server 側の判定のまま。
  assert.equal(page.call('hasWebProEntitlement'), true);
});

// ---------------------------------------------------------
// 16. 安全側の挙動
// ---------------------------------------------------------

test('**Free には契約概要を出さない**', () => {
  const { page } = setupPortal({ entitlement: { web: false, extension: false },
                                 billing: billingBody() });
  assert.equal(findById(planEl(page), 'planSummary'), null);
  assert.equal(findById(planEl(page), 'planAmountRow'), null);
  assert.notEqual(findById(planEl(page), 'planUpgradeCta'), null, 'Free の導線は残す');
});

test('契約情報が不明でも Pro 表示は壊れない（金額行だけ出さない）', () => {
  const { page } = setupPortal({ billing: null });
  assert.equal(findById(planEl(page), 'planAmountRow'), null);
  assert.notEqual(findById(planEl(page), 'planManageBtn'), null);
});

test('**金額が null なら金額行を出さない**（0 円と誤表示しない）', () => {
  const { page } = setupPortal({ billing: billingBody({ amount: null }) });
  assert.equal(findById(planEl(page), 'planAmountRow'), null);
});

test('**未対応通貨では金額を出さない**（単位を推測しない）', () => {
  const { page } = setupPortal({ billing: billingBody({ currency: 'usd', amount: 299 }) });
  assert.equal(findById(planEl(page), 'planAmountRow'), null);
});

test('日付が壊れていれば更新日行を出さない', () => {
  const { page } = setupPortal({ billing: billingBody({ currentPeriodEnd: 'not-a-date' }) });
  assert.equal(findById(planEl(page), 'planRenewalRow'), null);
});

test('readBillingState は整数でない amount を採用しない', () => {
  const { page } = setupPortal();
  const b = page.call('readBillingState', {
    cancel_at_period_end: false, amount: '300', currency: 'jpy', price_phase: 'launch',
  });
  assert.equal(b.amount, null);
});

test('**Stripe の内部 ID を画面に出さない**', () => {
  const { page } = setupPortal({ billing: billingBody() });
  const text = collectText(planEl(page));
  for (const f of ['cus_', 'sub_', 'price_', 'bpc_']) {
    assert.ok(!text.includes(f), f + ' が表示されている');
  }
});

test('契約概要があっても Portal CTA は維持される', () => {
  const { page } = setupPortal({ billing: billingBody() });
  assert.notEqual(findById(planEl(page), 'planManageBtn'), null);
});


// =========================================================
// 17. past_due / 7 日 grace の UX
//
//   **判定ロジックは一切変えていない。**
//   grace 期限は server（`/api/auth/me` の `grace_until`）が算出した値を
//   表示するだけで、client は「past_due から 7 日」を計算しない。
// =========================================================

const pastDue = (over = {}) => billingBody({
  status: 'past_due',
  graceUntil: '2026-09-17T04:21:35.000Z',
  ...over,
});

test('**past_due + grace 中は警告と期限を出す**', () => {
  const { page } = setupPortal({ billing: pastDue() });
  assert.match(collectText(findById(planEl(page), 'planPastDueNotice')),
    /お支払いの確認が必要です/);
  const detail = collectText(findById(planEl(page), 'planPastDueDetail'));
  assert.match(detail, /2026年9月17日/);
  assert.match(detail, /Web Pro/);
  assert.match(detail, /お支払い方法をご確認ください/);
});

test('**grace 中は entitlement を維持する**（Pro 機能も開いたまま）', () => {
  const { page } = setupPortal({ billing: pastDue() });
  assert.equal(page.call('hasWebProEntitlement'), true);
  assert.equal(page.call('canCustomizeBackground'), true);
  assert.equal(findById(planEl(page), 'planUpgradeCta'), null, '購入導線を出している');
});

test('past_due でも Portal CTA を出す（支払い方法の更新へ誘導）', () => {
  const { page } = setupPortal({ billing: pastDue() });
  assert.notEqual(findById(planEl(page), 'planManageBtn'), null);
});

test('past_due でも現在の契約料金は出す', () => {
  const { page } = setupPortal({ billing: pastDue() });
  assert.match(rowText(page, 'planAmountRow'), /¥300/);
});

test('**未払い金額を推測して表示しない**', () => {
  const { page } = setupPortal({ billing: pastDue() });
  const text = collectText(planEl(page));
  assert.ok(!/未払い|滞納/.test(text), '未払い額を書いている: ' + text);
});

test('past_due 中は「次回更新日」を出さない', () => {
  const { page } = setupPortal({ billing: pastDue() });
  assert.equal(findById(planEl(page), 'planRenewalRow'), null);
});

test('past_due 中は将来価格の注記を出さない', () => {
  const { page } = setupPortal({ billing: pastDue() });
  assert.equal(findById(planEl(page), 'planLaunchNote'), null);
});

test('**grace 期限が取れないときは日付を出さず、確認だけ促す**', () => {
  const { page } = setupPortal({ billing: pastDue({ graceUntil: null }) });
  const detail = collectText(findById(planEl(page), 'planPastDueDetail'));
  assert.match(detail, /お支払い方法をご確認ください/);
  assert.ok(!/年/.test(detail), '日付を捏造している: ' + detail);
});

test('grace 期限が壊れていても日付を出さない', () => {
  const { page } = setupPortal({ billing: pastDue({ graceUntil: 'not-a-date' }) });
  assert.ok(!/年/.test(collectText(findById(planEl(page), 'planPastDueDetail'))));
});

test('**残り日数を計算して表示しない**（負数も出ない）', () => {
  const { page } = setupPortal({ billing: pastDue({ graceUntil: '2020-01-01T00:00:00.000Z' }) });
  const text = collectText(planEl(page));
  assert.ok(!/あと.*日/.test(text), '残り日数を出している: ' + text);
  assert.ok(!/-\d/.test(text), '負数が出ている: ' + text);
});

test('grace 期限も JST で表示する（UTC 深夜で前日にならない）', () => {
  const { page } = setupPortal({ billing: pastDue({ graceUntil: '2026-09-17T15:30:00.000Z' }) });
  assert.match(collectText(findById(planEl(page), 'planPastDueDetail')), /2026年9月18日/);
});

// ---------------------------------------------------------
// 18. 状態の区別（優先順位: past_due > 解約予定 > 通常 active）
// ---------------------------------------------------------

test('active には past_due 警告を出さない', () => {
  const { page } = setupPortal({ billing: billingBody() });
  assert.equal(findById(planEl(page), 'planPastDueNotice'), null);
  assert.match(rowText(page, 'planStateRow'), /継続中/);
});

test('解約予定は past_due 警告ではない', () => {
  const { page } = setupPortal({ billing: billingBody({ cancelAtPeriodEnd: true }) });
  assert.equal(findById(planEl(page), 'planPastDueNotice'), null);
  assert.match(collectText(findById(planEl(page), 'planCancelNotice')), /解約予定/);
});

test('**past_due と解約予定が同時なら past_due を優先する**', () => {
  const { page } = setupPortal({ billing: pastDue({ cancelAtPeriodEnd: true }) });
  assert.notEqual(findById(planEl(page), 'planPastDueNotice'), null);
  assert.equal(findById(planEl(page), 'planCancelNotice'), null, '両方出している');
});

test('契約情報が不明なら past_due 警告を出さない', () => {
  const { page } = setupPortal({ billing: null });
  assert.equal(findById(planEl(page), 'planPastDueNotice'), null);
});

// ---------------------------------------------------------
// 19. grace 終了後（既存 entitlement 判定が担保）
// ---------------------------------------------------------

test('**grace 終了後は Free 表示へ戻る**', () => {
  const { page } = setupPortal({
    entitlement: { web: false, extension: false },
    billing: pastDue(),
  });
  assert.match(collectText(planEl(page)), /無料プラン/);
  assert.equal(findById(planEl(page), 'planPastDueNotice'), null, 'Free に警告を出している');
  assert.equal(findById(planEl(page), 'planSummary'), null);
});

test('**grace 終了後は Pro 専用 UI が閉じる**', () => {
  const { page } = setupPortal({
    entitlement: { web: false, extension: false },
    billing: pastDue(),
  });
  assert.equal(page.call('canCustomizeBackground'), false);
  assert.equal(findById(planEl(page), 'planManageBtn'), null);
});

test('grace 終了後は /pricing 導線が出る', () => {
  const { page } = setupPortal({
    entitlement: { web: false, extension: false },
    billing: pastDue(),
  });
  assert.deepEqual(collectHrefs(planEl(page)), ['/pricing']);
});

test('canceled は past_due 警告ではなく Free', () => {
  const { page } = setupPortal({
    entitlement: { web: false, extension: false },
    billing: billingBody({ status: 'canceled', amount: null, currency: null }),
  });
  assert.equal(findById(planEl(page), 'planPastDueNotice'), null);
  assert.match(collectText(planEl(page)), /無料プラン/);
});

test('Free ユーザーに past_due 警告を出さない', () => {
  const { page } = setupPortal({
    entitlement: { web: false, extension: false },
    billing: billingBody({ status: 'active', amount: null, currency: null }),
  });
  assert.equal(findById(planEl(page), 'planPastDueNotice'), null);
});

test('readBillingState は grace_until を server 値としてだけ取る', () => {
  const { page } = setupPortal();
  const b = page.call('readBillingState', {
    cancel_at_period_end: false, grace_until: '2026-09-17T04:21:35.000Z',
  });
  assert.equal(b.graceUntil, '2026-09-17T04:21:35.000Z');
  const b2 = page.call('readBillingState', { cancel_at_period_end: false, grace_until: 123 });
  assert.equal(b2.graceUntil, null);
});

test('**client 側で 7 日を計算していない**（静的確認）', () => {
  assert.ok(!/7\s*\*\s*24\s*\*\s*60/.test(indexHtml), 'client が 7 日を計算している');
  assert.ok(!/PAST_DUE_GRACE/.test(indexHtml), 'client が grace 定数を持っている');
});

test('past_due 表示に Stripe の内部 ID を出さない', () => {
  const { page } = setupPortal({ billing: pastDue() });
  const text = collectText(planEl(page));
  for (const f of ['cus_', 'sub_', 'price_', 'bpc_']) {
    assert.ok(!text.includes(f), f + ' が表示されている');
  }
});

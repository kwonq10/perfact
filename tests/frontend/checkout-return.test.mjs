import test from 'node:test';
import assert from 'node:assert/strict';
import { jsonResponse, loadPage, makeFetch } from './page-harness.mjs';

function me(web) {
  return { authenticated: true, plan_id: web ? 'web_pro' : 'free', status: 'active',
    entitlement: { web, extension: false }, current_period_end: null,
    cancel_at_period_end: false, currency: 'jpy', price_phase: web ? 'launch' : null,
    amount: web ? 300 : null, grace_until: null };
}

function setup({ initialWeb = false, respond = () => jsonResponse(200, me(true)) } = {}) {
  const fetchImpl = makeFetch([
    [(url) => url === '/api/auth/me', respond],
    [(url) => url === '/latest-version.json', () => jsonResponse(200, { version: '1.4.1', minimumVersion: '1.4.1' })],
  ]);
  const page = loadPage({ fetchImpl });
  page.context.__initial = me(initialWeb);
  page.run(`
    sukimaAuthenticated = true;
    sukimaPlanId = __initial.plan_id;
    sukimaSubscriptionStatus = __initial.status;
    sukimaEntitlement = readEntitlement(__initial);
    sukimaBilling = readBillingState(__initial);
    var __reloadCount = 0;
    location.reload = () => { __reloadCount += 1; };
  `);
  const handlers = {};
  page.context.document.addEventListener = (type, handler) => { handlers[type] = handler; };
  page.context.addEventListener = (type, handler) => { handlers[type] = handler; };
  page.context.setInterval = () => 1;
  page.call('scheduleUpdateChecks');
  return { page, handlers, fetchImpl,
    meCalls: () => fetchImpl.calls.filter((call) => call.url === '/api/auth/me') };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const text = (element) => [element.textContent || '', ...element.children.map(text)].join(' ');

test('Checkout成功から通常navigationで戻ると起動時に最新Proを取得する', async () => {
  const ctx = setup();
  ctx.page.run(`
    initServiceWorkerUpdates = () => {};
    initUpdateNotifications = () => {};
    setupGoogleIdentity = () => {};
    syncQuotaContext = async () => {};
  `);
  ctx.page.context.onload();
  await settle();
  assert.equal(ctx.meCalls().length, 1);
  assert.equal(ctx.page.run('hasWebProEntitlement()'), true);
  assert.match(text(ctx.page.el('planInfo')), /Web Pro/);
  assert.equal(ctx.meCalls()[0].init.cache, 'no-store');
  assert.equal(ctx.meCalls()[0].init.credentials, 'same-origin');
  assert.equal(ctx.page.run('__reloadCount'), 0);
});

test('Checkout別タブから前面復帰: 既知Freeでも最新Proを取得しプラン・制限表示を更新する', async () => {
  const ctx = setup();
  ctx.page.run('quotaStatus = { unlimited: false, remaining: 0 }; renderQuotaInfo();');
  ctx.handlers.visibilitychange();
  await settle();
  assert.equal(ctx.meCalls().length, 1);
  assert.equal(ctx.page.run('sukimaPlanId'), 'web_pro');
  assert.equal(ctx.page.run('sukimaSubscriptionStatus'), 'active');
  assert.equal(ctx.page.run('hasWebProEntitlement()'), true);
  assert.match(text(ctx.page.el('planInfo')), /Web Pro/);
  assert.equal(ctx.page.el('quotaInfo').style.display, 'none');
  assert.equal(ctx.fetchImpl.calls.filter((call) => call.method === 'POST').length, 0);
});

test('BFCache復帰: pageshow.persistedで最新契約を取得する', async () => {
  const ctx = setup();
  ctx.handlers.pageshow({ persisted: true });
  await settle();
  assert.equal(ctx.meCalls().length, 1);
  assert.equal(ctx.page.run('hasWebProEntitlement()'), true);
});

test('通常pageshowは起動時取得を重複させず、focusだけでも追加取得しない', async () => {
  const ctx = setup();
  ctx.handlers.pageshow({ persisted: false });
  ctx.handlers.focus();
  await settle();
  assert.equal(ctx.meCalls().length, 0);
});

test('非表示時・未ログイン時は復帰による契約API取得を行わない', async () => {
  const ctx = setup();
  ctx.page.context.document.visibilityState = 'hidden';
  ctx.handlers.visibilitychange();
  ctx.handlers.pageshow({ persisted: true });
  ctx.page.context.document.visibilityState = 'visible';
  ctx.page.run('sukimaAuthenticated = false;');
  ctx.handlers.visibilitychange();
  await settle();
  assert.equal(ctx.meCalls().length, 0);
});

test('復帰イベントが重複しても処理中の取得は1回、次の復帰は新しく取得する', async () => {
  let release;
  const response = new Promise((resolve) => { release = resolve; });
  const ctx = setup({ respond: () => response });
  ctx.handlers.visibilitychange();
  ctx.handlers.pageshow({ persisted: true });
  ctx.handlers.visibilitychange();
  const first = ctx.page.call('refreshSukimaSessionUi');
  assert.equal(ctx.page.call('refreshSukimaSessionUi'), first);
  assert.equal(ctx.meCalls().length, 1);
  release(jsonResponse(200, me(true)));
  await first;
  await ctx.page.call('refreshSukimaSessionUi');
  assert.equal(ctx.meCalls().length, 2);
  assert.equal(ctx.page.run('__reloadCount'), 0);
});

test('Pro→Free変更後の復帰は旧Proを維持せずFree表示に更新する', async () => {
  const ctx = setup({ initialWeb: true, respond: () => jsonResponse(200, me(false)) });
  ctx.handlers.visibilitychange();
  await settle();
  assert.equal(ctx.page.run('hasWebProEntitlement()'), false);
  assert.equal(ctx.page.run('sukimaPlanId'), 'free');
  assert.match(text(ctx.page.el('planInfo')), /無料プラン/);
  assert.equal(ctx.page.run('__reloadCount'), 0);
});

test('復帰時401はセッションと旧Proを消し、未ログイン表示にする', async () => {
  const ctx = setup({ initialWeb: true, respond: () => jsonResponse(401, { authenticated: false }) });
  await ctx.page.call('refreshSukimaSessionOnReturn');
  assert.equal(ctx.page.run('sukimaAuthenticated'), false);
  assert.equal(ctx.page.run('sukimaEntitlement'), null);
  assert.equal(ctx.page.el('planInfo').style.display, 'none');
});

for (const [name, respond] of [
  ['502', () => jsonResponse(502, { error: 'database_unavailable' })],
  ['offline', () => { throw new TypeError('offline'); }],
]) {
  test(`復帰時${name}は失敗扱いとし、Pro昇格やreload・自動retryを行わない`, async () => {
    const ctx = setup({ respond });
    assert.equal(await ctx.page.call('refreshSukimaSessionOnReturn'), 'check_failed');
    await settle();
    assert.equal(ctx.page.run('sukimaSessionCheckFailed'), true);
    assert.equal(ctx.page.run('hasWebProEntitlement()'), false);
    assert.equal(ctx.page.run('__reloadCount'), 0);
    assert.equal(ctx.meCalls().length, 1);
  });
}

// =========================================================
// public/assets/ads-measurement.js（広告の効果測定）と
// success.html の inline script のテスト
//
//   実際の Google・Stripe・サーバーへは接続しない（tests/frontend/ads-harness.mjs）。
//
//   このテストが守るもの:
//     - 許可前・拒否・設定を読めない・非本番・GPC・対象外の国で、Google への通信が 0 件
//     - 「許可する」「許可しない」を同じ見た目で出し、選ぶまでタグを読み込まない
//     - 許可後だけタグを読み込み、パーソナライズを無効にする
//     - 撤回（別タブを含む）で以後の送信をやめ、_gcl_ Cookie を消す
//     - 決済完了ページ: サーバーが eligible と答えたときだけ 1 件送る。
//       問い合わせには回数の上限がある。session_id を Google へ渡さない
//     - session_id は URL から消え、sessionStorage に期限つきで置かれる
// =========================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  commands,
  createEnv,
  flush,
  makeStorage,
  runSuccessInline,
} from './ads-harness.mjs';

const NOW = Date.parse('2026-10-18T03:00:00.000Z');
const SESSION_ID = 'cs_live_a1B2c3D4e5F6';
const TXN = 'sukima_sub_' + 'a'.repeat(40);

function consentValue(choice) {
  return JSON.stringify({ v: 1, choice, at: '2026-10-18T00:00:00.000Z' });
}

function storageWithConsent(choice) {
  return makeStorage({ initial: choice ? { sukima_ads_consent: consentValue(choice) } : {} });
}

function checkoutStorage(over = {}) {
  return makeStorage({
    initial: {
      sukima_ads_checkout: JSON.stringify({ sid: SESSION_ID, exp: NOW + 3600000, attempts: 0, ...over }),
    },
  });
}

const ELIGIBLE = {
  state: 'eligible',
  send_to: 'AW-18481971668/VxGaCNKJ26AdENSD8uxE',
  value: 300,
  currency: 'JPY',
  transaction_id: TXN,
};

function respondWith(conversion) {
  let n = 0;
  return (u) => {
    if (u === '/api/ads/tag-config') return { status: 200, body: { enabled: true, tag_id: 'AW-18481971668' } };
    if (u === '/api/billing/conversion') {
      const r = typeof conversion === 'function' ? conversion(n) : conversion;
      n += 1;
      return r;
    }
    return { status: 404, body: {} };
  };
}

function assertNoGoogle(env, label) {
  assert.deepEqual(env.googleTraffic(), { fetches: 0, scripts: 0, dataLayer: 0 }, label);
}

// ---------------------------------------------------------
// 1. 読み込まない条件（Google への通信 0 件）
// ---------------------------------------------------------

test('非本番（localhost・preview・http）では、サーバーにも Google にも問い合わせない', async () => {
  for (const href of ['http://localhost:8789/about/', 'https://abc123.sukima-web-8ws.pages.dev/about/',
                      'http://sukimacalendar.com/about/', 'https://example.com/about/']) {
    const env = createEnv({ href, page: 'lp', localStorage: storageWithConsent('granted') });
    await env.api.start();
    await flush();
    assert.equal(env.fetchCalls.length, 0, href);
    assertNoGoogle(env, href);
    assert.equal(env.banner(), null, href);
  }
});

test('非本番の決済完了ページでは、session_id を問い合わせに使わず破棄する', async () => {
  const ss = checkoutStorage();
  const env = createEnv({
    href: 'https://abc123.sukima-web-8ws.pages.dev/billing/success', page: 'success',
    localStorage: storageWithConsent('granted'), sessionStorage: ss,
  });
  await env.api.start();
  await flush();
  assert.equal(env.fetchCalls.length, 0);
  assert.equal(ss.map.has('sukima_ads_checkout'), false);
  assertNoGoogle(env);
});

test('Global Privacy Control が有効なら、許可済みでも読み込まない', async () => {
  const env = createEnv({ page: 'lp', gpc: true, localStorage: storageWithConsent('granted') });
  await env.api.start();
  await flush();
  assert.equal(env.fetchCalls.length, 0);
  assertNoGoogle(env);
});

test('「許可しない」を選んでいれば読み込まず、案内も出さない', async () => {
  const env = createEnv({ page: 'lp', localStorage: storageWithConsent('denied') });
  await env.api.start();
  await flush();
  assert.equal(env.fetchCalls.length, 0);
  assertNoGoogle(env);
  assert.equal(env.banner(), null);
});

test('設定を読めない（localStorage が使えない）なら読み込まず、案内も出さない', async () => {
  const env = createEnv({ page: 'lp', localStorage: makeStorage({ broken: true }) });
  await env.api.start();
  await flush();
  assert.equal(env.fetchCalls.length, 0);
  assertNoGoogle(env);
  assert.equal(env.banner(), null);
});

test('サーバーが無効（本番設定でない・日本以外・国が不明）と答えたら、案内も出さない', async () => {
  for (const body of [{ enabled: false }, { enabled: true, tag_id: 'not-a-tag' }, null]) {
    const env = createEnv({
      page: 'lp',
      respond: (u) => (u === '/api/ads/tag-config' ? { status: 200, body } : { status: 404, body: {} }),
    });
    await env.api.start();
    await flush();
    assert.deepEqual(env.fetchCalls.map((c) => c.url), ['/api/ads/tag-config']);
    assertNoGoogle(env);
    assert.equal(env.banner(), null);
  }
});

test('tag-config の通信に失敗しても例外を出さず、何も読み込まない', async () => {
  const env = createEnv({ page: 'lp', respond: () => new Error('offline') });
  await env.api.start();
  await flush();
  assertNoGoogle(env);
  assert.equal(env.banner(), null);
});

test('tag-config の問い合わせは Cookie を送らず、キャッシュさせない', async () => {
  const env = createEnv({ page: 'lp' });
  await env.api.start();
  await flush();
  const call = env.fetchCalls[0];
  assert.equal(call.url, '/api/ads/tag-config');
  assert.equal(call.init.credentials, 'omit');
  assert.equal(call.init.cache, 'no-store');
});

// ---------------------------------------------------------
// 2. 同意の案内
// ---------------------------------------------------------

test('未選択なら案内を出し、選ぶまで Google のタグを読み込まない', async () => {
  const env = createEnv({ page: 'lp' });
  await env.api.start();
  await flush();
  const banner = env.banner();
  assert.ok(banner, '案内が出ていない');
  assertNoGoogle(env, '選ぶ前');
  assert.equal(env.win.localStorage.map.has('sukima_ads_consent'), false);
});

test('「許可する」「許可しない」は同じ見た目・同じ要素で並ぶ', async () => {
  const env = createEnv({ page: 'lp' });
  await env.api.start();
  await flush();
  const buttons = [];
  const walk = (n) => { if (n.tagName === 'BUTTON') buttons.push(n); (n.children || []).forEach(walk); };
  walk(env.banner());
  assert.deepEqual(buttons.map((b) => b.textContent), ['許可する', '許可しない']);
  assert.equal(buttons[0].className, buttons[1].className);
  assert.equal(buttons[0].type, 'button');
  assert.equal(buttons[1].type, 'button');
  assert.deepEqual(Object.keys(buttons[0].attributes), Object.keys(buttons[1].attributes));
});

test('案内に「利用やお支払いに影響しない」ことと設定ページへのリンクがある', async () => {
  const env = createEnv({ page: 'lp' });
  await env.api.start();
  await flush();
  const texts = [];
  let link = null;
  const walk = (n) => {
    if (n.textContent) texts.push(n.textContent);
    if (n.tagName === 'A') link = n;
    (n.children || []).forEach(walk);
  };
  walk(env.banner());
  const all = texts.join('');
  assert.match(all, /許可しなくても、スキマの利用やお支払いには影響しません/);
  assert.match(all, /許可した場合だけ読み込み/);
  assert.equal(link.href, '/privacy/ads-measurement');
});

test('「許可しない」を選ぶと保存し、Google のタグは読み込まない', async () => {
  const env = createEnv({ page: 'lp' });
  await env.api.start();
  await flush();
  env.document.getElementById('sukima-ads-consent');
  const deny = findButton(env, 'denied');
  deny.click();
  await flush();
  assert.equal(env.banner(), null);
  assert.equal(JSON.parse(env.win.localStorage.map.get('sukima_ads_consent')).choice, 'denied');
  assertNoGoogle(env);
});

test('「許可する」を選ぶと、パーソナライズを無効にしてタグを読み込む', async () => {
  const env = createEnv({ page: 'lp' });
  await env.api.start();
  await flush();
  findButton(env, 'granted').click();
  await flush();
  assert.equal(env.banner(), null);
  assert.equal(JSON.parse(env.win.localStorage.map.get('sukima_ads_consent')).choice, 'granted');

  const scripts = env.appendedScripts.filter((s) => /googletagmanager/.test(s.src || ''));
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].src, 'https://www.googletagmanager.com/gtag/js?id=AW-18481971668');
  assert.equal(scripts[0].async, true);

  const cmds = commands(env.win);
  assert.deepEqual(cmds[0], ['consent', 'default', {
    ad_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'denied', analytics_storage: 'denied',
  }]);
  assert.deepEqual(cmds[1], ['set', 'allow_ad_personalization_signals', false]);
  const config = cmds.find((c) => c[0] === 'config');
  assert.equal(config[1], 'AW-18481971668');
  assert.equal(config[2].allow_ad_personalization_signals, false);
  // 紹介ページでは読み込み時の page_view を送る（広告クリック情報の保存のため）。コンバージョンは送らない。
  assert.equal(config[2].send_page_view, true);
  assert.equal(cmds.some((c) => c[0] === 'event'), false);
  // 広告クリック ID を独自に扱う設定（url_passthrough 等）を入れていない。
  assert.equal(JSON.stringify(cmds).includes('url_passthrough'), false);
});

test('許可済みなら案内を出さずに読み込む', async () => {
  const env = createEnv({ page: 'lp', localStorage: storageWithConsent('granted') });
  await env.api.start();
  await flush();
  assert.equal(env.banner(), null);
  assert.equal(env.googleTraffic().scripts, 1);
});

test('壊れた設定値は未選択として扱う（読み込まず案内を出す）', async () => {
  const env = createEnv({
    page: 'lp',
    localStorage: makeStorage({ initial: { sukima_ads_consent: '{"v":2,"choice":"granted"}' } }),
  });
  await env.api.start();
  await flush();
  assertNoGoogle(env);
  assert.ok(env.banner());
});

test('案内を出している間に別タブで許可されたら、案内を消して読み込む', async () => {
  const env = createEnv({ page: 'lp' });
  await env.api.start();
  await flush();
  env.otherTabSet('sukima_ads_consent', consentValue('granted'));
  await flush();
  assert.equal(env.banner(), null);
  assert.equal(env.googleTraffic().scripts, 1);
});

test('案内を出している間に別タブで拒否されたら、案内を消す', async () => {
  const env = createEnv({ page: 'lp' });
  await env.api.start();
  await flush();
  env.otherTabSet('sukima_ads_consent', consentValue('denied'));
  await flush();
  assert.equal(env.banner(), null);
  assertNoGoogle(env);
});

function findButton(env, choice) {
  let hit = null;
  const walk = (n) => { if (!hit && n.getAttribute && n.getAttribute('data-choice') === choice) hit = n; (n.children || []).forEach(walk); };
  walk(env.banner());
  return hit;
}

// ---------------------------------------------------------
// 3. 撤回
// ---------------------------------------------------------

test('別タブで撤回されたら、同意を denied に更新し、_gcl_ Cookie を消し、以後は送らない', async () => {
  const env = createEnv({
    href: 'https://sukimacalendar.com/billing/success', page: 'success',
    localStorage: storageWithConsent('granted'), sessionStorage: checkoutStorage(),
    cookie: '_gcl_aw=GCL.1.abc; _gcl_au=1.1.2; __Host-sukima=keep',
    respond: respondWith({ status: 200, body: { state: 'pending' } }),
  });
  await env.api.start();
  await flush();
  assert.equal(env.googleTraffic().scripts, 1);
  assert.equal(env.pendingTimers().length, 1, '再問い合わせが予約されている');

  env.otherTabSet('sukima_ads_consent', consentValue('denied'));
  await flush();

  const cmds = commands(env.win);
  assert.deepEqual(cmds[cmds.length - 1], ['consent', 'update', {
    ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied',
  }]);
  assert.equal(/_gcl_/.test(env.cookie), false, 'Google 広告の Cookie が残っている');
  assert.match(env.cookie, /__Host-sukima=keep/, 'ログインの Cookie は消さない');
  assert.equal(env.pendingTimers().length, 0, '再問い合わせを止めていない');
  assert.equal(env.win.sessionStorage.map.has('sukima_ads_checkout'), false);

  // 撤回後に何をしても conversion は送らない。
  const before = env.fetchCalls.length;
  while (env.runNextTimer()) { /* 何も残っていないはず */ }
  await flush();
  assert.equal(env.fetchCalls.length, before);
  assert.equal(commands(env.win).some((c) => c[0] === 'event'), false);
});

test('別タブで設定が消された（未選択に戻った）場合も、読み込み済みなら撤回として扱う', async () => {
  const env = createEnv({ page: 'lp', localStorage: storageWithConsent('granted'), cookie: '_gcl_au=1.1.2' });
  await env.api.start();
  await flush();
  env.otherTabSet('sukima_ads_consent', null);
  await flush();
  assert.equal(/_gcl_/.test(env.cookie), false);
  assert.equal(commands(env.win).at(-1)[1], 'update');
});

test('サーバーの応答待ちの間に撤回されたら、eligible が返っても送らない', async () => {
  let release;
  const env = createEnv({
    href: 'https://sukimacalendar.com/billing/success', page: 'success',
    localStorage: storageWithConsent('granted'), sessionStorage: checkoutStorage(),
  });
  env.win.fetch = (u) => {
    env.fetchCalls.push({ url: u });
    if (u === '/api/ads/tag-config') {
      return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({ enabled: true, tag_id: 'AW-18481971668' }) });
    }
    return new Promise((resolve) => { release = () => resolve({ status: 200, ok: true, json: () => Promise.resolve(ELIGIBLE) }); });
  };
  await env.api.start();
  await flush();
  env.otherTabSet('sukima_ads_consent', consentValue('denied'));
  release();
  await flush();
  assert.equal(commands(env.win).some((c) => c[0] === 'event'), false);
});

// ---------------------------------------------------------
// 4. 決済完了ページのコンバージョン
// ---------------------------------------------------------

function successEnv(over = {}) {
  return createEnv({
    href: 'https://sukimacalendar.com/billing/success',
    page: 'success',
    localStorage: storageWithConsent('granted'),
    sessionStorage: checkoutStorage(),
    referrer: 'https://checkout.stripe.com/c/pay/cs_live_a1B2c3D4e5F6#secret',
    respond: respondWith({ status: 200, body: ELIGIBLE }),
    ...over,
  });
}

test('eligible なら conversion を 1 件送る（値・通貨・transaction_id はサーバーの値）', async () => {
  const env = successEnv();
  await env.api.start();
  await flush();
  const events = commands(env.win).filter((c) => c[0] === 'event');
  assert.equal(events.length, 1);
  const [, name, params] = events[0];
  assert.equal(name, 'conversion');
  assert.equal(params.send_to, ELIGIBLE.send_to);
  assert.equal(params.value, 300);
  assert.equal(params.currency, 'JPY');
  assert.equal(params.transaction_id, TXN);
  assert.equal(typeof params.event_callback, 'function');
});

test('決済完了ページの config は page_view を送らず、参照元はドメインだけにする', async () => {
  const env = successEnv();
  await env.api.start();
  await flush();
  const config = commands(env.win).find((c) => c[0] === 'config');
  assert.equal(config[2].send_page_view, false);
  assert.equal(config[2].page_referrer, 'https://checkout.stripe.com/');
});

test('session_id・認証情報は Google へ渡す命令（dataLayer）にも script の URL にも含まれない', async () => {
  const env = successEnv({ cookie: '__Host-sukima_session=secret-token' });
  await env.api.start();
  await flush();
  const dump = JSON.stringify(commands(env.win).map((c) => c.map((x) => (typeof x === 'function' ? 'fn' : x))));
  for (const s of [SESSION_ID, 'cs_live', 'secret-token', 'sukima_session', '#secret']) {
    assert.equal(dump.includes(s), false, s);
  }
  for (const sc of env.appendedScripts) {
    assert.equal(String(sc.src).includes('cs_'), false);
  }
});

test('計測 API へは session_id だけを送り、Cookie は同一オリジンのみ・キャッシュさせない', async () => {
  const env = successEnv();
  await env.api.start();
  await flush();
  const call = env.fetchCalls.find((c) => c.url === '/api/billing/conversion');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.credentials, 'same-origin');
  assert.equal(call.init.cache, 'no-store');
  assert.deepEqual(JSON.parse(call.init.body), { session_id: SESSION_ID });
});

test('event_callback で送信済みの印を付け、session_id を破棄する', async () => {
  const env = successEnv();
  await env.api.start();
  await flush();
  const params = commands(env.win).find((c) => c[0] === 'event')[2];
  assert.equal(env.win.sessionStorage.map.has('sukima_ads_checkout'), true, 'callback 前は残す');
  params.event_callback();
  params.event_callback(); // 2 回呼ばれても 1 回分
  assert.equal(env.win.localStorage.map.has('sukima_ads_sent:' + TXN), true);
  assert.equal(env.win.sessionStorage.map.has('sukima_ads_checkout'), false);
});

test('送信済みの印がある transaction_id は、同じ端末から再送しない', async () => {
  const ls = storageWithConsent('granted');
  ls.map.set('sukima_ads_sent:' + TXN, String(NOW));
  const env = successEnv({ localStorage: ls });
  await env.api.start();
  await flush();
  assert.equal(commands(env.win).some((c) => c[0] === 'event'), false);
  assert.equal(env.win.sessionStorage.map.has('sukima_ads_checkout'), false);
});

test('localStorage に印を書けなくても送信はする（重複は transaction_id で Google 側が除外）', async () => {
  const ls = storageWithConsent('granted');
  const env = successEnv({ localStorage: ls });
  await env.api.start();
  await flush();
  const params = commands(env.win).find((c) => c[0] === 'event')[2];
  ls.setItem = () => { throw new Error('QuotaExceeded'); };
  assert.doesNotThrow(() => params.event_callback());
});

test('pending の間は間隔を空けて問い合わせ、1 回の表示で最大 7 回で打ち切る', async () => {
  const env = successEnv({ respond: respondWith({ status: 200, body: { state: 'pending' } }) });
  await env.api.start();
  await flush();
  const delays = [];
  while (env.pendingTimers().length > 0) {
    delays.push(env.pendingTimers()[0].ms);
    env.runNextTimer();
    await flush();
  }
  const calls = env.fetchCalls.filter((c) => c.url === '/api/billing/conversion');
  assert.equal(calls.length, 7);
  assert.deepEqual(delays, [2000, 3000, 5000, 8000, 12000, 20000]);
  assert.equal(commands(env.win).some((c) => c[0] === 'event'), false);
  // 再読み込みで続きができるよう、回数を記録して残す。
  const saved = JSON.parse(env.win.sessionStorage.map.get('sukima_ads_checkout'));
  assert.equal(saved.attempts, 7);
});

test('再読み込みをまたいでも、問い合わせは合計 14 回まで', async () => {
  const ss = checkoutStorage({ attempts: 13 });
  const env = successEnv({ sessionStorage: ss, respond: respondWith({ status: 200, body: { state: 'pending' } }) });
  await env.api.start();
  await flush();
  while (env.pendingTimers().length > 0) { env.runNextTimer(); await flush(); }
  assert.equal(env.fetchCalls.filter((c) => c.url === '/api/billing/conversion').length, 1);
  assert.equal(ss.map.has('sukima_ads_checkout'), false, '上限に達したら破棄する');
});

test('5xx・通信失敗は再試行し、成功すれば送る', async () => {
  const env = successEnv({
    respond: respondWith((n) => (n === 0 ? new Error('offline') : n === 1 ? { status: 502, body: {} } : { status: 200, body: ELIGIBLE })),
  });
  await env.api.start();
  await flush();
  env.runNextTimer(); await flush();
  env.runNextTimer(); await flush();
  assert.equal(commands(env.win).filter((c) => c[0] === 'event').length, 1);
});

test('対象外・無効・4xx は再試行せず、session_id を破棄する', async () => {
  for (const r of [{ status: 200, body: { state: 'not_eligible' } }, { status: 200, body: { state: 'disabled' } },
                   { status: 401, body: { error: 'unauthenticated' } }, { status: 400, body: {} }]) {
    const env = successEnv({ respond: respondWith(r) });
    await env.api.start();
    await flush();
    assert.equal(env.pendingTimers().length, 0, JSON.stringify(r));
    assert.equal(env.win.sessionStorage.map.has('sukima_ads_checkout'), false);
    assert.equal(commands(env.win).some((c) => c[0] === 'event'), false);
  }
});

test('サーバーの値の形が不正なら送らない', async () => {
  for (const bad of [{ value: 0 }, { value: 1.5 }, { currency: 'USD' }, { transaction_id: 'cs_live_x' },
                     { send_to: 'AW-1/x y' }]) {
    const env = successEnv({ respond: respondWith({ status: 200, body: { ...ELIGIBLE, ...bad } }) });
    await env.api.start();
    await flush();
    assert.equal(commands(env.win).some((c) => c[0] === 'event'), false, JSON.stringify(bad));
  }
});

test('session_id が無い・期限切れ・改ざんされた期限なら問い合わせない', async () => {
  const cases = [
    makeStorage(),
    checkoutStorage({ exp: NOW - 1 }),
    checkoutStorage({ exp: NOW + 3600000 * 24 }),
    checkoutStorage({ sid: 'not-a-session' }),
    makeStorage({ initial: { sukima_ads_checkout: '{broken' } }),
  ];
  for (const ss of cases) {
    const env = successEnv({ sessionStorage: ss });
    await env.api.start();
    await flush();
    assert.equal(env.fetchCalls.filter((c) => c.url === '/api/billing/conversion').length, 0);
    assert.equal(ss.map.has('sukima_ads_checkout'), false);
  }
});

test('sessionStorage が使えなければ問い合わせない（例外も出さない）', async () => {
  const env = successEnv({ sessionStorage: makeStorage({ broken: true }) });
  await env.api.start();
  await flush();
  assert.equal(env.fetchCalls.filter((c) => c.url === '/api/billing/conversion').length, 0);
});

test('決済完了ページでも、許可前は計測 API にも Google にも問い合わせない', async () => {
  const env = successEnv({ localStorage: storageWithConsent(null) });
  await env.api.start();
  await flush();
  assert.deepEqual(env.fetchCalls.map((c) => c.url), ['/api/ads/tag-config']);
  assertNoGoogle(env);
  assert.ok(env.banner());
  // 「許可しない」を選ぶと session_id を破棄する。
  findButton(env, 'denied').click();
  assert.equal(env.win.sessionStorage.map.has('sukima_ads_checkout'), false);
  assertNoGoogle(env);
});

test('決済完了ページで許可を選んだら、その場で確認して送る', async () => {
  const env = successEnv({ localStorage: storageWithConsent(null) });
  await env.api.start();
  await flush();
  findButton(env, 'granted').click();
  await flush();
  assert.equal(commands(env.win).filter((c) => c[0] === 'event').length, 1);
});

// ---------------------------------------------------------
// 5. 設定ページ
// ---------------------------------------------------------

function settingsEnv(over = {}) {
  return createEnv({
    href: 'https://sukimacalendar.com/privacy/ads-measurement',
    page: 'settings',
    staticIds: ['adsConsentStatus', 'adsGrant', 'adsDeny', 'adsGpcNote', 'adsStorageNote'],
    ...over,
  });
}

test('設定ページ: 現在の設定を表示し、許可・拒否を保存できる。タグは読み込まない', async () => {
  const env = settingsEnv({ cookie: '_gcl_au=1.1.2' });
  await env.api.start();
  const status = env.document.getElementById('adsConsentStatus');
  assert.match(status.textContent, /まだ選択していません/);

  env.document.getElementById('adsGrant').click();
  assert.match(status.textContent, /許可しています/);
  assert.equal(JSON.parse(env.win.localStorage.map.get('sukima_ads_consent')).choice, 'granted');

  env.document.getElementById('adsDeny').click();
  assert.match(status.textContent, /許可していません/);
  assert.equal(/_gcl_/.test(env.cookie), false);

  assert.equal(env.fetchCalls.length, 0);
  assertNoGoogle(env);
});

test('設定ページ: 別タブでの変更が表示に反映される', async () => {
  const env = settingsEnv();
  await env.api.start();
  env.otherTabSet('sukima_ads_consent', consentValue('granted'));
  assert.match(env.document.getElementById('adsConsentStatus').textContent, /許可しています/);
});

test('設定ページ: GPC 有効・保存不可の注意を出す', async () => {
  const gpc = settingsEnv({ gpc: true });
  await gpc.api.start();
  assert.equal(gpc.document.getElementById('adsGpcNote').hidden, false);

  const broken = settingsEnv({ localStorage: makeStorage({ broken: true }) });
  await broken.api.start();
  assert.equal(broken.document.getElementById('adsStorageNote').hidden, false);
  assert.match(broken.document.getElementById('adsConsentStatus').textContent, /保存できません/);
});

// ---------------------------------------------------------
// 6. success.html の inline script（URL から session_id を外す）
// ---------------------------------------------------------

test('inline: session_id を sessionStorage へ 1 時間の期限つきで移し、URL から外す', () => {
  const { history, sessionStorage } = runSuccessInline({
    href: 'https://sukimacalendar.com/billing/success?session_id=' + SESSION_ID,
  });
  assert.deepEqual(history.calls, ['/billing/success']);
  const saved = JSON.parse(sessionStorage.map.get('sukima_ads_checkout'));
  assert.deepEqual(saved, { sid: SESSION_ID, exp: NOW + 3600000, attempts: 0 });
});

test('inline: 形の不正な session_id は保存しないが、URL からは外す', () => {
  const { history, sessionStorage } = runSuccessInline({
    href: 'https://sukimacalendar.com/billing/success?session_id=%3Cscript%3E',
  });
  assert.deepEqual(history.calls, ['/billing/success']);
  assert.equal(sessionStorage.map.size, 0);
});

test('inline: sessionStorage が使えなくても URL からは外す', () => {
  const { history } = runSuccessInline({
    href: 'https://sukimacalendar.com/billing/success?session_id=' + SESSION_ID,
    sessionStorage: makeStorage({ broken: true }),
  });
  assert.deepEqual(history.calls, ['/billing/success']);
});

test('inline: session_id が無ければ何もしない', () => {
  const { history, sessionStorage } = runSuccessInline({ href: 'https://sukimacalendar.com/billing/success' });
  assert.deepEqual(history.calls, []);
  assert.equal(sessionStorage.map.size, 0);
});

// ---------------------------------------------------------
// 7. タグを置くページの範囲（静的な確認）
// ---------------------------------------------------------

import fs from 'node:fs';

const read = (rel) => fs.readFileSync(new URL('../../' + rel, import.meta.url), 'utf8');

test('計測スクリプトを読み込むのは紹介ページ・決済完了ページ・設定ページだけ', () => {
  assert.match(read('public/about/index.html'),
    /<script src="\/assets\/ads-measurement\.js" data-page="lp" defer><\/script>/);
  assert.match(read('public/billing/success.html'),
    /<script src="\/assets\/ads-measurement\.js" data-page="success" defer><\/script>/);
  assert.match(read('public/privacy/ads-measurement.html'),
    /<script src="\/assets\/ads-measurement\.js" data-page="settings" defer><\/script>/);
  for (const rel of ['public/index.html', 'public/app.html', 'public/pricing.html', 'public/privacy.html',
                     'public/billing/cancel.html', 'public/terms.html', 'public/sw.js', 'index.html']) {
    const html = read(rel);
    assert.equal(html.includes('ads-measurement.js'), false, rel);
    assert.equal(html.includes('googletagmanager'), false, rel);
    assert.equal(html.includes('AW-18481971668'), false, rel);
  }
});

test('計測スクリプト自体は Google タグ ID・送信先を持たない（サーバーの応答からだけ得る）', () => {
  const raw = read('public/assets/ads-measurement.js');
  // コメント（説明文）を除いたコードだけを見る。
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(raw.includes('18481971668'), false);
  assert.equal(src.includes('VxGaCNKJ26AdENSD8uxE'), false);
  // 広告クリック ID を独自に読む・保存するコードが無い
  for (const word of ['gclid', 'gbraid', 'wbraid', 'url_passthrough', 'location.search']) {
    assert.equal(src.includes(word), false, word);
  }
});

test('紹介ページのフッターに広告の効果測定の設定へのリンクがある', () => {
  assert.match(read('public/about/index.html'),
    /<li><a href="\/privacy\/ads-measurement">広告の効果測定の設定<\/a><\/li>/);
});

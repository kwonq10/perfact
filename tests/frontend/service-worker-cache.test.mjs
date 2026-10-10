import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const SOURCE = fs.readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8');
const ORIGIN = 'https://sukimacalendar.com';
const CURRENT_CACHE = 'sukima-1.4.1';

// 実SWを実行し、Cache APIとnetworkの境界を観測する。実通信・ブラウザstorageは使わない。
function worker() {
  const listeners = new Map();
  const stores = new Map();
  const cacheCalls = [];
  const networkCalls = [];
  const networkOptions = [];
  let networkBody = 'network';
  let offline = false;
  let claims = 0;
  let skips = 0;
  function store(name) {
    if (!stores.has(name)) stores.set(name, new Map());
    const entries = stores.get(name);
    return {
      async keys() { cacheCalls.push('keys'); return [...entries.values()].map((x) => x.request); },
      async put(request, response) {
        cacheCalls.push('put');
        entries.set(request.url, { request, response: response.clone() });
      },
      async match(request) {
        cacheCalls.push('match');
        const entry = entries.get(typeof request === 'string' ? new URL(request, ORIGIN).href : request.url);
        if (!entry) return undefined;
        const vary = entry.response.headers.get('vary');
        if (vary && vary.split(',').some((name) =>
          entry.request.headers.get(name.trim()) !== request.headers.get(name.trim()))) return undefined;
        return entry.response.clone();
      },
      async delete(request) { cacheCalls.push('delete'); return entries.delete(request.url); },
      async addAll(paths) {
        for (const path of paths) await this.put(request(path), new Response('static'));
      },
    };
  }
  const caches = {
    async keys() { cacheCalls.push('cacheNames'); return [...stores.keys()]; },
    async open(name) { cacheCalls.push('open'); return store(name); },
    async delete(name) { cacheCalls.push('deleteCache'); return stores.delete(name); },
    async match(req) {
      for (const name of stores.keys()) {
        const response = await store(name).match(req);
        if (response) return response;
      }
    },
  };
  const fetch = async (req, init) => {
    networkCalls.push(req);
    networkOptions.push(init);
    if (offline) throw new TypeError('offline');
    return new Response(networkBody, {
      headers: { 'Cache-Control': 'no-store', Vary: 'Cookie' },
    });
  };
  const self = {
    location: { origin: ORIGIN },
    addEventListener(type, callback) { listeners.set(type, callback); },
    clients: { async claim() { claims += 1; } },
    skipWaiting() { skips += 1; },
  };
  vm.runInNewContext(SOURCE, { self, caches, fetch, URL }, { filename: 'public/sw.js' });
  return {
    stores, cacheCalls, networkCalls, networkOptions,
    get claims() { return claims; },
    get skips() { return skips; },
    body(value) { networkBody = value; },
    offline() { offline = true; },
    async seed(path, body, name = CURRENT_CACHE) {
      await store(name).put(request(path), new Response(body, {
        headers: { 'Cache-Control': 'no-store', Vary: 'Cookie' },
      }));
    },
    async read(path, options) {
      const req = request(path, options);
      let response;
      listeners.get('fetch')({ request: req, respondWith(value) { response = value; } });
      const result = await (response === undefined ? fetch(req) : response);
      await new Promise((resolve) => setImmediate(resolve));
      return result.text();
    },
    async activate() {
      let done;
      listeners.get('activate')({ waitUntil(promise) { done = promise; } });
      await done;
    },
  };
}

function request(path, { navigation = false, method = 'GET', accept } = {}) {
  const req = new Request(new URL(path, ORIGIN), {
    method, headers: { Accept: accept || (navigation ? 'text/html' : 'application/json') },
  });
  if (navigation) Object.defineProperty(req, 'mode', { value: 'navigate' });
  return req;
}

for (const path of ['/api/auth/me', '/api/auth/session', '/api/billing/checkout',
                    '/api/billing/portal', '/api/quota/status', '/api/other?value=1', '/api']) {
  for (const navigation of [false, true]) {
    test(`${path}: ${navigation ? 'navigation' : '通常fetch'}でもCache APIに保存・参照しない`, async () => {
      const sw = worker();
      assert.equal(await sw.read(path, { navigation }), 'network');
      assert.equal(sw.networkCalls.length, 1);
      assert.equal(sw.networkOptions[0].cache, 'no-store');
      assert.deepEqual(sw.cacheCalls, []);
      assert.equal(sw.stores.size, 0);
    });
  }
}

test('billing POSTもService WorkerのCache APIを経由しない', async () => {
  const sw = worker();
  await sw.read('/api/billing/checkout', { method: 'POST' });
  assert.deepEqual(sw.cacheCalls, []);
  assert.equal(sw.networkCalls[0].method, 'POST');
});

for (const [oldState, latestState] of [['free', 'web_pro'], ['web_pro', 'free']]) {
  test(`${oldState} → ${latestState}: 保存済みAPIを無視し最新network応答を返す`, async () => {
    const sw = worker();
    await sw.seed('/api/auth/me', oldState);
    sw.cacheCalls.length = 0;
    sw.body(latestState);
    assert.equal(await sw.read('/api/auth/me'), latestState);
    assert.equal(sw.networkCalls.length, 1);
    assert.deepEqual(sw.cacheCalls, []);
  });
}

for (const oldState of ['free', 'web_pro']) {
  for (const navigation of [false, true]) {
    test(`offline: ${oldState}の古いAPI応答もHTML fallbackも返さない (${navigation})`, async () => {
      const sw = worker();
      await sw.seed('/api/auth/me', oldState);
      await sw.seed('/index.html', 'offline shell');
      sw.cacheCalls.length = 0;
      sw.offline();
      await assert.rejects(sw.read('/api/auth/me', { navigation }), /offline/);
      assert.deepEqual(sw.cacheCalls, []);
    });
  }
}

test('activate: 同じ版に残るAPIだけ除去し現在の静的アセットを維持する', async () => {
  const sw = worker();
  for (const path of ['/api/auth/me', '/api/billing/status?check=1', '/api/other', '/api']) {
    await sw.seed(path, 'old API');
  }
  for (const path of ['/', '/index.html', '/icon-192.png', '/apiary/logo.svg']) {
    await sw.seed(path, 'static');
  }
  await sw.seed('/index.html', 'old version', 'sukima-1.3.0');
  await sw.activate();
  assert.deepEqual([...sw.stores.get(CURRENT_CACHE).keys()].sort(),
    ['/', '/index.html', '/icon-192.png', '/apiary/logo.svg'].map((path) => ORIGIN + path).sort());
  assert.equal(sw.stores.has('sukima-1.3.0'), false, '既存の旧版cache整理は維持');
  assert.equal(sw.claims, 1);
  assert.equal(sw.skips, 0, '自動skipWaiting・reloadを追加しない');
});

test('静的navigationは従来どおり保存されofflineでも利用できる', async () => {
  const sw = worker();
  sw.body('page shell');
  assert.equal(await sw.read('/', { navigation: true }), 'page shell');
  assert.ok(sw.stores.get(CURRENT_CACHE).has(ORIGIN + '/'));
  sw.offline();
  assert.equal(await sw.read('/', { navigation: true }), 'page shell');
});

test('静的アセットは従来どおりcache-firstで利用できる', async () => {
  const sw = worker();
  await sw.seed('/icon-192.png', 'icon');
  sw.offline();
  assert.equal(await sw.read('/icon-192.png'), 'icon');
  assert.equal(sw.networkCalls.length, 0);
});

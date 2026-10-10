const APP_VERSION = '1.4.1';
const CACHE_NAME = `sukima-${APP_VERSION}`;
const ASSETS = ['/', '/index.html', '/manifest.json', '/icon-192.png', '/icon-512.png'];

// Service Worker のキャッシュ処理から常に除外するパス。
// 更新判定に使う情報なので、必ずネットワークの最新値を取得させる。
const BYPASS_PATHS = ['/latest-version.json', '/app', '/sw.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(ASSETS)));
  // ここで skipWaiting() は呼ばない。
  // 新しい Service Worker は waiting に留まり、ページから SKIP_WAITING を
  // 受け取ったときだけ activate へ進む。更新のタイミングを利用者に委ねるため。
});

function isApiPath(pathname) {
  return pathname === '/api' || pathname.startsWith('/api/');
}

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));

    // 同じ版のcacheにもAPI応答が残り得る。静的アセットは残してAPIだけ除去する。
    const cache = await caches.open(CACHE_NAME);
    const requests = await cache.keys();
    await Promise.all(requests.filter((request) => {
      const url = new URL(request.url);
      return url.origin === self.location.origin && isApiPath(url.pathname);
    }).map((request) => cache.delete(request)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => {
  const type = e.data && e.data.type;

  // ページが「アップデート」を選んだときだけ waiting から activate へ進む
  if (type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  // 現在動作している Service Worker のバージョンを MessageChannel で返す
  if (type === 'GET_VERSION') {
    const port = e.ports && e.ports[0];
    if (port) port.postMessage({ version: APP_VERSION });
  }
});

self.addEventListener('fetch', (e) => {
  const request = e.request;

  // 除外パスは respondWith せず、ブラウザの通常フェッチに委ねる
  let url;
  try {
    url = new URL(request.url);
  } catch (err) {
    return;
  }
  // APIはnavigationを含め、保存・参照・offline fallbackのすべてから除外する。
  // 認証・契約・権限の正は常にサーバー。通信失敗時も古いAPI応答を返さない。
  if (url.origin === self.location.origin && isApiPath(url.pathname)) {
    e.respondWith(fetch(request, { cache: 'no-store' }));
    return;
  }
  if (url.origin === self.location.origin && BYPASS_PATHS.includes(url.pathname)) {
    return;
  }

  const acceptsHtml = request.headers.get('accept')?.includes('text/html');

  if (request.mode === 'navigate' || acceptsHtml) {
    e.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached || caches.match('/index.html')))
    );
    return;
  }

  e.respondWith(caches.match(request).then((cached) => cached || fetch(request)));
});

// オフラインでも起動できるようにする簡単なサービスワーカー
// 方針: まずネットワークから取得し、取れたらキャッシュを更新。オフライン時はキャッシュを使う。
// パスはこのファイルの場所からの相対(GitHub Pages のサブフォルダーでも動くように)
const CACHE = "mieru-editor-v1";
const APP_ROOT = new URL("./", self.location).href;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(["./", "./manifest.webmanifest", "./icon.svg"])));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match(APP_ROOT)))
  );
});

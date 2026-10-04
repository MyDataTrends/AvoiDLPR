// FlockWatch service worker. The build (vite.config.ts) fills in VERSION and SHELL; this file is
// served as /sw.js and is never bundled.
//
// What is cached, and why:
//   app shell      precached per build, cache-first: the app opens instantly and offline.
//   road packs     cache-first once fetched: 19 MB, content-hashed so a name never changes
//                  meaning. Older versions of the same region are dropped.
//   fonts/sprites  cache-first: immutable.
//   regions.json   network-first with a cached fallback: it says which pack is current.
//   camera feeds   network-first with a cached fallback: they change hourly.
// Map tiles are range requests into one big file; those are never touched, so the browser and
// PMTiles handle them. (Offline tiles would be a separate, opt-in download.)
//
// Cache lookups pass `ignoreVary`: a host that answers with `Vary: Origin` (Vite's preview server
// does) would otherwise make a script request, which carries an Origin header, miss the copy
// that was precached without one, and the app would fail to start offline.

const VERSION = "__VERSION__";
const SHELL_CACHE = `fw-shell-${VERSION}`;
const DATA_CACHE = "fw-data-v1";
const SHELL = __SHELL__;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith("fw-shell-") && key !== SHELL_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data === "skipWaiting") self.skipWaiting();
});

const isPack = (url) => /\/packs\/[^/]+\.fwr$/.test(url.pathname);
const isStaticAsset = (url) => /\/basemap\/assets\//.test(url.pathname);
const isMutableData = (url) => /\/(cameras\/[^/]+\.json|regions\.json)$/.test(url.pathname);

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || request.headers.has("range")) return;
  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    if (request.mode === "navigate") {
      // The page is precached as "/" (not "/index.html": static hosts redirect that to "/", and a
      // redirected response can't answer a navigation). Query strings don't change the page.
      event.respondWith(caches.match("/", { cacheName: SHELL_CACHE, ignoreVary: true }).then((hit) => hit || fetch(request)));
      return;
    }
    if (SHELL.includes(url.pathname)) {
      event.respondWith(caches.match(request, { cacheName: SHELL_CACHE, ignoreVary: true }).then((hit) => hit || fetch(request)));
      return;
    }
  }

  if (isPack(url) || isStaticAsset(url)) {
    event.respondWith(cacheFirst(event, request, isPack(url) ? url : null));
  } else if (isMutableData(url)) {
    event.respondWith(networkFirst(event, request));
  }
});

async function cacheFirst(event, request, packUrl) {
  const cache = await caches.open(DATA_CACHE);
  const hit = await cache.match(request, { ignoreVary: true });
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) {
    event.waitUntil((async () => {
      await cache.put(request, response.clone());
      if (packUrl) await dropOtherVersions(cache, packUrl);
    })());
  }
  return response;
}

/** Keep one pack per region: the content-hashed name is <region>.<hash>.fwr. */
async function dropOtherVersions(cache, packUrl) {
  const region = packUrl.pathname.split("/").pop().split(".")[0];
  for (const key of await cache.keys()) {
    const u = new URL(key.url);
    if (isPack(u) && u.pathname !== packUrl.pathname && u.pathname.split("/").pop().split(".")[0] === region) {
      await cache.delete(key);
    }
  }
}

async function networkFirst(event, request) {
  const cache = await caches.open(DATA_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) event.waitUntil(cache.put(request, response.clone()));
    return response;
  } catch (err) {
    const hit = await cache.match(request, { ignoreVary: true });
    if (hit) return hit;
    throw err;
  }
}

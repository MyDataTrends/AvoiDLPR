// AvoiDLPR service worker. The build (vite.config.ts) fills in VERSION and SHELL; this file is
// served as /sw.js and is never bundled.
//
// What is cached, and why:
//   app shell      precached per build, cache-first: the app opens instantly and offline.
//   road packs     cache-first once fetched: a few MB each, content-hashed so a name never
//   and search     changes meaning. When the page says a new one loaded ("pack-ok": it matched
//   indexes        its checksum and decoded), older versions of that area are dropped, and only
//                  the last few areas are kept. Until then the old one stays, as the fallback.
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
  if (event.data?.type === "pack-ok" && typeof event.data.url === "string") {
    const url = new URL(event.data.url);
    if (isAreaFile(url)) event.waitUntil(caches.open(DATA_CACHE).then((cache) => dropOtherVersions(cache, url)));
  }
  // A file that failed its checksum or didn't decode: drop the copy, so the next try downloads it.
  if (event.data?.type === "pack-bad" && typeof event.data.url === "string") {
    const url = new URL(event.data.url);
    if (isAreaFile(url)) event.waitUntil(caches.open(DATA_CACHE).then((cache) => cache.delete(url.href, { ignoreVary: true })));
  }
});

/** An area's road pack (packs/<area>.<hash>.fwr.gz) or search index (places/<area>.<hash>.fwp.gz). */
const isAreaFile = (url) => /\/(packs\/[^/]+\.fwr|places\/[^/]+\.fwp)(\.gz)?$/.test(url.pathname);
/** How many areas' road packs and search indexes to keep for offline use. */
const MAX_PACKS = 4;
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

  if (isAreaFile(url) || isStaticAsset(url)) {
    event.respondWith(cacheFirst(event, request));
  } else if (isMutableData(url)) {
    event.respondWith(networkFirst(event, request));
  }
});

async function cacheFirst(event, request) {
  const cache = await caches.open(DATA_CACHE);
  const hit = await cache.match(request, { ignoreVary: true });
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) event.waitUntil(cache.put(request, response.clone()));
  return response;
}

/**
 * Keep one file of each kind per area (packs/<area>.<hash>.fwr.gz, places/<area>.<hash>.fwp.gz),
 * and only the MAX_PACKS areas cached most recently: the cache lists keys oldest first.
 */
async function dropOtherVersions(cache, fileUrl) {
  const area = (u) => u.pathname.split("/").pop().split(".")[0];
  const kind = (u) => u.pathname.split("/").slice(-2, -1)[0];
  const files = (await cache.keys()).filter((key) => {
    const u = new URL(key.url);
    return isAreaFile(u) && kind(u) === kind(fileUrl);
  });
  const others = files.filter((key) => new URL(key.url).pathname !== fileUrl.pathname);
  for (const key of others.filter((k) => area(new URL(k.url)) === area(fileUrl))) await cache.delete(key);
  const rest = others.filter((k) => area(new URL(k.url)) !== area(fileUrl));
  for (const key of rest.slice(0, Math.max(0, rest.length - (MAX_PACKS - 1)))) await cache.delete(key);
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

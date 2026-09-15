/* allday service worker.

   One job: make the shell open when the network is gone, without ever serving a
   stale build when it isn't. The owner's standing question is "did my deploy
   land?" and a worker that caches index.html forever would turn every deploy
   into a mystery. So:

     index.html            network first, 3s, then the last copy we saw
     React / ReactDOM /    cache first — versioned URLs that never change
       Tailwind
     Google Fonts          whatever's cached, refreshed in the background
     /.netlify/functions   never touched — the app has its own offline story
                           (localStorage + the "not syncing" banner)

   VERSION matches APP_VERSION in index.html. Bump both on a release: the byte
   change is what makes browsers install the new worker and show the reload
   toast. Forgetting to bump costs only the toast — index.html is network-first
   regardless, so an online open always gets the current build. */
const VERSION = "v4";
const CACHE = "allday-" + VERSION;
const NET_TIMEOUT_MS = 3000;
const SHELL = "/";
const CDN = [
  "https://unpkg.com/react@18/umd/react.production.min.js",
  "https://unpkg.com/react-dom@18/umd/react-dom.production.min.js",
  "https://cdn.tailwindcss.com"
];

const isCdn = (url) => url.hostname === "unpkg.com" || url.hostname === "cdn.tailwindcss.com";
const isFont = (url) => url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";
const isFunction = (url) => url.origin === self.location.origin && url.pathname.indexOf("/.netlify/") === 0;
const isShell = (url) => url.origin === self.location.origin && (url.pathname === "/" || url.pathname === "/index.html");

// Store a URL in the cache - only from a CORS fetch, whose status can be seen.
// An opaque (no-cors) response might be a 503 page from the CDN's edge, and a
// 503 stored as react.production.min.js is served on every open until the next
// deploy. So a host that won't answer CORS is simply not precached; the runtime
// handler serves it straight from the network instead. Never throws - one
// asset failing must not fail the install.
async function precache(cache, url) {
  let r;
  try { r = await fetch(url, { cache: "no-cache" }); } catch (e) { return false; }
  if (!r || !r.ok) return false;
  try { await cache.put(url, r); return true; } catch (e) { return false; }
}

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(CDN.concat([SHELL]).map((u) => precache(cache, u)));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.indexOf("allday-") === 0 && n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
    // Tell open pages a new build is installed. The page decides whether that
    // deserves a toast (it doesn't on the very first install).
    const cs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    cs.forEach((c) => { try { c.postMessage({ type: "allday-updated", version: VERSION }); } catch (err) {} });
  })());
});

// The shell: try the network, briefly. Online you always get the current build
// and the cache is refreshed behind you; offline you get the last one. The race
// is against the response's headers, not its body - a slow link must not hand
// back the old build while the new one is still downloading - and the cache
// write happens in the background, tied to the event so the worker isn't shut
// down before it lands. A 5xx from the origin counts as "no answer" when there
// is a cached copy. A slow first-ever load keeps waiting for the network
// rather than failing, and a failed first-ever load fails the way the browser
// does today, not with a blank cached page.
async function shell(req, event) {
  const cache = await caches.open(CACHE);
  const net = fetch(req);
  net.catch(() => {});
  const store = net.then((r) => {
    if (r && r.status === 200 && r.type === "basic") return cache.put(SHELL, r.clone());
  }).catch(() => {});
  if (event && event.waitUntil) event.waitUntil(store);
  const timer = new Promise((resolve) => setTimeout(() => resolve("timeout"), NET_TIMEOUT_MS));
  try {
    const r = await Promise.race([net, timer]);
    if (r !== "timeout" && r.status < 500) return r;
    const cached = await cache.match(SHELL);
    return cached || (r === "timeout" ? net : r);
  } catch (e) {
    const cached = await cache.match(SHELL);
    if (cached) return cached;
    throw e;
  }
}

// A CORS fetch first so the status is visible: only an OK response is stored.
// If the host won't answer CORS, the plain (opaque) response is served to the
// page but never kept - it could be an error page wearing status 0.
async function fetchVisible(req) {
  try {
    const r = await fetch(req.url, { cache: "no-cache" });
    return { r, visible: true };
  } catch (e) {
    return { r: await fetch(req), visible: false };
  }
}
async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req, { ignoreVary: true });
  if (hit) return hit;
  const { r, visible } = await fetchVisible(req);
  if (visible && r && r.ok) { try { await cache.put(req.url, r.clone()); } catch (e) {} }
  return r;
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req, { ignoreVary: true });
  const refresh = fetchVisible(req).then(({ r, visible }) => {
    if (visible && r && r.ok) cache.put(req.url, r.clone()).catch(() => {});
    return r;
  }).catch(() => null);
  if (hit) return hit;
  const r = await refresh;
  return r || Response.error();
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (isFunction(url)) return;
  if (req.mode === "navigate") {
    if (isShell(url)) e.respondWith(shell(req, e));
    return;
  }
  if (isCdn(url)) { e.respondWith(cacheFirst(req)); return; }
  if (isFont(url)) { e.respondWith(staleWhileRevalidate(req)); return; }
});

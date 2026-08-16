/* ==========================================================================
   Menhirs de Bretagne — service worker
   --------------------------------------------------------------------------
   IMPORTANT — à faire à CHAQUE mise en ligne : incrémenter APP_VERSION
   ci-dessous. C'est ce qui déclenche le renouvellement du cache chez les
   personnes qui ont déjà installé l'application. Sans cela, elles gardent
   indéfiniment la version qu'elles ont installée la première fois.

   Trois caches distincts, et c'est volontaire :
     - SHELL : l'application elle-même. Versionné, purgé à chaque nouvelle
       version.
     - TUILES : les fonds de carte OpenStreetMap téléchargés au fil des
       balades. NON versionné — il survit aux mises à jour, sinon chaque
       publication effacerait les cartes hors-ligne des utilisateurs.
     - MEDIA : les photos Wikimedia Commons des fiches. Non versionné lui
       aussi, pour la même raison.
   ========================================================================== */

const APP_VERSION = "2026-08-16-ah";

const SHELL_CACHE = `menhirs-shell-${APP_VERSION}`;
const TILE_CACHE  = "menhirs-tuiles";
const MEDIA_CACHE = "menhirs-photos";

/* Plafonds : au-delà, les entrées les plus anciennes sont supprimées.
   Sans cela, le cache grossit sans fin au fil des balades et finit par
   se faire vider d'autorité par le navigateur — en emportant l'app shell. */
const MAX_TILES = 1200;
const MAX_MEDIA = 400;

const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-512-maskable.png",
  "./apple-touch-icon.png",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.css",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js"
];

/* --------------------------------------------------------------------------
   Installation : on met l'app shell en cache, ressource par ressource.
   Volontairement pas de cache.addAll() : addAll est atomique, une seule URL
   en échec (CDN momentanément injoignable, par exemple) et RIEN n'est mis en
   cache. Ici chaque ressource est indépendante.
   -------------------------------------------------------------------------- */
self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await Promise.all(APP_SHELL.map(async (url) => {
      try {
        // cache:"reload" force le passage par le réseau : sans cela, le cache
        // HTTP du navigateur pourrait resservir l'ancien index.html et la
        // nouvelle version serait installée... avec l'ancien contenu.
        const res = await fetch(new Request(url, { cache: "reload" }));
        if (res && (res.ok || res.type === "opaque")) await cache.put(url, res);
      } catch (e) { /* ressource indisponible : on continue sans elle */ }
    }));
    self.skipWaiting();
  })());
});

/* --------------------------------------------------------------------------
   Activation : on ne supprime que les anciens app shells. Les tuiles de carte
   et les photos déjà téléchargées sont conservées.
   -------------------------------------------------------------------------- */
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k.startsWith("menhirs-shell-") && k !== SHELL_CACHE)
        .map((k) => caches.delete(k))
    );
    // Nettoyage du cache unique de l'ancienne version du service worker.
    if (keys.includes("menhirs-bretagne-v1")) await caches.delete("menhirs-bretagne-v1");
    await self.clients.claim();
  })());
});

/* Permet à la page de demander l'activation immédiate d'une mise à jour. */
self.addEventListener("message", (event) => {
  if (event.data === "skipWaiting") self.skipWaiting();
});

/* -------------------------------------------------------------------------- */

async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  // keys() rend les entrées dans leur ordre d'insertion : les premières sont
  // les plus anciennes.
  await Promise.all(keys.slice(0, keys.length - maxEntries).map((k) => cache.delete(k)));
}

/* Réseau d'abord, cache en secours. Utilisé pour l'application elle-même :
   c'est ce qui garantit qu'une mise à jour publiée arrive tout de suite chez
   quelqu'un qui a du réseau, tout en gardant l'appli utilisable hors-ligne. */
async function networkFirst(req, cacheName, fallbackUrl) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    const cached = (await cache.match(req)) || (fallbackUrl && await cache.match(fallbackUrl));
    if (cached) return cached;
    throw e;
  }
}

/* Cache d'abord, réseau en secours, avec remplissage du cache au passage.
   Utilisé pour les tuiles et les photos : leur contenu ne change pas, et on
   veut économiser les données mobiles. */
async function cacheFirst(req, cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  // Les réponses cross-origin sans CORS sont "opaques" (status 0) : on les
  // garde quand même, c'est la seule façon d'avoir les photos hors-ligne.
  if (res && (res.ok || res.type === "opaque")) {
    await cache.put(req, res.clone());
    trimCache(cacheName, maxEntries);
  }
  return res;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return;

  // 1. Navigation (ouverture de l'appli) → réseau d'abord.
  if (req.mode === "navigate") {
    event.respondWith(networkFirst(req, SHELL_CACHE, "./index.html"));
    return;
  }

  // 2. Tuiles OpenStreetMap → cache d'abord, cache persistant plafonné.
  if (url.hostname.endsWith("tile.openstreetmap.org")) {
    event.respondWith(
      cacheFirst(req, TILE_CACHE, MAX_TILES).catch(() => caches.match(req))
    );
    return;
  }

  // 3. Photos Wikimedia Commons → cache d'abord, cache persistant plafonné.
  if (url.hostname.endsWith("wikimedia.org")) {
    event.respondWith(
      cacheFirst(req, MEDIA_CACHE, MAX_MEDIA).catch(() => caches.match(req))
    );
    return;
  }

  // 4. Le document de l'application → réseau d'abord (même raison qu'en 1,
  //    pour les rechargements qui ne passent pas par une navigation).
  if (url.origin === self.location.origin && /\/(index\.html)?$/.test(url.pathname)) {
    event.respondWith(networkFirst(req, SHELL_CACHE, "./index.html"));
    return;
  }

  // 5. Le reste de l'app shell (icônes, manifeste, Leaflet) → cache d'abord,
  //    revalidation en arrière-plan. Le cache étant versionné, une mise à jour
  //    de ces fichiers arrive avec la nouvelle version.
  event.respondWith((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const cached = await cache.match(req);
    const network = fetch(req)
      .then((res) => {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      })
      .catch(() => null);
    return cached || (await network) || new Response("", { status: 504, statusText: "Hors ligne" });
  })());
});

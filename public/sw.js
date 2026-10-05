const CACHE = "jam-shell-v10";
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      const response = await fetch("/", { cache: "reload" });
      if (!response.ok) throw new Error("Application shell unavailable");
      const html = await response.clone().text();
      // On the first visit JS/CSS load before this worker controls the page.
      // Precache the hashed production assets so reopening offline also works then.
      const assets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
        .map((m) => m[1])
        .filter((path) => path.startsWith("/assets/"));
      await cache.addAll(
        [
          ...new Set([
            ...assets,
            "/icon.svg",
            "/icon-192.png",
            "/icon-512.png",
            "/manifest.webmanifest",
          ]),
        ].map((path) => new Request(path, { cache: "reload" })),
      );
      await cache.put("/", response);
      await self.skipWaiting();
    })(),
  );
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      caches
        .keys()
        .then((keys) =>
          Promise.all(
            keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
          ),
        ),
      self.clients.claim(),
    ]),
  );
});
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin)
    return;
  // Never cache API data, identities, or cross-origin Supabase responses.
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            event.waitUntil(caches.open(CACHE).then((c) => c.put("/", copy)));
          }
          return response;
        })
        .catch(() => caches.match("/")),
    );
  } else if (
    url.pathname.startsWith("/assets/") ||
    [
      "/icon.svg",
      "/icon-192.png",
      "/icon-512.png",
      "/manifest.webmanifest",
    ].includes(url.pathname)
  ) {
    // Only public, same-origin static files: ignore Vary: Origin from preview/CDN servers.
    event.respondWith(
      caches.match(event.request, { ignoreVary: true }).then(
        (hit) =>
          hit ||
          fetch(event.request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              event.waitUntil(
                caches.open(CACHE).then((c) => c.put(event.request, copy)),
              );
            }
            return response;
          }),
      ),
    );
  }
});
self.addEventListener("push", (event) => {
  let data = {
    title: "Jam",
    body: "Une nouvelle activité vous attend.",
    id: "jam",
  };
  try {
    Object.assign(data, event.data.json());
  } catch {
    /* valid fallback notification */
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      tag: data.id,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: "/" },
    }),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then(async (windows) => {
        const existing = windows.find(
          (w) => new URL(w.url).origin === self.location.origin,
        );
        if (existing) {
          await existing.focus();
          existing.postMessage({ type: "refresh" });
        } else await clients.openWindow("/");
      }),
  );
});

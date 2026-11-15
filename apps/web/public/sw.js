const ASSET_CACHE = "cox-assets-v1";
const HASHED_ASSET = /^\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.(?:js|css|wasm|woff2|png|svg)$/;

function safeThreadPath(value) {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\u0000-\u0020\u007f]/.test(value)
  ) {
    return null;
  }
  const target = new URL(value, self.location.origin);
  if (target.origin !== self.location.origin || target.pathname.startsWith("/settings/")) {
    return null;
  }
  const segments = target.pathname.split("/");
  if (segments.length !== 3 || segments[0] !== "") return null;
  for (const segment of segments.slice(1)) {
    if (!segment || segment === "." || segment === ".." || segment.length > 256) return null;
    try {
      if (/[/\\\u0000-\u0020\u007f]/.test(decodeURIComponent(segment))) return null;
    } catch {
      return null;
    }
  }
  return `${target.pathname}${target.search}${target.hash}`;
}

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then(async (names) => {
      await Promise.all(
        names.filter((name) => name !== ASSET_CACHE).map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    }),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (
    url.pathname === "/api" ||
    url.pathname.startsWith("/api/") ||
    url.pathname === "/ws" ||
    url.pathname.startsWith("/ws/") ||
    url.pathname === "/mcp" ||
    url.pathname.startsWith("/mcp/") ||
    url.pathname.startsWith("/.well-known/")
  ) {
    return;
  }
  if (request.mode === "navigate" || request.headers.get("accept")?.includes("text/html")) {
    event.respondWith(
      fetch(new Request(request, { cache: "no-store" })).catch(
        () =>
          new Response(
            '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cox is offline</title><h1>Cox is offline</h1><p>Reconnect to your Cox server and try again.</p><button onclick="location.reload()">Retry</button></html>',
            {
              status: 503,
              headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
            },
          ),
      ),
    );
    return;
  }
  if (!HASHED_ASSET.test(url.pathname)) return;
  event.respondWith(
    caches.open(ASSET_CACHE).then(async (cache) => {
      const cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok && response.type === "basic" && !response.redirected) {
        await cache.put(request, response.clone());
      }
      return response;
    }),
  );
});

self.addEventListener("push", (event) => {
  let payload;
  try {
    payload = event.data?.json();
  } catch {
    payload = undefined;
  }
  const data = payload !== null && typeof payload === "object" ? payload : {};
  const title = typeof data.title === "string" ? data.title : "Cox";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof data.body === "string" ? data.body : "",
      tag: typeof data.tag === "string" ? data.tag : undefined,
      data: {
        threadPath: safeThreadPath(data.threadPath),
        kind: typeof data.kind === "string" ? data.kind : undefined,
      },
      icon: "/apple-touch-icon.png",
      badge: "/favicon.ico",
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const threadPath = safeThreadPath(event.notification.data?.threadPath);
  if (threadPath === null) return;
  const targetUrl = new URL(threadPath, self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clients) => {
      const client = clients.find(
        (candidate) => new URL(candidate.url).origin === self.location.origin,
      );
      if (client) {
        await client.focus();
        client.postMessage({ type: "cox:navigate-thread", threadPath });
      } else {
        await self.clients.openWindow(targetUrl);
      }
    }),
  );
});

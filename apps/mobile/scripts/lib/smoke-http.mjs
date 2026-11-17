import http from "node:http";
import { readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

export const httpServers = [];

export function startStaticServer(root, port) {
  const contentTypes = new Map([
    [".html", "text/html; charset=utf-8"],
    [".js", "text/javascript; charset=utf-8"],
    [".mjs", "text/javascript; charset=utf-8"],
    [".css", "text/css; charset=utf-8"],
    [".json", "application/json; charset=utf-8"],
    [".svg", "image/svg+xml"],
    [".png", "image/png"],
    [".webp", "image/webp"],
    [".ico", "image/x-icon"],
    [".woff2", "font/woff2"],
    [".map", "application/json"],
  ]);
  const server = http.createServer(async (request, response) => {
    try {
      const requestPath = decodeURIComponent(
        new URL(request.url ?? "/", "http://127.0.0.1").pathname,
      );
      const relativePath = requestPath === "/" ? "index.html" : requestPath.replace(/^\/+/, "");
      const body = await readFile(join(root, relativePath)).catch(() => null);
      if (body === null) {
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("Not found");
        return;
      }
      response.writeHead(200, {
        "content-type": contentTypes.get(extname(relativePath)) ?? "application/octet-stream",
        "cache-control": "no-store",
      });
      response.end(body);
    } catch {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end("Launcher server error");
    }
  });
  httpServers.push({ server, label: `static(${basename(root)})` });
  return new Promise((resolvePromise) => server.listen(port, "127.0.0.1", resolvePromise));
}

export function startWebhookReceiver(port) {
  const deliveries = [];
  let resolveDelivery;
  const waitForDelivery = () =>
    new Promise((resolvePromise) => {
      resolveDelivery = resolvePromise;
    });
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      deliveries.push({ at: new Date().toISOString(), body });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      resolveDelivery?.();
    });
  });
  httpServers.push({ server, label: "webhook-receiver" });
  return {
    deliveries,
    waitForDelivery,
    listening: new Promise((resolvePromise) => server.listen(port, "127.0.0.1", resolvePromise)),
  };
}

export function installInspectProxy(context, origins, launcherOrigin) {
  const handler = async (route) => {
    const upstream = await route.fetch().catch(async (error) => {
      await route.abort();
      throw error;
    });
    const headers = { ...upstream.headers() };
    delete headers["access-control-allow-origin"];
    delete headers["access-control-allow-credentials"];
    delete headers["content-encoding"];
    delete headers["content-length"];
    await route.fulfill({
      status: upstream.status(),
      headers: {
        ...headers,
        "access-control-allow-origin": launcherOrigin,
        "access-control-allow-credentials": "true",
        vary: "Origin",
      },
      body: await upstream.body(),
    });
  };
  return Promise.all(origins.map((origin) => context.route(`${origin}/**`, handler)));
}

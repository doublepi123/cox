import { execFileSync } from "node:child_process";
import http from "node:http";
import https from "node:https";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

function generateSelfSignedTls() {
  const dir = mkdtempSync(join(tmpdir(), "cox-cf-tls-"));
  try {
    const keyPath = join(dir, "key.pem");
    const certPath = join(dir, "cert.pem");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=cox.test",
        "-addext",
        "subjectAltName=DNS:cox.test,DNS:team.cloudflareaccess.com,IP:127.0.0.1",
        "-keyout",
        keyPath,
        "-out",
        certPath,
      ],
      { stdio: "ignore" },
    );
    return {
      key: readFileSync(keyPath),
      cert: readFileSync(certPath),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function startCloudflareAccessProxy({ port, upstreamPort, token = "cf-smoke-session-ok" }) {
  const tls = generateSelfSignedTls();
  const hasCfAuth = (cookieHeader = "") =>
    cookieHeader.split(";").some((part) => part.trim() === `CF_Authorization=${token}`);

  const server = https.createServer(tls, (req, res) => {
    const hostHeader = req.headers.host ?? `cox.test:${port}`;
    const hostname = hostHeader.split(":")[0]?.toLowerCase() ?? "cox.test";
    const parsed = new URL(req.url ?? "/", `https://${hostHeader}`);

    if (
      hostname === "team.cloudflareaccess.com" &&
      parsed.pathname.startsWith("/cdn-cgi/access/login")
    ) {
      const targetOrigin = parsed.searchParams.get("origin") ?? `https://cox.test:${port}`;
      const returnPath = parsed.searchParams.get("redirect_url") ?? "/";
      if (req.method === "POST") {
        const authorized = new URL("/cdn-cgi/access/authorized", targetOrigin);
        authorized.searchParams.set("redirect_url", returnPath);
        res.writeHead(302, { location: authorized.href, "cache-control": "no-store" });
        res.end();
        return;
      }
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(
        `<!doctype html><title>Cloudflare Access</title><form method="POST" action="${parsed.pathname}${parsed.search}"><button type="submit">Approve Cloudflare Access</button></form>`,
      );
      return;
    }

    if (parsed.pathname === "/cdn-cgi/access/authorized") {
      const returnPath = parsed.searchParams.get("redirect_url") ?? "/";
      res.writeHead(302, {
        "set-cookie": `CF_Authorization=${token}; Path=/; Secure; HttpOnly; SameSite=Lax`,
        location: new URL(returnPath, `https://${hostHeader}`).href,
        "cache-control": "no-store",
      });
      res.end();
      return;
    }

    if (!hasCfAuth(req.headers.cookie)) {
      const login = new URL(`https://team.cloudflareaccess.com:${port}/cdn-cgi/access/login`);
      login.searchParams.set("origin", `https://${hostHeader}`);
      login.searchParams.set("redirect_url", `${parsed.pathname}${parsed.search}`);
      res.writeHead(302, {
        location: login.href,
        "www-authenticate": `Cloudflare-Access resource_metadata="https://${hostHeader}/.well-known/cloudflare-access-protected-resource"`,
        "cache-control": "no-store",
      });
      res.end();
      return;
    }

    const proxyReq = http.request(
      {
        hostname: "127.0.0.1",
        port: upstreamPort,
        method: req.method,
        path: req.url,
        headers: {
          ...req.headers,
          host: hostHeader,
          "x-forwarded-proto": "https",
        },
      },
      (proxyRes) => {
        const outHeaders = { ...proxyRes.headers };
        if (Array.isArray(outHeaders["set-cookie"])) {
          outHeaders["set-cookie"] = outHeaders["set-cookie"].map((cookie) =>
            /;\s*secure/i.test(cookie) ? cookie : `${cookie}; Secure`,
          );
        } else if (
          typeof outHeaders["set-cookie"] === "string" &&
          !/;\s*secure/i.test(outHeaders["set-cookie"])
        ) {
          outHeaders["set-cookie"] = `${outHeaders["set-cookie"]}; Secure`;
        }
        res.writeHead(proxyRes.statusCode ?? 502, outHeaders);
        proxyRes.pipe(res);
      },
    );
    proxyReq.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end("Bad gateway");
    });
    req.pipe(proxyReq);
  });

  server.on("upgrade", (req, clientSocket, head) => {
    if (!hasCfAuth(req.headers.cookie)) {
      clientSocket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      clientSocket.destroy();
      return;
    }
    const upstreamReq = http.request({
      hostname: "127.0.0.1",
      port: upstreamPort,
      method: req.method,
      path: req.url,
      headers: {
        ...req.headers,
        "x-forwarded-proto": "https",
      },
    });
    upstreamReq.on("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
      let rawHeaders = `HTTP/1.1 ${upstreamRes.statusCode ?? 101} ${upstreamRes.statusMessage ?? "Switching Protocols"}\r\n`;
      for (let i = 0; i < upstreamRes.rawHeaders.length; i += 2) {
        rawHeaders += `${upstreamRes.rawHeaders[i]}: ${upstreamRes.rawHeaders[i + 1]}\r\n`;
      }
      rawHeaders += "\r\n";
      clientSocket.write(rawHeaders);
      if (upstreamHead.length > 0) clientSocket.write(upstreamHead);
      if (head.length > 0) upstreamSocket.write(head);
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
    });
    upstreamReq.on("error", () => clientSocket.destroy());
    upstreamReq.end();
  });

  httpServers.push({ server, label: "cloudflare-access-proxy" });
  return {
    origin: `https://cox.test:${port}`,
    listening: new Promise((resolvePromise) => server.listen(port, "127.0.0.1", resolvePromise)),
  };
}

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const home = await mkdtemp(join(tmpdir(), "cox-smoke-"));
const reservation = createServer();
await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const websocketStatus = (browserOrigin, cookie = "") =>
  new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(
        [
          "GET /ws?orchestrationProtocol=2 HTTP/1.1",
          `Host: 127.0.0.1:${port}`,
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Version: 13",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          `Origin: ${browserOrigin}`,
          ...(cookie ? [`Cookie: ${cookie}`] : []),
          "",
          "",
        ].join("\r\n"),
      );
    });
    let headers = "";
    socket.setTimeout(10000, () =>
      socket.destroy(new Error("WebSocket handshake deadline exceeded")),
    );
    socket.on("data", (chunk) => {
      headers += chunk;
      if (!headers.includes("\r\n\r\n")) return;
      socket.destroy();
      const status = headers.match(/^HTTP\/1\.1 (\d+)/)?.[1];
      if (!status) return reject(new Error("Missing WebSocket handshake status"));
      resolve(Number(status));
    });
    socket.once("error", reject);
  });
const child = spawn(
  process.execPath,
  [
    process.argv[2] ?? join(root, "apps/server/dist/bin.mjs"),
    "--home-dir",
    home,
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--no-browser",
  ],
  {
    cwd: root,
    env: {
      ...process.env,
      HOME: home,
      COX_HOME: home,
      T3CODE_HOST: "127.0.0.1",
      COX_TELEMETRY_ENABLED: "false",
      T3CODE_TELEMETRY_ENABLED: "false",
      T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  },
);
let output = "";
let readyResolve;
const ready = new Promise((resolve) => {
  readyResolve = resolve;
});
for (const stream of [child.stdout, child.stderr]) {
  stream.on("data", (chunk) => {
    output += chunk;
    const match = output.match(/pairingUrl:\s*(http\S+)/);
    if (match) readyResolve(new URL(match[1]));
  });
}
const exited = new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve({ code, signal }));
});
let timeout;
const deadline = new Promise((_, reject) => {
  timeout = setTimeout(() => reject(new Error("Cox startup deadline exceeded")), 60000);
});
try {
  const pairing = await Promise.race([
    ready,
    deadline,
    exited.then((result) => {
      throw new Error(`Cox exited before ready: ${JSON.stringify(result)}`);
    }),
  ]);
  const descriptorResponse = await fetch(`${origin}/.well-known/t3/environment`);
  assert.equal(descriptorResponse.status, 200);
  const descriptor = await descriptorResponse.json();
  assert.ok(descriptor);
  const sessionBefore = await fetch(`${origin}/api/auth/session`).then((response) =>
    response.json(),
  );
  assert.equal(sessionBefore.authenticated, false);
  const protectedResponse = await fetch(`${origin}/api/projects`);
  assert.equal(protectedResponse.status, 401);
  const credential = new URLSearchParams(pairing.hash.slice(1)).get("token");
  assert.ok(credential);
  const login = await fetch(`${origin}/api/auth/browser-session`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ credential }),
  });
  assert.equal(login.status, 200);
  const cookieHeader = login.headers.get("set-cookie");
  assert.match(cookieHeader, /HttpOnly/i);
  assert.match(cookieHeader, /SameSite=Lax/i);
  const cookie = cookieHeader.split(";")[0];
  assert.equal((await login.json()).authenticated, true);
  const sessionAfter = await fetch(`${origin}/api/auth/session`, { headers: { cookie } }).then(
    (response) => response.json(),
  );
  assert.equal(sessionAfter.authenticated, true);
  const projects = await fetch(`${origin}/api/projects`, { headers: { cookie } });
  assert.equal(projects.status, 200);
  const foreign = await fetch(`${origin}/api/projects`, {
    headers: { cookie, origin: "https://untrusted.example" },
  });
  assert.equal(foreign.status, 401);
  assert.equal(await websocketStatus(origin), 401);
  assert.equal(await websocketStatus("https://untrusted.example", cookie), 401);
  assert.equal(await websocketStatus(origin, cookie), 101);
  const replay = await fetch(`${origin}/api/auth/browser-session`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ credential }),
  });
  assert.equal(replay.status, 401);
  for (const path of [
    "/api/cloud",
    "/api/relay",
    "/api/peer-links",
    "/api/devices",
    "/api/server/update",
    "/api/guest-share",
  ]) {
    const response = await fetch(`${origin}${path}`, {
      method: "POST",
      headers: { cookie, origin, "content-type": "application/json" },
      body: "{}",
    });
    assert.ok([404, 405].includes(response.status), `${path}: ${response.status}`);
  }
  if (process.env.COX_SMOKE_STATIC !== "0") {
    const indexResponse = await fetch(origin);
    assert.equal(indexResponse.status, 200);
    const html = await indexResponse.text();
    assert.match(html, /<title>Cox(?: \(Beta\))?<\/title>/);
    const entryAssets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)];
    assert.ok(entryAssets.length > 0);
    for (const match of entryAssets) {
      const asset = await fetch(`${origin}${match[1]}`);
      assert.equal(asset.status, 200, match[1]);
    }
  }
  console.log(
    "PASS: isolated built-server startup, local descriptor, auth required, one-use bootstrap, HttpOnly cookie, authenticated projects API, HTTP/WS foreign-origin rejection, authenticated WebSocket upgrade, removed endpoint probes.",
  );
} catch (error) {
  const sanitized = output
    .replace(/pairingUrl:[^\n]*/g, "pairingUrl: [redacted]")
    .replace(/token=[^\s&]+/g, "token=[redacted]");
  console.error(sanitized.slice(-10000));
  throw error;
} finally {
  clearTimeout(timeout);
  if (child.pid && child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") {
        console.error("Failed to stop the Cox smoke-test process group:", error);
        process.exitCode = 1;
      }
    }
  }
  await exited;
  await rm(home, { recursive: true, force: true });
  console.log("Cox smoke-test process stopped and temporary state removed.");
}

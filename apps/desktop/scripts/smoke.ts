import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { BackendProcess, validateBackendInstallation } from "../src/backend.ts";
import { BackendUpdates } from "../src/backend-updates.ts";
import { backendEnvironment } from "../src/config.ts";

const root = resolve(import.meta.dirname, "../../..");
const output = join(
  root,
  "release",
  "desktop",
  process.env.COX_DESKTOP_CLIENT_ONLY === "true" ? "client-only" : "bundled",
);
const candidates =
  process.platform === "darwin"
    ? [
        join(
          output,
          process.arch === "arm64" ? "mac-arm64" : "mac",
          "Cox.app",
          "Contents",
          "Resources",
        ),
      ]
    : [
        join(
          output,
          `${process.platform === "win32" ? "win" : "linux"}${process.arch === "arm64" ? "-arm64" : ""}-unpacked`,
          "resources",
        ),
      ];
const resources = candidates.find((candidate) => existsSync(join(candidate, "backend.json")));
assert.ok(resources, "Build the desktop package before running its smoke test.");
const temporary = await mkdtemp(join(tmpdir(), "cox-desktop-smoke-"));
const home = join(temporary, "data");
const metadata = JSON.parse(await readFile(join(resources, "backend.json"), "utf8")) as {
  desktopVersion: string;
  coxVersion: string | null;
  nodeVersion: string;
};
assert.equal(existsSync(join(resources, "server")), metadata.coxVersion !== null);
const node = join(
  resources,
  "runtime",
  ...(process.platform === "win32" ? ["node.exe"] : ["bin", "node"]),
);
const environment = backendEnvironment({
  inherited: { ...process.env, HOME: temporary, USERPROFILE: temporary },
  runtimeDirectory: dirname(node),
  homeDirectory: home,
  userHome: temporary,
  platform: process.platform,
});
let logs = "";
let backend: BackendProcess | undefined;
let serverDirectory = join(resources, "server");
const startBackend = async (directory: string) => {
  serverDirectory = directory;
  backend = new BackendProcess({
    nodePath: node,
    entryPath: join(directory, "dist", "bin.mjs"),
    preloadPath: join(resources, "backend-parent.mjs"),
    homeDirectory: home,
    cwd: temporary,
    environment,
    onLog: (message) => {
      logs = (logs + message).slice(-16_384);
    },
    onUnexpectedExit: (message) => {
      throw new Error(message);
    },
  });
  return backend.start();
};
const updates = new BackendUpdates({
  home,
  desktopVersion: metadata.desktopVersion,
  bundledVersion: metadata.coxVersion,
  bundledDirectory: serverDirectory,
  nodeVersion: metadata.nodeVersion,
  node,
  npm: join(
    resources,
    "runtime",
    ...(process.platform === "win32" ? ["node_modules"] : ["lib", "node_modules"]),
    "npm",
    "bin",
    "npm-cli.js",
  ),
  environment,
  onState: () => {},
  validate: (directory, signal) =>
    validateBackendInstallation({
      directory,
      node,
      preload: join(resources, "backend-parent.mjs"),
      environment,
      signal,
    }),
});

function websocketStatus(origin: string, browserOrigin: string, cookie: string): Promise<number> {
  const url = new URL(origin);
  return new Promise((resolveStatus, reject) => {
    const socket = connect(Number(url.port), url.hostname, () => {
      socket.write(
        [
          "GET /ws?orchestrationProtocol=2 HTTP/1.1",
          `Host: ${url.host}`,
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Version: 13",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          `Origin: ${browserOrigin}`,
          `Cookie: ${cookie}`,
          "",
          "",
        ].join("\r\n"),
      );
    });
    let headers = "";
    socket.setTimeout(5_000, () =>
      socket.destroy(new Error("WebSocket handshake deadline exceeded.")),
    );
    socket.on("data", (chunk) => {
      headers += String(chunk);
      if (!headers.includes("\r\n\r\n")) return;
      socket.destroy();
      const status = headers.match(/^HTTP\/1\.1 (\d+)/)?.[1];
      if (!status) reject(new Error("Missing WebSocket handshake status."));
      else resolveStatus(Number(status));
    });
    socket.once("error", reject);
  });
}

try {
  assert.match(execFileSync(node, ["--version"], { encoding: "utf8" }), /^v26\./);
  assert.ok(
    existsSync(join(dirname(node), process.platform === "win32" ? "npm.cmd" : "npm")),
    "The packaged npm launcher must not contain a broken staging symlink.",
  );
  const origin = await updates.launch(startBackend, () => backend?.stop() ?? Promise.resolve());
  assert.equal((await fetch(`${origin}/api/projects`)).status, 401);
  const session = await fetch(`${origin}/api/auth/browser-session`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(session.status, 200);
  const cookieHeader = session.headers.get("set-cookie");
  assert.ok(cookieHeader);
  assert.match(cookieHeader, /HttpOnly/i);
  assert.match(cookieHeader, /SameSite=Lax/i);
  const cookie = cookieHeader.split(";")[0]!;
  assert.equal((await fetch(`${origin}/api/projects`, { headers: { cookie } })).status, 200);
  assert.equal(await websocketStatus(origin, "https://foreign.invalid", cookie), 401);
  assert.equal(await websocketStatus(origin, origin, cookie), 101);
  const html = await fetch(origin).then((response) => response.text());
  assert.match(html, /<title>Cox(?: \(Beta\))?<\/title>/);
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)];
  assert.ok(assets.length > 0);
  for (const match of assets) assert.equal((await fetch(`${origin}${match[1]}`)).status, 200);
  const ptyProbe = `
import { createRequire } from 'node:module';
const require = createRequire(process.cwd() + '/package.json');
const pty = require('node-pty');
const terminal = pty.spawn(process.platform === 'win32' ? 'powershell.exe' : '/bin/sh', process.platform === 'win32' ? ['-NoProfile', '-Command', "[Console]::Write('COX_DESKTOP_PTY_OK')"] : ['-c', "printf COX_DESKTOP_PTY_OK"], { cols: 80, rows: 24, env: process.env });
let output = '';
terminal.onData((chunk) => { output += chunk; });
terminal.onExit(({ exitCode }) => {
  const success = exitCode === 0 && output.includes('COX_DESKTOP_PTY_OK');
  if (!success) console.error({ exitCode, output });
  else console.log('PASS: native terminal produced the marker and exited successfully.');
  process.exit(success ? 0 : 1);
});
`;
  execFileSync(node, ["--input-type=module", "-e", ptyProbe], {
    cwd: serverDirectory,
    env: environment,
    timeout: 15_000,
    stdio: "inherit",
  });
  await backend?.stop();
  assert.equal(
    existsSync(join(home, "userdata", "server-runtime.json")),
    false,
    "The backend must release ownership during graceful shutdown.",
  );
  console.log(
    "PASS: packaged Node/backend, native terminal, browser assets, local cookie authentication, authenticated WebSocket, foreign-origin rejection and graceful ownership cleanup.",
  );
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  await updates.close();
  await backend?.stop();
  await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

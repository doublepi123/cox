import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, symlink, writeFile, rm, stat } from "node:fs/promises";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const root = await mkdtemp(join(tmpdir(), "cox-dev-smoke-"));
const reservations = [createServer(), createServer()];
for (const server of reservations)
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const [serverPort, webPort] = reservations.map((server) => server.address().port);
for (const server of reservations) await new Promise((resolve) => server.close(resolve));
const origin = `http://127.0.0.1:${webPort}`;
await mkdir(join(root, "apps"));
await symlink(join(source, "apps/server"), join(root, "apps/server"));
await symlink(join(source, "apps/web"), join(root, "apps/web"));
const driver = join(root, "driver.mjs");
await writeFile(
  driver,
  `
  import { createDevConfig, runDev } from ${JSON.stringify(new URL("./dev-runner.ts", import.meta.url).href)};
  process.exitCode = await runDev(createDevConfig('dev', process.env, ${JSON.stringify(root)}));
`,
);
const child = spawn(process.execPath, [driver], {
  cwd: source,
  detached: true,
  env: {
    ...process.env,
    HOME: root,
    T3CODE_TRACE_FILE: join(root, "smoke-trace.ndjson"),
    COX_AUTH_PASSWORD: "",
    T3CODE_AUTH_PASSWORD: "",
    COX_SERVER_PORT: String(serverPort),
    COX_WEB_PORT: String(webPort),
    T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
    NO_COLOR: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
let startupUrl;
let viteReady = false;
let resolveReady;
const ready = new Promise((resolve) => {
  resolveReady = resolve;
});
for (const stream of [child.stdout, child.stderr])
  stream.on("data", (chunk) => {
    output += chunk;
    const text = output.replace(/\u001b\[[0-9;]*m/g, "");
    const match = text.match(/Local URL:\s*(http\S+)/);
    if (match) startupUrl = new URL(match[1]);
    if (/ready in/i.test(text)) viteReady = true;
    if (startupUrl && viteReady) resolveReady();
  });
const exited = new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve({ code, signal }));
});
let timeout;
const deadline = new Promise((_, reject) => {
  timeout = setTimeout(() => reject(new Error("Cox development startup deadline exceeded")), 90000);
});
try {
  await Promise.race([
    ready,
    deadline,
    exited.then((result) => {
      throw new Error(`Development launcher exited before ready: ${JSON.stringify(result)}`);
    }),
  ]);
  assert.equal(startupUrl.origin, origin);
  const indexResponse = await fetch(origin);
  assert.equal(indexResponse.status, 200);
  assert.match(await indexResponse.text(), /<title>Cox(?: \(Beta\))?<\/title>/);
  const descriptor = await fetch(`${origin}/.well-known/t3/environment`);
  assert.equal(descriptor.status, 200);
  assert.match(descriptor.headers.get("content-type"), /json/);
  const sessionBefore = await fetch(`${origin}/api/auth/session`).then((response) =>
    response.json(),
  );
  assert.equal(sessionBefore.authenticated, false);
  assert.equal(sessionBefore.auth.loginMode, "local");
  const login = await fetch(`${origin}/api/auth/browser-session`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: "{}",
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  assert.equal((await fetch(`${origin}/api/projects`, { headers: { cookie } })).status, 200);
  const wsStatus = await new Promise((resolve, reject) => {
    const socket = connect(webPort, "127.0.0.1", () =>
      socket.write(
        [
          "GET /ws?orchestrationProtocol=2 HTTP/1.1",
          `Host: 127.0.0.1:${webPort}`,
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Version: 13",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          `Origin: ${origin}`,
          `Cookie: ${cookie}`,
          "",
          "",
        ].join("\r\n"),
      ),
    );
    let headers = "";
    socket.setTimeout(10000, () =>
      socket.destroy(new Error("Development WebSocket deadline exceeded")),
    );
    socket.on("data", (chunk) => {
      headers += chunk;
      if (!headers.includes("\r\n\r\n")) return;
      socket.destroy();
      resolve(Number(headers.match(/^HTTP\/1\.1 (\d+)/)?.[1]));
    });
    socket.once("error", reject);
  });
  assert.equal(wsStatus, 101);
  assert.ok((await stat(join(root, ".cox/userdata/statev2.sqlite"))).isFile());
  console.log(
    "PASS: actual development launcher, Cox HTML, same-origin descriptor/auth/projects proxy, WebSocket proxy, isolated checkout state.",
  );
} catch (error) {
  console.error(output.slice(-10000));
  throw error;
} finally {
  clearTimeout(timeout);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  const result = await exited;
  assert.equal(result.code, 143);
  for (const port of [serverPort, webPort]) {
    const probe = createServer();
    await new Promise((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", resolve);
    });
    await new Promise((resolve) => probe.close(resolve));
  }
  await rm(root, { recursive: true, force: true });
  console.log("Development children stopped, both ports released, temporary state removed.");
}

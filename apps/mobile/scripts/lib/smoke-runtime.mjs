import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";

export async function withDeadline(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function reservePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export function startCoxServer({ repoRoot, home, port, password, label }) {
  const child = spawn(
    process.execPath,
    [
      join(repoRoot, "apps/server/dist/bin.mjs"),
      "--home-dir",
      home,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--no-browser",
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: home,
        COX_HOME: home,
        COX_AUTH_PASSWORD: password,
        T3CODE_AUTH_PASSWORD: "",
        VITE_DEV_SERVER_URL: undefined,
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
  const ready = Promise.withResolvers();
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      output = (output + chunk).slice(-60_000);
      const match = output.match(/Local URL:\s*(http\S+)/);
      if (match) ready.resolve(match[1]);
    });
  }
  return {
    child,
    label,
    home,
    port,
    exited,
    origin: `http://127.0.0.1:${port}`,
    async descriptor() {
      await withDeadline(
        Promise.race([
          ready.promise,
          exited.then((result) => {
            throw new Error(`${label} exited before ready: ${JSON.stringify(result)}\n${output}`);
          }),
        ]),
        90_000,
        `${label} never announced its Local URL.\n${output}`,
      );
      const response = await fetch(`http://127.0.0.1:${port}/.well-known/t3/environment`, {
        signal: AbortSignal.timeout(15_000),
      });
      assert.equal(response.status, 200);
      return await response.json();
    },
  };
}

export async function stopCoxServer(entry) {
  if (entry.child.exitCode !== null || entry.child.signalCode !== null) return;
  let timer;
  try {
    process.kill(-entry.child.pid, "SIGTERM");
    timer = setTimeout(() => {
      try {
        process.kill(-entry.child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }, 15_000);
    await withDeadline(entry.exited, 25_000, `${entry.label} survived termination.`);
  } finally {
    clearTimeout(timer);
  }
}

export async function assertStopped(entry) {
  assert.throws(() => process.kill(entry.child.pid, 0), { code: "ESRCH" });
  const survivors = [];
  for (const pid of await readdir("/proc")) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
    try {
      const command = await readFile(join("/proc", pid, "cmdline"), "utf8");
      if (command.includes(entry.home)) survivors.push(pid);
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error;
    }
  }
  assert.deepEqual(survivors, [], `${entry.label} left subprocesses behind.`);
}

export async function assertConnectionRefused(origin) {
  await assert.rejects(
    fetch(origin, { signal: AbortSignal.timeout(5_000) }),
    (error) => error.cause?.code === "ECONNREFUSED",
  );
}

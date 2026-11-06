import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { BackendProcess } from "./backend.ts";

const fixture = `
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const home = process.argv[process.argv.indexOf('--home-dir') + 1];
const mode = process.env.FIXTURE_MODE;
writeFileSync(join(home, 'parent-flag'), String(process.env.COX_DESKTOP_PARENT_PID));
if (mode === 'exit') process.exit(7);
const server = createServer((request, response) => {
  if (request.url === '/crash') { response.end('stopping'); setImmediate(() => process.exit(9)); return; }
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ authenticated: false, auth: { loginMode: 'local' } }));
});
process.on('SIGINT', () => {
  if (mode === 'stubborn') return;
  writeFileSync(join(home, 'stopped'), 'graceful');
  server.close(() => process.exit(0));
});
server.listen(0, '127.0.0.1', () => {
  const origin = 'http://127.0.0.1:' + server.address().port;
  mkdirSync(join(home, 'userdata'), { recursive: true });
  writeFileSync(join(home, 'userdata', 'server-runtime.json'), JSON.stringify({ pid: mode === 'wrong-owner' ? 1 : process.pid, origin }));
  if (mode === 'timeout') { console.log('FIXTURE_WAITING'); return; }
  process.stdout.write('Local UR');
  process.stdout.write('L: ' + origin + '\\n');
});
`;
const cleanups: Array<() => Promise<unknown>> = [];
const preload = join(import.meta.dirname, "backend-parent.ts");

async function createBackend(mode = "normal") {
  const home = await mkdtemp(join(tmpdir(), "cox-desktop-test-"));
  cleanups.unshift(() => rm(home, { recursive: true, force: true }));
  const entry = join(home, "fixture.mjs");
  await writeFile(entry, fixture);
  const onLog = vi.fn();
  const onUnexpectedExit = vi.fn();
  const backend = new BackendProcess({
    nodePath: process.execPath,
    entryPath: entry,
    preloadPath: preload,
    homeDirectory: home,
    cwd: home,
    environment: { ...process.env, FIXTURE_MODE: mode },
    onLog,
    onUnexpectedExit,
    stopTimeoutMs: 100,
  });
  cleanups.unshift(() => backend.stop());
  return { backend, home, entry, onLog, onUnexpectedExit };
}

afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("desktop backend supervisor", () => {
  it("waits for its own backend, checks auth and stops gracefully", async () => {
    const { backend, home, onUnexpectedExit } = await createBackend();
    const origin = await backend.start();
    expect(await readFile(join(home, "parent-flag"), "utf8")).toBe("undefined");
    expect(JSON.parse(await readFile(join(home, "backend-owner.json"), "utf8")).pid).toBeTypeOf(
      "number",
    );
    expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect((await fetch(`${origin}/api/auth/session`)).status).toBe(200);
    await backend.stop();
    await backend.stop();
    expect(await readFile(join(home, "stopped"), "utf8")).toBe("graceful");
    await expect(readFile(join(home, "backend-owner.json"), "utf8")).rejects.toThrow();
    expect(onUnexpectedExit).not.toHaveBeenCalled();
  });

  it("reports early startup failures without attaching to another service", async () => {
    const { backend, onUnexpectedExit } = await createBackend("exit");
    await expect(backend.start()).rejects.toThrow("code 7");
    expect(onUnexpectedExit).not.toHaveBeenCalled();
  });

  it("rejects a runtime descriptor owned by another process", async () => {
    const { backend } = await createBackend("wrong-owner");
    await expect(backend.start()).rejects.toThrow("did not publish its own loopback address");
  });

  it("bounds startup waiting and cleans up the started process", async () => {
    const { backend, onLog } = await createBackend("timeout");
    const waiting = Promise.withResolvers<void>();
    onLog.mockImplementation((message: string) => {
      if (message.includes("FIXTURE_WAITING")) waiting.resolve();
    });
    vi.useFakeTimers();
    const startup = backend.start();
    const failure = expect(startup).rejects.toThrow("did not become ready");
    await waiting.promise;
    await vi.advanceTimersByTimeAsync(90_000);
    await failure;
    vi.useRealTimers();
  });

  it("terminates only its own process tree when graceful shutdown fails", async () => {
    const independent = await createBackend();
    const independentOrigin = await independent.backend.start();
    const { backend, home, onUnexpectedExit } = await createBackend("stubborn");
    await backend.start();
    await backend.stop();
    await expect(readFile(join(home, "stopped"))).rejects.toThrow();
    expect(onUnexpectedExit).not.toHaveBeenCalled();
    expect((await fetch(`${independentOrigin}/api/auth/session`)).status).toBe(200);
  });

  it.runIf(process.platform === "darwin")(
    "waits for a reaped owned group after a macOS EPERM race",
    async () => {
      const { backend, home, onUnexpectedExit } = await createBackend("stubborn");
      await backend.start();
      const owner = JSON.parse(await readFile(join(home, "backend-owner.json"), "utf8")) as {
        pid: number;
      };
      const killProcess = process.kill.bind(process);
      const kill = vi.spyOn(process, "kill").mockImplementation((target, signal) => {
        if (target === -owner.pid && signal === "SIGKILL") {
          killProcess(target, signal);
          throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
        }
        return killProcess(target, signal);
      });
      try {
        await backend.stop();
        expect(() => killProcess(-owner.pid, 0)).toThrow();
        expect(onUnexpectedExit).not.toHaveBeenCalled();
      } finally {
        kill.mockRestore();
      }
    },
  );

  it("reports a backend crash after startup", async () => {
    const { backend, onUnexpectedExit } = await createBackend();
    const notice = Promise.withResolvers<string>();
    onUnexpectedExit.mockImplementation(notice.resolve);
    const origin = await backend.start();
    await fetch(`${origin}/crash`);
    expect(await notice.promise).toContain("code 9");
  });

  it("does not start a new process after it has been stopped", async () => {
    const { backend } = await createBackend();
    await backend.stop();
    expect(() => backend.start()).toThrow("already been stopped");
  });

  it("cleans up when the desktop IPC connection disappears", async () => {
    const { home, entry } = await createBackend();
    const child = spawn(
      process.execPath,
      ["--import", pathToFileURL(preload).href, entry, "--home-dir", home],
      {
        env: { ...process.env, COX_DESKTOP_PARENT_PID: String(process.pid) },
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    const exited = once(child, "exit");
    child.on("message", (message: unknown) => {
      if (message === "cox:backend-ready-to-start") child.send("cox:backend-start");
    });
    cleanups.unshift(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    });
    await once(child.stdout!, "data");
    child.disconnect();
    await exited;
    expect(await readFile(join(home, "stopped"), "utf8")).toBe("graceful");
  });

  it("never loads backend code if the desktop disconnected before preload completed", async () => {
    const { home, entry } = await createBackend();
    const child = spawn(
      process.execPath,
      ["--import", pathToFileURL(preload).href, entry, "--home-dir", home],
      {
        env: { ...process.env, COX_DESKTOP_PARENT_PID: String(process.pid) },
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    const exited = once(child, "exit");
    cleanups.unshift(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    });
    child.disconnect();
    expect((await exited)[0]).toBe(0);
    await expect(readFile(join(home, "userdata", "server-runtime.json"))).rejects.toThrow();
  });
});

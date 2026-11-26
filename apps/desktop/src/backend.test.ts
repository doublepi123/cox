import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { BackendProcess, type BackendOptions } from "./backend.ts";

const fixture = `
import { createServer } from 'node:http';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const home = process.argv[process.argv.indexOf('--home-dir') + 1];
const mode = process.env.FIXTURE_MODE;
if (mode === 'computer-ipc') process.on('message', message => {
  const record = (name, value) => {
    writeFileSync(join(home, name + '.tmp'), JSON.stringify(value));
    renameSync(join(home, name + '.tmp'), join(home, name));
  };
  if (message?.type === 'cox:computer-reply') record('computer-reply', message);
  if (message?.type === 'cox:computer-availability') record('computer-availability', message);
});
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
  const publish = (pid = process.pid, reportedOrigin = origin) => {
    const target = join(home, 'userdata', 'server-runtime.json');
    const staged = target + '.tmp';
    writeFileSync(staged, mode === 'malformed-state' ? '{' : JSON.stringify({ pid, origin: reportedOrigin }));
    renameSync(staged, target);
  };
  if (['stale-state', 'wrong-owner'].includes(mode)) publish(1);
  else if (mode === 'wrong-origin') publish(process.pid, origin.replace('127.0.0.1', '127.0.0.2'));
  else if (!['late-state', 'late-wrong-owner', 'missing-state'].includes(mode)) publish();
  if (mode === 'computer-ipc') setTimeout(() => process.send?.({ type: 'cox:computer-request', id: 'req', threadId: 'thread', threadTitle: 'Title', environmentId: 'env', agent: 'Agent', action: { kind: 'status' } }), 50);
  if (mode === 'timeout') { console.log('FIXTURE_WAITING'); return; }
  const announce = () => {
    process.stdout.write('Local UR');
    process.stdout.write('L: ' + origin + '\\n');
    if (mode === 'late-state') setTimeout(publish, 100);
    if (mode === 'late-wrong-owner') setTimeout(() => publish(1), 100);
    if (mode === 'stale-state') setTimeout(publish, 300);
  };
  if (mode === 'migrating') {
    process.stdout.write('Running database migra');
    process.stdout.write('tions\\n');
    process.stdout.write('Upgrading database (1 of ');
    process.stdout.write('2)\\nUpgrading database (2 of 2)\\n');
    setTimeout(() => {
      console.log('Migrations ran successfully');
      announce();
    }, 400);
  } else announce();
});
`;
const cleanups: Array<() => Promise<unknown>> = [];
const preload = join(import.meta.dirname, "backend-parent.ts");

async function createBackend(
  mode = "normal",
  options?: Pick<BackendOptions, "onComputerRequest" | "startupTimeoutMs" | "onMigrationProgress">,
) {
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
    ...options,
    computerAvailability: () => ({ enabled: true, ready: false, missing: ["input"] }),
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

  it("round-trips computer requests and publishes availability through IPC", async () => {
    const { backend, home } = await createBackend("computer-ipc", {
      onComputerRequest: async (request) => ({
        type: "cox:computer-reply",
        id: request.id,
        ok: true,
        result: { threadId: request.threadId },
      }),
    });
    const observed = new Set<string>();
    const received = Promise.withResolvers<void>();
    const watcher = watch(home, (_event, filename) => {
      const name = String(filename);
      if (name === "computer-reply" || name === "computer-availability") observed.add(name);
      if (observed.size === 2) received.resolve();
    });
    watcher.on("error", received.reject);
    try {
      await backend.start();
      await received.promise;
    } finally {
      watcher.close();
    }
    const reply = JSON.parse(await readFile(join(home, "computer-reply"), "utf8")) as {
      id: string;
      result: { threadId: string };
    };
    const availability = JSON.parse(
      await readFile(join(home, "computer-availability"), "utf8"),
    ) as { enabled: boolean; ready: boolean; missing: string[] };
    expect(reply).toEqual({
      type: "cox:computer-reply",
      id: "req",
      ok: true,
      result: { threadId: "thread" },
    });
    expect(availability).toMatchObject({ enabled: true, ready: false, missing: ["input"] });
  });

  it("answers a computer request whose handler fails instead of leaving the server waiting", async () => {
    const { backend, home, onLog } = await createBackend("computer-ipc", {
      onComputerRequest: async () => {
        throw new Error("desktop host broke");
      },
    });
    const received = Promise.withResolvers<void>();
    const watcher = watch(home, (_event, filename) => {
      if (String(filename) === "computer-reply") received.resolve();
    });
    watcher.on("error", received.reject);
    try {
      await backend.start();
      await received.promise;
    } finally {
      watcher.close();
    }
    const reply = JSON.parse(await readFile(join(home, "computer-reply"), "utf8")) as unknown;
    expect(reply).toMatchObject({
      type: "cox:computer-reply",
      id: "req",
      ok: false,
      error: { code: "engine", message: expect.stringContaining("desktop host broke") },
    });
    expect(onLog).toHaveBeenCalledWith(expect.stringContaining("desktop host broke"));
  });

  it("reports early startup failures without attaching to another service", async () => {
    const { backend, onUnexpectedExit } = await createBackend("exit");
    await expect(backend.start()).rejects.toThrow("code 7");
    expect(onUnexpectedExit).not.toHaveBeenCalled();
  });

  it("waits for its runtime descriptor after the address is logged", async () => {
    const { backend, home } = await createBackend("late-state");
    const origin = await backend.start();
    const state = JSON.parse(
      await readFile(join(home, "userdata", "server-runtime.json"), "utf8"),
    ) as { origin: string };
    expect(state.origin).toBe(origin);
    expect((await fetch(`${origin}/api/auth/session`)).status).toBe(200);
  });

  it("replaces a stale runtime descriptor before checking backend readiness", async () => {
    const { backend, home } = await createBackend("stale-state");
    const origin = await backend.start();
    const state: unknown = JSON.parse(
      await readFile(join(home, "userdata", "server-runtime.json"), "utf8"),
    );
    expect(state).toMatchObject({ origin });
    expect(state).not.toMatchObject({ pid: 1 });
    expect((await fetch(`${origin}/api/auth/session`)).status).toBe(200);
  });

  it.each(["wrong-owner", "wrong-origin", "late-wrong-owner"])(
    "times out without probing a mismatched runtime descriptor (%s)",
    async (mode) => {
      const { backend } = await createBackend(mode, { startupTimeoutMs: 1_500 });
      const fetch = vi.spyOn(globalThis, "fetch");
      try {
        await expect(backend.start()).rejects.toThrow("did not become ready within 1.5 seconds");
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        fetch.mockRestore();
      }
    },
  );

  it("does not retry a malformed runtime descriptor", async () => {
    const { backend } = await createBackend("malformed-state");
    await expect(backend.start()).rejects.toBeInstanceOf(SyntaxError);
  });

  it("bounds and cancels waiting for a missing runtime descriptor", async () => {
    const { backend, onLog } = await createBackend("missing-state");
    const waiting = Promise.withResolvers<void>();
    let output = "";
    onLog.mockImplementation((message: string) => {
      output += message;
      if (output.includes("Local URL:")) waiting.resolve();
    });
    vi.useFakeTimers();
    const startup = backend.start();
    const failure = expect(startup).rejects.toThrow("did not become ready");
    await waiting.promise;
    await vi.advanceTimersByTimeAsync(180_000);
    await failure;
    vi.useRealTimers();
  });

  it("waits past the startup timeout during an announced database migration", async () => {
    const { backend, onLog } = await createBackend("migrating");
    const waiting = Promise.withResolvers<void>();
    let output = "";
    onLog.mockImplementation((message: string) => {
      output += message;
      if (output.includes("Running database migrations")) waiting.resolve();
    });
    vi.useFakeTimers();
    const startup = backend.start();
    const ready = expect(startup).resolves.toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await waiting.promise;
    await vi.advanceTimersByTimeAsync(180_000);
    await ready;
  });

  it("bounds startup waiting and cleans up the started process", async () => {
    const { backend, onLog } = await createBackend("timeout");
    const waiting = Promise.withResolvers<void>();
    onLog.mockImplementation((message: string) => {
      if (message.includes("FIXTURE_WAITING")) waiting.resolve();
    });
    vi.useFakeTimers();
    const startup = backend.start();
    const failure = expect(startup).rejects.toThrow("did not become ready within 180 seconds");
    await waiting.promise;
    await vi.advanceTimersByTimeAsync(180_000);
    await failure;
    vi.useRealTimers();
  });

  it("publishes the latest complete migration step and clears it after the upgrade", async () => {
    const onMigrationProgress = vi.fn();
    const { backend } = await createBackend("migrating", { onMigrationProgress });
    await backend.start();
    expect(onMigrationProgress).toHaveBeenCalledWith({ current: 2, total: 2 });
    expect(onMigrationProgress).toHaveBeenLastCalledWith(null);
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

  it.runIf(process.platform !== "win32").each([
    { mode: "normal", freeze: true, exit: [0, null] },
    { mode: "stubborn", freeze: false, exit: [null, "SIGKILL"] },
  ])("stops the $mode backend after the launcher dies", async ({ mode, freeze, exit }) => {
    const { home, entry } = await createBackend(mode);
    const child = spawn(
      process.execPath,
      ["--import", pathToFileURL(preload).href, entry, "--home-dir", home],
      {
        env: {
          ...process.env,
          COX_DESKTOP_PARENT_PID: String(process.pid),
          COX_DESKTOP_RECOVERY_PIPE: "1",
          FIXTURE_MODE: mode,
        },
        detached: true,
        stdio: ["ignore", "pipe", "pipe", "ipc", "pipe"],
      },
    );
    const exited = once(child, "exit");
    cleanups.unshift(async () => {
      if (child.exitCode === null && child.signalCode === null && child.pid)
        process.kill(-child.pid, "SIGKILL");
      await exited;
    });
    child.on("message", (message: unknown) => {
      if (message === "cox:backend-ready-to-start") child.send("cox:backend-start");
    });
    await once(child.stdout!, "data");
    if (freeze) child.kill("SIGSTOP");
    child.disconnect();
    child.stdio[4]?.destroy();
    expect(await exited).toEqual(exit);
    if (freeze) expect(await readFile(join(home, "stopped"), "utf8")).toBe("graceful");
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

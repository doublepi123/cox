import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { BackendUpdates } from "./backend-updates.ts";
import type { DesktopBackendUpdateState, DesktopUpdateProgress } from "@t3tools/contracts";
import type { installBackendRelease } from "./backend-install.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const metadata = (
  version = "0.1.2",
  compatibility: unknown = { protocol: 1, nodeVersion: "26.12.1" },
) => ({
  name: "@doublepi123/cox",
  version,
  coxDesktop: compatibility,
  dist: {
    tarball: "https://registry.npmjs.org/@doublepi123/cox/-/cox-" + version + ".tgz",
    integrity: "sha512-" + Buffer.alloc(64).toString("base64"),
  },
});

const phaseProgress = (phase: DesktopUpdateProgress["phase"]): DesktopUpdateProgress => ({
  phase,
  transferredBytes: 0,
  totalBytes: null,
  bytesPerSecond: null,
  remainingSeconds: null,
});

async function fixture(bundledVersion: string | null = "0.1.1") {
  const home = await mkdtemp(join(tmpdir(), "cox-updates-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const bundle = join(home, "bundle");
  await mkdir(bundle);
  await writeFile(join(bundle, "bundled.txt"), "bundled Cox");
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(metadata())));
  const install = vi.fn<typeof installBackendRelease>(async (input) => {
    input.onProgress?.({
      phase: "downloading",
      transferredBytes: 10,
      totalBytes: 20,
      bytesPerSecond: 5,
      remainingSeconds: 2,
    });
    input.onProgress?.(phaseProgress("verifying"));
    input.onProgress?.(phaseProgress("installing"));
    const server = join(input.directory, "server");
    await mkdir(server, { recursive: true });
    await writeFile(
      join(input.directory, "installed.json"),
      JSON.stringify({
        version: input.release.version,
        protocol: 1,
        nodeVersion: "26.12.1",
      }),
    );
    return server;
  });
  const validate = vi.fn(async () => {});
  const onState = vi.fn<(state: DesktopBackendUpdateState) => void>();
  const options = {
    home,
    desktopVersion: "0.2.0",
    bundledVersion,
    bundledDirectory: bundle,
    nodeVersion: "26.12.1",
    node: process.execPath,
    npm: "/fixture/npm-cli.js",
    environment: process.env,
    fetcher,
    install,
    validate,
    onState,
  };
  const make = (offline = false, bundleVersion = bundledVersion, development = false) => {
    const manager = new BackendUpdates({
      ...options,
      bundledVersion: bundleVersion,
      offline,
      development,
    });
    cleanups.unshift(() => manager.close());
    return manager;
  };
  const manager = make();
  const start = vi.fn(async (_directory: string) => "http://127.0.0.1:12345");
  const stop = vi.fn(async () => {});
  const data = join(home, "userdata");
  const stateFile = join(home, "backend-updates", "state.json");
  const disk = async () =>
    JSON.parse(await readFile(stateFile, "utf8")) as {
      active: { id: string; version: string } | null;
      pending: { id: string; version: string } | null;
      transition: { backup: string } | null;
      backup: string;
      failedVersion: string | null;
    };
  return {
    home,
    get bundle() {
      return start.mock.calls[0]?.[0] ?? bundle;
    },
    manager,
    make,
    start,
    stop,
    fetcher,
    install,
    validate,
    data,
    onState,
    disk,
    stateFile,
  };
}

describe("managed desktop Cox backend", () => {
  it("publishes first-install progress before starting the web backend and clears it on success", async () => {
    const test = await fixture(null);
    expect(test.manager.getState().progress).toBeNull();
    test.validate.mockImplementation(async () => {
      expect(test.manager.getState().progress).toEqual(phaseProgress("validating"));
      expect(test.start).not.toHaveBeenCalled();
    });
    test.start.mockImplementation(async () => {
      expect(test.manager.getState().progress).toEqual(phaseProgress("starting"));
      return "http://127.0.0.1:12345";
    });
    await test.manager.launch(test.start, test.stop);
    const phases = test.onState.mock.calls.flatMap(([state]) =>
      state.progress ? [state.progress.phase] : [],
    );
    expect(phases).toEqual([
      "downloading",
      "downloading",
      "verifying",
      "installing",
      "validating",
      "starting",
    ]);
    expect(
      test.onState.mock.calls.find(([state]) => state.progress?.transferredBytes === 10)?.[0],
    ).toMatchObject({
      status: "installing",
      progress: { totalBytes: 20, bytesPerSecond: 5, remainingSeconds: 2 },
    });
    expect(test.manager.getState()).toMatchObject({
      status: "idle",
      currentVersion: "0.1.2",
      progress: null,
    });
  });

  it("reports bundled copy, validation and startup as indeterminate phases without downloading", async () => {
    const test = await fixture();
    await test.manager.launch(test.start, test.stop);
    expect(
      test.onState.mock.calls.flatMap(([state]) => (state.progress ? [state.progress] : [])),
    ).toEqual([
      phaseProgress("installing"),
      phaseProgress("validating"),
      phaseProgress("starting"),
    ]);
    expect(test.manager.getState().progress).toBeNull();
    expect(test.fetcher).not.toHaveBeenCalled();
  });

  it("clears staged progress and does not leak it into a later metadata check", async () => {
    const test = await fixture();
    await test.manager.launch(test.start, test.stop);
    await test.manager.check();
    expect(await test.manager.stage()).toMatchObject({ status: "ready", progress: null });
    const next = test.make();
    await next.launch(test.start, test.stop);
    test.onState.mockClear();
    await next.check();
    expect(test.onState.mock.calls[0]?.[0]).toMatchObject({
      status: "checking",
      progress: null,
    });
    expect(test.onState.mock.calls.every(([state]) => state.progress === null)).toBe(true);
  });

  it.each(["download", "verification", "installation", "validation"])(
    "clears progress after a first-install %s failure and retries on the same manager",
    async (failure) => {
      const test = await fixture(null);
      if (failure === "validation")
        test.validate.mockRejectedValueOnce(new Error("validation failed"));
      else
        test.install.mockImplementationOnce(async (input) => {
          input.onProgress?.(
            phaseProgress(
              failure === "download"
                ? "downloading"
                : failure === "verification"
                  ? "verifying"
                  : "installing",
            ),
          );
          throw new Error(failure + " failed");
        });
      await expect(test.manager.launch(test.start, test.stop)).rejects.toThrow(failure + " failed");
      expect(test.manager.getState()).toMatchObject({
        status: "error",
        currentVersion: null,
        progress: null,
      });
      expect(test.start).not.toHaveBeenCalled();
      await test.manager.launch(test.start, test.stop);
      expect(test.manager.getState()).toMatchObject({
        status: "idle",
        currentVersion: "0.1.2",
        progress: null,
      });
      expect(test.install).toHaveBeenCalledTimes(2);
    },
  );

  it("clears first-start progress after failure and can install again", async () => {
    const test = await fixture(null);
    test.start.mockRejectedValueOnce(new Error("startup failed"));
    await expect(test.manager.launch(test.start, test.stop)).rejects.toThrow("startup failed");
    expect(test.manager.getState()).toMatchObject({
      status: "error",
      currentVersion: null,
      progress: null,
    });
    await test.manager.launch(test.start, test.stop);
    expect(test.manager.getState()).toMatchObject({
      status: "idle",
      currentVersion: "0.1.2",
      progress: null,
    });
  });

  it("reports a failed bundled validation and clears progress before retrying", async () => {
    const test = await fixture();
    test.validate.mockRejectedValueOnce(new Error("invalid bundle"));
    await expect(test.manager.launch(test.start, test.stop)).rejects.toThrow("invalid bundle");
    expect(test.manager.getState()).toMatchObject({ status: "error", progress: null });
    await test.manager.launch(test.start, test.stop);
    expect(test.manager.getState()).toMatchObject({ status: "idle", progress: null });
  });

  it("clears startup progress and stops a failed existing backend before retrying", async () => {
    const test = await fixture();
    await test.manager.launch(test.start, test.stop);
    const next = test.make();
    let live = false;
    let failures = 1;
    test.start.mockImplementation(async () => {
      if (live) throw new Error("The previous Cox backend is still running.");
      live = true;
      if (failures-- > 0) throw new Error("existing backend failed");
      return "http://127.0.0.1:12345";
    });
    test.stop.mockImplementation(async () => {
      live = false;
    });
    await expect(next.launch(test.start, test.stop)).rejects.toThrow("existing backend failed");
    expect(next.getState()).toMatchObject({ status: "error", progress: null });
    expect(test.stop).toHaveBeenCalledOnce();
    await expect(next.launch(test.start, test.stop)).resolves.toBe("http://127.0.0.1:12345");
    expect(next.getState().progress).toBeNull();
  });

  it("stops a failed rollback backend start before retrying", async () => {
    const test = await fixture();
    await test.manager.launch(test.start, test.stop);
    await test.manager.check();
    await test.manager.stage();
    const next = test.make();
    let live = false;
    let starts = 0;
    test.start.mockImplementation(async () => {
      if (live) throw new Error("The previous Cox backend is still running.");
      live = true;
      starts++;
      if (starts === 1) throw new Error("candidate failed");
      if (starts === 2) throw new Error("rollback failed");
      return "http://127.0.0.1:12345";
    });
    test.stop.mockImplementation(async () => {
      live = false;
    });
    await expect(next.launch(test.start, test.stop)).rejects.toThrow("rollback failed");
    expect(test.stop).toHaveBeenCalledTimes(2);
    await expect(next.launch(test.start, test.stop)).resolves.toBe("http://127.0.0.1:12345");
  });

  it("persists an ignored version while still offering newer releases", async () => {
    const test = await fixture();
    await test.manager.launch(test.start, test.stop);
    await test.manager.check();
    expect(await test.manager.setPolicy("ignore-version", "0.1.2")).toMatchObject({
      status: "idle",
      latestVersion: null,
      automaticChecks: true,
      ignoredVersion: "0.1.2",
    });
    const restarted = test.make();
    await restarted.launch(test.start, test.stop);
    expect((await restarted.check()).status).toBe("idle");
    expect(restarted.getState().latestVersion).toBeNull();
    expect((await restarted.check(true)).status).toBe("available");
    test.fetcher.mockImplementation(async () => new Response(JSON.stringify(metadata("0.1.3"))));
    expect(await restarted.check()).toMatchObject({ status: "available", latestVersion: "0.1.3" });
    expect(test.install).not.toHaveBeenCalled();
    expect(test.stop).not.toHaveBeenCalled();
  });

  it("permanently disables automatic checks across restarts but allows explicit checks", async () => {
    const test = await fixture();
    await test.manager.launch(test.start, test.stop);
    await test.manager.setPolicy("never");
    const restarted = test.make();
    await restarted.launch(test.start, test.stop);
    expect(await restarted.check()).toMatchObject({ automaticChecks: false, status: "idle" });
    expect(test.fetcher).not.toHaveBeenCalled();
    expect(await restarted.check(true)).toMatchObject({
      automaticChecks: false,
      status: "available",
    });
    expect(test.fetcher).toHaveBeenCalledOnce();
    expect(test.stop).not.toHaveBeenCalled();
  });

  it("restores automatic checks and clears an ignored version", async () => {
    const test = await fixture();
    await test.manager.launch(test.start, test.stop);
    await test.manager.setPolicy("ignore-version", "0.1.2");
    await test.manager.setPolicy("automatic");
    const restarted = test.make();
    await restarted.launch(test.start, test.stop);
    expect(await restarted.check()).toMatchObject({
      automaticChecks: true,
      ignoredVersion: null,
      status: "available",
    });
    await restarted.setPolicy("never");
    await restarted.setPolicy("automatic");
    expect((await restarted.check()).status).toBe("available");
  });

  it("does not dismiss a newer release when ignoring the version shown by an older dialog", async () => {
    const test = await fixture();
    await test.manager.launch(test.start, test.stop);
    await test.manager.check();
    expect(await test.manager.setPolicy("ignore-version", "0.1.0")).toMatchObject({
      status: "available",
      latestVersion: "0.1.2",
      ignoredVersion: "0.1.0",
    });
  });

  it("suppresses a check already in flight when automatic checks are disabled", async () => {
    const test = await fixture();
    await test.manager.launch(test.start, test.stop);
    const response = Promise.withResolvers<Response>();
    test.fetcher.mockImplementation(() => response.promise);
    const checking = test.manager.check();
    await test.manager.setPolicy("never");
    response.resolve(new Response(JSON.stringify(metadata())));
    expect(await checking).toMatchObject({
      status: "idle",
      latestVersion: null,
      automaticChecks: false,
    });
    expect(test.onState.mock.calls.some(([state]) => state.status === "available")).toBe(false);
  });

  it("flushes accepted preference changes before closing", async () => {
    const test = await fixture();
    await test.manager.launch(test.start, test.stop);
    const change = test.manager.setPolicy("never");
    await test.manager.close();
    await change;
    expect(
      JSON.parse(await readFile(join(test.home, "backend-updates/preferences.json"), "utf8")),
    ).toEqual({ automaticChecks: false, ignoredVersion: null });
  });

  it("does not let ignored updates block required client-only first installation", async () => {
    const test = await fixture(null);
    const directory = join(test.home, "backend-updates");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "preferences.json"),
      JSON.stringify({ automaticChecks: false, ignoredVersion: null }),
    );
    await test.manager.launch(test.start, test.stop);
    expect(test.manager.getState()).toMatchObject({
      automaticChecks: false,
      currentVersion: "0.1.2",
    });
    expect(test.install).toHaveBeenCalledOnce();
  });

  it("rejects invalid ignored versions before writing preferences", async () => {
    const test = await fixture();
    await test.manager.launch(test.start, test.stop);
    await expect(test.manager.setPolicy("ignore-version", "../../0.1.2")).rejects.toThrow(
      "valid version",
    );
    await expect(
      readFile(join(test.home, "backend-updates/preferences.json"), "utf8"),
    ).rejects.toThrow();
  });

  it("rejects malformed saved update preferences", async () => {
    const test = await fixture();
    const directory = join(test.home, "backend-updates");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "preferences.json"),
      JSON.stringify({ automaticChecks: "false", ignoredVersion: null }),
    );
    await expect(test.manager.launch(test.start, test.stop)).rejects.toThrow(
      "Invalid Cox update preferences.",
    );
    expect(test.start).not.toHaveBeenCalled();
  });

  it("preserves staged updates and running data when disabling automatic checks", async () => {
    const test = await fixture();
    await mkdir(test.data);
    await writeFile(join(test.data, "database"), "unchanged");
    await test.manager.launch(test.start, test.stop);
    await test.manager.check();
    await test.manager.stage();
    expect(await test.manager.setPolicy("never")).toMatchObject({
      status: "ready",
      automaticChecks: false,
    });
    expect((await test.disk()).pending?.version).toBe("0.1.2");
    expect(await readFile(join(test.data, "database"), "utf8")).toBe("unchanged");
    expect(test.start).toHaveBeenCalledOnce();
    expect(test.stop).not.toHaveBeenCalled();
  });

  it("keeps development workspace symlinks in place instead of copying them into a runtime cache", async () => {
    const test = await fixture();
    const development = test.make(true, "0.1.1", true);
    await development.launch(test.start, test.stop);
    expect(test.validate).not.toHaveBeenCalled();
    await expect(readFile(test.stateFile, "utf8")).rejects.toThrow();
    expect(test.fetcher).not.toHaveBeenCalled();
  });
  it("starts the bundled backend without requiring a network request", async () => {
    const test = await fixture();
    await test.manager.launch(test.start, test.stop);
    expect(test.start).toHaveBeenCalledWith(test.bundle);
    expect(await readFile(join(test.bundle, "bundled.txt"), "utf8")).toBe("bundled Cox");
    expect(test.fetcher).not.toHaveBeenCalled();
    expect(test.manager.getState()).toMatchObject({
      desktopVersion: "0.2.0",
      currentVersion: "0.1.1",
    });
  });

  it("stages an upgrade without touching running data or restarting the backend", async () => {
    const test = await fixture();
    await mkdir(test.data);
    await writeFile(join(test.data, "database"), "before");
    await test.manager.launch(test.start, test.stop);
    expect((await test.manager.check()).status).toBe("available");
    expect((await test.manager.stage()).status).toBe("ready");
    expect(await readFile(join(test.data, "database"), "utf8")).toBe("before");
    expect(test.start).toHaveBeenCalledOnce();
    expect(test.stop).not.toHaveBeenCalled();
    expect((await test.disk()).active?.version).toBe("0.1.1");
    expect((await test.disk()).pending?.version).toBe("0.1.2");
  });

  it("waits for an ongoing update check before downloading", async () => {
    const test = await fixture();
    await test.manager.launch(test.start, test.stop);
    const checking = test.manager.check();
    const staging = test.manager.stage();
    await checking;
    expect((await staging).status).toBe("ready");
    expect(test.install).toHaveBeenCalledOnce();
    expect(test.stop).not.toHaveBeenCalled();
  });

  it("downloads when an available-state listener accepts before the check finishes", async () => {
    const test = await fixture();
    await test.manager.launch(test.start, test.stop);
    let staging: Promise<unknown> | undefined;
    test.onState.mockImplementation((state) => {
      if (state.status === "available") staging = test.manager.stage();
    });
    await test.manager.check();
    expect(staging).toBeDefined();
    await staging;
    expect(test.manager.getState().status).toBe("ready");
    expect(test.install).toHaveBeenCalledOnce();
    expect((await test.disk()).pending?.version).toBe("0.1.2");
  });

  it("activates on the next launch and retains the matching pre-migration backup", async () => {
    const test = await fixture();
    await mkdir(test.data);
    await writeFile(join(test.data, "database"), "before");
    await test.manager.launch(test.start, test.stop);
    await test.manager.check();
    await test.manager.stage();
    await test.manager.close();
    const next = test.make();
    await next.launch(async () => {
      await writeFile(join(test.data, "database"), "migrated");
      return "http://127.0.0.1:54321";
    }, test.stop);
    const state = await test.disk();
    expect(state.active?.version).toBe("0.1.2");
    expect(state.pending).toBeNull();
    expect(state.transition).toBeNull();
    expect(
      await readFile(
        join(test.home, "backend-updates", "backups", state.backup, "userdata", "database"),
        "utf8",
      ),
    ).toBe("before");
    expect(next.getState().currentVersion).toBe("0.1.2");
  });

  it("restores both code and data before starting the previous backend after a failed migration", async () => {
    const test = await fixture();
    await mkdir(test.data);
    await writeFile(join(test.data, "database"), "before");
    await test.manager.launch(test.start, test.stop);
    await test.manager.check();
    await test.manager.stage();
    const next = test.make();
    await next.launch(async (directory) => {
      if (directory !== test.bundle) {
        await writeFile(join(test.data, "database"), "broken-migration");
        throw new Error("candidate failed");
      }
      expect(await readFile(join(test.data, "database"), "utf8")).toBe("before");
      return "http://127.0.0.1:12345";
    }, test.stop);
    expect(test.stop).toHaveBeenCalledOnce();
    expect((await test.disk()).failedVersion).toBe("0.1.2");
    expect(next.getState()).toMatchObject({
      currentVersion: "0.1.1",
      status: "error",
      progress: null,
    });
    expect((await next.check()).status).toBe("error");
    expect((await next.check(true)).status).toBe("available");
  });

  it("recovers an interrupted activation before letting the old code read migrated data", async () => {
    const test = await fixture();
    await mkdir(test.data);
    await writeFile(join(test.data, "database"), "before");
    await test.manager.launch(test.start, test.stop);
    await test.manager.check();
    await test.manager.stage();
    const crashed = test.make();
    await expect(
      crashed.launch(
        async () => {
          await writeFile(join(test.data, "database"), "migration-in-progress");
          throw new Error("crash");
        },
        async () => {
          throw new Error("stop failed");
        },
      ),
    ).rejects.toThrow("stop failed");
    expect((await test.disk()).transition).not.toBeNull();
    const recovered = test.make();
    await recovered.launch(async (directory) => {
      expect(directory).toBe(test.bundle);
      expect(await readFile(join(test.data, "database"), "utf8")).toBe("before");
      return "http://127.0.0.1:12345";
    }, test.stop);
    expect((await test.disk()).transition).toBeNull();
  });

  it("bootstraps a client-only install and can subsequently start entirely offline", async () => {
    const test = await fixture(null);
    await test.manager.launch(test.start, test.stop);
    expect(test.fetcher).toHaveBeenCalledOnce();
    expect(test.install).toHaveBeenCalledOnce();
    expect(test.validate).toHaveBeenCalledOnce();
    expect(test.manager.getState()).toMatchObject({
      bundledVersion: null,
      currentVersion: "0.1.2",
    });
    const offline = test.make(true);
    await offline.launch(test.start, test.stop);
    expect(test.fetcher).toHaveBeenCalledOnce();
    expect((await offline.check()).status).toBe("error");
  });

  it("keeps first-install failures retryable without claiming an installed backend", async () => {
    const test = await fixture(null);
    test.fetcher.mockRejectedValueOnce(new Error("offline"));
    await expect(test.manager.launch(test.start, test.stop)).rejects.toThrow("offline");
    expect(test.install).not.toHaveBeenCalled();
    expect(test.start).not.toHaveBeenCalled();
    await test.manager.launch(test.start, test.stop);
    expect(test.manager.getState().currentVersion).toBe("0.1.2");
  });

  it("refuses a first offline launch instead of looking for a global Cox installation", async () => {
    const test = await fixture(null);
    await expect(test.make(true).launch(test.start, test.stop)).rejects.toThrow("first launch");
    expect(test.fetcher).not.toHaveBeenCalled();
    expect(test.start).not.toHaveBeenCalled();
  });

  it("refuses incompatible updates without installing or disrupting the current backend", async () => {
    const test = await fixture();
    await test.manager.launch(test.start, test.stop);
    test.fetcher.mockResolvedValue(
      new Response(JSON.stringify(metadata("0.1.3", { protocol: 2, nodeVersion: "27.0.0" }))),
    );
    expect((await test.manager.check()).status).toBe("incompatible");
    await test.manager.stage();
    expect(test.install).not.toHaveBeenCalled();
    expect(test.stop).not.toHaveBeenCalled();
  });

  it("does not downgrade when latest is older than the active version", async () => {
    const test = await fixture("0.2.0");
    await test.manager.launch(test.start, test.stop);
    expect((await test.manager.check()).status).toBe("idle");
    await test.manager.stage();
    expect(test.install).not.toHaveBeenCalled();
  });

  it("leaves the current installation intact if candidate validation fails", async () => {
    const test = await fixture();
    await test.manager.launch(test.start, test.stop);
    test.validate.mockRejectedValueOnce(new Error("bad native module"));
    await test.manager.check();
    expect(await test.manager.stage()).toMatchObject({ status: "error", progress: null });
    expect(await readdir(join(test.home, "backend-updates", "versions"))).toHaveLength(1);
    expect(test.stop).not.toHaveBeenCalled();
  });

  it("refuses to change data while a previous backend process is still alive", async () => {
    const test = await fixture();
    await mkdir(test.data);
    await writeFile(join(test.data, "server-runtime.json"), JSON.stringify({ pid: process.pid }));
    await expect(test.manager.launch(test.start, test.stop)).rejects.toThrow("still running");
    expect(test.start).not.toHaveBeenCalled();
    expect(test.fetcher).not.toHaveBeenCalled();
  });

  it("also blocks a previous backend that has not published its HTTP address yet", async () => {
    const test = await fixture();
    await writeFile(join(test.home, "backend-owner.json"), JSON.stringify({ pid: process.pid }));
    await expect(test.manager.launch(test.start, test.stop)).rejects.toThrow("still running");
    expect(test.start).not.toHaveBeenCalled();
  });

  it("rejects persisted path traversal instead of selecting another installation", async () => {
    const test = await fixture();
    await test.manager.launch(test.start, test.stop);
    await writeFile(
      test.stateFile,
      JSON.stringify({
        schema: 1,
        active: { id: "../../elsewhere", version: "0.1.2" },
        previous: null,
        pending: null,
        transition: null,
        backup: null,
        failedVersion: null,
      }),
    );
    await expect(test.make().launch(test.start, test.stop)).rejects.toThrow("Invalid managed");
  });

  it("serializes installers and cancels staging without stopping active work", async () => {
    const test = await fixture();
    await test.manager.launch(test.start, test.stop);
    await test.manager.check();
    const entered = Promise.withResolvers<void>();
    test.install.mockImplementation(async (input) => {
      entered.resolve();
      return new Promise<string>((_resolve, reject) => {
        input.signal.addEventListener("abort", () => reject(new Error("cancelled")), {
          once: true,
        });
      });
    });
    const staging = test.manager.stage();
    await entered.promise;
    const concurrent = test.manager.stage();
    await test.manager.close();
    expect(await staging).toMatchObject({ status: "error", progress: null });
    expect(await concurrent).toMatchObject({ status: "error", progress: null });
    expect(test.install).toHaveBeenCalledOnce();
    expect(test.stop).not.toHaveBeenCalled();
    expect(await readdir(join(test.home, "backend-updates", "versions"))).toHaveLength(1);
  });

  it("never falls back to bundled older code when an active managed installation is missing", async () => {
    const test = await fixture(null);
    await test.manager.launch(test.start, test.stop);
    const installed = (await test.disk()).active!;
    await rm(join(test.home, "backend-updates", "versions", installed.id), { recursive: true });
    const start = vi.fn(async () => "http://127.0.0.1:12345");
    await expect(test.make().launch(start, test.stop)).rejects.toThrow();
    expect(start).not.toHaveBeenCalled();
  });

  it("activates a newer bundled Cox without a download and preserves it across a client-only offline install", async () => {
    const test = await fixture();
    await test.manager.launch(test.start, test.stop);
    const combined = test.make(true, "0.1.3");
    await combined.launch(test.start, test.stop);
    expect(combined.getState().currentVersion).toBe("0.1.3");
    expect(test.fetcher).not.toHaveBeenCalled();
    expect(test.install).not.toHaveBeenCalled();
    const clientOnly = test.make(true, null);
    await clientOnly.launch(test.start, test.stop);
    expect(clientOnly.getState()).toMatchObject({ currentVersion: "0.1.3", bundledVersion: null });
    expect(test.fetcher).not.toHaveBeenCalled();
  });

  it("keeps a staged Cox newer than the backend included in a client update", async () => {
    const test = await fixture();
    await test.manager.launch(test.start, test.stop);
    test.fetcher.mockResolvedValue(new Response(JSON.stringify(metadata("0.1.5"))));
    await test.manager.check();
    await test.manager.stage();
    const combined = test.make(true, "0.1.4");
    await combined.launch(test.start, test.stop);
    expect(combined.getState().currentVersion).toBe("0.1.5");
  });
});

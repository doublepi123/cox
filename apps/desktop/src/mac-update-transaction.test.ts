import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  loadMacUpdateLaunch,
  macUpdatePaths,
  macUpdateInProgress,
  readMacUpdateTransaction,
  runMacUpdateTransaction,
  writeMacUpdateState,
  type MacUpdateOperations,
  type MacUpdateTransaction,
} from "./mac-update-transaction.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cox-mac-update-")));
  directories.push(root);
  const home = join(root, ".cox", "desktop");
  const target = join(root, "Applications", "Cox.app");
  const transaction: MacUpdateTransaction = {
    schema: 1,
    id: randomUUID(),
    target,
    oldPid: 1234,
    currentVersion: "0.2.4",
    version: "0.2.5",
    architecture: "arm64",
    flavor: "bundled",
    backendVersion: "0.1.44",
    offline: true,
  };
  const paths = macUpdatePaths(home, transaction.id, target);
  await Promise.all([
    mkdir(paths.directory, { recursive: true }),
    mkdir(target, { recursive: true }),
    mkdir(paths.staged, { recursive: true }),
    mkdir(join(home, "userdata"), { recursive: true }),
    mkdir(join(home, "backend-updates"), { recursive: true }),
    mkdir(join(home, "browser"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(paths.directory, "transaction.json"), JSON.stringify(transaction)),
    writeFile(join(target, "version"), "old"),
    writeFile(join(paths.staged, "version"), "new"),
    writeFile(join(home, "userdata", "database"), "old-data"),
    writeFile(join(home, "backend-updates", "state.json"), "old-state"),
    writeFile(join(home, "browser", "Preferences"), "old-browser"),
  ]);
  const launch = vi.fn<MacUpdateOperations["launch"]>(async (_application, current) => {
    if (current)
      await writeMacUpdateState(paths.directory, "healthy.json", {
        id: current.id,
        version: current.version,
        pid: 5678,
      });
    return { pid: 5678, exited: () => false, stop: async () => {} };
  });
  const operations: MacUpdateOperations = {
    verify: vi.fn(async () => {}),
    launch,
    isAlive: () => false,
    sleep: async () => {},
    timeoutMs: 0,
  };
  return { root, home, target, transaction, paths, launch, operations };
}

describe("macOS application update transactions", () => {
  it("reserves the data directory during replacement and admits only the expected relaunch", async () => {
    const test = await fixture();
    const alive = (pid: number) => pid === process.pid;
    test.operations.isAlive = alive;
    test.launch.mockImplementation(async (_application, current) => {
      if (current) {
        expect(await macUpdateInProgress(test.home, undefined, alive)).toBe(true);
        expect(await macUpdateInProgress(test.home, current.id, alive)).toBe(false);
        await writeMacUpdateState(test.paths.directory, "healthy.json", {
          id: current.id,
          version: current.version,
          pid: 5678,
        });
      }
      return { pid: 5678, exited: () => false, stop: async () => {} };
    });
    await runMacUpdateTransaction(test.home, test.transaction.id, test.operations);
    expect(await macUpdateInProgress(test.home, undefined, alive)).toBe(false);
  });
  it("keeps an aged reservation active while its helper is alive", async () => {
    const test = await fixture();
    const reservation = join(test.home, "client-updates", "mac-applying.json");
    await writeMacUpdateState(join(test.home, "client-updates"), "mac-applying.json", {
      id: test.transaction.id,
      helperPid: process.pid,
    });
    const expired = 1_700_000_000;
    await utimes(reservation, expired, expired);
    expect(await macUpdateInProgress(test.home, undefined, () => true)).toBe(true);
    expect(await macUpdateInProgress(test.home, undefined, () => false)).toBe(false);
    expect(await macUpdateInProgress(test.home, test.transaction.id, () => true)).toBe(false);
  });
  it("restores the old app if placing the replacement fails after the old bundle was moved", async () => {
    const test = await fixture();
    let checks = 0;
    test.operations.verify = async () => {
      if (++checks === 2) await rm(test.paths.staged, { recursive: true });
    };
    expect(await runMacUpdateTransaction(test.home, test.transaction.id, test.operations)).toBe(
      "rolled-back",
    );
    expect(await readFile(join(test.target, "version"), "utf8")).toBe("old");
    expect(await readFile(join(test.home, "userdata", "database"), "utf8")).toBe("old-data");
    expect(test.launch).toHaveBeenCalledOnce();
    expect(test.launch).toHaveBeenCalledWith(test.target);
  });
  it("retains the running app until the parent exits and commits only after the replacement is healthy", async () => {
    const test = await fixture();
    let parentAlive = true;
    test.operations.isAlive = (pid) => pid === test.transaction.oldPid && parentAlive;
    test.operations.sleep = async () => {
      expect(await readFile(join(test.target, "version"), "utf8")).toBe("old");
      parentAlive = false;
    };
    expect(await runMacUpdateTransaction(test.home, test.transaction.id, test.operations)).toBe(
      "committed",
    );
    expect(await readFile(join(test.target, "version"), "utf8")).toBe("new");
    expect(await readFile(join(test.home, "userdata", "database"), "utf8")).toBe("old-data");
    expect(await readFile(join(test.home, "client-updates", "mac-result.json"), "utf8")).toBe(
      JSON.stringify({ version: "0.2.5", currentVersion: "0.2.5", status: "updated" }),
    );
    await expect(readdir(test.paths.previous)).rejects.toThrow();
    await expect(readdir(test.paths.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restores both application and matching data when a replacement migrates data and then fails", async () => {
    const test = await fixture();
    test.launch.mockImplementation(async (_application, current) => {
      if (current) {
        await writeFile(join(test.home, "userdata", "database"), "failed-migration");
        await writeFile(join(test.home, "backend-updates", "state.json"), "new-state");
        await writeFile(join(test.home, "browser", "Preferences"), "new-browser");
        throw new Error("App could not start");
      }
      expect(await readFile(join(test.home, "userdata", "database"), "utf8")).toBe("old-data");
      return { pid: 9, exited: () => false, stop: async () => {} };
    });
    expect(await runMacUpdateTransaction(test.home, test.transaction.id, test.operations)).toBe(
      "rolled-back",
    );
    expect(await readFile(join(test.target, "version"), "utf8")).toBe("old");
    expect(await readFile(join(test.home, "backend-updates", "state.json"), "utf8")).toBe(
      "old-state",
    );
    expect(await readFile(join(test.paths.directory, "failed-userdata", "database"), "utf8")).toBe(
      "failed-migration",
    );
    expect(test.launch).toHaveBeenCalledTimes(2);
    expect(await readFile(join(test.home, "browser", "Preferences"), "utf8")).toBe("old-browser");
    expect(await readFile(join(test.paths.directory, "status.json"), "utf8")).toContain(
      '"phase":"rolled-back"',
    );
  });

  it("refuses to restore data while an unresponsive replacement cannot be stopped", async () => {
    const test = await fixture();
    test.launch.mockResolvedValue({
      pid: 5678,
      exited: () => true,
      stop: async () => {
        throw new Error("Still running");
      },
    });
    await expect(
      runMacUpdateTransaction(test.home, test.transaction.id, test.operations),
    ).rejects.toThrow("Still running");
    expect(await readFile(join(test.target, "version"), "utf8")).toBe("new");
    expect(await readFile(join(test.paths.previous, "version"), "utf8")).toBe("old");
  });

  it("does not accept a readiness acknowledgment from a different process", async () => {
    const test = await fixture();
    const stop = vi.fn(async () => {});
    test.launch.mockImplementation(async (_application, current) => {
      if (current)
        await writeMacUpdateState(test.paths.directory, "healthy.json", {
          id: current.id,
          version: current.version,
          pid: 1,
        });
      return { pid: 5678, exited: () => false, stop };
    });
    expect(await runMacUpdateTransaction(test.home, test.transaction.id, test.operations)).toBe(
      "rolled-back",
    );
    expect(stop).toHaveBeenCalledOnce();
  });

  it("keeps the current installation untouched when validation or a data-path check fails", async () => {
    const test = await fixture();
    test.operations.verify = async () => {
      throw new Error("Signature invalid");
    };
    await expect(
      runMacUpdateTransaction(test.home, test.transaction.id, test.operations),
    ).rejects.toThrow("Signature invalid");
    expect(await readFile(join(test.target, "version"), "utf8")).toBe("old");
    test.operations.verify = async () => {};
    await rm(join(test.home, "userdata"), { recursive: true });
    await symlink(test.target, join(test.home, "userdata"));
    await expect(
      runMacUpdateTransaction(test.home, test.transaction.id, test.operations),
    ).rejects.toThrow("symbolic link");
    expect(test.launch).not.toHaveBeenCalled();
  });

  it("validates relaunch context before writing a readiness signal", async () => {
    const test = await fixture();
    await writeMacUpdateState(test.paths.directory, "status.json", { phase: "replaced" });
    await expect(
      loadMacUpdateLaunch(test.home, test.transaction.id, test.target, "0.2.6"),
    ).rejects.toThrow("Invalid macOS update launch");
    await expect(readMacUpdateTransaction(test.home, "../other")).rejects.toThrow("Invalid");
    const launch = await loadMacUpdateLaunch(test.home, test.transaction.id, test.target, "0.2.5");
    await launch.ready();
    expect(
      JSON.parse(await readFile(join(test.paths.directory, "healthy.json"), "utf8")),
    ).toMatchObject({ id: test.transaction.id, version: "0.2.5", pid: process.pid });
  });
});

import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { cleanupDiscardedMacUpdates, discardMacUpdate } from "./mac-update-cleanup.ts";
import {
  macUpdatePaths,
  writeMacUpdateState,
  type MacUpdateTransaction,
} from "./mac-update-transaction.ts";
import { MacAppUpdate } from "./mac-update.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cox-mac-cleanup-")));
  directories.push(root);
  const home = join(root, ".cox", "desktop");
  const target = join(root, "Applications", "Cox.app");
  const transaction: MacUpdateTransaction = {
    schema: 1,
    id: randomUUID(),
    target,
    oldPid: process.pid,
    currentVersion: "0.2.18",
    version: "0.2.19",
    architecture: "arm64",
    flavor: "bundled",
    backendVersion: "0.1.58",
    offline: true,
  };
  const paths = macUpdatePaths(home, transaction.id, target);
  for (const path of [paths.directory, paths.staged, target, join(home, "userdata")]) {
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "retained"), path);
  }
  await writeMacUpdateState(paths.directory, "transaction.json", transaction);
  const mark = () =>
    writeMacUpdateState(paths.directory, "discarded.json", {
      schema: 1,
      id: transaction.id,
      target,
    });
  return { root, home, target, transaction, paths, mark };
}

describe("discarded macOS update cleanup", () => {
  it("bounds deletion retries and removes only the owned staged bundle and cache", async () => {
    const { home, target, paths, transaction } = await fixture();
    const remove = vi.fn<typeof rm>(rm);
    await discardMacUpdate(home, transaction, remove);
    expect(remove.mock.calls).toEqual([
      [paths.staged, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }],
      [paths.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }],
    ]);
    await expect(readdir(paths.staged)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(paths.directory)).rejects.toMatchObject({ code: "ENOENT" });
    for (const path of [target, join(home, "userdata")])
      expect(await readFile(join(path, "retained"), "utf8")).toBe(path);
  });

  it("retries a failed discard on the next launch without the original transaction file", async () => {
    const { home, target, paths, transaction } = await fixture();
    const error = Object.assign(new Error("directory not empty"), { code: "ENOTEMPTY" });
    await expect(
      discardMacUpdate(home, transaction, async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(JSON.parse(await readFile(join(paths.directory, "discarded.json"), "utf8"))).toEqual({
      schema: 1,
      id: transaction.id,
      target,
    });
    await rm(join(paths.directory, "transaction.json"));
    const report = vi.fn();
    const update = new MacAppUpdate({
      home,
      application: target,
      node: process.execPath,
      helperDirectory: paths.directory,
      currentVersion: transaction.currentVersion,
      offline: true,
      onCleanupError: report,
    });
    await update.close();
    expect(report).not.toHaveBeenCalled();
    await expect(readdir(paths.staged)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(paths.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports a deferred cleanup without preventing startup or removing rollback data", async () => {
    const { home, target, paths, mark } = await fixture();
    await mark();
    const error = Object.assign(new Error("directory not empty"), { code: "ENOTEMPTY" });
    const report = vi.fn();
    await cleanupDiscardedMacUpdates(home, target, report, async () => {
      throw error;
    });
    expect(report).toHaveBeenCalledExactlyOnceWith(error);
    expect(await readdir(paths.directory)).toContain("discarded.json");
    expect(await readFile(join(home, "userdata", "retained"), "utf8")).toBe(join(home, "userdata"));
    await cleanupDiscardedMacUpdates(home, target, report);
    await expect(readdir(paths.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    "unmarked",
    "wrong target",
    "wrong id",
    "wrong schema",
    "invalid JSON",
    "active helper",
  ])("does not remove a transaction with %s", async (condition) => {
    const { home, target, paths, transaction, mark } = await fixture();
    if (condition !== "unmarked") await mark();
    if (condition === "invalid JSON") await writeFile(join(paths.directory, "discarded.json"), "{");
    else if (condition.startsWith("wrong"))
      await writeMacUpdateState(paths.directory, "discarded.json", {
        schema: condition === "wrong schema" ? 2 : 1,
        id: condition === "wrong id" ? randomUUID() : transaction.id,
        target: condition === "wrong target" ? join(home, "Other.app") : target,
      });
    if (condition === "active helper")
      await writeMacUpdateState(join(home, "client-updates"), "mac-applying.json", {
        id: transaction.id,
        helperPid: process.pid,
      });
    const remove = vi.fn<typeof rm>(rm);
    await cleanupDiscardedMacUpdates(home, target, vi.fn(), remove);
    expect(remove).not.toHaveBeenCalled();
    expect(await readFile(join(paths.staged, "retained"), "utf8")).toBe(paths.staged);
  });

  it.skipIf(process.platform === "win32")(
    "ignores symlinked transaction directories and discard markers",
    async () => {
      const { home, target, paths, mark } = await fixture();
      await mark();
      const alias = join(home, "client-updates", "mac-updates", randomUUID());
      await symlink(paths.directory, alias, "dir");
      const marker = join(paths.directory, "discarded.json");
      const external = join(home, "discarded.json");
      await writeFile(external, await readFile(marker));
      await rm(marker);
      await symlink(external, marker);
      const remove = vi.fn<typeof rm>(rm);
      await cleanupDiscardedMacUpdates(home, target, vi.fn(), remove);
      expect(remove).not.toHaveBeenCalled();
    },
  );

  it.each(["previous", "status.json", "userdata-backup", "browser-backup", "backend-state.json"])(
    "retains a transaction containing %s rollback evidence",
    async (name) => {
      const { home, target, paths, transaction, mark } = await fixture();
      await mark();
      const path = name === "previous" ? paths.previous : join(paths.directory, name);
      await mkdir(path, { recursive: true });
      await writeFile(join(path, "retained"), "rollback data");
      const remove = vi.fn<typeof rm>(rm);
      await expect(discardMacUpdate(home, transaction, remove)).rejects.toThrow("rollback data");
      const report = vi.fn();
      await cleanupDiscardedMacUpdates(home, target, report, remove);
      expect(remove).not.toHaveBeenCalled();
      expect(report).toHaveBeenCalledOnce();
      expect(await readFile(join(path, "retained"), "utf8")).toBe("rollback data");
    },
  );

  it("unlinks a staged symlink without following it", async () => {
    if (process.platform === "win32") return;
    const { home, target, paths, transaction } = await fixture();
    await rm(paths.staged, { recursive: true });
    await symlink(target, paths.staged, "dir");
    await discardMacUpdate(home, transaction);
    expect(await readFile(join(target, "retained"), "utf8")).toBe(target);
  });
});

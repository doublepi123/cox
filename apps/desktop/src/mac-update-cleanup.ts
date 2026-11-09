import { lstat, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  macUpdateInProgress,
  macUpdatePaths,
  writeMacUpdateState,
  type MacUpdateTransaction,
} from "./mac-update-transaction.ts";

const removalOptions = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 } as const;

async function assertDiscardable(directory: string, previous: string) {
  for (const path of [
    previous,
    ...["status.json", "userdata-backup", "browser-backup", "backend-state.json"].map((name) =>
      join(directory, name),
    ),
  ]) {
    const exists = await lstat(path)
      .then(() => true)
      .catch((error: unknown) => {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
          return false;
        throw error;
      });
    if (exists) throw new Error("Retaining macOS update rollback data.");
  }
}

export async function discardMacUpdate(
  home: string,
  transaction: MacUpdateTransaction,
  remove: typeof rm = rm,
) {
  const paths = macUpdatePaths(home, transaction.id, transaction.target);
  await assertDiscardable(paths.directory, paths.previous);
  await writeMacUpdateState(paths.directory, "discarded.json", {
    schema: 1,
    id: transaction.id,
    target: transaction.target,
  });
  await remove(paths.staged, removalOptions);
  await remove(paths.directory, removalOptions);
}

export async function cleanupDiscardedMacUpdates(
  home: string,
  application: string,
  report: (error: unknown) => void,
  remove: typeof rm = rm,
) {
  if (await macUpdateInProgress(home)) return;
  const directory = join(home, "client-updates", "mac-updates");
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
      report(error);
    return [];
  });
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
    try {
      const paths = macUpdatePaths(home, entry.name, application);
      const markerPath = join(paths.directory, "discarded.json");
      if (!(await lstat(markerPath)).isFile()) continue;
      const marker: unknown = JSON.parse(await readFile(markerPath, "utf8"));
      if (
        !marker ||
        typeof marker !== "object" ||
        !("schema" in marker) ||
        marker.schema !== 1 ||
        !("id" in marker) ||
        marker.id !== entry.name ||
        !("target" in marker) ||
        marker.target !== application
      )
        continue;
      await assertDiscardable(paths.directory, paths.previous);
      await remove(paths.staged, removalOptions);
      await remove(paths.directory, removalOptions);
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
        report(error);
    }
  }
}

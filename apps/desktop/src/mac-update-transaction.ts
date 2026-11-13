import { constants } from "node:fs";
import { cp, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export interface MacUpdateTransaction {
  readonly schema: 1;
  readonly id: string;
  readonly target: string;
  readonly oldPid: number;
  readonly currentVersion: string;
  readonly version: string;
  readonly architecture: "arm64" | "x64";
  readonly flavor: "bundled" | "client-only";
  readonly backendVersion: string | null;
  readonly offline: boolean;
}

export function macUpdatePaths(home: string, id: string, target: string) {
  if (
    !/^[a-f0-9-]{36}$/.test(id) ||
    !isAbsolute(home) ||
    !isAbsolute(target) ||
    !target.endsWith(".app") ||
    resolve(target) !== target
  )
    throw new Error("Invalid macOS update transaction.");
  return {
    directory: join(home, "client-updates", "mac-updates", id),
    staged: join(dirname(target), ".cox-update-" + id + ".app"),
    previous: join(dirname(target), ".cox-previous-" + id + ".app"),
  };
}

export async function readMacUpdateTransaction(
  home: string,
  id: string,
): Promise<MacUpdateTransaction> {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid macOS update transaction.");
  const value: unknown = JSON.parse(
    await readFile(join(home, "client-updates", "mac-updates", id, "transaction.json"), "utf8"),
  );
  if (
    !value ||
    typeof value !== "object" ||
    !("schema" in value) ||
    value.schema !== 1 ||
    !("id" in value) ||
    value.id !== id ||
    !("target" in value) ||
    typeof value.target !== "string" ||
    !("oldPid" in value) ||
    !Number.isSafeInteger(value.oldPid) ||
    Number(value.oldPid) < 1 ||
    !("currentVersion" in value) ||
    typeof value.currentVersion !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(value.currentVersion) ||
    !("version" in value) ||
    typeof value.version !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(value.version) ||
    !("architecture" in value) ||
    !["arm64", "x64"].includes(String(value.architecture)) ||
    !("flavor" in value) ||
    !["bundled", "client-only"].includes(String(value.flavor)) ||
    !("backendVersion" in value) ||
    (value.backendVersion !== null && typeof value.backendVersion !== "string") ||
    !("offline" in value) ||
    typeof value.offline !== "boolean"
  )
    throw new Error("Invalid macOS update transaction.");
  const transaction = value as MacUpdateTransaction;
  macUpdatePaths(home, id, transaction.target);
  return transaction;
}

export async function writeMacUpdateState(directory: string, name: string, value: unknown) {
  const temporary = join(directory, name + ".temporary");
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, join(directory, name));
}

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ESRCH")
      return false;
    throw error;
  }
}

async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
}

export async function macUpdateInProgress(
  home: string,
  requestedId?: string,
  isAlive = processIsAlive,
) {
  const path = join(home, "client-updates", "mac-applying.json");
  if (!(await exists(path))) return false;
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return false;
  }
  if (
    !value ||
    typeof value !== "object" ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    value.id === requestedId ||
    !("helperPid" in value) ||
    typeof value.helperPid !== "number" ||
    !Number.isSafeInteger(value.helperPid) ||
    value.helperPid < 1
  )
    return false;
  return isAlive(value.helperPid);
}

export interface MacUpdateChild {
  readonly pid: number;
  exited(): boolean;
  stop(): Promise<void>;
}

export interface MacUpdateOperations {
  verify(application: string, transaction: MacUpdateTransaction): Promise<void>;
  launch(application: string, transaction?: MacUpdateTransaction): Promise<MacUpdateChild>;
  ready?(): void;
  isAlive?: (pid: number) => boolean;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
}

async function assertBackendStopped(home: string, isAlive: (pid: number) => boolean) {
  const path = join(home, "backend-owner.json");
  if (!(await exists(path))) return;
  const owner: unknown = JSON.parse(await readFile(path, "utf8"));
  if (
    !owner ||
    typeof owner !== "object" ||
    !("pid" in owner) ||
    typeof owner.pid !== "number" ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid < 1 ||
    isAlive(owner.pid)
  )
    throw new Error("The owned Cox backend must stop before updating the client.");
}

export async function runMacUpdateTransaction(
  home: string,
  id: string,
  operations: MacUpdateOperations,
) {
  const transaction = await readMacUpdateTransaction(home, id);
  const paths = macUpdatePaths(home, id, transaction.target);
  const sleep = operations.sleep ?? ((milliseconds: number) => delay(milliseconds));
  const isAlive = operations.isAlive ?? processIsAlive;
  const timeoutMs = operations.timeoutMs ?? 300_000;
  if (await macUpdateInProgress(home, id, isAlive))
    throw new Error("Another Cox client update is already running.");
  if ((await realpath(transaction.target)) !== transaction.target || (await exists(paths.previous)))
    throw new Error("The installed Cox application changed during the update.");
  await operations.verify(paths.staged, transaction);
  await assertBackendStopped(home, isAlive);
  const data = join(home, "userdata");
  const state = join(home, "backend-updates", "state.json");
  const browser = join(home, "browser");
  const hadData = await exists(data);
  const hadState = await exists(state);
  const hadBrowser = await exists(browser);
  if (hadData && (!(await lstat(data)).isDirectory() || (await lstat(data)).isSymbolicLink()))
    throw new Error("The desktop data directory cannot be a symbolic link during an update.");
  if (hadState && (!(await lstat(state)).isFile() || (await lstat(state)).isSymbolicLink()))
    throw new Error("The backend update state cannot be a symbolic link.");
  if (
    hadBrowser &&
    (!(await lstat(browser)).isDirectory() || (await lstat(browser)).isSymbolicLink())
  )
    throw new Error("The desktop browser profile cannot be a symbolic link during an update.");
  if (hadData)
    await cp(data, join(paths.directory, "userdata-backup"), {
      recursive: true,
      verbatimSymlinks: true,
      mode: constants.COPYFILE_FICLONE,
    });
  if (hadState) await cp(state, join(paths.directory, "backend-state.json"));
  await writeMacUpdateState(paths.directory, "status.json", { phase: "armed", hadData, hadState });
  const reservation = join(home, "client-updates", "mac-applying.json");
  const releaseReservation = async () => {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(reservation, "utf8"));
    } catch {
      return;
    }
    if (value && typeof value === "object" && "id" in value && value.id === id)
      await rm(reservation, { force: true });
  };
  await writeMacUpdateState(join(home, "client-updates"), "mac-applying.json", {
    id,
    helperPid: process.pid,
  });
  try {
    operations.ready?.();
    const parentDeadline = performance.now() + 60_000;
    while (isAlive(transaction.oldPid)) {
      if (performance.now() >= parentDeadline)
        throw new Error("Cox did not quit. Its current installation was retained.");
      await sleep(100);
    }
    let moved = false;
    let replaced = false;
    let child: MacUpdateChild | undefined;
    try {
      await assertBackendStopped(home, isAlive);
      if (hadBrowser)
        await cp(browser, join(paths.directory, "browser-backup"), {
          recursive: true,
          verbatimSymlinks: true,
          mode: constants.COPYFILE_FICLONE,
        });
      await operations.verify(paths.staged, transaction);
      await rename(transaction.target, paths.previous);
      moved = true;
      await rename(paths.staged, transaction.target);
      replaced = true;
      await writeMacUpdateState(paths.directory, "status.json", {
        phase: "replaced",
        hadData,
        hadState,
      });
      child = await operations.launch(transaction.target, transaction);
      const deadline = performance.now() + timeoutMs;
      while (true) {
        if (await exists(join(paths.directory, "healthy.json"))) {
          const acknowledgment: unknown = JSON.parse(
            await readFile(join(paths.directory, "healthy.json"), "utf8"),
          );
          if (
            acknowledgment &&
            typeof acknowledgment === "object" &&
            "pid" in acknowledgment &&
            acknowledgment.pid === child.pid &&
            "version" in acknowledgment &&
            acknowledgment.version === transaction.version &&
            "id" in acknowledgment &&
            acknowledgment.id === id &&
            !child.exited()
          )
            break;
        }
        if (
          child.exited() ||
          (await exists(join(paths.directory, "failed.json"))) ||
          performance.now() >= deadline
        )
          throw new Error("The updated Cox client did not become ready.");
        await sleep(100);
      }
      await writeMacUpdateState(paths.directory, "status.json", { phase: "committed" }).catch(
        () => {},
      );
      await writeMacUpdateState(join(home, "client-updates"), "mac-result.json", {
        version: transaction.version,
        currentVersion: transaction.version,
        status: "updated",
      }).catch(() => {});
      await rm(paths.previous, { recursive: true, force: true }).catch(() => {});
      await rm(join(paths.directory, "userdata-backup"), { recursive: true, force: true }).catch(
        () => {},
      );
      await rm(join(paths.directory, "backend-state.json"), { force: true }).catch(() => {});
      await rm(join(paths.directory, "browser-backup"), { recursive: true, force: true }).catch(
        () => {},
      );
      await rm(paths.directory, { recursive: true, force: true }).catch(() => {});
      return "committed" as const;
    } catch (error) {
      if (child) await child.stop();
      await assertBackendStopped(home, isAlive);
      if (replaced) await rename(transaction.target, paths.staged);
      if (moved) await rename(paths.previous, transaction.target);
      if (replaced) {
        if (await exists(data)) await rename(data, join(paths.directory, "failed-userdata"));
        if (hadData)
          await cp(join(paths.directory, "userdata-backup"), data, {
            recursive: true,
            verbatimSymlinks: true,
            mode: constants.COPYFILE_FICLONE,
          });
        if (hadState) {
          await mkdir(dirname(state), { recursive: true });
          await cp(join(paths.directory, "backend-state.json"), state);
        } else await rm(state, { force: true });
        if (await exists(browser)) await rename(browser, join(paths.directory, "failed-browser"));
        if (hadBrowser)
          await cp(join(paths.directory, "browser-backup"), browser, {
            recursive: true,
            verbatimSymlinks: true,
            mode: constants.COPYFILE_FICLONE,
          });
      }
      await writeMacUpdateState(paths.directory, "status.json", {
        phase: "rolled-back",
        message: String(error),
      });
      await writeMacUpdateState(join(home, "client-updates"), "mac-result.json", {
        version: transaction.version,
        currentVersion: transaction.currentVersion,
        status: "rolled-back",
      });
      await releaseReservation();
      await operations.launch(transaction.target);
      return "rolled-back" as const;
    }
  } finally {
    await releaseReservation();
  }
}

export async function loadMacUpdateLaunch(
  home: string,
  id: string,
  target: string,
  version: string,
) {
  const transaction = await readMacUpdateTransaction(home, id);
  const paths = macUpdatePaths(home, id, target);
  const status = JSON.parse(await readFile(join(paths.directory, "status.json"), "utf8")) as {
    phase?: unknown;
  };
  if (
    transaction.target !== target ||
    transaction.version !== version ||
    status.phase !== "replaced" ||
    (await realpath(target)) !== target
  )
    throw new Error("Invalid macOS update launch.");
  let acknowledged = false;
  return {
    get acknowledged() {
      return acknowledged;
    },
    async ready() {
      if (acknowledged) return;
      await writeMacUpdateState(paths.directory, "healthy.json", { id, version, pid: process.pid });
      acknowledged = true;
    },
    fail: () =>
      writeMacUpdateState(paths.directory, "failed.json", { id, version, pid: process.pid }),
  };
}

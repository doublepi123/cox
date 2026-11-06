import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { DesktopBackendUpdateState, DesktopUpdateProgress } from "@t3tools/contracts";
import {
  backendInstallationId,
  compareBackendVersions,
  fetchBackendRelease,
  installBackendRelease,
  isBackendVersion,
  record,
  type BackendRelease,
} from "./backend-install.ts";

interface Installation {
  readonly id: string;
  readonly version: string;
}
interface Transition {
  readonly from: Installation | null;
  readonly to: Installation;
  readonly backup: string;
  readonly hadData: boolean;
}
interface UpdateDiskState {
  readonly schema: 1;
  readonly active: Installation | null;
  readonly previous: Installation | null;
  readonly pending: Installation | null;
  readonly transition: Transition | null;
  readonly backup: string | null;
  readonly failedVersion: string | null;
}
interface UpdatePreferences {
  readonly automaticChecks: boolean;
  readonly ignoredVersion: string | null;
}
const EMPTY_STATE: UpdateDiskState = {
  schema: 1,
  active: null,
  previous: null,
  pending: null,
  transition: null,
  backup: null,
  failedVersion: null,
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function installation(value: unknown): Installation | null {
  if (value === null) return null;
  const item = record(value);
  if (
    !isBackendVersion(item.version) ||
    typeof item.id !== "string" ||
    !item.id.startsWith(item.version + "-") ||
    !UUID.test(item.id.slice(item.version.length + 1))
  )
    throw new Error("Invalid managed Cox installation.");
  return { id: item.id, version: item.version };
}

function diskState(value: unknown): UpdateDiskState {
  const state = record(value);
  if (state.schema !== 1) throw new Error("Unsupported Cox update state.");
  if (state.backup !== null && (typeof state.backup !== "string" || !UUID.test(state.backup)))
    throw new Error("Invalid Cox backup path.");
  if (state.failedVersion !== null && !isBackendVersion(state.failedVersion))
    throw new Error("Invalid failed Cox version.");
  let transition: Transition | null = null;
  if (state.transition !== null) {
    const item = record(state.transition);
    const target = installation(item.to);
    if (
      !target ||
      typeof item.backup !== "string" ||
      !UUID.test(item.backup) ||
      typeof item.hadData !== "boolean"
    )
      throw new Error("Invalid Cox update transaction.");
    transition = {
      from: installation(item.from),
      to: target,
      backup: item.backup,
      hadData: item.hadData,
    };
  }
  return {
    schema: 1,
    active: installation(state.active),
    previous: installation(state.previous),
    pending: installation(state.pending),
    transition,
    backup: state.backup as string | null,
    failedVersion: state.failedVersion as string | null,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (record(error).code === "ENOENT") return false;
    throw error;
  }
}

function progress(phase: DesktopUpdateProgress["phase"]): DesktopUpdateProgress {
  return {
    phase,
    transferredBytes: 0,
    totalBytes: null,
    bytesPerSecond: null,
    remainingSeconds: null,
  };
}

interface BackendUpdatesOptions {
  readonly development?: boolean;
  readonly home: string;
  readonly desktopVersion: string;
  readonly bundledVersion: string | null;
  readonly bundledDirectory: string;
  readonly nodeVersion: string;
  readonly node: string;
  readonly npm: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly offline?: boolean;
  readonly onState: (state: DesktopBackendUpdateState) => void;
  readonly validate: (directory: string, signal: AbortSignal) => Promise<void>;
  readonly fetcher?: typeof fetch | undefined;
  readonly install?: typeof installBackendRelease;
}

export class BackendUpdates {
  private disk: UpdateDiskState = EMPTY_STATE;
  private release: BackendRelease | undefined;
  private operation: Promise<void> | undefined;
  private preferenceOperation: Promise<void> = Promise.resolve();
  private preferences: UpdatePreferences = { automaticChecks: true, ignoredVersion: null };
  private controller: AbortController | undefined;
  private closed = false;
  private state: DesktopBackendUpdateState;
  private readonly directory: string;
  private readonly options: BackendUpdatesOptions;

  constructor(options: BackendUpdatesOptions) {
    this.options = options;
    this.directory = join(options.home, "backend-updates");
    this.state = {
      desktopVersion: options.desktopVersion,
      bundledVersion: options.bundledVersion,
      currentVersion: options.bundledVersion,
      latestVersion: null,
      status: "idle",
      message: null,
      progress: null,
      ...this.preferences,
    };
  }

  getState(): DesktopBackendUpdateState {
    return { ...this.state };
  }

  async setPolicy(
    policy: "automatic" | "ignore-version" | "never",
    version?: string,
  ): Promise<DesktopBackendUpdateState> {
    if (!["automatic", "ignore-version", "never"].includes(policy))
      throw new Error("Invalid Cox update policy.");
    if (policy === "ignore-version" && !isBackendVersion(version))
      throw new Error("Ignoring a Cox update requires a valid version.");
    if (this.closed) return this.getState();
    const operation = this.preferenceOperation.then(async () => {
      const preferences: UpdatePreferences = {
        automaticChecks: policy !== "never",
        ignoredVersion: policy === "ignore-version" ? version! : null,
      };
      const temporary = join(this.directory, "preferences-" + randomUUID() + ".json");
      try {
        await writeFile(temporary, JSON.stringify(preferences), { mode: 0o600, flag: "wx" });
        await rename(temporary, join(this.directory, "preferences.json"));
      } finally {
        await rm(temporary, { force: true });
      }
      this.preferences = preferences;
      const dismissed =
        policy !== "automatic" &&
        (policy === "never" || version === this.state.latestVersion) &&
        ["available", "incompatible", "error"].includes(this.state.status);
      this.publish({
        ...preferences,
        ...(dismissed ? { status: "idle", latestVersion: null, message: null } : {}),
      });
    });
    this.preferenceOperation = operation.catch(() => {});
    await operation;
    return this.getState();
  }

  private publish(change: Partial<DesktopBackendUpdateState>) {
    this.state = {
      ...this.state,
      ...(change.status && change.status !== "installing" ? { progress: null } : {}),
      ...change,
    };
    this.options.onState(this.getState());
  }

  private async save(state: UpdateDiskState) {
    const temporary = join(this.directory, "state-" + randomUUID() + ".json");
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600, flag: "wx" });
    await rename(temporary, join(this.directory, "state.json"));
    this.disk = state;
  }

  private async ensureStopped() {
    for (const descriptor of [
      join(this.options.home, "backend-owner.json"),
      join(this.options.home, "userdata", "server-runtime.json"),
    ]) {
      if (!(await exists(descriptor))) continue;
      const runtime = record(JSON.parse(await readFile(descriptor, "utf8")));
      if (!Number.isSafeInteger(runtime.pid) || (runtime.pid as number) < 1)
        throw new Error("The previous Cox backend ownership could not be checked.");
      try {
        process.kill(runtime.pid as number, 0);
      } catch (error) {
        if (record(error).code === "ESRCH") continue;
      }
      throw new Error(
        "The previous Cox backend is still running. Wait for it to stop, then reopen Cox.",
      );
    }
  }

  private async server(target: Installation | null): Promise<string> {
    if (!target) {
      if (!this.options.bundledVersion)
        throw new Error("Cox must be installed before it can start.");
      return this.options.bundledDirectory;
    }
    const directory = join(this.directory, "versions", target.id);
    if (
      (await realpath(directory)) !==
      join(await realpath(join(this.directory, "versions")), target.id)
    )
      throw new Error("The managed Cox installation must not be a symbolic link.");
    const installed = record(JSON.parse(await readFile(join(directory, "installed.json"), "utf8")));
    if (installed.version !== target.version || installed.protocol !== 1)
      throw new Error("The managed Cox installation is incomplete.");
    const requiredNode = installed.nodeVersion;
    if (
      requiredNode !== null &&
      (!isBackendVersion(requiredNode) ||
        requiredNode.split(".")[0] !== this.options.nodeVersion.split(".")[0] ||
        compareBackendVersions(this.options.nodeVersion, requiredNode) < 0)
    )
      throw new Error("The installed Cox backend requires a different desktop Node runtime.");
    return join(directory, "server");
  }

  private async restore(transition: Transition) {
    const backup = join(this.directory, "backups", transition.backup);
    const data = join(this.options.home, "userdata");
    if (transition.hadData && !(await exists(join(backup, "userdata"))))
      throw new Error("The Cox upgrade backup is missing. No older backend will be started.");
    if (await exists(data)) await rename(data, join(backup, "failed-userdata-" + randomUUID()));
    if (transition.hadData) {
      const restored = join(this.options.home, ".userdata-restore-" + randomUUID());
      await cp(join(backup, "userdata"), restored, {
        recursive: true,
        verbatimSymlinks: true,
        errorOnExist: true,
        force: false,
      });
      await rename(restored, data);
    }
    await this.save({
      ...this.disk,
      active: transition.from,
      pending: null,
      transition: null,
      backup: transition.backup,
      failedVersion: transition.to.version,
    });
    this.publish({
      currentVersion: transition.from?.version ?? this.options.bundledVersion,
      status: "error",
      message:
        "The Cox upgrade failed. The previous backend and its matching data backup were restored.",
    });
  }

  private async snapshot(target: Installation): Promise<Transition> {
    const backup = randomUUID();
    const directory = join(this.directory, "backups", backup);
    const data = join(this.options.home, "userdata");
    const hadData = await exists(data);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (hadData) {
      if (!(await lstat(data)).isDirectory())
        throw new Error("Cox userdata must be a directory before upgrading.");
      await cp(data, join(directory, "userdata"), {
        recursive: true,
        verbatimSymlinks: true,
        errorOnExist: true,
        force: false,
      });
    }
    const transition = { from: this.disk.active, to: target, backup, hadData };
    await this.save({ ...this.disk, transition });
    return transition;
  }

  private async cacheBundledBackend() {
    if (this.options.development) return;
    const version = this.options.bundledVersion;
    if (!version || (this.disk.active && this.disk.failedVersion === version)) return;
    const existing = this.disk.pending?.version ?? this.disk.active?.version;
    if (existing && compareBackendVersions(version, existing) <= 0) return;
    const id = backendInstallationId(version);
    const temporary = join(this.directory, ".install-" + id);
    const server = join(temporary, "server");
    this.controller = new AbortController();
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(120_000)]);
    this.operation = (async () => {
      try {
        this.publish({ status: "installing", message: null, progress: progress("installing") });
        await cp(this.options.bundledDirectory, server, {
          recursive: true,
          verbatimSymlinks: true,
          mode: constants.COPYFILE_FICLONE,
        });
        signal.throwIfAborted();
        this.publish({ progress: progress("validating") });
        await this.options.validate(server, signal);
        if (this.closed) throw new Error("Cox startup was cancelled.");
        await writeFile(
          join(temporary, "installed.json"),
          JSON.stringify({
            version,
            protocol: 1,
            nodeVersion: this.options.nodeVersion,
          }),
          { mode: 0o600 },
        );
        await rename(temporary, join(this.directory, "versions", id));
        await this.save({ ...this.disk, pending: { id, version } });
      } catch (error) {
        if (!this.disk.active) throw error;
        await this.save({ ...this.disk, failedVersion: version });
        this.publish({ status: "error", message: String(error) });
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    })();
    try {
      await this.operation;
    } finally {
      this.operation = undefined;
      this.controller = undefined;
    }
  }

  async launch(
    start: (directory: string) => Promise<string>,
    stop: () => Promise<void>,
  ): Promise<string> {
    try {
      return await this.launchBackend(start, stop);
    } catch (error) {
      this.publish({ status: "error", message: String(error) });
      throw error;
    }
  }

  private async launchBackend(
    start: (directory: string) => Promise<string>,
    stop: () => Promise<void>,
  ): Promise<string> {
    await mkdir(join(this.directory, "versions"), { recursive: true, mode: 0o700 });
    if (await exists(join(this.directory, "state.json")))
      this.disk = diskState(JSON.parse(await readFile(join(this.directory, "state.json"), "utf8")));
    const preferencesPath = join(this.directory, "preferences.json");
    if (await exists(preferencesPath)) {
      const preferences = record(JSON.parse(await readFile(preferencesPath, "utf8")));
      if (
        typeof preferences.automaticChecks !== "boolean" ||
        (preferences.ignoredVersion !== null && !isBackendVersion(preferences.ignoredVersion))
      )
        throw new Error("Invalid Cox update preferences.");
      this.preferences = {
        automaticChecks: preferences.automaticChecks,
        ignoredVersion: preferences.ignoredVersion as string | null,
      };
    }
    await this.ensureStopped();
    if (this.disk.transition) await this.restore(this.disk.transition);
    this.publish({
      currentVersion: this.disk.active?.version ?? this.options.bundledVersion,
      progress: null,
      ...this.preferences,
    });
    await this.cacheBundledBackend();
    if (!this.disk.active && !this.options.bundledVersion && !this.disk.pending) {
      if (this.options.offline)
        throw new Error(
          "The client-only package needs internet access to install Cox on its first launch.",
        );
      await this.check(true);
      await this.stage();
      if (!this.disk.pending)
        throw new Error(
          this.state.message ?? "Cox could not be downloaded. Reopen the client to retry.",
        );
    }
    if (!this.disk.pending) {
      const { status, message } = this.state;
      this.publish({ status: "installing", message: null, progress: progress("starting") });
      const origin = await start(await this.server(this.disk.active));
      this.publish({ status, message, progress: null });
      return origin;
    }
    const target = this.disk.pending;
    let transition: Transition | undefined;
    try {
      this.publish({ status: "installing", message: null, progress: progress("starting") });
      const server = await this.server(target);
      transition = await this.snapshot(target);
      const origin = await start(server);
      await this.save({
        ...this.disk,
        active: target,
        previous: transition.from,
        pending: null,
        transition: null,
        backup: transition.backup,
        failedVersion: null,
      });
      this.publish({
        currentVersion: target.version,
        latestVersion: null,
        status: "idle",
        message: null,
      });
      void this.cleanup().catch(() => {});
      return origin;
    } catch (error) {
      await stop();
      if (transition) await this.restore(transition);
      else {
        await this.save({ ...this.disk, pending: null, failedVersion: target.version });
        this.publish({ status: "error", message: String(error) });
      }
      if (!this.disk.active) throw error;
      const { status, message } = this.state;
      this.publish({ status: "installing", message: null, progress: progress("starting") });
      const origin = await start(await this.server(this.disk.active));
      this.publish({ status, message, progress: null });
      return origin;
    }
  }

  async check(manual = false): Promise<DesktopBackendUpdateState> {
    if (this.closed || this.operation || this.disk.pending) return this.getState();
    if (!manual && !this.preferences.automaticChecks) return this.getState();
    if (this.options.offline) {
      this.publish({ status: "error", message: "Update checks are disabled in offline mode." });
      return this.getState();
    }
    this.controller = new AbortController();
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(30_000)]);
    this.publish({ status: "checking", message: null });
    this.operation = (async () => {
      try {
        const release = await fetchBackendRelease(
          this.options.nodeVersion,
          signal,
          this.options.fetcher,
        );
        await this.preferenceOperation;
        this.release = release;
        const newer =
          !this.state.currentVersion ||
          compareBackendVersions(release.version, this.state.currentVersion) > 0;
        if (manual && release.compatible && this.disk.failedVersion === release.version)
          await this.save({ ...this.disk, failedVersion: null });
        const failed =
          this.state.currentVersion !== null && this.disk.failedVersion === release.version;
        const ignored =
          !manual &&
          (!this.preferences.automaticChecks ||
            this.preferences.ignoredVersion === release.version);
        this.publish({
          latestVersion: ignored ? null : release.version,
          status:
            ignored || !newer
              ? "idle"
              : failed
                ? "error"
                : release.compatible
                  ? "available"
                  : "incompatible",
          message: ignored
            ? null
            : failed
              ? "This Cox version failed to start previously. Wait for a newer release."
              : newer && !release.compatible
                ? "This Cox version requires a newer desktop client."
                : null,
        });
      } catch (error) {
        this.publish({ status: "error", message: String(error) });
      }
    })();
    try {
      await this.operation;
    } finally {
      this.operation = undefined;
      this.controller = undefined;
    }
    return this.getState();
  }

  async stage(): Promise<DesktopBackendUpdateState> {
    if (this.operation) await this.operation;
    if (this.closed || this.operation || this.disk.pending) return this.getState();
    const release = this.release;
    if (!release || this.state.status !== "available") return this.getState();
    this.controller = new AbortController();
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(480_000)]);
    this.publish({ status: "installing", message: null, progress: progress("downloading") });
    this.operation = (async () => {
      const id = backendInstallationId(release.version);
      const temporary = join(this.directory, ".install-" + id);
      try {
        const directory = await (this.options.install ?? installBackendRelease)({
          release,
          directory: temporary,
          node: this.options.node,
          npm: this.options.npm,
          environment: this.options.environment,
          signal,
          fetcher: this.options.fetcher,
          onProgress: (progress) => {
            if (!this.closed && !signal.aborted) this.publish({ progress });
          },
        });
        signal.throwIfAborted();
        this.publish({ progress: progress("validating") });
        await this.options.validate(directory, signal);
        signal.throwIfAborted();
        await rename(temporary, join(this.directory, "versions", id));
        await this.save({ ...this.disk, pending: { id, version: release.version } });
        this.publish({ status: "ready", message: null });
      } catch (error) {
        this.publish({ status: "error", message: String(error) });
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    })();
    try {
      await this.operation;
    } finally {
      this.operation = undefined;
      this.controller = undefined;
    }
    return this.getState();
  }

  private async cleanup() {
    const retained = new Set([this.disk.active?.id, this.disk.previous?.id, this.disk.pending?.id]);
    for (const entry of await readdir(join(this.directory, "versions"), { withFileTypes: true })) {
      if (this.operation) return;
      if (
        entry.isDirectory() &&
        !retained.has(entry.name) &&
        /^[0-9]+[.][0-9]+[.][0-9]+-[0-9a-f-]{36}$/.test(entry.name)
      )
        await rm(join(this.directory, "versions", entry.name), { recursive: true });
    }
    const backups = join(this.directory, "backups");
    if (await exists(backups))
      for (const entry of await readdir(backups, { withFileTypes: true })) {
        if (this.operation) return;
        if (
          entry.isDirectory() &&
          UUID.test(entry.name) &&
          entry.name !== this.disk.backup &&
          entry.name !== this.disk.transition?.backup
        )
          await rm(join(backups, entry.name), { recursive: true });
      }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.controller?.abort();
    await this.operation?.catch(() => {});
    await this.preferenceOperation;
  }
}

import {
  DATABASE_MIGRATIONS_FINISHED_MESSAGE,
  DATABASE_MIGRATIONS_STARTED_MESSAGE,
} from "@t3tools/shared/databaseMigrationLog";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { backendOriginFromOutput } from "./config.ts";
import { backendInstallerEnvironment } from "./backend-install.ts";
import { killOwnedProcessTree, stopOwnedProcess } from "./process-tree.ts";
import type {
  DesktopComputerReply,
  DesktopComputerRequest,
  DesktopComputerThreadEvent,
} from "@t3tools/contracts";

function validateComputerRequest(value: object): DesktopComputerRequest {
  if (
    !("id" in value) ||
    typeof value.id !== "string" ||
    !("threadId" in value) ||
    typeof value.threadId !== "string" ||
    !("action" in value) ||
    typeof value.action !== "object" ||
    value.action === null
  )
    throw new Error("Invalid computer request.");
  return value as DesktopComputerRequest;
}
function validateComputerReply(value: DesktopComputerReply): DesktopComputerReply {
  if (
    value.type !== "cox:computer-reply" ||
    typeof value.id !== "string" ||
    typeof value.ok !== "boolean"
  )
    throw new Error("Invalid computer reply.");
  return value;
}
function validateComputerThreadEvent(value: object): DesktopComputerThreadEvent {
  if (
    !("threadId" in value) ||
    typeof value.threadId !== "string" ||
    !("state" in value) ||
    typeof value.state !== "string" ||
    !["waiting-model", "completed", "failed", "stopped", "cancelled"].includes(value.state)
  )
    throw new Error("Invalid computer thread event.");
  return value as DesktopComputerThreadEvent;
}

export interface BackendOptions {
  readonly nodePath: string;
  readonly entryPath: string;
  readonly preloadPath: string;
  readonly homeDirectory: string;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly onLog: (message: string) => void;
  readonly onUnexpectedExit: (message: string) => void;
  readonly startupTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
  readonly onComputerRequest?: (request: DesktopComputerRequest) => Promise<DesktopComputerReply>;
  readonly onComputerThread?: (event: DesktopComputerThreadEvent) => void;
  readonly computerAvailability?: {
    readonly enabled: boolean;
    readonly ready: boolean;
    readonly missing: readonly string[];
  };
}

export class BackendProcess {
  private child: ChildProcess | undefined;
  private exited: Promise<void> = Promise.resolve();
  private stopping: Promise<void> | undefined;
  private ready = false;

  private readonly options: BackendOptions;

  constructor(options: BackendOptions) {
    this.options = options;
  }

  start(): Promise<string> {
    if (this.stopping) throw new Error("The desktop backend has already been stopped.");
    if (this.child) throw new Error("The desktop backend has already been started.");
    const child = spawn(
      this.options.nodePath,
      [
        "--import",
        pathToFileURL(this.options.preloadPath).href,
        this.options.entryPath,
        "--home-dir",
        this.options.homeDirectory,
        "--host",
        "127.0.0.1",
        "--no-browser",
      ],
      {
        cwd: this.options.cwd,
        env: { ...this.options.environment, COX_DESKTOP_PARENT_PID: String(process.pid) },
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    child.on("message", (message: unknown) => {
      if (message === "cox:backend-ready-to-start" && child.connected && !this.stopping) {
        child.send("cox:backend-start", () => {});
        const availability = this.options.computerAvailability;
        if (availability)
          child.send({ type: "cox:computer-availability", ...availability }, () => {});
        return;
      }
      if (
        !child.connected ||
        this.stopping ||
        typeof message !== "object" ||
        message === null ||
        !("type" in message)
      )
        return;
      try {
        if (message.type === "cox:computer-request") {
          const request = validateComputerRequest(message);
          void (
            this.options.onComputerRequest?.(request) ??
            Promise.resolve({
              type: "cox:computer-reply",
              id: request.id,
              ok: false,
              error: { code: "unavailable", message: "Computer control is unavailable." },
            } as const)
          )
            .then((reply) => {
              const decoded = validateComputerReply(reply);
              if (child.connected) child.send(decoded, () => {});
            })
            .catch(() => {});
        } else if (message.type === "cox:computer-thread") {
          this.options.onComputerThread?.(validateComputerThreadEvent(message));
        }
      } catch {}
    });
    this.child = child;
    this.exited = new Promise((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });
    return new Promise((resolve, reject) => {
      const validation = new AbortController();
      const startupTimeoutMs = this.options.startupTimeoutMs ?? 180_000;
      const scheduleTimeout = () =>
        setTimeout(
          () =>
            fail(
              new Error(
                `The local backend did not become ready within ${startupTimeoutMs / 1_000} seconds.`,
              ),
            ),
          startupTimeoutMs,
        );
      let timeout = scheduleTimeout();
      let migrating = false;
      let output = "";
      let validating = false;
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        validation.abort(error);
        reject(error);
      };
      child.once("error", fail);
      child.once("exit", (code, signal) => {
        const message = `The local backend stopped (code ${code ?? "none"}, signal ${signal ?? "none"}).`;
        fail(new Error(message));
        if (this.ready && !this.stopping) this.options.onUnexpectedExit(message);
      });
      const receive = (chunk: Buffer) => {
        const message = chunk.toString();
        this.options.onLog(message);
        if (settled || validating) return;
        const boundary = output.length;
        output += message;
        const started = output.lastIndexOf(DATABASE_MIGRATIONS_STARTED_MESSAGE);
        const finished = output.lastIndexOf(DATABASE_MIGRATIONS_FINISHED_MESSAGE);
        if (
          started >= 0 &&
          started > finished &&
          started + DATABASE_MIGRATIONS_STARTED_MESSAGE.length > boundary
        ) {
          migrating = true;
          clearTimeout(timeout);
        } else if (
          migrating &&
          finished >= 0 &&
          finished + DATABASE_MIGRATIONS_FINISHED_MESSAGE.length > boundary
        ) {
          migrating = false;
          timeout = scheduleTimeout();
        }
        output = output.slice(-65_536);
        const origin = backendOriginFromOutput(output);
        if (!origin) return;
        validating = true;
        void this.validateOrigin(origin, child, validation.signal).then(() => {
          if (settled) return;
          if (this.stopping || child.exitCode !== null || child.signalCode !== null) {
            fail(new Error("The local backend stopped during startup."));
            return;
          }
          this.ready = true;
          settled = true;
          clearTimeout(timeout);
          const availability = this.options.computerAvailability;
          if (availability && child.connected)
            child.send({ type: "cox:computer-availability", ...availability }, () => {});
          resolve(origin);
        }, fail);
      };
      child.stdout?.on("data", receive);
      child.stderr?.on("data", receive);
    });
  }

  private async validateOrigin(
    origin: string,
    child: ChildProcess,
    signal: AbortSignal,
  ): Promise<void> {
    let contents: string;
    while (true) {
      signal.throwIfAborted();
      if (this.stopping || child.exitCode !== null || child.signalCode !== null)
        throw new Error("The local backend stopped during startup.");
      try {
        contents = await readFile(
          join(this.options.homeDirectory, "userdata", "server-runtime.json"),
          { encoding: "utf8", signal },
        );
        break;
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
        await delay(25, undefined, { signal });
      }
    }
    const state: unknown = JSON.parse(contents);
    if (
      typeof state !== "object" ||
      state === null ||
      !("pid" in state) ||
      state.pid !== child.pid ||
      !("origin" in state) ||
      state.origin !== origin
    ) {
      throw new Error("The local backend did not publish its own loopback address.");
    }
    const response = await fetch(`${origin}/api/auth/session`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
      redirect: "error",
    });
    if (!response.ok)
      throw new Error(`The local backend authentication check failed (${response.status}).`);
  }

  publishComputerAvailability(state: {
    readonly enabled: boolean;
    readonly ready: boolean;
    readonly missing: readonly string[];
  }): void {
    if (this.child?.connected && !this.stopping)
      this.child.send({ type: "cox:computer-availability", ...state }, () => {});
  }

  stop(): Promise<void> {
    this.stopping ??= this.stopChild();
    return this.stopping;
  }

  private async stopChild(): Promise<void> {
    const child = this.child;
    const pid = child?.pid;
    if (!pid || child.exitCode !== null || child.signalCode !== null) return;
    await stopOwnedProcess({
      pid,
      exited: () => child.exitCode !== null || child.signalCode !== null,
      notify: () => {
        if (child.connected) child.send("shutdown", () => {});
      },
      waitForExit: (timeoutMs) => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        return Promise.race([
          this.exited.then(() => true),
          new Promise<false>((resolve) => {
            timeout = setTimeout(() => resolve(false), timeoutMs);
          }),
        ]).finally(() => clearTimeout(timeout));
      },
      timeoutMs: this.options.stopTimeoutMs ?? 12_000,
      force: () => this.forceChild(child, pid),
    });
    await this.exited;
  }

  private async forceChild(child: ChildProcess, pid: number): Promise<void> {
    if (process.platform === "win32") {
      await killOwnedProcessTree({
        pid,
        platform: "win32",
        ...(this.options.environment.SystemRoot
          ? { systemRoot: this.options.environment.SystemRoot }
          : {}),
        execFile: (file, args) =>
          new Promise((resolve, reject) => {
            execFile(file, [...args], { windowsHide: true, timeout: 5_000 }, (error) => {
              if (error && child.exitCode === null && child.signalCode === null) reject(error);
              else resolve();
            });
          }),
        killGroup: () => {},
      });
      return;
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (process.platform === "darwin" && code === "EPERM") {
        let reaped = false;
        for (let attempt = 0; attempt < 40; attempt++) {
          await new Promise<void>((resolve) => setTimeout(resolve, 25));
          try {
            process.kill(-pid, 0);
          } catch (probeError) {
            const probeCode =
              probeError instanceof Error && "code" in probeError ? probeError.code : undefined;
            if (probeCode === "ESRCH") {
              reaped = true;
              break;
            }
            if (probeCode !== "EPERM") throw probeError;
          }
        }
        if (!reaped) throw error;
      } else if (code !== "ESRCH") throw error;
    }
  }
}

export async function validateBackendInstallation(input: {
  readonly directory: string;
  readonly node: string;
  readonly preload: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
}): Promise<void> {
  const home = await mkdtemp(join(dirname(input.directory), "health-"));
  let failure: string | undefined;
  const backend = new BackendProcess({
    nodePath: input.node,
    entryPath: join(input.directory, "dist", "bin.mjs"),
    preloadPath: input.preload,
    homeDirectory: home,
    cwd: home,
    environment: {
      ...backendInstallerEnvironment(input.environment),
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_CACHE_HOME: join(home, "cache"),
      APPDATA: join(home, "config"),
      LOCALAPPDATA: join(home, "cache"),
      COX_HOME: home,
      T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
      COX_TELEMETRY_ENABLED: "false",
      T3CODE_TELEMETRY_ENABLED: "false",
    },
    onLog: () => {},
    onUnexpectedExit: (message) => {
      failure = message;
    },
  });
  const stop = () => {
    void backend.stop().catch(() => {});
  };
  input.signal.addEventListener("abort", stop, { once: true });
  try {
    input.signal.throwIfAborted();
    const origin = await backend.start();
    const page = await fetch(origin, { redirect: "error", signal: input.signal });
    const html = await page.text();
    const asset = /(?:src|href)="(\/assets\/[^"]+)"/.exec(html)?.[1];
    if (!page.ok || !asset) throw new Error("The downloaded Cox browser UI is incomplete.");
    const response = await fetch(origin + asset, { redirect: "error", signal: input.signal });
    if (!response.ok || failure)
      throw new Error(failure ?? "The downloaded Cox browser asset is unavailable.");
  } finally {
    input.signal.removeEventListener("abort", stop);
    await backend.stop();
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

import { spawn, execFile, type ChildProcess } from "node:child_process";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { backendOriginFromOutput } from "./config.ts";
import { backendInstallerEnvironment } from "./backend-install.ts";

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
      if (message === "cox:backend-ready-to-start" && child.connected && !this.stopping)
        child.send("cox:backend-start", () => {});
    });
    this.child = child;
    this.exited = new Promise((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });
    return new Promise((resolve, reject) => {
      const validation = new AbortController();
      const timeout = setTimeout(
        () => fail(new Error("The local backend did not become ready within 90 seconds.")),
        this.options.startupTimeoutMs ?? 90_000,
      );
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
        output = (output + message).slice(-65_536);
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

  stop(): Promise<void> {
    this.stopping ??= this.stopChild();
    return this.stopping;
  }

  private async stopChild(): Promise<void> {
    const child = this.child;
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    if (child.connected) child.send("shutdown", () => {});
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const stopped = await Promise.race([
      this.exited.then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), this.options.stopTimeoutMs ?? 12_000);
      }),
    ]);
    clearTimeout(timeout);
    if (stopped || child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === "win32") {
      await new Promise<void>((resolve, reject) => {
        execFile(
          join(this.options.environment.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
          ["/PID", String(child.pid), "/T", "/F"],
          { windowsHide: true, timeout: 5_000 },
          (error) => {
            if (error && child.exitCode === null && child.signalCode === null) reject(error);
            else resolve();
          },
        );
      });
    } else {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        const code = error instanceof Error && "code" in error ? error.code : undefined;
        if (process.platform === "darwin" && code === "EPERM") {
          let reaped = false;
          for (let attempt = 0; attempt < 40; attempt++) {
            await new Promise<void>((resolve) => setTimeout(resolve, 25));
            try {
              process.kill(-child.pid, 0);
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
    await this.exited;
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

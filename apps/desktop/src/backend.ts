import { spawn, execFile, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { backendOriginFromOutput } from "./config.ts";

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
        env: this.options.environment,
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    this.child = child;
    this.exited = new Promise((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });
    return new Promise((resolve, reject) => {
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
        void this.validateOrigin(origin, child).then(() => {
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

  private async validateOrigin(origin: string, child: ChildProcess): Promise<void> {
    const state: unknown = JSON.parse(
      await readFile(join(this.options.homeDirectory, "userdata", "server-runtime.json"), "utf8"),
    );
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
      signal: AbortSignal.timeout(5_000),
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
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
      }
    }
    await this.exited;
  }
}

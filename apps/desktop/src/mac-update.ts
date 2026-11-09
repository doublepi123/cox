import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { macCommand, verifyMacApplication } from "./mac-update-platform.ts";
import { macUpdatePaths, type MacUpdateTransaction } from "./mac-update-transaction.ts";
import { cleanupDiscardedMacUpdates, discardMacUpdate } from "./mac-update-cleanup.ts";

export interface MacUpdateCandidate {
  readonly version: string;
  readonly architecture: "arm64" | "x64";
  readonly flavor: "bundled" | "client-only";
  readonly backendVersion: string | null;
}

export interface MacUpdateAdapter {
  prepare(archive: string, candidate: MacUpdateCandidate): Promise<void>;
  apply(): Promise<void>;
  close(): Promise<void>;
}

export class MacAppUpdate implements MacUpdateAdapter {
  private transaction: MacUpdateTransaction | undefined;
  private handedOff = false;
  private closing: Promise<void> | undefined;
  private readonly initialized: Promise<void>;
  private readonly options: {
    home: string;
    application: string;
    node: string;
    helperDirectory: string;
    currentVersion: string;
    offline: boolean;
    onCleanupError?: (error: unknown) => void;
  };
  constructor(options: {
    home: string;
    application: string;
    node: string;
    helperDirectory: string;
    currentVersion: string;
    offline: boolean;
    onCleanupError?: (error: unknown) => void;
  }) {
    this.options = options;
    const report =
      options.onCleanupError ??
      ((error: unknown) => {
        process.stderr.write(`Cox update cache cleanup deferred: ${String(error)}\n`);
      });
    this.initialized = cleanupDiscardedMacUpdates(options.home, options.application, report).catch(
      report,
    );
  }

  async prepare(archive: string, candidate: MacUpdateCandidate) {
    if (process.platform !== "darwin") throw new Error("Automatic macOS updates require macOS.");
    await this.initialized;
    await this.close();
    const target = await realpath(this.options.application);
    if (
      target !== this.options.application ||
      target.startsWith("/Volumes/") ||
      target.includes("/AppTranslocation/")
    )
      throw new Error("Move Cox to Applications before using automatic updates.");
    await access(dirname(target), constants.W_OK);
    const transaction: MacUpdateTransaction = {
      schema: 1,
      id: randomUUID(),
      target,
      oldPid: process.pid,
      currentVersion: this.options.currentVersion,
      offline: this.options.offline,
      ...candidate,
    };
    const paths = macUpdatePaths(this.options.home, transaction.id, target);
    await mkdir(paths.directory, { recursive: true, mode: 0o700 });
    const mount = join(paths.directory, "image");
    await mkdir(mount, { mode: 0o700 });
    let attached = false;
    try {
      await macCommand("hdiutil", [
        "attach",
        "-readonly",
        "-nobrowse",
        "-noautoopen",
        "-mountpoint",
        mount,
        archive,
      ]);
      attached = true;
      const application = join(mount, "Cox.app");
      await verifyMacApplication(application, transaction, target);
      await mkdir(paths.staged, { mode: 0o700 });
      await macCommand("ditto", [application, paths.staged]);
      await verifyMacApplication(paths.staged, transaction, target);
      await copyFile(this.options.node, join(paths.directory, "node"));
      for (const name of [
        "mac-update-helper.js",
        "mac-update-platform.js",
        "mac-update-transaction.js",
      ])
        await writeFile(
          join(paths.directory, name),
          await readFile(join(this.options.helperDirectory, name)),
          { mode: 0o600 },
        );
      await writeFile(join(paths.directory, "package.json"), JSON.stringify({ type: "module" }), {
        mode: 0o600,
      });
      await writeFile(join(paths.directory, "transaction.json"), JSON.stringify(transaction), {
        mode: 0o600,
        flag: "wx",
      });
      this.transaction = transaction;
      this.handedOff = false;
    } catch (error) {
      await rm(paths.staged, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      throw error;
    } finally {
      if (attached) await macCommand("hdiutil", ["detach", mount]);
      if (!this.transaction)
        await rm(paths.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }

  async apply() {
    const transaction = this.transaction;
    if (!transaction || this.handedOff)
      throw new Error("The macOS client update has not been prepared.");
    const paths = macUpdatePaths(this.options.home, transaction.id, transaction.target);
    await verifyMacApplication(paths.staged, transaction, transaction.target);
    const node = join(paths.directory, "node");
    if (!(await lstat(node)).isFile()) throw new Error("The macOS update runtime is missing.");
    const log = await open(join(paths.directory, "helper.log"), "a", 0o600);
    try {
      const child = spawn(
        node,
        [join(paths.directory, "mac-update-helper.js"), this.options.home, transaction.id],
        {
          detached: true,
          cwd: paths.directory,
          stdio: ["ignore", log.fd, log.fd, "ipc"],
          env: Object.fromEntries(
            Object.entries(process.env).filter(
              ([name]) => !/^(?:NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE)$/.test(name),
            ),
          ),
        },
      );
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error("The macOS update helper did not become ready."));
        }, 180_000);
        const finish = (error?: Error) => {
          clearTimeout(timer);
          if (error) reject(error);
          else resolve();
        };
        child.once("error", finish);
        child.once("exit", () =>
          finish(new Error("The macOS update helper stopped before accepting the update.")),
        );
        child.on("message", (message: unknown) => {
          if (message === "cox:mac-update-ready") finish();
          else if (
            message &&
            typeof message === "object" &&
            "type" in message &&
            message.type === "cox:mac-update-error"
          )
            finish(new Error("The macOS update could not be prepared safely."));
        });
      });
      this.handedOff = true;
      child.disconnect();
      child.unref();
    } finally {
      await log.close();
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      await this.initialized;
      if (!this.transaction || this.handedOff) return;
      await discardMacUpdate(this.options.home, this.transaction);
      this.transaction = undefined;
    })().finally(() => {
      this.closing = undefined;
    });
    return this.closing;
  }
}

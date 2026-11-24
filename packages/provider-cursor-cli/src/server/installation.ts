import {
  ProviderDriverKind,
  ProviderSetupError,
  type ProviderInstallState,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { providerArchiveTarCommand } from "@t3tools/shared/providerArchive";
import {
  CommandResolutionCache,
  resolveCommandPath,
  resolveSpawnCommand,
} from "@t3tools/shared/shell";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import { CURSOR_CLI_DEFAULT_COMMAND } from "./acpSupport.ts";

const DRIVER = ProviderDriverKind.make("cursorCli");
const isProviderSetupError = Schema.is(ProviderSetupError);
export const CURSOR_CLI_INSTALL_SCRIPT_URL = "https://cursor.com/install";
const MAX_INSTALL_SCRIPT_BYTES = 1024 * 1024;
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 20_000;
const KEPT_VERSIONS = 2;
const VERSION_PATTERN = /\b(\d{4}\.\d{2}\.\d{2}-[0-9a-f]{7,40})\b/u;

export function parseCursorCliVersion(output: string): string | undefined {
  return VERSION_PATTERN.exec(output)?.[1];
}

export function parseCursorCliInstallScriptVersion(script: string): string | undefined {
  return /https:\/\/downloads\.cursor\.com\/lab\/(\d{4}\.\d{2}\.\d{2}-[0-9a-f]{7,40})\//u.exec(
    script,
  )?.[1];
}

export function cursorCliDownloadUrl(
  version: string,
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
): string | undefined {
  const os =
    platform === "darwin"
      ? "darwin"
      : platform === "linux"
        ? "linux"
        : platform === "win32"
          ? "windows"
          : undefined;
  const cpu = arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : undefined;
  if (os === undefined || cpu === undefined) return undefined;
  const extension = os === "windows" ? "zip" : "tar.gz";
  return `https://downloads.cursor.com/lab/${version}/${os}/${cpu}/agent-cli-package.${extension}`;
}

export function isSafeCursorCliArchiveEntry(entry: string): boolean {
  const normalized = entry.replace(/\/$/u, "");
  const parts = normalized.split("/");
  return (
    normalized.length > 0 &&
    !entry.includes("\\") &&
    !entry.startsWith("/") &&
    parts[0] === "dist-package" &&
    parts.every((part) => part !== "" && part !== "." && part !== ".." && !part.includes(":"))
  );
}

export const makeCursorCliInstallation = Effect.fn("makeCursorCliInstallation")(
  function* (options: {
    readonly instanceId: ProviderInstanceId;
    readonly baseDir: string;
    readonly binaryPath?: string;
    readonly environment: NodeJS.ProcessEnv;
    readonly onChanged: Effect.Effect<void>;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const random = yield* SecureRandom.SecureRandom;
    const http = yield* HttpClient.HttpClient;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const scope = yield* Scope.Scope;
    const platform = yield* HostProcess.Platform;
    const arch = yield* HostProcess.Architecture;
    const directory = path.join(options.baseDir, "tools", "cursor-cli");
    const versionsDirectory = path.join(directory, "versions");
    const binDirectory = path.join(directory, "bin");
    const executableName = platform === "win32" ? "cursor-agent.cmd" : "cursor-agent";
    const executablePath = path.join(binDirectory, executableName);
    const pathKey =
      Object.keys(options.environment).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
    const environment: NodeJS.ProcessEnv = {
      ...options.environment,
      [pathKey]: [options.environment[pathKey], binDirectory]
        .filter(Boolean)
        .join(platform === "win32" ? ";" : ":"),
    };
    const customBinary = Boolean(
      options.binaryPath && options.binaryPath !== CURSOR_CLI_DEFAULT_COMMAND,
    );
    const error = (operation: string, detail: string) =>
      new ProviderSetupError({ instanceId: options.instanceId, operation, detail });
    const lock = yield* Semaphore.make(1);
    let running: { readonly id: string; readonly fiber: Fiber.Fiber<void> } | undefined;
    const state = yield* SubscriptionRef.make<ProviderInstallState>({
      driver: DRIVER,
      operationId: null,
      phase: "idle",
      downloadedBytes: 0,
      totalBytes: null,
      version: null,
      installedVersion: null,
      executablePath: null,
      canRemove: false,
      message: null,
    });

    const command = Effect.fn("CursorCliInstallation.command")(function* (
      binary: string,
      args: ReadonlyArray<string>,
      failureDetail: string,
    ) {
      const resolved = yield* resolveSpawnCommand(binary, args, { env: environment });
      const child = yield* spawner.spawn(
        ChildProcess.make(resolved.command, resolved.args, {
          env: { ...environment, NO_COLOR: "1", NO_OPEN_BROWSER: "1" },
          shell: resolved.shell,
          stdin: "ignore",
        }),
      );
      const [stdout, , code] = yield* Effect.all(
        [
          collectUint8StreamText({ stream: child.stdout, maxBytes: 16 * 1024 * 1024 }),
          Stream.runDrain(child.stderr),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      if (code !== 0) return yield* error("install", failureDetail);
      return stdout.text;
    }, Effect.scoped);

    const inspect = Effect.gen(function* () {
      const resolved = yield* resolveCommandPath(options.binaryPath || CURSOR_CLI_DEFAULT_COMMAND, {
        env: environment,
      }).pipe(Effect.provideService(CommandResolutionCache, new Map()));
      if (!resolved) return;
      const version = yield* command(resolved, ["--version"], "Cursor CLI did not start.").pipe(
        Effect.map(parseCursorCliVersion),
        Effect.timeout("15 seconds"),
        Effect.orElseSucceed(() => undefined),
      );
      if (!version) return;
      yield* SubscriptionRef.update(state, (current): ProviderInstallState => ({
        ...current,
        installedVersion: version,
        executablePath: resolved,
        source: path.resolve(resolved) === path.resolve(executablePath) ? "managed" : "local",
      }));
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

    const latestVersion = Effect.gen(function* () {
      const response = yield* http
        .execute(HttpClientRequest.get(CURSOR_CLI_INSTALL_SCRIPT_URL))
        .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
      const script = yield* collectUint8StreamText({
        stream: response.stream,
        maxBytes: MAX_INSTALL_SCRIPT_BYTES,
      });
      const version = parseCursorCliInstallScriptVersion(script.text);
      if (version === undefined)
        return yield* error("install", "Could not read the latest Cursor CLI version from Cursor.");
      return version;
    }).pipe(Effect.timeout("30 seconds"));

    const pruneVersions = Effect.fn("CursorCliInstallation.pruneVersions")(
      function* (keep: string) {
        const entries = yield* fs.readDirectory(versionsDirectory);
        const stale = entries
          .filter((entry) => entry !== keep && parseCursorCliVersion(entry) === entry)
          .sort()
          .reverse()
          .slice(KEPT_VERSIONS - 1);
        yield* Effect.forEach(stale, (entry) =>
          fs.remove(path.join(versionsDirectory, entry), { recursive: true }),
        );
      },
      Effect.catch((cause) => Effect.logWarning("Could not remove old Cursor CLI versions", cause)),
    );

    const activate = Effect.fn("CursorCliInstallation.activate")(function* (version: string) {
      yield* fs.makeDirectory(binDirectory, { recursive: true });
      const temporary = path.join(binDirectory, `.${executableName}-${yield* random.uuidV4()}`);
      const target = path.join(versionsDirectory, version, executableName);
      if (platform === "win32") {
        yield* fs.writeFileString(temporary, `@echo off\r\n"${target}" %*\r\n`);
      } else {
        yield* fs.symlink(target, temporary);
      }
      yield* fs.rename(temporary, executablePath);
    });

    const install = Effect.gen(function* () {
      const version = yield* latestVersion;
      const url = cursorCliDownloadUrl(version, platform, arch);
      if (url === undefined)
        return yield* error(
          "install",
          `Cursor does not publish the CLI for ${platform}-${arch}. Install it manually.`,
        );
      yield* SubscriptionRef.update(state, (current): ProviderInstallState => ({
        ...current,
        version,
        message: "Downloading Cursor CLI.",
      }));
      yield* fs.makeDirectory(versionsDirectory, { recursive: true });
      const staging = yield* fs.makeTempDirectoryScoped({ directory, prefix: ".install-" });
      const archivePath = path.join(
        staging,
        platform === "win32" ? "agent-cli-package.zip" : "agent-cli-package.tar.gz",
      );
      const response = yield* http
        .execute(HttpClientRequest.get(url))
        .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
      const totalBytes = Option.getOrNull(
        Option.fromNullishOr(response.headers["content-length"]).pipe(
          Option.map(Number),
          Option.filter((value) => Number.isSafeInteger(value) && value > 0),
        ),
      );
      yield* SubscriptionRef.update(state, (current): ProviderInstallState => ({
        ...current,
        totalBytes,
      }));
      let downloadedBytes = 0;
      let lastProgressAt = yield* Clock.currentTimeMillis;
      yield* response.stream.pipe(
        Stream.tap((chunk) =>
          Effect.gen(function* () {
            downloadedBytes += chunk.byteLength;
            if (downloadedBytes > MAX_ARCHIVE_BYTES)
              return yield* error("download", "The Cursor CLI download is larger than expected.");
            const now = yield* Clock.currentTimeMillis;
            if (now - lastProgressAt >= 250) {
              lastProgressAt = now;
              yield* SubscriptionRef.update(state, (current) => ({ ...current, downloadedBytes }));
            }
          }),
        ),
        Stream.run(fs.sink(archivePath, { flag: "wx", mode: 0o600 })),
      );
      if (totalBytes !== null && downloadedBytes !== totalBytes)
        return yield* error(
          "download",
          "The Cursor CLI download was incomplete. Retry installation.",
        );
      yield* SubscriptionRef.update(state, (current): ProviderInstallState => ({
        ...current,
        downloadedBytes,
        phase: "extracting",
        message: "Extracting Cursor CLI.",
      }));
      const tar = providerArchiveTarCommand(platform, environment);
      const archiveError = "The Cursor CLI archive could not be read.";
      const entries = (yield* command(tar, ["-tf", archivePath], archiveError))
        .trim()
        .split(/\r?\n/u);
      const types = (yield* command(tar, ["-tvf", archivePath], archiveError))
        .trim()
        .split(/\r?\n/u);
      if (
        entries.length > MAX_ARCHIVE_ENTRIES ||
        entries.length !== types.length ||
        types.some((line) => !["-", "d"].includes(line[0] ?? "")) ||
        !entries.every(isSafeCursorCliArchiveEntry)
      )
        return yield* error("extract", "The Cursor CLI archive contains unexpected entries.");
      const extracted = path.join(staging, "extracted");
      yield* fs.makeDirectory(extracted);
      yield* command(tar, ["-xf", archivePath, "-C", extracted], archiveError);
      yield* SubscriptionRef.update(state, (current): ProviderInstallState => ({
        ...current,
        phase: "verifying",
        message: "Checking Cursor CLI.",
      }));
      const stagedPackage = path.join(extracted, "dist-package");
      const stagedVersion = parseCursorCliVersion(
        yield* command(
          path.join(stagedPackage, executableName),
          ["--version"],
          "The downloaded Cursor CLI did not start.",
        ).pipe(Effect.timeout("60 seconds")),
      );
      if (stagedVersion !== version)
        return yield* error(
          "verify",
          "The downloaded Cursor CLI reported an unexpected version. Retry installation.",
        );
      const destination = path.join(versionsDirectory, version);
      if (yield* fs.exists(destination)) yield* fs.remove(destination, { recursive: true });
      const move = fs.rename(stagedPackage, destination);
      yield* platform === "win32"
        ? move.pipe(Effect.retry({ times: 10, schedule: Schedule.spaced("100 millis") }))
        : move;
      yield* activate(version).pipe(Effect.uninterruptible);
      yield* pruneVersions(version);
      return version;
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.scoped,
      Effect.timeout("45 minutes"),
    );

    const runInstallation = Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const result = yield* restore(install).pipe(Effect.exit);
        if (Exit.isSuccess(result)) yield* options.onChanged;
        running = undefined;
        const failure = Exit.isFailure(result)
          ? Option.getOrUndefined(Cause.findErrorOption(result.cause))
          : undefined;
        yield* SubscriptionRef.update(state, (current): ProviderInstallState =>
          Exit.isSuccess(result)
            ? {
                ...current,
                phase: "succeeded",
                version: result.value,
                installedVersion: result.value,
                executablePath,
                source: "managed",
                message: null,
              }
            : {
                ...current,
                phase: Cause.hasInterruptsOnly(result.cause) ? "cancelled" : "failed",
                message: Cause.hasInterruptsOnly(result.cause)
                  ? "Cursor CLI installation cancelled."
                  : isProviderSetupError(failure)
                    ? failure.detail
                    : "Could not install Cursor CLI. Check your connection and disk space, then retry.",
              },
        );
      }),
    );

    const start = lock
      .withPermit(
        Effect.gen(function* () {
          if (running && !running.fiber.pollUnsafe()) return yield* SubscriptionRef.get(state);
          if (customBinary)
            return yield* error(
              "install",
              "Clear the custom binary path before installing Cursor CLI in Cox.",
            );
          const id = yield* random.uuidV4();
          yield* SubscriptionRef.update(state, (current): ProviderInstallState => ({
            ...current,
            operationId: id,
            phase: "downloading",
            downloadedBytes: 0,
            totalBytes: null,
            message: "Checking the latest Cursor CLI version.",
          }));
          running = { id, fiber: yield* runInstallation.pipe(Effect.forkIn(scope)) };
          return yield* SubscriptionRef.get(state);
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          isProviderSetupError(cause)
            ? cause
            : error("install", "Could not start Cursor CLI installation. Try again."),
        ),
      );
    const cancel = (operationId: string) =>
      lock.withPermit(
        Effect.gen(function* () {
          if (running?.id === operationId) yield* Fiber.interrupt(running.fiber);
          return yield* SubscriptionRef.get(state);
        }),
      );
    const changes = Stream.unwrap(inspect.pipe(Effect.as(SubscriptionRef.changes(state))));
    return {
      start,
      cancel,
      changes,
      latestVersion: latestVersion.pipe(Effect.orElseSucceed(() => null)),
      environment,
      pathKey,
      executablePath,
      isInstalling: Effect.sync(() => running !== undefined && !running.fiber.pollUnsafe()),
    };
  },
);

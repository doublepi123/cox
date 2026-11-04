import {
  ProviderDriverKind,
  ProviderSetupError,
  type ProviderInstallState,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import {
  CommandResolutionCache,
  resolveCommandPath,
  resolveSpawnCommand,
} from "@t3tools/shared/shell";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { parseGenericCliVersion } from "@t3tools/provider-core/server/snapshotProbe";
import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import { parseSemver } from "@t3tools/shared/semver";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export const makeOpenCodeInstallation = Effect.fn("makeOpenCodeInstallation")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly baseDir: string;
  readonly binaryPath: string;
  readonly serverUrl?: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly onChanged: Effect.Effect<void>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Scope.Scope;
  const commandCache = yield* CommandResolutionCache;
  const platform = yield* HostProcess.Platform;
  const directory = path.join(
    options.baseDir,
    "tools",
    "opencode",
    encodeURIComponent(options.instanceId),
  );
  const executablePath = path.join(
    directory,
    "bin",
    platform === "win32" ? "opencode.exe" : "opencode",
  );
  const pathKey =
    Object.keys(options.environment).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  const environment = {
    ...options.environment,
    [pathKey]: [options.environment[pathKey], path.dirname(executablePath)]
      .filter(Boolean)
      .join(platform === "win32" ? ";" : ":"),
  };
  const customBinary = Boolean(options.binaryPath && options.binaryPath !== "opencode");
  const externalServer = Boolean(options.serverUrl?.trim());
  const error = (operation: string, detail: string) =>
    new ProviderSetupError({ instanceId: options.instanceId, operation, detail });
  const lock = yield* Semaphore.make(1);
  let running: { readonly id: string; readonly fiber: Fiber.Fiber<void> } | undefined;
  const state = yield* SubscriptionRef.make<ProviderInstallState>({
    driver: ProviderDriverKind.make("opencode"),
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
  const resolveExecutable = Effect.suspend(() =>
    resolveCommandPath(options.binaryPath || "opencode", { env: environment }).pipe(
      Effect.provideService(CommandResolutionCache, new Map()),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.map((resolved) => resolved ?? (customBinary ? options.binaryPath : executablePath)),
    ),
  );
  const command = Effect.fn("OpenCodeInstallation.command")(function* (
    binary: string,
    args: ReadonlyArray<string>,
    env = environment,
  ) {
    const resolved = yield* resolveSpawnCommand(binary, args, { env });
    const child = yield* spawner.spawn(
      ChildProcess.make(resolved.command, resolved.args, { env, shell: resolved.shell }),
    );
    const [stdout, , code] = yield* Effect.all(
      [
        collectUint8StreamText({ stream: child.stdout, maxBytes: 16_384 }),
        Stream.runDrain(child.stderr),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    if (code !== 0)
      return yield* error(
        "install",
        "Could not install OpenCode. Check your connection and Node.js/npm installation, then retry.",
      );
    return stdout.text;
  }, Effect.scoped);
  const inspect = Effect.gen(function* () {
    if (running || externalServer) return;
    const operationId = (yield* SubscriptionRef.get(state)).operationId;
    const resolved = yield* resolveExecutable;
    const version = yield* command(resolved, ["--version"]).pipe(
      Effect.map(parseGenericCliVersion),
      Effect.timeout("5 seconds"),
      Effect.orElseSucceed(() => null),
    );
    if (!version) return;
    yield* SubscriptionRef.update(state, (value): ProviderInstallState =>
      running || value.operationId !== operationId
        ? value
        : {
            ...value,
            installedVersion: version,
            executablePath: resolved,
            source: path.resolve(resolved) === path.resolve(executablePath) ? "managed" : "local",
          },
    );
  });
  const install = Effect.gen(function* () {
    yield* fs.makeDirectory(directory, { recursive: true });
    const staging = yield* fs.makeTempDirectoryScoped({ directory, prefix: ".install-" });
    const npm = yield* resolveCommandPath(platform === "win32" ? "npm.cmd" : "npm", {
      env: environment,
    });
    const node = yield* resolveCommandPath(platform === "win32" ? "node.exe" : "node", {
      env: environment,
    });
    if (!npm || !node)
      return yield* error("install", "Installing OpenCode requires Node.js and npm on PATH.");
    const home = path.join(staging, "home");
    yield* fs.makeDirectory(home);
    const installEnvironment = {
      ...environment,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, "config"),
      XDG_DATA_HOME: path.join(home, "data"),
      XDG_STATE_HOME: path.join(home, "state"),
      XDG_CACHE_HOME: path.join(home, "cache"),
    };
    yield* command(
      npm,
      [
        "install",
        "--prefix",
        staging,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--include=optional",
        "--global=false",
        "--workspaces=false",
        "@opencode/cli@latest",
      ],
      installEnvironment,
    );
    yield* SubscriptionRef.update(state, (value): ProviderInstallState => ({
      ...value,
      phase: "extracting",
    }));
    const packageDirectory = path.join(staging, "node_modules", "@opencode", "cli");
    yield* command(node, [path.join(packageDirectory, "postinstall.mjs")], installEnvironment);
    yield* SubscriptionRef.update(state, (value): ProviderInstallState => ({
      ...value,
      phase: "verifying",
    }));
    const stagedBinary = path.join(packageDirectory, "bin", "opencode.exe");
    const version = parseGenericCliVersion(
      yield* command(stagedBinary, ["--version"], installEnvironment),
    );
    if (!version || parseSemver(version)?.major !== 2)
      return yield* error(
        "install",
        "The downloaded OpenCode CLI did not report a supported V2 version. Retry installation.",
      );
    yield* fs.makeDirectory(path.dirname(executablePath), { recursive: true });
    const nextBinary = path.join(staging, path.basename(executablePath));
    yield* fs.copyFile(stagedBinary, nextBinary);
    if (platform !== "win32") yield* fs.chmod(nextBinary, 0o755);
    yield* fs.rename(nextBinary, executablePath).pipe(Effect.uninterruptible);
    return version;
  }).pipe(
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
    Effect.scoped,
    Effect.timeout("15 minutes"),
  );
  const runInstallation = Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const result = yield* restore(install).pipe(Effect.exit);
      if (Exit.isSuccess(result)) {
        commandCache.clear();
        yield* options.onChanged;
      }
      running = undefined;
      yield* SubscriptionRef.update(state, (value): ProviderInstallState =>
        Exit.isSuccess(result)
          ? {
              ...value,
              phase: "succeeded",
              version: result.value,
              installedVersion: result.value,
              executablePath,
              source: "managed",
              message: null,
            }
          : {
              ...value,
              phase: Cause.hasInterruptsOnly(result.cause) ? "cancelled" : "failed",
              message: Cause.hasInterruptsOnly(result.cause)
                ? "OpenCode installation cancelled."
                : "Could not install OpenCode. Check your connection and Node.js/npm installation, then retry.",
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
            "Clear the custom binary path before installing OpenCode in Cox.",
          );
        if (externalServer)
          return yield* error(
            "install",
            "Clear the server URL before installing a local OpenCode CLI in Cox.",
          );
        const resolved = yield* resolveExecutable;
        if (resolved && path.resolve(resolved) !== path.resolve(executablePath))
          return yield* error(
            "install",
            "OpenCode already uses a local installation. Update it with its existing installation method.",
          );
        const id = yield* crypto.randomUUIDv4();
        yield* SubscriptionRef.update(state, (value): ProviderInstallState => ({
          ...value,
          operationId: id,
          phase: "downloading",
          message: null,
        }));
        running = { id, fiber: yield* runInstallation.pipe(Effect.forkIn(scope)) };
        return yield* SubscriptionRef.get(state);
      }),
    )
    .pipe(
      Effect.mapError((cause) =>
        cause._tag === "ProviderSetupError"
          ? cause
          : error("install", "Could not start OpenCode installation. Try again."),
      ),
    );
  const cancel = (operationId: string) =>
    lock.withPermit(
      Effect.gen(function* () {
        if (running?.id === operationId) yield* Fiber.interrupt(running.fiber);
        return yield* SubscriptionRef.get(state);
      }),
    );
  return {
    start,
    cancel,
    changes: Stream.unwrap(inspect.pipe(Effect.as(SubscriptionRef.changes(state)))),
    resolveExecutable,
    environment,
    executablePath,
    pathKey,
    canInstall: !customBinary && !externalServer,
  };
});

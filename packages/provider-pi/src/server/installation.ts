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
import { compareSemverVersions } from "@t3tools/shared/semver";
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
import { MINIMUM_PI_VERSION } from "./status.ts";

export const makePiInstallation = Effect.fn("makePiInstallation")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly baseDir: string;
  readonly binaryPath?: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly onChanged: Effect.Effect<void>;
  readonly runtime?: {
    readonly driver: string;
    readonly command: string;
    readonly label: string;
    readonly packageName: string;
    readonly version: string;
    readonly minimumVersion: string;
  };
}) {
  const runtime = options.runtime ?? {
    driver: "pi",
    command: "pi",
    label: "Pi",
    packageName: "@earendil-works/pi-coding-agent",
    version: "latest",
    minimumVersion: MINIMUM_PI_VERSION,
  };
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
    runtime.driver,
    encodeURIComponent(options.instanceId),
  );
  const current = path.join(directory, "current");
  const bin = path.join(current, "node_modules", ".bin");
  const executablePath = path.join(
    bin,
    platform === "win32" ? `${runtime.command}.cmd` : runtime.command,
  );
  const normalizePath = (value: string) => {
    const resolved = path.resolve(value);
    return platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const pathKeys = Object.keys(options.environment).filter((key) => key.toUpperCase() === "PATH");
  const inheritedPathKey =
    ["PATH", "Path", "path"].find((key) => options.environment[key] !== undefined) ??
    pathKeys[0] ??
    "PATH";
  const pathKey = platform === "win32" ? inheritedPathKey : "PATH";
  const customBinary = Boolean(options.binaryPath && options.binaryPath !== runtime.command);
  const environment = {
    ...options.environment,
    [pathKey]: (customBinary
      ? [options.environment[inheritedPathKey], bin]
      : [bin, options.environment[inheritedPathKey]]
    )
      .filter(Boolean)
      .join(platform === "win32" ? ";" : ":"),
  };
  if (platform === "win32") {
    for (const key of pathKeys) environment[key] = environment[pathKey];
  }
  const error = (operation: string, detail: string) =>
    new ProviderSetupError({ instanceId: options.instanceId, operation, detail });
  const lock = yield* Semaphore.make(1);
  let running: { readonly id: string; readonly fiber: Fiber.Fiber<void> } | undefined;
  const state = yield* SubscriptionRef.make<ProviderInstallState>({
    driver: ProviderDriverKind.make(runtime.driver),
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
  const command = Effect.fn("PiInstallation.command")(function* (
    binary: string,
    args: ReadonlyArray<string>,
  ) {
    const resolved = yield* resolveSpawnCommand(binary, args, { env: environment });
    const child = yield* spawner.spawn(
      ChildProcess.make(resolved.command, resolved.args, {
        env: { ...environment, PI_OFFLINE: "1" },
        shell: resolved.shell,
      }),
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
        `Could not install ${runtime.label}. Check your connection and Node.js/npm installation, then retry.`,
      );
    return stdout.text;
  }, Effect.scoped);
  const verify = Effect.fn("PiInstallation.verify")(function* (
    binary: string,
    expectedPath: string,
  ) {
    const resolved = yield* resolveCommandPath(binary, { env: environment }).pipe(
      Effect.provideService(CommandResolutionCache, new Map()),
    );
    if (!resolved || normalizePath(resolved) !== normalizePath(expectedPath))
      return yield* error(
        "install",
        `The downloaded ${runtime.label} CLI is not available on PATH. Retry installation.`,
      );
    const version = parseGenericCliVersion(
      yield* command(resolved, ["--version"]).pipe(Effect.timeout("5 seconds")),
    );
    if (!version || compareSemverVersions(version, runtime.minimumVersion) < 0)
      return yield* error(
        "install",
        `The downloaded ${runtime.label} CLI did not report a supported version. Retry installation.`,
      );
    return { version, executablePath: resolved };
  });
  const inspect = Effect.gen(function* () {
    if (running) return;
    const previous = yield* SubscriptionRef.get(state);
    const operationId = previous.operationId;
    const resolved = yield* resolveCommandPath(options.binaryPath || runtime.command, {
      env: environment,
    }).pipe(Effect.provideService(CommandResolutionCache, new Map()));
    const version = resolved
      ? yield* command(resolved, ["--version"]).pipe(
          Effect.map(parseGenericCliVersion),
          Effect.timeout("5 seconds"),
          Effect.orElseSucceed(() => null),
        )
      : null;
    if (running || (yield* SubscriptionRef.get(state)).operationId !== operationId) return;
    const selected = version ? resolved : null;
    commandCache.clear();
    yield* SubscriptionRef.update(state, (value): ProviderInstallState =>
      running || value.operationId !== operationId
        ? value
        : {
            ...value,
            installedVersion: version,
            executablePath: selected,
            source: selected
              ? normalizePath(selected) === normalizePath(executablePath)
                ? "managed"
                : "local"
              : null,
          },
    );
  }).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.provideService(Path.Path, path));
  const install = Effect.gen(function* () {
    yield* fs.makeDirectory(directory, { recursive: true });
    const temporary = yield* fs.makeTempDirectoryScoped({ directory, prefix: ".install-" });
    const staging = path.join(temporary, "package");
    const npm = yield* resolveCommandPath(platform === "win32" ? "npm.cmd" : "npm", {
      env: environment,
    });
    if (!npm)
      return yield* error(
        "install",
        `Installing ${runtime.label} requires Node.js and npm on PATH.`,
      );
    yield* command(npm, [
      "install",
      "--prefix",
      staging,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--include=optional",
      "--global=false",
      "--workspaces=false",
      `${runtime.packageName}@${runtime.version}`,
    ]);
    yield* SubscriptionRef.update(state, (value): ProviderInstallState => ({
      ...value,
      phase: "verifying",
    }));
    const stagedBinary = path.join(staging, "node_modules", ".bin", path.basename(executablePath));
    yield* verify(stagedBinary, stagedBinary);
    const id = yield* crypto.randomUUIDv4();
    const release = path.join(directory, "releases", id);
    yield* fs.makeDirectory(path.dirname(release), { recursive: true });
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        yield* fs.rename(staging, release);
        const link = path.join(directory, `.current-${id}`);
        const previous = yield* fs.readLink(current).pipe(Effect.orElseSucceed(() => null));
        const switched = yield* fs
          .symlink(release, link)
          .pipe(Effect.andThen(fs.rename(link, current)), Effect.exit);
        if (Exit.isFailure(switched)) {
          yield* fs.remove(link, { force: true });
          yield* fs.remove(release, { recursive: true, force: true });
          return yield* Effect.failCause(switched.cause);
        }
        const verified = yield* restore(
          verify(options.binaryPath || runtime.command, executablePath),
        ).pipe(Effect.exit);
        if (Exit.isFailure(verified)) {
          if (previous) {
            yield* fs.symlink(previous, link);
            yield* fs.rename(link, current);
          } else {
            yield* fs.remove(current, { force: true });
          }
          yield* fs.remove(release, { recursive: true, force: true });
          return yield* Effect.failCause(verified.cause);
        }
        return verified.value;
      }),
    );
  }).pipe(
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
    Effect.scoped,
    Effect.timeout("15 minutes"),
  );
  const runInstallation = Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const result = yield* restore(install).pipe(Effect.exit);
      commandCache.clear();
      if (Exit.isSuccess(result)) {
        yield* options.onChanged;
      }
      running = undefined;
      yield* SubscriptionRef.update(state, (value): ProviderInstallState =>
        Exit.isSuccess(result)
          ? {
              ...value,
              phase: "succeeded",
              version: result.value.version,
              installedVersion: result.value.version,
              executablePath: result.value.executablePath,
              source: "managed",
              message: null,
            }
          : {
              ...value,
              phase: Cause.hasInterruptsOnly(result.cause) ? "cancelled" : "failed",
              message: Cause.hasInterruptsOnly(result.cause)
                ? `${runtime.label} installation cancelled.`
                : `Could not install ${runtime.label}. Check your connection and Node.js/npm installation, then retry.`,
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
            `Clear the custom binary path before installing ${runtime.label} in Cox.`,
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
          : error("install", `Could not start ${runtime.label} installation. Try again.`),
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
    environment,
    pathKey,
    executablePath,
  };
});

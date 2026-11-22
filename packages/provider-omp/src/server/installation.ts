import {
  ProviderDriverKind,
  ProviderSetupError,
  type ProviderInstallState,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import { parseGenericCliVersion } from "@t3tools/provider-core/server/snapshotProbe";
import { makePiInstallation } from "@t3tools/provider-pi/server";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { compareSemverVersions } from "@t3tools/shared/semver";
import {
  CommandResolutionCache,
  resolveCommandPath,
  resolveSpawnCommand,
} from "@t3tools/shared/shell";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { OMP_BUN_VERSION, OMP_INSTALL_SPEC, OMP_MINIMUM_VERSION } from "./configuration.ts";

const BUN_PLATFORM_PACKAGES: Readonly<Record<string, string>> = {
  "darwin-arm64": "@oven/bun-darwin-aarch64",
  "darwin-x64": "@oven/bun-darwin-x64",
  "linux-arm64": "@oven/bun-linux-aarch64",
  "linux-x64": "@oven/bun-linux-x64",
  "win32-arm64": "@oven/bun-windows-aarch64",
  "win32-x64": "@oven/bun-windows-x64",
};

const INSTALL_FAILURE_MESSAGE =
  "Could not install Oh My Pi. Check your connection and Node.js/npm installation, then retry.";

export const makeOmpInstallation = Effect.fn("makeOmpInstallation")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly baseDir: string;
  readonly binaryPath?: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly onChanged: Effect.Effect<void>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const architecture = yield* HostProcess.Architecture;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* SecureRandom.SecureRandom;
  const scope = yield* Scope.Scope;
  const instanceDirectory = path.join(
    options.baseDir,
    "tools",
    "omp",
    encodeURIComponent(options.instanceId),
  );
  const bunDirectory = path.join(instanceDirectory, "bun");
  const bunBinaryDirectory = path.join(bunDirectory, "bin");
  const bunExecutableName = platform === "win32" ? "bun.exe" : "bun";
  const pathKeys = Object.keys(options.environment).filter((key) => key.toUpperCase() === "PATH");
  const inheritedPathKey =
    ["PATH", "Path", "path"].find((key) => options.environment[key] !== undefined) ??
    pathKeys[0] ??
    "PATH";
  const pathKey = platform === "win32" ? inheritedPathKey : "PATH";
  const environment: NodeJS.ProcessEnv = {
    ...options.environment,
    [pathKey]: [bunBinaryDirectory, options.environment[inheritedPathKey]]
      .filter(Boolean)
      .join(platform === "win32" ? ";" : ":"),
  };
  if (platform === "win32") {
    for (const key of pathKeys) environment[key] = environment[pathKey];
  }
  const installation = yield* makePiInstallation({
    ...options,
    environment,
    runtime: {
      driver: "omp",
      command: "omp",
      label: "Oh My Pi",
      packageName: "@oh-my-pi/pi-coding-agent",
      version: OMP_INSTALL_SPEC,
      minimumVersion: OMP_MINIMUM_VERSION,
    },
  });
  const error = (detail: string) =>
    new ProviderSetupError({ instanceId: options.instanceId, operation: "install", detail });
  const command = Effect.fn("OmpInstallation.command")(function* (
    binary: string,
    args: ReadonlyArray<string>,
  ) {
    const resolved = yield* resolveSpawnCommand(binary, args, { env: installation.environment });
    const child = yield* spawner.spawn(
      ChildProcess.make(resolved.command, resolved.args, {
        env: installation.environment,
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
    if (code !== 0) return yield* error(INSTALL_FAILURE_MESSAGE);
    return stdout.text;
  }, Effect.scoped);
  const readVersion = (binary: string) =>
    command(binary, ["--version"]).pipe(
      Effect.timeout("5 seconds"),
      Effect.map(parseGenericCliVersion),
      Effect.orElseSucceed(() => null),
    );
  const probeBun = Effect.gen(function* () {
    const resolved = yield* resolveCommandPath("bun", { env: installation.environment }).pipe(
      Effect.provideService(CommandResolutionCache, new Map()),
    );
    if (!resolved) return false;
    const version = yield* readVersion(resolved);
    return version !== null && compareSemverVersions(version, OMP_BUN_VERSION) >= 0;
  });
  const stageBun = Effect.gen(function* () {
    const bunPackage = BUN_PLATFORM_PACKAGES[`${platform}-${architecture}`];
    if (!bunPackage)
      return yield* error(
        `Oh My Pi requires Bun ${OMP_BUN_VERSION}+, which Cox cannot install automatically on this platform. Install Bun and retry.`,
      );
    yield* fs.makeDirectory(instanceDirectory, { recursive: true });
    const temporary = yield* fs.makeTempDirectoryScoped({
      directory: instanceDirectory,
      prefix: ".bun-install-",
    });
    const staging = path.join(temporary, "package");
    const npm = yield* resolveCommandPath(platform === "win32" ? "npm.cmd" : "npm", {
      env: installation.environment,
    });
    if (!npm) return yield* error("Installing Oh My Pi requires Node.js and npm on PATH.");
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
      `${bunPackage}@${OMP_BUN_VERSION}`,
    ]);
    const stagedBun = path.join(staging, "node_modules", bunPackage, "bin", bunExecutableName);
    const version = yield* readVersion(stagedBun);
    if (!version || compareSemverVersions(version, OMP_BUN_VERSION) < 0)
      return yield* error(
        "The managed Bun runtime did not report a supported version. Retry installation.",
      );
    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        yield* fs.remove(bunDirectory, { recursive: true, force: true });
        yield* fs.rename(path.join(staging, "node_modules", bunPackage), bunDirectory);
      }),
    );
  }).pipe(Effect.scoped, Effect.timeout("15 minutes"));
  const state = yield* SubscriptionRef.make<ProviderInstallState>({
    driver: ProviderDriverKind.make("omp"),
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
  let running: { readonly id: string; readonly fiber: Fiber.Fiber<void> } | undefined;
  const bootstrapOwnsState = (value: ProviderInstallState) =>
    running !== undefined && value.phase === "downloading" && value.operationId === running.id;
  const mergeInnerState = (value: ProviderInstallState, next: ProviderInstallState) =>
    (value.phase === "failed" || value.phase === "cancelled") && next.phase === "idle"
      ? value
      : bootstrapOwnsState(value)
        ? value
        : next;
  const relayInnerState = installation.changes.pipe(
    Stream.runForEach((next) =>
      SubscriptionRef.update(state, (current) => mergeInnerState(current, next)),
    ),
  );
  const changes = Stream.unwrap(
    Effect.gen(function* () {
      const current = yield* installation.changes.pipe(
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
      yield* SubscriptionRef.update(state, (value) => mergeInnerState(value, current));
      yield* relayInnerState.pipe(Effect.forkIn(scope));
      return SubscriptionRef.changes(state);
    }),
  );
  const isProviderSetupError = Schema.is(ProviderSetupError);
  const reportBootstrapFailure = Effect.fn("OmpInstallation.reportBootstrapFailure")(function* <
    A,
    E,
  >(failure: Exit.Exit<A, E>) {
    const interrupted = Exit.hasInterrupts(failure);
    const error = Result.getOrNull(Exit.findError(failure));
    const detail =
      !interrupted && isProviderSetupError(error) ? error.detail : INSTALL_FAILURE_MESSAGE;
    yield* SubscriptionRef.update(state, (value): ProviderInstallState => ({
      ...value,
      phase: interrupted ? "cancelled" : "failed",
      message: interrupted ? "Oh My Pi installation cancelled." : detail,
    }));
  }, Effect.uninterruptible);
  const runBootstrap = Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const bootstrap = yield* restore(
        Effect.gen(function* () {
          if (!(yield* probeBun)) yield* stageBun;
        }),
      ).pipe(Effect.exit);
      if (Exit.isFailure(bootstrap)) {
        yield* reportBootstrapFailure(bootstrap);
        running = undefined;
        return;
      }
      running = undefined;
      const takeover = yield* restore(installation.start).pipe(Effect.exit);
      if (Exit.isFailure(takeover)) yield* reportBootstrapFailure(takeover);
    }),
  ).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.provideService(Path.Path, path));
  const bootstrapLock = yield* Semaphore.make(1);
  const start = bootstrapLock
    .withPermit(
      Effect.gen(function* () {
        if (options.binaryPath && options.binaryPath !== "omp") return yield* installation.start;
        if (running && !running.fiber.pollUnsafe()) return yield* SubscriptionRef.get(state);
        const id = yield* crypto.uuidV4();
        yield* SubscriptionRef.update(state, (value): ProviderInstallState => ({
          ...value,
          operationId: id,
          phase: "downloading",
          message: null,
        }));
        running = { id, fiber: yield* runBootstrap.pipe(Effect.forkIn(scope)) };
        return yield* SubscriptionRef.get(state);
      }),
    )
    .pipe(
      Effect.mapError((cause) =>
        isProviderSetupError(cause)
          ? cause
          : error("Could not start Oh My Pi installation. Try again."),
      ),
    );
  const cancel = Effect.fn("OmpInstallation.cancel")(function* (operationId: string) {
    if (running?.id !== operationId) return yield* installation.cancel(operationId);
    yield* Fiber.interrupt(running.fiber);
    return yield* SubscriptionRef.get(state);
  });
  return {
    start,
    cancel,
    changes,
    environment: installation.environment,
    pathKey: installation.pathKey,
    executablePath: installation.executablePath,
  };
});

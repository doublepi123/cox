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
import { parseGenericCliVersion } from "@t3tools/provider-core/server/snapshotProbe";
import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";

export const makeGrokInstallation = Effect.fn("makeGrokInstallation")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly baseDir: string;
  readonly binaryPath?: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly onChanged: Effect.Effect<void>;
  readonly canStart: Effect.Effect<boolean>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Scope.Scope;
  const platform = yield* HostProcess.Platform;
  const directory = path.join(
    options.baseDir,
    "tools",
    "grok",
    encodeURIComponent(options.instanceId),
  );
  const executablePath = path.join(directory, "bin", platform === "win32" ? "grok.exe" : "grok");
  const pathKey =
    Object.keys(options.environment).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  const home =
    options.environment.GROK_HOME?.trim() ||
    path.join(
      options.environment.HOME ||
        options.environment.USERPROFILE ||
        (yield* HostProcess.HomeDirectory),
      ".grok",
    );
  const environment = {
    ...options.environment,
    [pathKey]: [options.environment[pathKey], path.join(home, "bin"), path.dirname(executablePath)]
      .filter(Boolean)
      .join(platform === "win32" ? ";" : ":"),
  };
  const customBinary = Boolean(options.binaryPath && options.binaryPath !== "grok");
  const error = (operation: string, detail: string) =>
    new ProviderSetupError({ instanceId: options.instanceId, operation, detail });
  const lock = yield* Semaphore.make(1);
  let running: { readonly id: string; readonly fiber: Fiber.Fiber<void> } | undefined;
  const state = yield* SubscriptionRef.make<ProviderInstallState>({
    driver: ProviderDriverKind.make("grok"),
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
  const command = Effect.fn("GrokInstallation.command")(function* (
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
        "Could not install Grok. Check your connection and npm installation, then retry.",
      );
    return stdout.text;
  }, Effect.scoped);
  const inspect = Effect.gen(function* () {
    const resolved = yield* resolveCommandPath(options.binaryPath || "grok", {
      env: environment,
    }).pipe(Effect.provideService(CommandResolutionCache, new Map()));
    if (!resolved) return;
    const version = yield* command(resolved, ["--version"]).pipe(
      Effect.map(parseGenericCliVersion),
      Effect.timeout("5 seconds"),
      Effect.orElseSucceed(() => null),
    );
    if (!version) return;
    yield* SubscriptionRef.update(state, (current): ProviderInstallState => ({
      ...current,
      installedVersion: version,
      executablePath: resolved,
      source: path.resolve(resolved) === path.resolve(executablePath) ? "managed" : "local",
    }));
  }).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.provideService(Path.Path, path));
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
      return yield* error("install", "Installing Grok requires Node.js and npm on PATH.");
    const installEnv = {
      ...environment,
      GROK_HOME: path.join(staging, "home"),
      GROK_INSTALL_COMPLETIONS: "0",
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
        "@xai-official/grok@latest",
      ],
      installEnv,
    );
    yield* SubscriptionRef.update(state, (current): ProviderInstallState => ({
      ...current,
      phase: "extracting",
    }));
    yield* command(
      node,
      [path.join(staging, "node_modules", "@xai-official", "grok", "bin", "postinstall.js")],
      installEnv,
    );
    yield* SubscriptionRef.update(state, (current): ProviderInstallState => ({
      ...current,
      phase: "verifying",
    }));
    const stagedBinary = path.join(installEnv.GROK_HOME, "bin", path.basename(executablePath));
    const version = parseGenericCliVersion(yield* command(stagedBinary, ["--version"], installEnv));
    if (!version)
      return yield* error(
        "install",
        "The downloaded Grok CLI did not report a valid version. Retry installation.",
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
      if (Exit.isSuccess(result)) yield* options.onChanged;
      running = undefined;
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
                ? "Grok installation cancelled."
                : "Could not install Grok. Check your connection and Node.js/npm installation, then retry.",
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
            "Clear the custom binary path before installing Grok in Cox.",
          );
        if (!(yield* options.canStart))
          return yield* error("install", "Finish or cancel Grok sign-in before installing.");
        const id = yield* crypto.randomUUIDv4();
        yield* SubscriptionRef.update(state, (current): ProviderInstallState => ({
          ...current,
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
          : error("install", "Could not start Grok installation. Try again."),
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
    environment,
    pathKey,
    executablePath,
    isInstalling: Effect.sync(() => running !== undefined && !running.fiber.pollUnsafe()),
  };
});

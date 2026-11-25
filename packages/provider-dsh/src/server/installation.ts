import {
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
import { compareSemverVersions } from "@t3tools/shared/semver";
import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import * as Cause from "effect/Cause";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { pathToFileURL } from "node:url";

import {
  DSH_ACP_PLUS_PACKAGE_NAME,
  DSH_ACP_PLUS_TARBALL,
  DSH_DRIVER_KIND,
  DSH_OVERLAY_FILE,
  DSH_PACKAGE_NAME,
  DSH_VERSION,
  dshAcpPlusOverlay,
  dshRuntimeLaunch,
} from "./acpSupport.ts";

const isProviderSetupError = Schema.is(ProviderSetupError);
const INSTALL_FAILURE =
  "Could not install DeepSeek Harness. Check your connection, disk space and Node.js/npm installation, then retry.";

export function dshRuntimeManifest(): string {
  return `${JSON.stringify(
    {
      name: "cox-dsh-runtime",
      private: true,
      dependencies: {
        [DSH_PACKAGE_NAME]: DSH_VERSION,
        [DSH_ACP_PLUS_PACKAGE_NAME]: DSH_ACP_PLUS_TARBALL,
      },
      allowScripts: {
        "node-pty": true,
        koffi: true,
        protobufjs: true,
        "@deepseek-ai/dsh-subprocess-local": true,
      },
    },
    null,
    2,
  )}\n`;
}

export function parseDshVersion(output: string): string | null {
  return /\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/u.exec(output)?.[1] ?? null;
}

export function isSupportedDshVersion(version: string | null | undefined): boolean {
  return (
    version !== null && version !== undefined && compareSemverVersions(version, DSH_VERSION) === 0
  );
}

export const makeDshInstallation = Effect.fn("makeDshInstallation")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly baseDir: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly onChanged: Effect.Effect<void>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* SecureRandom.SecureRandom;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Scope.Scope;
  const platform = yield* HostProcess.Platform;
  const { directory, current, ...launch } = dshRuntimeLaunch({
    baseDir: options.baseDir,
    platform,
    join: (...segments) => path.join(...segments),
  });
  const binaryIn = (root: string) => path.join(root, path.relative(current, launch.executablePath));
  const environment = options.environment;
  const error = (operation: string, detail: string) =>
    new ProviderSetupError({ instanceId: options.instanceId, operation, detail });
  const lock = yield* Semaphore.make(1);
  let running: { readonly id: string; readonly fiber: Fiber.Fiber<void> } | undefined;
  const state = yield* SubscriptionRef.make<ProviderInstallState>({
    driver: DSH_DRIVER_KIND,
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

  const command = Effect.fn("DshInstallation.command")(function* (
    binary: string,
    args: ReadonlyArray<string>,
    cwd?: string,
  ) {
    const resolved = yield* resolveSpawnCommand(binary, args, { env: environment });
    const child = yield* spawner.spawn(
      ChildProcess.make(resolved.command, resolved.args, {
        env: { ...environment, NO_COLOR: "1" },
        shell: resolved.shell,
        stdin: "ignore",
        ...(cwd === undefined ? {} : { cwd }),
      }),
    );
    const [stdout, stderr, code] = yield* Effect.all(
      [
        collectUint8StreamText({ stream: child.stdout, maxBytes: 64 * 1024 }),
        collectUint8StreamText({ stream: child.stderr, maxBytes: 256 * 1024 }),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    if (code !== 0) {
      const detail = stderr.text.trim().split(/\r?\n/u).slice(-3).join(" ").slice(-400);
      return yield* error("install", detail ? `${INSTALL_FAILURE} (${detail})` : INSTALL_FAILURE);
    }
    return stdout.text;
  }, Effect.scoped);

  const readVersion = (binary: string) =>
    command(binary, ["--version"]).pipe(Effect.map(parseDshVersion), Effect.timeout("30 seconds"));

  const inspect = Effect.gen(function* () {
    if (running) return;
    const operationId = (yield* SubscriptionRef.get(state)).operationId;
    const ready =
      (yield* fs.exists(launch.executablePath)) && (yield* fs.exists(launch.overlayPath));
    const version = ready
      ? yield* readVersion(launch.executablePath).pipe(Effect.orElseSucceed(() => null))
      : null;
    yield* SubscriptionRef.update(state, (value): ProviderInstallState =>
      running || value.operationId !== operationId
        ? value
        : {
            ...value,
            installedVersion: version ?? null,
            executablePath: version ? launch.executablePath : null,
            source: version ? "managed" : null,
          },
    );
  }).pipe(
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
    Effect.orElseSucceed(() => undefined),
  );

  const pruneReleases = Effect.fn("DshInstallation.pruneReleases")(
    function* (keep: string) {
      const releases = path.join(directory, "releases");
      const entries = yield* fs.readDirectory(releases);
      yield* Effect.forEach(
        entries.filter((entry) => entry !== keep),
        (entry) => fs.remove(path.join(releases, entry), { recursive: true, force: true }),
        { discard: true },
      );
    },
    Effect.catch((cause) =>
      Effect.logWarning("Could not remove old DeepSeek Harness releases", cause),
    ),
  );

  const install = Effect.gen(function* () {
    yield* fs.makeDirectory(directory, { recursive: true });
    const temporary = yield* fs.makeTempDirectoryScoped({ directory, prefix: ".install-" });
    const staging = path.join(temporary, "runtime");
    yield* fs.makeDirectory(staging);
    yield* fs.writeFileString(path.join(staging, "package.json"), dshRuntimeManifest());
    const npm = yield* resolveCommandPath(platform === "win32" ? "npm.cmd" : "npm", {
      env: environment,
    }).pipe(Effect.provideService(CommandResolutionCache, new Map()));
    if (!npm)
      return yield* error(
        "install",
        "Installing DeepSeek Harness requires Node.js and npm on PATH.",
      );
    yield* command(
      npm,
      [
        "install",
        "--prefix",
        staging,
        "--no-audit",
        "--no-fund",
        "--include=optional",
        "--global=false",
        "--workspaces=false",
      ],
      staging,
    );
    yield* SubscriptionRef.update(state, (value): ProviderInstallState => ({
      ...value,
      phase: "verifying",
      message: "Checking DeepSeek Harness.",
    }));
    const stagedVersion = yield* readVersion(binaryIn(staging));
    if (!isSupportedDshVersion(stagedVersion))
      return yield* error(
        "verify",
        "The downloaded DeepSeek Harness reported an unexpected version. Retry installation.",
      );
    const id = yield* crypto.uuidV4();
    const release = path.join(directory, "releases", id);
    yield* fs.makeDirectory(path.dirname(release), { recursive: true });
    yield* fs.rename(staging, release);
    yield* fs.writeFileString(
      path.join(release, DSH_OVERLAY_FILE),
      dshAcpPlusOverlay(
        pathToFileURL(path.join(release, "node_modules", DSH_ACP_PLUS_PACKAGE_NAME)).href,
      ),
    );
    const link = path.join(directory, `.current-${id}`);
    yield* Effect.uninterruptible(
      fs.symlink(release, link).pipe(Effect.andThen(fs.rename(link, current))),
    ).pipe(
      Effect.tapError(() =>
        Effect.all(
          [fs.remove(link, { force: true }), fs.remove(release, { recursive: true, force: true })],
          { discard: true },
        ).pipe(Effect.ignore),
      ),
    );
    yield* pruneReleases(id);
    return stagedVersion!;
  }).pipe(
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
    Effect.scoped,
    Effect.timeout("45 minutes"),
  );

  const runInstallation = Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const result = yield* restore(install).pipe(Effect.exit);
      running = undefined;
      const failure = Exit.isFailure(result) ? Cause.squash(result.cause) : undefined;
      yield* SubscriptionRef.update(state, (value): ProviderInstallState =>
        Exit.isSuccess(result)
          ? {
              ...value,
              phase: "succeeded",
              version: result.value,
              installedVersion: result.value,
              executablePath: launch.executablePath,
              source: "managed",
              message: null,
            }
          : {
              ...value,
              phase: Cause.hasInterruptsOnly(result.cause) ? "cancelled" : "failed",
              message: Cause.hasInterruptsOnly(result.cause)
                ? "DeepSeek Harness installation cancelled."
                : isProviderSetupError(failure)
                  ? failure.detail
                  : INSTALL_FAILURE,
            },
      );
      if (Exit.isSuccess(result)) yield* options.onChanged;
    }),
  );

  const start = lock
    .withPermit(
      Effect.gen(function* () {
        if (running && !running.fiber.pollUnsafe()) return yield* SubscriptionRef.get(state);
        const id = yield* crypto.uuidV4();
        yield* SubscriptionRef.update(state, (value): ProviderInstallState => ({
          ...value,
          operationId: id,
          phase: "downloading",
          version: DSH_VERSION,
          downloadedBytes: 0,
          totalBytes: null,
          message: "Installing DeepSeek Harness and its ACP bridge.",
        }));
        running = { id, fiber: yield* runInstallation.pipe(Effect.forkIn(scope)) };
        return yield* SubscriptionRef.get(state);
      }),
    )
    .pipe(
      Effect.mapError((cause) =>
        isProviderSetupError(cause)
          ? cause
          : error("install", "Could not start DeepSeek Harness installation. Try again."),
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
    launch,
    installedVersion: Effect.suspend(() =>
      running && !running.fiber.pollUnsafe()
        ? Effect.succeed(null)
        : inspect.pipe(
            Effect.andThen(SubscriptionRef.get(state)),
            Effect.map((value) => value.installedVersion),
          ),
    ),
  };
});

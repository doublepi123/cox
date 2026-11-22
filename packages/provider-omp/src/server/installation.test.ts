import * as Redacted from "effect/Redacted";
import * as Layer from "effect/Layer";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ProviderSetupError,
  type ProviderInstallState,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { CommandResolutionCache, resolveCommandPath } from "@t3tools/shared/shell";
import { makeOmpInstallation } from "./installation.ts";
import { OMP_BUN_VERSION, OMP_INSTALL_SPEC, OMP_VERSION } from "./configuration.ts";

const assertPath = (
  actual: string | null | undefined,
  expected: string,
  platform = HostProcess.Platform.defaultValue(),
) =>
  assert.equal(
    platform === "win32" ? actual?.toLowerCase() : actual,
    platform === "win32" ? expected.toLowerCase() : expected,
  );

const makeHarness = Effect.fn("OmpInstallation.test.harness")(function* (
  options: {
    readonly hostBunVersion?: string;
    readonly stagedBunVersion?: string;
    readonly ompVersion?: string;
    readonly customBinary?: boolean | string;
    readonly blockedBun?: boolean;
    readonly blockedOmp?: boolean;
    readonly pathKey?: "PATH" | "Path";
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "cox-omp-install-test-" });
  const bin = path.join(root, "host-bin");
  yield* fs.makeDirectory(bin);
  for (const name of platform === "win32" ? ["npm.cmd", "node.exe"] : ["npm", "node"]) {
    yield* fs.writeFileString(path.join(bin, name), "stub");
    yield* fs.chmod(path.join(bin, name), 0o755);
  }
  const bunName = platform === "win32" ? "bun.exe" : "bun";
  const ompName = platform === "win32" ? "omp.cmd" : "omp";
  if (options.hostBunVersion) {
    yield* fs.writeFileString(path.join(bin, bunName), `host-bun-${options.hostBunVersion}`);
    yield* fs.chmod(path.join(bin, bunName), 0o755);
  }
  const customBinary =
    options.customBinary === true ? path.join(root, "custom", ompName) : options.customBinary;
  if (customBinary && customBinary !== "omp") {
    yield* fs.makeDirectory(path.dirname(customBinary), { recursive: true });
    yield* fs.writeFileString(customBinary, `custom-omp-9.9.9`);
    yield* fs.chmod(customBinary, 0o755);
  }
  const instanceId = ProviderInstanceId.make("omp-test");
  const instanceDirectory = path.join(root, "tools", "omp", "omp-test");
  const bunExecutablePath = path.join(instanceDirectory, "bun", "bin", bunName);
  const environment: NodeJS.ProcessEnv = {
    [options.pathKey ?? "PATH"]: bin,
    HOME: path.join(root, "user-home"),
  };
  const bunSpawned = yield* Deferred.make<void>();
  const ompSpawned = yield* Deferred.make<void>();
  const bunRelease = yield* Deferred.make<void>();
  const ompRelease = yield* Deferred.make<void>();
  const calls: ReadonlyArray<string>[] = [];
  const probes: string[] = [];
  let stagedBunVersion = options.stagedBunVersion ?? OMP_BUN_VERSION;
  let ompVersion = options.ompVersion ?? OMP_VERSION;
  let blockedBun = options.blockedBun ?? false;
  let blockedOmp = options.blockedOmp ?? false;
  let changed = 0;
  const commandCache = new Map<
    string,
    { readonly resolvedPath: string | null; readonly expiresAtNanos: bigint }
  >();
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand") return yield* Effect.die("Unexpected pipeline");
      const parts = command.options.shell
        ? Array.from(
            command.command.replaceAll("^", "").matchAll(/"([^"]*)"|(\S+)/g),
            (match) => match[1] ?? match[2]!,
          )
        : [command.command, ...command.args.map(String)];
      const [binary, ...args] = parts;
      calls.push(args);
      const installing = args[0] === "install";
      const spec = args.at(-1) ?? "";
      const bunInstall = spec.startsWith("@oven/");
      if (installing) {
        const staging = args[args.indexOf("--prefix") + 1]!;
        const packageName = spec.slice(0, spec.lastIndexOf("@"));
        if (bunInstall) {
          const stagedBin = path.join(staging, "node_modules", packageName, "bin");
          yield* fs.makeDirectory(stagedBin, { recursive: true });
          yield* fs.writeFileString(
            path.join(stagedBin, bunName),
            `managed-bun-${stagedBunVersion}`,
          );
          yield* fs.chmod(path.join(stagedBin, bunName), 0o755);
          yield* Deferred.succeed(bunSpawned, undefined);
        } else {
          const stagedBin = path.join(staging, "node_modules", ".bin");
          yield* fs.makeDirectory(stagedBin, { recursive: true });
          yield* fs.writeFileString(path.join(stagedBin, ompName), `installed-omp-${ompVersion}`);
          yield* fs.chmod(path.join(stagedBin, ompName), 0o755);
          yield* fs.writeFileString(
            path.join(staging, "node_modules", "fixture.json"),
            "dependency",
          );
          yield* Deferred.succeed(ompSpawned, undefined);
        }
      }
      let output = "";
      let missing = false;
      if (args[0] === "--version") {
        const resolved = yield* resolveCommandPath(binary!, {
          env:
            command.options.env === undefined
              ? environment
              : Object.fromEntries(
                  Object.entries(command.options.env).map(([key, value]) => [
                    key,
                    Redacted.isRedacted(value) ? Redacted.value(value) : value,
                  ]),
                ),
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        );
        probes.push(resolved ?? binary!);
        missing = resolved === null;
        if (resolved) {
          const contents = yield* fs.readFileString(resolved);
          const bunMatch = /^(?:managed|host)-bun-(.+)$/.exec(contents);
          const ompMatch = /^(?:installed|local|custom)-omp-(.+)$/.exec(contents);
          output = bunMatch
            ? `${bunMatch[1]}\n`
            : ompMatch
              ? `omp/${ompMatch[1]}\n`
              : "unrecognized\n";
        }
      }
      const blocked = installing && (bunInstall ? blockedBun : blockedOmp);
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(900_000_002),
        exitCode: blocked
          ? Deferred.await(bunInstall ? bunRelease : ompRelease).pipe(
              Effect.as(ChildProcessSpawner.ExitCode(0)),
            )
          : Effect.succeed(ChildProcessSpawner.ExitCode(missing ? 1 : 0)),
        isRunning: Effect.succeed(blocked),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.encodeText(Stream.make(output)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  const build = () =>
    makeOmpInstallation({
      instanceId,
      baseDir: root,
      ...(customBinary ? { binaryPath: customBinary } : {}),
      environment,
      onChanged: Effect.sync(() => {
        changed++;
      }),
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(CommandResolutionCache, commandCache),
    );
  const installation = yield* build();
  type Installation = typeof installation;
  const currentState = (target: Installation = installation) =>
    target.changes.pipe(Stream.runHead, Effect.map(Option.getOrThrow));
  const terminalState = (target: Installation = installation) =>
    target.changes.pipe(
      Stream.filter((state) => ["succeeded", "failed", "cancelled"].includes(state.phase)),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
      Effect.scoped,
    );
  return {
    root,
    installation,
    currentState,
    terminalState,
    calls,
    probes,
    environment,
    instanceDirectory,
    bunExecutablePath,
    bunName,
    changed: () => changed,
    bunCalls: () => calls.filter((args) => (args.at(-1) ?? "").startsWith("@oven/")),
    resolveOmp: resolveCommandPath("omp", { env: installation.environment }).pipe(
      Effect.provideService(CommandResolutionCache, commandCache),
    ),
    recreate: build,
    configure: (next: { blockedBun?: boolean; blockedOmp?: boolean }) => {
      blockedBun = next.blockedBun ?? blockedBun;
      blockedOmp = next.blockedOmp ?? blockedOmp;
    },
    bunSpawned,
    ompSpawned,
  };
});

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("Omp installation", (it) => {
  it.effect(
    "stages the managed Bun runtime and installs the pinned omp package when Bun is absent",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const platform = yield* HostProcess.Platform;
        const architecture = yield* HostProcess.Architecture;
        const h = yield* makeHarness();
        const started = yield* h.installation.start;
        assert.equal(started.phase, "downloading");
        assert.isNotNull(started.operationId);
        const state = yield* h.terminalState();
        assert.equal(state.driver, "omp");
        assert.equal(state.phase, "succeeded");
        assert.equal(state.source, "managed");
        assert.equal(state.installedVersion, OMP_VERSION);
        assert.equal(state.version, OMP_VERSION);
        assertPath(state.executablePath, h.installation.executablePath);
        assert.equal(h.changed(), 1);
        const bunCall = h.bunCalls().at(-1)!;
        assert.include(bunCall, "--ignore-scripts");
        assert.include(bunCall, "--include=optional");
        if (platform === "linux" && architecture === "x64")
          assert.equal(bunCall.at(-1), `@oven/bun-linux-x64@${OMP_BUN_VERSION}`);
        else assert.isTrue(bunCall.at(-1)!.startsWith("@oven/bun-"));
        assert.isTrue(bunCall[bunCall.indexOf("--prefix") + 1]!.startsWith(h.instanceDirectory));
        assert.isTrue(
          h.calls.some((args) => args.includes(`@oh-my-pi/pi-coding-agent@${OMP_INSTALL_SPEC}`)),
        );
        assert.equal(
          yield* fs.readFileString(h.bunExecutablePath),
          `managed-bun-${OMP_BUN_VERSION}`,
        );
        assert.equal(
          yield* fs.readFileString(h.installation.executablePath),
          `installed-omp-${OMP_VERSION}`,
        );
        assert.equal(
          yield* fs.readFileString(
            path.join(path.dirname(path.dirname(h.installation.executablePath)), "fixture.json"),
          ),
          "dependency",
        );
        assert.equal(
          h.installation.environment[h.installation.pathKey],
          [
            path.dirname(h.installation.executablePath),
            path.dirname(h.bunExecutablePath),
            h.environment.PATH,
          ].join(platform === "win32" ? ";" : ":"),
        );
        assert.equal(h.probes.at(-1), state.executablePath);
      }).pipe(Effect.scoped),
  );

  it.effect("skips the Bun bootstrap when a supported Bun is already on PATH", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ hostBunVersion: OMP_BUN_VERSION });
      yield* h.installation.start;
      const state = yield* h.terminalState();
      assert.equal(state.phase, "succeeded");
      assert.equal(state.installedVersion, OMP_VERSION);
      assert.deepEqual(h.bunCalls(), []);
      assert.isFalse(yield* (yield* FileSystem.FileSystem).exists(h.bunExecutablePath));
      assert.isTrue(h.probes.some((probe) => probe.endsWith(h.bunName)));
    }).pipe(Effect.scoped),
  );

  it.effect("shadows an unsupported global Bun with the managed runtime", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ hostBunVersion: "1.3.0" });
      yield* h.installation.start;
      const state = yield* h.terminalState();
      assert.equal(state.phase, "succeeded");
      assert.lengthOf(h.bunCalls(), 1);
      assert.equal(
        yield* (yield* FileSystem.FileSystem).readFileString(h.bunExecutablePath),
        `managed-bun-${OMP_BUN_VERSION}`,
      );
    }).pipe(Effect.scoped),
  );

  it.effect("rediscovers the persisted managed Bun after a restart without downloading again", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const h = yield* makeHarness();
      yield* h.installation.start;
      assert.equal((yield* h.terminalState()).phase, "succeeded");
      const restarted = yield* h.recreate();
      const state = yield* h.currentState(restarted);
      assert.equal(state.source, "managed");
      assert.equal(state.installedVersion, OMP_VERSION);
      assertPath(state.executablePath, restarted.executablePath);
      yield* restarted.start;
      assert.equal((yield* h.terminalState(restarted)).phase, "succeeded");
      assert.lengthOf(h.bunCalls(), 1);
      assert.equal(yield* fs.readFileString(h.bunExecutablePath), `managed-bun-${OMP_BUN_VERSION}`);
    }).pipe(Effect.scoped),
  );

  for (const persistedContents of ["managed-bun-1.3.0", "corrupt-binary"]) {
    it.effect(
      `re-stages a persisted managed Bun that is ${
        persistedContents === "corrupt-binary" ? "corrupt" : "outdated"
      }`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const h = yield* makeHarness();
          yield* fs.makeDirectory(path.dirname(h.bunExecutablePath), { recursive: true });
          yield* fs.writeFileString(h.bunExecutablePath, persistedContents);
          yield* fs.chmod(h.bunExecutablePath, 0o755);
          yield* h.installation.start;
          const state = yield* h.terminalState();
          assert.equal(state.phase, "succeeded");
          assert.lengthOf(h.bunCalls(), 1);
          assert.equal(
            yield* fs.readFileString(h.bunExecutablePath),
            `managed-bun-${OMP_BUN_VERSION}`,
          );
        }).pipe(Effect.scoped),
    );
  }

  it.effect("rejects a staged Bun that reports an unsupported version", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const h = yield* makeHarness({ stagedBunVersion: "1.3.0" });
      yield* h.installation.start;
      const state = yield* h.terminalState();
      assert.equal(state.phase, "failed");
      assert.include(state.message ?? "", "Bun");
      assert.lengthOf(h.bunCalls(), 1);
      assert.isFalse(h.calls.some((args) => args.includes("@oh-my-pi/pi-coding-agent")));
      assert.isFalse(yield* fs.exists(h.bunExecutablePath));
      assert.deepEqual(yield* fs.readDirectory(h.instanceDirectory), []);
    }).pipe(Effect.scoped),
  );

  it.effect("rejects an omp package that does not satisfy the pinned version", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const h = yield* makeHarness({ ompVersion: "18.19.0" });
      yield* h.installation.start;
      const state = yield* h.terminalState();
      assert.equal(state.phase, "failed");
      assert.notEqual(state.source, "managed");
      assert.isFalse(yield* fs.exists(h.installation.executablePath));
      assert.equal(h.changed(), 0);
      assert.equal(yield* fs.readFileString(h.bunExecutablePath), `managed-bun-${OMP_BUN_VERSION}`);
    }).pipe(Effect.scoped),
  );

  it.effect("does not bootstrap Bun or install for a custom binary", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ customBinary: true });
      const state = yield* h.currentState();
      assert.equal(state.installedVersion, "9.9.9");
      assert.equal(state.source, "local");
      assert.include((yield* Effect.flip(h.installation.start)).detail, "custom binary");
      assert.deepEqual(
        h.calls.filter((args) => args[0] === "install"),
        [],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("defers the Bun bootstrap until an install is requested", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      void (h.installation.start satisfies Effect.Effect<ProviderInstallState, ProviderSetupError>);
      void (h.installation.cancel satisfies (
        operationId: string,
      ) => Effect.Effect<ProviderInstallState, ProviderSetupError>);
      const state = yield* h.currentState();
      assert.equal(state.phase, "idle");
      assert.isNull(state.installedVersion);
      assert.isNull(yield* h.resolveOmp);
      assert.deepEqual(h.calls, []);
      assert.isFalse(yield* (yield* FileSystem.FileSystem).exists(h.bunExecutablePath));
    }).pipe(Effect.scoped),
  );

  it.effect(
    "cancels the omp installation, cleans its staging, and keeps the managed Bun reusable",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const h = yield* makeHarness({ blockedOmp: true });
        const started = yield* h.installation.start;
        yield* Deferred.await(h.ompSpawned);
        const takeover = yield* h.installation.changes.pipe(
          Stream.filter(
            (state) =>
              state.phase === "downloading" &&
              state.operationId !== null &&
              state.operationId !== started.operationId,
          ),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        assert.equal((yield* h.installation.cancel(takeover.operationId!)).phase, "cancelled");
        assert.isFalse(yield* fs.exists(h.installation.executablePath));
        assert.equal(
          yield* fs.readFileString(h.bunExecutablePath),
          `managed-bun-${OMP_BUN_VERSION}`,
        );
        assert.deepEqual(yield* fs.readDirectory(h.instanceDirectory), ["bun"]);
        h.configure({ blockedOmp: false });
        yield* h.installation.start;
        assert.equal((yield* h.terminalState()).phase, "succeeded");
        assert.lengthOf(h.bunCalls(), 1);
      }).pipe(Effect.scoped),
  );

  it.effect("cancels during the Bun stage through the owned operation", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const h = yield* makeHarness({ blockedBun: true });
      const started = yield* h.installation.start;
      assert.equal(started.phase, "downloading");
      assert.isNotNull(started.operationId);
      yield* Deferred.await(h.bunSpawned);
      assert.equal((yield* h.currentState()).phase, "downloading");
      assert.equal((yield* h.currentState()).operationId, started.operationId);
      assert.equal((yield* h.installation.cancel(started.operationId!)).phase, "cancelled");
      assert.equal((yield* h.terminalState()).phase, "cancelled");
      assert.isFalse(yield* fs.exists(h.bunExecutablePath));
      assert.deepEqual(yield* fs.readDirectory(h.instanceDirectory), []);
      assert.isFalse(h.calls.some((args) => args.includes("@oh-my-pi/pi-coding-agent")));
      h.configure({ blockedBun: false });
      yield* h.installation.start;
      assert.equal((yield* h.terminalState()).phase, "succeeded");
      assert.lengthOf(h.bunCalls(), 2);
    }).pipe(Effect.scoped),
  );

  it.effect("uses Windows Path casing, bun.exe, and semicolon-delimited managed directories", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const h = yield* makeHarness({ pathKey: "Path" });
      yield* h.installation.start;
      const state = yield* h.terminalState();
      assert.equal(state.phase, "succeeded");
      assert.equal(state.installedVersion, OMP_VERSION);
      assert.equal(
        h.installation.environment.Path,
        [
          path.dirname(h.installation.executablePath),
          path.dirname(h.bunExecutablePath),
          h.environment.Path,
        ].join(";"),
      );
      assert.isUndefined(h.installation.environment.PATH);
      assert.equal(
        yield* (yield* FileSystem.FileSystem).readFileString(h.bunExecutablePath),
        `managed-bun-${OMP_BUN_VERSION}`,
      );
      assert.equal(h.bunCalls().at(-1)!.at(-1), `@oven/bun-windows-x64@${OMP_BUN_VERSION}`);
    }).pipe(Effect.provideService(HostProcess.Platform, "win32"), Effect.scoped),
  );

  it.effect("selects the official aarch64 platform package for arm64 hosts", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.installation.start;
      assert.equal((yield* h.terminalState()).phase, "succeeded");
      assert.equal(h.bunCalls().at(-1)!.at(-1), `@oven/bun-windows-aarch64@${OMP_BUN_VERSION}`);
    }).pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(HostProcess.Architecture, "arm64"),
      Effect.scoped,
    ),
  );
});

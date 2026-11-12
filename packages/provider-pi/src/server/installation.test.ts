import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  CommandResolutionCache,
  resolveCommandPath,
  resolveSpawnCommand,
} from "@t3tools/shared/shell";
import { makePiInstallation } from "./installation.ts";

const assertPath = (
  actual: string | null | undefined,
  expected: string,
  platform = HostProcess.Platform.defaultValue(),
) =>
  assert.equal(
    platform === "win32" ? actual?.toLowerCase() : actual,
    platform === "win32" ? expected.toLowerCase() : expected,
  );

const makeHarness = Effect.fn("PiInstallation.test.harness")(function* (
  options: {
    readonly customBinary?: boolean | string;
    readonly blocked?: boolean;
    readonly fail?: boolean;
    readonly version?: string;
    readonly omo?: boolean;
    readonly localVersion?: string;
    readonly pathKey?: "PATH" | "Path";
    readonly binary?: "missing" | "non-executable";
    readonly activeVersion?: string;
    readonly activeFails?: boolean;
    readonly removeOnActivation?: boolean;
    readonly duplicatePathKey?: boolean;
    readonly realCli?: boolean;
    readonly uppercaseShim?: boolean;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const realSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "cox-pi-install-test-" });
  const bin = path.join(root, "host-bin");
  yield* fs.makeDirectory(bin);
  for (const name of platform === "win32" ? ["npm.cmd", "node.exe"] : ["npm", "node"]) {
    yield* fs.writeFileString(path.join(bin, name), "stub");
    yield* fs.chmod(path.join(bin, name), 0o755);
  }
  const downloading = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const calls: ReadonlyArray<string>[] = [];
  let fail = options.fail ?? false;
  let blocked = options.blocked ?? false;
  let activeVersion = options.activeVersion;
  const commandName = options.omo ? "omo" : "pi";
  let version = options.version ?? (options.omo ? "5.1.69" : "1.5.0");
  const executableName = platform === "win32" ? `${commandName}.cmd` : commandName;
  const cliContents = (version: string) =>
    platform === "win32"
      ? `@echo off\r\necho ${commandName} ${version}\r\n`
      : `#!/bin/sh\nprintf '%s\\n' '${commandName} ${version}'\n`;
  const localBinary = path.join(bin, executableName);
  if (options.localVersion) {
    yield* fs.writeFileString(
      localBinary,
      options.realCli
        ? cliContents(options.localVersion)
        : `local-${commandName}-${options.localVersion}`,
    );
    yield* fs.chmod(localBinary, 0o755);
  }
  const customBinary =
    options.customBinary === true
      ? path.join(root, "custom", executableName)
      : options.customBinary;
  if (customBinary && customBinary !== commandName) {
    const customPath = customBinary.includes(path.sep)
      ? customBinary
      : path.join(bin, platform === "win32" ? `${customBinary}.cmd` : customBinary);
    yield* fs.makeDirectory(path.dirname(customPath), { recursive: true });
    yield* fs.writeFileString(customPath, `custom-${commandName}-9.9.9`);
    yield* fs.chmod(customPath, 0o755);
  }
  const environment: NodeJS.ProcessEnv = {
    ...(options.duplicatePathKey ? { Path: path.join(root, "unused-bin") } : {}),
    [options.pathKey ?? "PATH"]: bin,
    HOME: path.join(root, "user-home"),
  };
  const probes: string[] = [];
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
        : [command.command, ...command.args];
      const [binary, ...args] = parts;
      calls.push(args);
      const installing = args[0] === "install";
      if (!installing && options.realCli) return yield* realSpawner.spawn(command);
      if (installing) {
        const staging = args[args.indexOf("--prefix") + 1]!;
        const stagedBin = path.join(staging, "node_modules", ".bin");
        yield* fs.makeDirectory(stagedBin, { recursive: true });
        if (options.binary !== "missing") {
          const executable = path.join(
            stagedBin,
            options.uppercaseShim ? executableName.replace(/\.cmd$/, ".CMD") : executableName,
          );
          yield* fs.writeFileString(
            executable,
            options.realCli ? cliContents(version) : `installed-${commandName}-${version}`,
          );
          yield* fs.chmod(executable, options.binary === "non-executable" ? 0o644 : 0o755);
        }
        yield* fs.writeFileString(path.join(staging, "node_modules", "fixture.json"), "dependency");
        yield* Deferred.succeed(downloading, undefined);
      }
      let output = "";
      let missing = false;
      let failed = false;
      if (args[0] === "--version") {
        const resolved = yield* resolveCommandPath(binary!, {
          env: command.options.env ?? environment,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        );
        probes.push(resolved ?? binary!);
        missing = resolved === null;
        if (resolved) {
          failed = Boolean(
            options.activeFails && resolved.includes(`${path.sep}current${path.sep}`),
          );
          const contents = yield* fs.readFileString(resolved);
          const reportedVersion =
            activeVersion && resolved.includes(`${path.sep}current${path.sep}`)
              ? activeVersion
              : contents.replace(/^(?:installed|local|custom)-(?:pi|omo)-/, "");
          output = `${commandName} ${reportedVersion}\n`;
        }
      }
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(900_000_001),
        exitCode:
          installing && blocked
            ? Deferred.await(release).pipe(Effect.as(ChildProcessSpawner.ExitCode(0)))
            : Effect.succeed(
                ChildProcessSpawner.ExitCode((installing && fail) || missing || failed ? 1 : 0),
              ),
        isRunning: Effect.succeed(installing && blocked),
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
  const installation = yield* makePiInstallation({
    instanceId: ProviderInstanceId.make("pi-test"),
    baseDir: root,
    ...(customBinary ? { binaryPath: customBinary } : {}),
    environment,
    onChanged: Effect.sync(() => {
      changed++;
    }),
    ...(options.omo
      ? {
          runtime: {
            driver: "omo",
            command: "omo",
            label: "OMO Native",
            packageName: "omo-ai",
            version: "5.1.69",
            minimumVersion: "5.1.69",
          },
        }
      : {}),
  }).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.provideService(CommandResolutionCache, commandCache),
    Effect.provideService(FileSystem.FileSystem, {
      ...fs,
      rename: (from, to) =>
        fs
          .rename(from, to)
          .pipe(
            Effect.andThen(
              options.removeOnActivation && path.basename(to) === "current"
                ? fs.remove(path.join(to, "node_modules", ".bin", executableName))
                : Effect.void,
            ),
          ),
    }),
  );
  const terminal = installation.changes.pipe(
    Stream.filter((state) => ["succeeded", "failed", "cancelled"].includes(state.phase)),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );
  return {
    root,
    installation,
    terminal,
    calls,
    probes,
    localBinary,
    environment,
    changed: () => changed,
    inspect: installation.changes.pipe(Stream.runHead, Effect.map(Option.getOrThrow)),
    resolve: resolveCommandPath(commandName, { env: installation.environment }).pipe(
      Effect.provideService(CommandResolutionCache, commandCache),
    ),
    spawn: resolveSpawnCommand(commandName, ["--version"], { env: installation.environment }).pipe(
      Effect.provideService(CommandResolutionCache, commandCache),
    ),
    run: Effect.gen(function* () {
      const resolved = yield* resolveSpawnCommand(commandName, ["--version"], {
        env: installation.environment,
      });
      const child = yield* realSpawner.spawn(
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
      assert.equal(code, 0);
      return stdout.text.trim();
    }).pipe(Effect.scoped, Effect.provideService(CommandResolutionCache, commandCache)),
    downloading,
    release,
    commandCache,
    configure: (next: {
      fail?: boolean;
      blocked?: boolean;
      version?: string;
      activeVersion?: string;
    }) => {
      fail = next.fail ?? fail;
      blocked = next.blocked ?? blocked;
      version = next.version ?? version;
      activeVersion = next.activeVersion ?? activeVersion;
    },
  };
});

it.layer(NodeServices.layer)("Pi installation", (it) => {
  for (const omo of [false, true]) {
    for (const pathKey of ["PATH", "Path"] as const) {
      it.effect(`prefers managed ${omo ? "OMO" : "Pi"} over an existing ${pathKey} command`, () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const platform = yield* HostProcess.Platform;
          const localVersion = omo ? "5.1.68" : "1.4.0";
          const h = yield* makeHarness({ omo, pathKey, localVersion });
          const initial = yield* h.inspect;
          assert.equal(initial.installedVersion, localVersion);
          assertPath(initial.executablePath, h.localBinary);
          assert.equal(initial.source, "local");
          assertPath(yield* h.resolve, h.localBinary);
          const before = yield* h.spawn;
          if (platform === "win32")
            assert.include(before.command.toLowerCase(), h.localBinary.toLowerCase());
          else assert.equal(before.command, omo ? "omo" : "pi");
          yield* h.installation.start;
          const state = yield* h.terminal;
          assert.equal(state.phase, "succeeded");
          assert.equal(state.source, "managed");
          assert.equal(state.executablePath, yield* h.resolve);
          assertPath(state.executablePath, h.installation.executablePath);
          assert.equal(state.installedVersion, omo ? "5.1.69" : "1.5.0");
          assert.equal(state.version, state.installedVersion);
          assert.equal(h.probes.at(-1), state.executablePath);
          assert.equal(h.changed(), 1);
          assert.equal(
            h.installation.environment[h.installation.pathKey],
            [path.dirname(h.installation.executablePath), h.environment[pathKey]].join(
              platform === "win32" ? ";" : ":",
            ),
          );
          if (platform === "win32")
            assert.include(
              (yield* h.spawn).command.toLowerCase(),
              h.installation.executablePath.toLowerCase(),
            );
          assert.equal((yield* h.inspect).installedVersion, state.installedVersion);
          assert.equal(h.environment[pathKey], path.dirname(h.localBinary));
        }).pipe(Effect.scoped),
      );
    }
  }

  it.effect("uses Windows Path casing, semicolon delimiters, and managed cmd shims", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const h = yield* makeHarness({ omo: true, pathKey: "Path", localVersion: "5.1.68" });
      assertPath(yield* h.resolve, h.localBinary, "win32");
      yield* h.installation.start;
      const state = yield* h.terminal;
      assert.equal(state.phase, "succeeded");
      assert.equal(state.installedVersion, "5.1.69");
      assert.equal(state.executablePath, yield* h.resolve);
      assert.equal(path.basename(state.executablePath!).toLowerCase(), "omo.cmd");
      assert.equal(
        h.installation.environment.Path,
        `${path.dirname(h.installation.executablePath)};${h.environment.Path}`,
      );
      assert.isUndefined(h.installation.environment.PATH);
    }).pipe(Effect.provideService(HostProcess.Platform, "win32"), Effect.scoped),
  );

  it.effect("keeps duplicate Windows PATH keys consistent for resolution and child processes", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ duplicatePathKey: true, localVersion: "1.4.0" });
      yield* h.installation.start;
      assert.equal((yield* h.terminal).phase, "succeeded");
      assertPath(yield* h.resolve, h.installation.executablePath, "win32");
      assert.equal(h.installation.pathKey, "PATH");
      assert.equal(h.installation.environment.PATH, h.installation.environment.Path);
      assert.notEqual(h.environment.PATH, h.environment.Path);
    }).pipe(Effect.provideService(HostProcess.Platform, "win32"), Effect.scoped),
  );

  it.effect("recognizes the same managed Windows binary with an uppercase CMD extension", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ uppercaseShim: true, localVersion: "1.4.0" });
      yield* h.installation.start;
      const state = yield* h.terminal;
      assert.equal(state.phase, "succeeded");
      assert.equal(state.source, "managed");
      assertPath(state.executablePath, h.installation.executablePath, "win32");
      assert.equal(state.executablePath, yield* h.resolve);
      assert.equal((yield* h.inspect).source, "managed");
    }).pipe(Effect.provideService(HostProcess.Platform, "win32"), Effect.scoped),
  );

  for (const omo of [false, true]) {
    for (const pathKey of ["PATH", "Path"] as const) {
      it.effect(
        `executes managed ${omo ? "omo" : "pi"} from ${pathKey} and restores the old CLI after removal`,
        () =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const commandName = omo ? "omo" : "pi";
            const localVersion = omo ? "5.1.68" : "1.4.0";
            const h = yield* makeHarness({ omo, pathKey, localVersion, realCli: true });
            assert.equal(yield* h.run, `${commandName} ${localVersion}`);
            yield* h.installation.start;
            const state = yield* h.terminal;
            assert.equal(state.phase, "succeeded");
            assert.equal(yield* h.run, `${commandName} ${state.installedVersion}`);
            assert.equal(state.executablePath, yield* h.resolve);
            yield* fs.remove(h.installation.executablePath);
            assertPath((yield* h.inspect).executablePath, h.localBinary);
            assert.equal(yield* h.run, `${commandName} ${localVersion}`);
          }).pipe(Effect.scoped),
      );
    }
  }

  it.effect("accepts the default command explicitly without preserving a stale PATH hit", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ customBinary: "pi", localVersion: "1.4.0" });
      assertPath(yield* h.resolve, h.localBinary);
      yield* h.installation.start;
      assertPath((yield* h.terminal).executablePath, h.installation.executablePath);
      assertPath(yield* h.resolve, h.installation.executablePath);
    }).pipe(Effect.scoped),
  );

  for (const customBinary of [true, "custom-pi"]) {
    it.effect(`preserves a custom ${customBinary === true ? "path" : "command"} selection`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const platform = yield* HostProcess.Platform;
        const h = yield* makeHarness({ customBinary, localVersion: "1.4.0" });
        yield* fs.makeDirectory(path.dirname(h.installation.executablePath), { recursive: true });
        yield* fs.writeFileString(h.installation.executablePath, "installed-pi-1.5.0", {
          mode: 0o755,
        });
        const state = yield* h.inspect;
        assert.equal(state.installedVersion, "9.9.9");
        assert.equal(state.source, "local");
        assert.notEqual(state.executablePath, h.installation.executablePath);
        assertPath(yield* h.resolve, h.localBinary);
        assert.equal(
          h.installation.environment.PATH,
          [h.environment.PATH, path.dirname(h.installation.executablePath)].join(
            platform === "win32" ? ";" : ":",
          ),
        );
        assert.include((yield* Effect.flip(h.installation.start)).detail, "custom binary");
      }).pipe(Effect.scoped),
    );
  }

  for (const omo of [false, true]) {
    it.effect(`restores PATH resolution after removing managed ${omo ? "OMO" : "Pi"}`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const platform = yield* HostProcess.Platform;
        const h = yield* makeHarness({ omo, localVersion: omo ? "5.1.68" : "1.4.0" });
        yield* h.installation.start;
        assert.equal((yield* h.terminal).source, "managed");
        assertPath(yield* h.resolve, h.installation.executablePath);
        yield* h.spawn;
        yield* fs.remove(h.installation.executablePath);
        const state = yield* h.inspect;
        assert.equal(state.source, "local");
        assertPath(state.executablePath, h.localBinary);
        assert.equal(state.installedVersion, omo ? "5.1.68" : "1.4.0");
        assertPath(yield* h.resolve, h.localBinary);
        if (platform === "win32")
          assert.include((yield* h.spawn).command.toLowerCase(), h.localBinary.toLowerCase());
      }).pipe(Effect.scoped),
    );
  }

  it.effect("clears stale installed metadata when no executable remains", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const h = yield* makeHarness();
      yield* h.installation.start;
      assert.equal((yield* h.terminal).phase, "succeeded");
      yield* h.resolve;
      yield* fs.remove(h.installation.executablePath);
      const state = yield* h.inspect;
      assert.isNull(state.installedVersion);
      assert.isNull(state.executablePath);
      assert.isNull(state.source);
      assert.isNull(yield* h.resolve);
    }).pipe(Effect.scoped),
  );

  for (const fixture of [
    { version: "unrecognized" },
    { binary: "missing" as const },
    { removeOnActivation: true },
    { activeVersion: "0.1.0" },
    { activeVersion: "unrecognized" },
    { activeFails: true },
  ]) {
    it.effect(
      `rejects an unusable package without reporting the PATH fallback as installed: ${JSON.stringify(fixture)}`,
      () =>
        Effect.gen(function* () {
          const h = yield* makeHarness({ ...fixture, omo: true, localVersion: "5.1.68" });
          yield* h.installation.start;
          const state = yield* h.terminal;
          assert.equal(state.phase, "failed");
          assert.notEqual(state.source, "managed");
          assert.notEqual(state.executablePath, h.installation.executablePath);
          assert.equal(h.changed(), 0);
          assertPath(yield* h.resolve, h.localBinary);
        }).pipe(Effect.scoped),
    );
  }

  it.effect.runIf(HostProcess.Platform.defaultValue() !== "win32")(
    "rejects a package whose binary is not executable",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness({ binary: "non-executable", localVersion: "1.4.0" });
        yield* h.installation.start;
        assert.equal((yield* h.terminal).phase, "failed");
        assertPath(yield* h.resolve, h.localBinary);
        assert.equal(h.changed(), 0);
      }).pipe(Effect.scoped),
  );

  it.effect("reports the version probed through the activated command", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ activeVersion: "1.5.1" });
      yield* h.installation.start;
      const state = yield* h.terminal;
      assert.equal(state.phase, "succeeded");
      assert.equal(state.version, "1.5.1");
      assert.equal(state.installedVersion, "1.5.1");
      assert.equal(h.probes.at(-1), state.executablePath);
    }).pipe(Effect.scoped),
  );

  it.effect("rolls back a failed activated update to the previous managed package", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const h = yield* makeHarness({ localVersion: "1.4.0" });
      yield* h.installation.start;
      assert.equal((yield* h.terminal).installedVersion, "1.5.0");
      h.configure({ version: "1.5.1", activeVersion: "unrecognized" });
      yield* h.installation.start;
      const state = yield* h.terminal;
      assert.equal(state.phase, "failed");
      assert.equal(state.installedVersion, "1.5.0");
      assert.equal(yield* fs.readFileString(h.installation.executablePath), "installed-pi-1.5.0");
      assertPath(yield* h.resolve, h.installation.executablePath);
      assert.equal(h.changed(), 1);
      assert.lengthOf(
        yield* fs.readDirectory(path.join(h.root, "tools", "pi", "pi-test", "releases")),
        1,
      );
    }).pipe(Effect.scoped),
  );

  it.effect("installs the pinned OMO package in its own tools directory and resolves its CLI", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const h = yield* makeHarness({ omo: true });
      yield* h.installation.start;
      const state = yield* h.terminal;
      assert.equal(state.driver, "omo");
      assert.equal(state.phase, "succeeded");
      assert.equal(state.installedVersion, "5.1.69");
      assert.isTrue(h.calls.some((args) => args.includes("omo-ai@5.1.69")));
      assert.isTrue(h.installation.executablePath.startsWith(path.join(h.root, "tools", "omo")));
      const resolved = yield* resolveCommandPath("omo", { env: h.installation.environment }).pipe(
        Effect.provideService(CommandResolutionCache, h.commandCache),
      );
      assertPath(resolved, h.installation.executablePath);
    }),
  );
  it.effect(
    "installs the complete package tree in Cox and invalidates a cached missing command",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const h = yield* makeHarness();
        const resolve = resolveCommandPath("pi", { env: h.installation.environment }).pipe(
          Effect.provideService(CommandResolutionCache, h.commandCache),
        );
        assert.isNull(yield* resolve);
        yield* h.installation.start;
        const state = yield* h.terminal;
        assert.equal(state.phase, "succeeded");
        assert.equal(state.installedVersion, "1.5.0");
        assert.equal(state.source, "managed");
        assertPath(yield* resolve, h.installation.executablePath);
        assert.equal(yield* fs.readFileString(h.installation.executablePath), "installed-pi-1.5.0");
        assert.equal(
          yield* fs.readFileString(
            path.join(path.dirname(path.dirname(h.installation.executablePath)), "fixture.json"),
          ),
          "dependency",
        );
        assert.isFalse(yield* fs.exists(path.join(h.root, "user-home", ".pi")));
        assert.include(h.calls[0]!, "--ignore-scripts");
        assert.include(h.calls[0]!, "@earendil-works/pi-coding-agent@latest");
      }).pipe(Effect.scoped),
  );

  it.effect("keeps the prior package tree usable when an update fails, and supports retry", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const h = yield* makeHarness();
      yield* h.installation.start;
      assert.equal((yield* h.terminal).phase, "succeeded");
      h.configure({ fail: true, version: "1.5.1" });
      yield* h.installation.start;
      assert.equal((yield* h.terminal).phase, "failed");
      assert.equal(yield* fs.readFileString(h.installation.executablePath), "installed-pi-1.5.0");
      h.configure({ fail: false });
      yield* h.installation.start;
      assert.equal((yield* h.terminal).installedVersion, "1.5.1");
      assert.equal(yield* fs.readFileString(h.installation.executablePath), "installed-pi-1.5.1");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "deduplicates downloads and cancels only the active operation while cleaning staging",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const h = yield* makeHarness({ blocked: true });
        const first = yield* h.installation.start;
        yield* Deferred.await(h.downloading);
        assert.equal((yield* h.installation.start).operationId, first.operationId);
        assert.equal(h.calls.filter((args) => args[0] === "install").length, 1);
        assert.equal((yield* h.installation.cancel("stale-operation")).phase, "downloading");
        assert.equal((yield* h.installation.cancel(first.operationId!)).phase, "cancelled");
        assert.isFalse(yield* fs.exists(h.installation.executablePath));
        assert.deepEqual(yield* fs.readDirectory(path.join(h.root, "tools", "pi", "pi-test")), []);
      }).pipe(Effect.scoped),
  );

  it.effect("does not replace a custom executable or accept an unsupported download", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ customBinary: true });
      assert.include((yield* Effect.flip(h.installation.start)).detail, "custom binary");
      assert.deepEqual(h.calls, []);
      const invalid = yield* makeHarness({ version: "0.1.0" });
      yield* invalid.installation.start;
      assert.equal((yield* invalid.terminal).phase, "failed");
      assert.isFalse(
        yield* (yield* FileSystem.FileSystem).exists(invalid.installation.executablePath),
      );
    }).pipe(Effect.scoped),
  );
});

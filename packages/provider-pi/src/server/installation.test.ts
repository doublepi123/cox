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
import { ChildProcessSpawner } from "effect/process";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { CommandResolutionCache, resolveCommandPath } from "@t3tools/shared/shell";
import { makePiInstallation } from "./installation.ts";

const makeHarness = Effect.fn("PiInstallation.test.harness")(function* (
  options: {
    readonly customBinary?: boolean;
    readonly blocked?: boolean;
    readonly fail?: boolean;
    readonly version?: string;
    readonly omo?: boolean;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
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
  const commandName = options.omo ? "omo" : "pi";
  let version = options.version ?? (options.omo ? "5.1.69" : "1.5.0");
  const commandCache = new Map<
    string,
    { readonly resolvedPath: string | null; readonly expiresAtNanos: bigint }
  >();
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand") return yield* Effect.die("Unexpected pipeline");
      calls.push(command.args);
      const installing = command.args[0] === "install";
      if (installing) {
        const staging = command.args[command.args.indexOf("--prefix") + 1]!;
        const stagedBin = path.join(staging, "node_modules", ".bin");
        yield* fs.makeDirectory(stagedBin, { recursive: true });
        const executable = path.join(
          stagedBin,
          platform === "win32" ? `${commandName}.cmd` : commandName,
        );
        yield* fs.writeFileString(executable, `installed-${commandName}-` + version);
        yield* fs.chmod(executable, 0o755);
        yield* fs.writeFileString(path.join(staging, "node_modules", "fixture.json"), "dependency");
        yield* Deferred.succeed(downloading, undefined);
      }
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(900_000_001),
        exitCode:
          installing && blocked
            ? Deferred.await(release).pipe(Effect.as(ChildProcessSpawner.ExitCode(0)))
            : Effect.succeed(ChildProcessSpawner.ExitCode(installing && fail ? 1 : 0)),
        isRunning: Effect.succeed(installing && blocked),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout:
          command.args[0] === "--version"
            ? Stream.encodeText(Stream.make(commandName + " " + version + "\n"))
            : Stream.empty,
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
    ...(options.customBinary ? { binaryPath: "/custom/pi" } : {}),
    environment: { PATH: bin, HOME: path.join(root, "user-home") },
    onChanged: Effect.void,
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
    downloading,
    release,
    commandCache,
    configure: (next: { fail?: boolean; blocked?: boolean; version?: string }) => {
      fail = next.fail ?? fail;
      blocked = next.blocked ?? blocked;
      version = next.version ?? version;
    },
  };
});

it.layer(NodeServices.layer)("Pi installation", (it) => {
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
      assert.equal(resolved, h.installation.executablePath);
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
        assert.equal(yield* resolve, h.installation.executablePath);
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

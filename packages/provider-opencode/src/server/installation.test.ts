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
import { CommandResolutionCache } from "@t3tools/shared/shell";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { makeOpenCodeInstallation } from "./installation.ts";

const makeHarness = Effect.fn("OpenCodeInstallation.test.harness")(function* (
  options: {
    readonly customBinary?: boolean;
    readonly blocked?: boolean;
    readonly fail?: boolean;
    readonly version?: string;
    readonly serverUrl?: string;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "cox-opencode-install-test-" });
  const bin = path.join(root, "host-bin");
  yield* fs.makeDirectory(bin);
  for (const name of platform === "win32" ? ["npm.cmd", "node.exe"] : ["npm", "node"]) {
    const file = path.join(bin, name);
    yield* fs.writeFileString(file, "stub");
    yield* fs.chmod(file, 0o755);
  }
  const downloading = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const calls: ReadonlyArray<string>[] = [];
  const commandCache = new Map<string, { resolvedPath: string | null; expiresAtNanos: bigint }>();
  let refreshed = 0;
  let fail = options.fail ?? false;
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand") return yield* Effect.die("Unexpected pipeline");
      calls.push(command.args);
      const install = command.args[0] === "install";
      if (install) yield* Deferred.succeed(downloading, undefined);
      if (command.args[0]?.endsWith("postinstall.mjs")) {
        const home = path.dirname(command.args[0]);
        yield* fs.makeDirectory(path.join(home, "bin"), { recursive: true });
        yield* fs.writeFileString(path.join(home, "bin", "opencode.exe"), "new-native-binary");
      }
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode:
          install && options.blocked
            ? Deferred.await(release).pipe(Effect.as(ChildProcessSpawner.ExitCode(0)))
            : Effect.succeed(ChildProcessSpawner.ExitCode(install && fail ? 1 : 0)),
        isRunning: Effect.succeed(install && Boolean(options.blocked)),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout:
          command.args[0] === "--version"
            ? Stream.encodeText(Stream.make(options.version ?? "opencode v2.2.5\n"))
            : Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  const buildInstallation = makeOpenCodeInstallation({
    instanceId: ProviderInstanceId.make("opencode-test"),
    baseDir: root,
    binaryPath: options.customBinary ? "/custom/opencode" : "opencode",
    ...(options.serverUrl === undefined ? {} : { serverUrl: options.serverUrl }),
    environment: { PATH: bin, HOME: path.join(root, "user-home") },
    onChanged: Effect.sync(() => {
      refreshed++;
    }),
  }).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.provideService(CommandResolutionCache, commandCache),
  );
  const installation = yield* buildInstallation;
  const terminal = installation.changes.pipe(
    Stream.filter((state) => ["succeeded", "failed", "cancelled"].includes(state.phase)),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );
  return {
    installation,
    terminal,
    root,
    calls,
    commandCache,
    buildInstallation,
    bin,
    downloading,
    release,
    refreshed: () => refreshed,
    allowRetry: () => {
      fail = false;
    },
  };
});

it.layer(NodeServices.layer)("OpenCode installation", (it) => {
  it.effect(
    "prefers an existing CLI on PATH and discovers managed installations after restart",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const platform = yield* HostProcess.Platform;
        const h = yield* makeHarness();
        yield* h.installation.start;
        assert.equal((yield* h.terminal).phase, "succeeded");
        const restarted = yield* h.buildInstallation;
        assert.equal(yield* restarted.resolveExecutable, h.installation.executablePath);
        const state = yield* Stream.runHead(restarted.changes).pipe(Effect.map(Option.getOrThrow));
        assert.equal(state.source, "managed");
        assert.equal(state.installedVersion, "2.2.5");
        const local = path.join(h.bin, platform === "win32" ? "opencode.exe" : "opencode");
        yield* fs.writeFileString(local, "existing-local-cli");
        yield* fs.chmod(local, 0o755);
        assert.equal(yield* restarted.resolveExecutable, local);
        assert.equal(yield* fs.readFileString(local), "existing-local-cli");
      }).pipe(Effect.scoped),
  );
  it.effect("installs and verifies a native CLI inside Cox without modifying Claude's home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const h = yield* makeHarness();
      h.commandCache.set("missing-opencode", { resolvedPath: null, expiresAtNanos: 0n });
      const resolved = yield* h.installation.resolveExecutable;
      assert.equal(resolved, h.installation.executablePath);
      yield* h.installation.start;
      const state = yield* h.terminal;
      assert.equal(h.commandCache.size, 0);
      assert.strictEqual(state.phase, "succeeded");
      assert.strictEqual(state.installedVersion, "2.2.5");
      assert.strictEqual(state.source, "managed");
      assert.strictEqual(
        yield* fs.readFileString(h.installation.executablePath),
        "new-native-binary",
      );
      assert.isFalse(yield* fs.exists(path.join(h.root, "user-home", ".opencode")));
      assert.deepEqual(
        yield* fs.readDirectory(path.dirname(path.dirname(h.installation.executablePath))),
        ["bin"],
      );
      assert.include(h.calls[0]!, "--ignore-scripts");
      assert.include(h.calls[0]!, "@opencode/cli@latest");
      assert.isTrue(h.calls.some((args) => args[0]?.endsWith("postinstall.mjs")));
      assert.strictEqual(h.refreshed(), 1);
    }).pipe(Effect.scoped),
  );

  it.effect("cancels a download, preserves the prior CLI, and removes staging files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const h = yield* makeHarness({ blocked: true });
      yield* fs.makeDirectory(path.dirname(h.installation.executablePath), { recursive: true });
      yield* fs.writeFileString(h.installation.executablePath, "prior-native-binary");
      const started = yield* h.installation.start;
      yield* Deferred.await(h.downloading);
      const duplicate = yield* h.installation.start;
      assert.strictEqual(duplicate.operationId, started.operationId);
      assert.equal((yield* h.installation.cancel("stale-operation")).phase, "downloading");
      const cancelled = yield* h.installation.cancel(started.operationId!);
      assert.strictEqual(cancelled.phase, "cancelled");
      assert.strictEqual(
        yield* fs.readFileString(h.installation.executablePath),
        "prior-native-binary",
      );
      assert.deepEqual(
        yield* fs.readDirectory(path.dirname(path.dirname(h.installation.executablePath))),
        ["bin"],
      );
      assert.strictEqual(h.refreshed(), 0);
    }).pipe(Effect.scoped),
  );

  it.effect("retries failed installation and only reports success after verification", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ fail: true });
      yield* h.installation.start;
      assert.strictEqual((yield* h.terminal).phase, "failed");
      assert.strictEqual(h.refreshed(), 0);
      h.allowRetry();
      yield* h.installation.start;
      assert.strictEqual((yield* h.terminal).phase, "succeeded");
      assert.strictEqual(h.refreshed(), 1);
    }).pipe(Effect.scoped),
  );

  it.effect("protects explicitly configured executables from managed installation", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ customBinary: true });
      const failure = yield* Effect.flip(h.installation.start);
      assert.include(failure.detail, "custom binary");
      assert.deepEqual(h.calls, []);
    }).pipe(Effect.scoped),
  );

  it.effect.each(["invalid version", "1.18.32", "3.0.0"])(
    "rejects unsupported %s while preserving an existing binary",
    (version) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const h = yield* makeHarness({ version });
        yield* fs.makeDirectory(path.dirname(h.installation.executablePath), { recursive: true });
        yield* fs.writeFileString(h.installation.executablePath, "prior-native-binary");
        yield* h.installation.start;
        assert.equal((yield* h.terminal).phase, "failed");
        assert.equal(
          yield* fs.readFileString(h.installation.executablePath),
          "prior-native-binary",
        );
        assert.equal(h.refreshed(), 0);
      }).pipe(Effect.scoped),
  );

  it.effect("does not replace a local installation or install for an external server", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const platform = yield* HostProcess.Platform;
      const local = yield* makeHarness();
      const executable = path.join(local.bin, platform === "win32" ? "opencode.exe" : "opencode");
      yield* fs.writeFileString(executable, "local-v1");
      yield* fs.chmod(executable, 0o755);
      assert.include(
        (yield* Effect.flip(local.installation.start)).detail,
        "existing installation method",
      );
      assert.equal(yield* fs.readFileString(executable), "local-v1");
      assert.deepEqual(local.calls, []);
      const external = yield* makeHarness({ serverUrl: "http://127.0.0.1:4096" });
      assert.isFalse(external.installation.canInstall);
      assert.include((yield* Effect.flip(external.installation.start)).detail, "server URL");
      yield* Stream.runHead(external.installation.changes);
      assert.deepEqual(external.calls, []);
    }).pipe(Effect.scoped),
  );
});

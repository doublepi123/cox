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
import { makeGrokInstallation } from "./installation.ts";

const makeHarness = Effect.fn("GrokInstallation.test.harness")(function* (
  options: {
    readonly customBinary?: boolean;
    readonly blocked?: boolean;
    readonly fail?: boolean;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "cox-grok-install-test-" });
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
  let refreshed = 0;
  let fail = options.fail ?? false;
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand") return yield* Effect.die("Unexpected pipeline");
      calls.push(command.args);
      const install = command.args[0] === "install";
      if (install) yield* Deferred.succeed(downloading, undefined);
      if (command.args[0]?.endsWith("postinstall.js")) {
        const home = command.options.env!.GROK_HOME!;
        yield* fs.makeDirectory(path.join(home, "bin"), { recursive: true });
        yield* fs.writeFileString(
          path.join(home, "bin", platform === "win32" ? "grok.exe" : "grok"),
          "new-native-binary",
        );
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
            ? Stream.encodeText(Stream.make("grok 1.2.3 (test)\n"))
            : Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  const installation = yield* makeGrokInstallation({
    instanceId: ProviderInstanceId.make("grok-test"),
    baseDir: root,
    ...(options.customBinary ? { binaryPath: "/custom/grok" } : {}),
    environment: { PATH: bin, HOME: path.join(root, "user-home") },
    canStart: Effect.succeed(true),
    onChanged: Effect.sync(() => {
      refreshed++;
    }),
  }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
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
    downloading,
    release,
    refreshed: () => refreshed,
    allowRetry: () => {
      fail = false;
    },
  };
});

it.layer(NodeServices.layer)("Grok installation", (it) => {
  it.effect("installs and verifies a native CLI inside Cox without modifying Grok's home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const h = yield* makeHarness();
      yield* h.installation.start;
      const state = yield* h.terminal;
      assert.strictEqual(state.phase, "succeeded");
      assert.strictEqual(state.installedVersion, "1.2.3");
      assert.strictEqual(state.source, "managed");
      assert.strictEqual(
        yield* fs.readFileString(h.installation.executablePath),
        "new-native-binary",
      );
      assert.isFalse(yield* fs.exists(path.join(h.root, "user-home", ".grok")));
      assert.deepEqual(
        yield* fs.readDirectory(path.dirname(path.dirname(h.installation.executablePath))),
        ["bin"],
      );
      assert.include(h.calls[0]!, "--ignore-scripts");
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
});

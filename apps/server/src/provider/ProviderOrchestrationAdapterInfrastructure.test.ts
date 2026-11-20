import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Stream from "effect/Stream";

it.live("spawns the __cursor-sdk-worker CLI fast path and shuts down cleanly on close", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const executable = yield* HostProcess.ExecutablePath;
      const entry = yield* path.fromFileUrl(new URL("../bin.ts", import.meta.url));
      const fs = yield* FileSystem.FileSystem;
      const config = yield* fs.makeTempDirectoryScoped();
      const handle = yield* spawner.spawn(
        ChildProcess.make(executable, [entry, "__cursor-sdk-worker"], {
          stdin: { stream: "pipe", endOnDone: false },
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, CURSOR_CONFIG_DIR: config },
        }),
      );
      yield* Stream.run(
        Stream.encodeText(Stream.make(`${JSON.stringify({ id: 1, type: "close" })}\n`)),
        handle.stdin,
      );
      const stdout = yield* handle.stdout.pipe(Stream.decodeText(), Stream.mkString);
      const exitCode = Number(yield* handle.exitCode);
      assert.strictEqual(exitCode, 0);
      assert.deepStrictEqual(JSON.parse(stdout.trim()), {
        type: "response",
        id: 1,
        ok: true,
        result: null,
      });
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

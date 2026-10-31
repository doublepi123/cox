import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { ServerCliCommandExitError } from "./cliErrors.ts";

const build = Effect.gen(function* () {
  if (process.argv[2] !== "build") return yield* Effect.die("Usage: node scripts/cli.ts build");
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const serverDir = yield* path.fromFileUrl(new URL("..", import.meta.url));
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make(process.execPath, ["--run", "build:bundle"], {
      cwd: serverDir,
      stdout: "inherit",
      stderr: "inherit",
    }),
  );
  const exitCode = yield* child.exitCode;
  if (exitCode !== 0)
    return yield* new ServerCliCommandExitError({
      command: process.execPath,
      args: ["--run", "build:bundle"],
      cwd: serverDir,
      exitCode,
    });
  const webDist = path.join(serverDir, "../web/dist");
  yield* fs.readFileString(path.join(webDist, "index.html"));
  yield* fs.copy(webDist, path.join(serverDir, "dist/client"));
});
build.pipe(Effect.scoped, Effect.provide(NodeServices.layer), NodeRuntime.runMain);

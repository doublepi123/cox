// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- The guard runs in Node's unhandled-rejection callback, outside an Effect runtime. stderr must match Node's default unhandled-rejection print.
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { loadCursorSdk, loadCursorSqlite } from "./sdk.ts";

// The SDK leaves a shell-error promise unhandled, which would exit the server.
const CURSOR_SHELL_SPAWN_MARKERS = [
  "dump_zsh_state",
  "dump_bash_state",
  "__CURSOR_SANDBOX_ENV_RESTORE",
] as const;

function isCursorShellSpawnFailure(reason: unknown): boolean {
  if (typeof reason !== "object" || reason === null) {
    return false;
  }
  const syscall = Reflect.get(reason, "syscall");
  const code = Reflect.get(reason, "code");
  const spawnargs = Reflect.get(reason, "spawnargs");
  if (typeof syscall !== "string" || !syscall.startsWith("spawn") || typeof code !== "string") {
    return false;
  }
  if (!Array.isArray(spawnargs)) {
    return false;
  }
  return spawnargs.some(
    (arg) =>
      typeof arg === "string" && CURSOR_SHELL_SPAWN_MARKERS.some((marker) => arg.includes(marker)),
  );
}

/**
 * The SDK writes final frames from promises nothing awaits. A closed stream rejects them
 * with WriteIterableClosedError; an ended request body rejects them with the Aborted
 * ConnectError its connect-node pump wraps around ERR_STREAM_WRITE_AFTER_END. The classes
 * are minified, so only `name` identifies them.
 */
function isCursorClosedStreamWrite(reason: unknown): boolean {
  if (!(reason instanceof Error)) {
    return false;
  }
  if (reason.name === "WriteIterableClosedError") {
    return true;
  }
  return (
    reason.name === "ConnectError" &&
    reason.cause instanceof Error &&
    Reflect.get(reason.cause, "code") === "ERR_STREAM_WRITE_AFTER_END"
  );
}

/**
 * When the SDK's stall detector fires it aborts the request, then rejects a promise
 * nothing awaits. The abort is the SDK's own recovery, so it must not stop the server.
 * Only an abort raised from `onStall` counts; any other AbortError is still unexpected.
 */
function isCursorStallAbort(reason: unknown): boolean {
  return (
    reason instanceof Error &&
    reason.name === "AbortError" &&
    typeof reason.stack === "string" &&
    /^\s+at (?:\S+\.)?onStall\b/m.test(reason.stack)
  );
}

function onUnhandledRejection(reason: unknown): void {
  if (isCursorShellSpawnFailure(reason)) {
    console.error("Cursor shell spawn failed. The server will keep running.", reason);
    return;
  }
  if (isCursorClosedStreamWrite(reason)) {
    console.error("Cursor SDK wrote to a closed stream. The server will keep running.");
    return;
  }
  if (isCursorStallAbort(reason)) {
    console.error("Cursor SDK aborted a stalled request. The server will keep running.");
    return;
  }
  if (process.listenerCount("unhandledRejection") > 1) {
    return;
  }
  console.error(reason);
  process.exit(1);
}

const decodeCliConfig = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      network: Schema.optionalKey(
        Schema.Struct({ useHttp1ForAgent: Schema.optionalKey(Schema.Boolean) }),
      ),
    }),
  ),
);

const readCliTransport = Effect.gen(function* () {
  const { CURSOR_CONFIG_DIR, XDG_CONFIG_HOME } = yield* HostProcess.Environment;
  const home = yield* HostProcess.HomeDirectory;
  const directory = CURSOR_CONFIG_DIR?.trim()
    ? CURSOR_CONFIG_DIR
    : XDG_CONFIG_HOME?.trim()
      ? join(XDG_CONFIG_HOME, "cursor")
      : join(home, ".cursor");
  const path = join(directory, "cli-config.json");
  return yield* Effect.tryPromise(() => readFile(path, "utf8")).pipe(
    Effect.flatMap(decodeCliConfig),
    Effect.map((config) => config.network?.useHttp1ForAgent === true),
    Effect.catch((error) =>
      error._tag === "UnknownError" &&
      error.cause instanceof Error &&
      "code" in error.cause &&
      error.cause.code === "ENOENT"
        ? Effect.succeed(false)
        : Effect.logWarning("Could not read the Cursor CLI transport setting", { path }).pipe(
            Effect.as(false),
          ),
    ),
  );
});

/** Keeps the shell spawn guard armed while in-process agents run. */
export class CursorSdk extends Context.Service<
  CursorSdk,
  {
    readonly load: typeof loadCursorSdk;
    readonly loadSqlite: typeof loadCursorSqlite;
  }
>()("@t3tools/provider-cursor/server/CursorSdk") {}

/** Provide once per process: a second guard would defer to the first and swallow real rejections. */
export const layer = Layer.effect(
  CursorSdk,
  Effect.gen(function* () {
    const useHttp1 = yield* readCliTransport;
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        if (useHttp1) loadCursorSdk().Cursor.configure({ local: { useHttp1ForAgent: true } });
        process.on("unhandledRejection", onUnhandledRejection);
      }),
      () =>
        Effect.sync(() => {
          process.off("unhandledRejection", onUnhandledRejection);
          if (useHttp1) loadCursorSdk().Cursor.configure({ local: { useHttp1ForAgent: null } });
        }),
    );
    return CursorSdk.of({ load: loadCursorSdk, loadSqlite: loadCursorSqlite });
  }),
);

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { tmpdir } from "node:os";
import { vi } from "vite-plus/test";

import * as CursorSdk from "./CursorSdk.ts";

const configure = vi.hoisted(() => vi.fn());
vi.mock("./sdk.ts", () => ({
  loadCursorSdk: () => ({ Cursor: { configure } }),
  loadCursorSqlite: vi.fn(),
}));

// Shaped like the SDK's minified class: the constructor is not named after the error.
class o extends Error {
  override name = "WriteIterableClosedError";
}

// Calls the guard directly, with Vitest's own listener detached so the guard does not defer to it.
const rejectThroughGuard = (reason: unknown) =>
  Effect.gen(function* () {
    const others = process.listeners("unhandledRejection");
    yield* Layer.build(CursorSdk.layer);
    const guard = process.listeners("unhandledRejection").find((l) => !others.includes(l));
    assert.isDefined(guard);
    using exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    using _log = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const listener of others) process.off("unhandledRejection", listener);
    try {
      guard(reason, Promise.resolve());
    } finally {
      for (const listener of others) process.on("unhandledRejection", listener);
    }
    return exit.mock.calls;
  }).pipe(
    Effect.scoped,
    Effect.provideService(HostProcess.Environment, { CURSOR_CONFIG_DIR: tmpdir() }),
  );

describe("CursorSdk unhandled rejection guard", () => {
  it.effect("keeps the server running when the SDK writes to a closed stream", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* rejectThroughGuard(new o("WritableIterable is closed")), []);
    }),
  );

  it.effect("keeps the server running when the SDK aborts a stalled request", () =>
    Effect.gen(function* () {
      const stall = new DOMException("This operation was aborted", "AbortError");
      stall.stack = "AbortError: This operation was aborted\n    at Is.onStall (689.js:1:111536)";
      assert.deepStrictEqual(yield* rejectThroughGuard(stall), []);
    }),
  );

  it.effect("still exits on an abort that was not raised from onStall", () =>
    Effect.gen(function* () {
      const abort = new DOMException("onStall was aborted", "AbortError");
      abort.stack = "AbortError: onStall was aborted\n    at somewhereElse (app.js:1:1)";
      assert.deepStrictEqual(yield* rejectThroughGuard(abort), [[1]]);
    }),
  );

  it.effect("keeps the server running when the SDK writes after its request stream ended", () =>
    Effect.gen(function* () {
      // Shaped like `ConnectError.from(e, Code.Aborted)` from the SDK's connect-node body pump.
      const cause = Object.assign(new Error("write after end"), {
        code: "ERR_STREAM_WRITE_AFTER_END",
      });
      const reason = Object.assign(new Error("[aborted] write after end", { cause }), {
        name: "ConnectError",
        code: 10,
        rawMessage: "write after end",
      });
      assert.deepStrictEqual(yield* rejectThroughGuard(reason), []);
    }),
  );

  it.effect("still exits on other rejections", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* rejectThroughGuard(new Error("WritableIterable is closed")), [
        [1],
      ]);
    }),
  );

  it.effect("still exits on aborted requests other than a write after end", () =>
    Effect.gen(function* () {
      const cause = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      const reason = Object.assign(new Error("[aborted] socket hang up", { cause }), {
        name: "ConnectError",
        code: 10,
      });
      assert.deepStrictEqual(yield* rejectThroughGuard(reason), [[1]]);
    }),
  );
});

describe("Cursor SDK agent transport", () => {
  it.effect.each([
    ["explicit", "explicit/cli-config.json", true],
    ["xdg", "xdg/cursor/cli-config.json", true],
    ["home", "home/.cursor/cli-config.json", true],
    ["home", "home/.cursor/cli-config.json", false],
    ["home", null, false],
  ] as const)("uses the CLI config at %s (%s, %s)", ([source, file, enabled]) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "cox-cursor-config-" });
      configure.mockClear();
      if (file !== null) {
        const configPath = path.join(root, file);
        yield* fs.makeDirectory(path.dirname(configPath), { recursive: true });
        yield* fs.writeFileString(
          configPath,
          JSON.stringify({ network: { useHttp1ForAgent: enabled } }),
        );
      }
      const environment = {
        ...(source === "explicit" ? { CURSOR_CONFIG_DIR: path.join(root, "explicit") } : {}),
        ...(source === "home" ? {} : { XDG_CONFIG_HOME: path.join(root, "xdg") }),
      };
      yield* Effect.gen(function* () {
        yield* Layer.build(CursorSdk.layer);
        assert.deepStrictEqual(
          configure.mock.calls,
          enabled ? [[{ local: { useHttp1ForAgent: true } }]] : [],
        );
      }).pipe(
        Effect.scoped,
        Effect.provideService(HostProcess.Environment, environment),
        Effect.provideService(HostProcess.HomeDirectory, path.join(root, "home")),
      );
      assert.deepStrictEqual(
        configure.mock.calls,
        enabled
          ? [[{ local: { useHttp1ForAgent: true } }], [{ local: { useHttp1ForAgent: null } }]]
          : [],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

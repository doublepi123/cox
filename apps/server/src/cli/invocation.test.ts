import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveHostCliCommand, resolveRootCliCommand } from "./invocation.ts";

describe("local CLI invocation", () => {
  it.effect("uses the current Node and entry, ignoring upstream launchers", () =>
    Effect.gen(function* () {
      const result = yield* resolveHostCliCommand("doctor", ["--home-dir", "/tmp/cox home"]);
      expect(result.command).toBe(
        "/opt/node/bin/node '/tmp/cox checkout/bin.ts' doctor --home-dir '/tmp/cox home'",
      );
      expect(yield* resolveRootCliCommand("browser setup")).toBe(
        "sudo /opt/node/bin/node '/tmp/cox checkout/bin.ts' browser setup",
      );
    }).pipe(
      Effect.provideService(HostProcess.ExecutablePath, "/opt/node/bin/node"),
      Effect.provideService(HostProcess.Arguments, ["node", "/tmp/cox checkout/bin.ts"]),
      Effect.provideService(HostProcess.IsExecutable, false),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.Environment, {
        T3CODE_CLI_PATH: "/upstream/t3",
        T3CODE_NPM_LAUNCHER_PATH: "/upstream/t3",
      }),
    ),
  );
});

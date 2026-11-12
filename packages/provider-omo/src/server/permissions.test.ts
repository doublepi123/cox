import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import { PiRpcError, type PiRpcConnection, type PiRpcRecord } from "@t3tools/provider-pi/server";
import { applyOmoRuntimePolicy, omoPermissionPreset } from "./permissions.ts";
import { buildOmoLaunch } from "./extension.ts";

const policy = (
  runtimeMode: "approval-required" | "auto-accept-edits" | "auto" | "full-access",
) => ({ runtimeMode, interactionMode: "default" as const, cwd: null });

describe("OMO runtime permissions", () => {
  it("maps Cox modes without making Auto unrestricted", () => {
    assert.equal(omoPermissionPreset("approval-required"), "ask");
    assert.equal(omoPermissionPreset("auto"), "ask");
    assert.equal(omoPermissionPreset("auto-accept-edits"), "accept-edits");
    assert.equal(omoPermissionPreset("full-access"), "full-access");
    for (const runtimeMode of [
      "approval-required",
      "auto-accept-edits",
      "auto",
      "full-access",
    ] as const) {
      const launch = buildOmoLaunch({
        launchArgs: [],
        environment: {},
        mcpSession: undefined,
        extensionPath: undefined,
        runtimeMode,
      });
      assert.equal(
        launch.args[launch.args.indexOf("--permission-preset") + 1],
        omoPermissionPreset(runtimeMode),
      );
      assert.isFalse(launch.args.includes("--omo-senpi-disabled"));
      assert.equal(launch.env.OMO_SENPI_DISABLED, "1");
    }
  });
  it("disables native task composition without passing npm-only extension flags", () => {
    const launch = buildOmoLaunch({
      launchArgs: [],
      environment: {},
      mcpSession: undefined,
      extensionPath: undefined,
      disableTools: true,
    });
    assert.include(launch.args, "--no-tools");
    assert.isFalse(launch.args.some((arg) => arg.startsWith("--omo-senpi")));
    assert.equal(launch.env.COX_OMO_TOOLS_REQUIRED, "0");
  });

  it.effect("sets an explicit client policy and verifies enforcement on every change", () =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<PiRpcRecord, PiRpcError>();
      const calls: PiRpcRecord[] = [];
      let preset = "ask";
      let terminated = false;
      const connection: PiRpcConnection = {
        events,
        send: () => Effect.void,
        exited: Effect.never,
        terminate: Effect.sync(() => {
          terminated = true;
        }),
        request: (input) =>
          Effect.sync(() => {
            calls.push(input);
            if (input.type === "set_permission_preset") preset = String(input.permissionPreset);
            return {
              permissionPreset: preset,
              permissionPresetSource: "client",
              permissionPresetStatus: "applied",
              effectivePermissionPreset: preset,
            };
          }),
      };
      for (const mode of ["full-access", "auto-accept-edits", "approval-required", "auto"] as const)
        yield* applyOmoRuntimePolicy(connection, policy(mode));
      assert.deepEqual(
        calls
          .filter((call) => call.type === "set_permission_preset")
          .map((call) => call.permissionPreset),
        ["full-access", "accept-edits", "ask", "ask"],
      );
      assert.equal(calls.filter((call) => call.type === "get_state").length, 4);
      assert.isFalse(terminated);
    }),
  );

  it.effect.each([
    "stale-preset",
    "host-default",
    "not-applied",
    "wrong-effective",
    "rpc-error",
  ] as const)("stops rather than using stale permissions: %s", (reason) =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<PiRpcRecord, PiRpcError>();
      let terminated = false;
      const valid = {
        permissionPreset: "ask",
        permissionPresetSource: "client",
        permissionPresetStatus: "applied",
        effectivePermissionPreset: "ask",
      };
      const connection: PiRpcConnection = {
        events,
        send: () => Effect.void,
        exited: Effect.never,
        terminate: Effect.sync(() => {
          terminated = true;
        }),
        request: (input) =>
          reason === "rpc-error"
            ? Effect.fail(new PiRpcError({ operation: "set_permission_preset" }))
            : Effect.succeed(
                input.type === "set_permission_preset"
                  ? valid
                  : {
                      ...valid,
                      ...(reason === "stale-preset" ? { permissionPreset: "full-access" } : {}),
                      ...(reason === "host-default"
                        ? { permissionPresetSource: "host_default" }
                        : {}),
                      ...(reason === "not-applied" ? { permissionPresetStatus: "invalid" } : {}),
                      ...(reason === "wrong-effective"
                        ? { effectivePermissionPreset: "full-access" }
                        : {}),
                    },
              ),
      };
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(applyOmoRuntimePolicy(connection, policy("approval-required"))),
        ),
      );
      assert.isTrue(terminated);
    }),
  );
});

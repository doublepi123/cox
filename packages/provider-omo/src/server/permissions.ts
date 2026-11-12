import type { RuntimeMode } from "@t3tools/contracts";
import type { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";
import { PiRpcError, type PiRpcConnection, type PiRpcRecord } from "@t3tools/provider-pi/server";
import * as Effect from "effect/Effect";

export function omoPermissionPreset(mode: RuntimeMode): "ask" | "accept-edits" | "full-access" {
  return mode === "full-access"
    ? "full-access"
    : mode === "auto-accept-edits"
      ? "accept-edits"
      : "ask";
}

function record(value: unknown): PiRpcRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as PiRpcRecord)
    : {};
}

export const applyOmoRuntimePolicy = Effect.fn("OmoRuntime.applyPolicy")(
  function* (connection: PiRpcConnection, policy: ProviderAdapterV2RuntimePolicy) {
    const preset = omoPermissionPreset(policy.runtimeMode);
    const applied = record(
      yield* connection.request({ type: "set_permission_preset", permissionPreset: preset }),
    );
    const state = record(yield* connection.request({ type: "get_state" }));
    if (
      applied.permissionPreset !== preset ||
      applied.permissionPresetSource !== "client" ||
      applied.permissionPresetStatus !== "applied" ||
      state.permissionPreset !== preset ||
      state.permissionPresetSource !== "client" ||
      state.permissionPresetStatus !== "applied" ||
      state.effectivePermissionPreset !== preset
    )
      return yield* new PiRpcError({
        operation: "set_permission_preset",
        detail:
          "OMO Native did not apply the requested Cox permission mode. The session was stopped rather than continuing with stale permissions.",
      });
  },
  (effect, connection) => effect.pipe(Effect.tapError(() => connection.terminate)),
);

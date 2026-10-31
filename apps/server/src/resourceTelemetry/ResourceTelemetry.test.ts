import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ResourceTelemetry from "./ResourceTelemetry.ts";
import * as NativeTelemetryClient from "./NativeTelemetryClient.ts";
import * as ResourceAttribution from "./ResourceAttribution.ts";

it.effect("refreshes only native local process telemetry", () =>
  Effect.gen(function* () {
    const service = yield* ResourceTelemetry.ResourceTelemetry;
    const snapshot = yield* service.refresh;
    expect(snapshot.groups.allT3.processCount).toBe(0);
    expect(snapshot.health).not.toHaveProperty("desktop");
    expect(snapshot.groups).not.toHaveProperty("electron");
    expect(snapshot.power.source).toBe("unknown");
  }).pipe(
    Effect.provide(
      ResourceTelemetry.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            ResourceAttribution.layer,
            NativeTelemetryClient.layerTest({
              sampleNow: Effect.succeed({
                generation: 0,
                snapshot: {
                  version: 3,
                  type: "snapshot",
                  sequence: 1,
                  sampledAtUnixMs: 1_000,
                  collectionDurationMicros: 0,
                  scannedProcessCount: 0,
                  retainedProcessCount: 0,
                  inaccessibleProcessCount: 0,
                  processes: [],
                },
              }),
            }),
          ),
        ),
      ),
    ),
  ),
);

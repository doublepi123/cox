import { describe, expect, it } from "@effect/vitest";
import type { ResourceMonitorSnapshotEvent } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as NativeTelemetryClient from "../resourceTelemetry/NativeTelemetryClient.ts";
import * as ResourceAttribution from "../resourceTelemetry/ResourceAttribution.ts";
import * as ResourceTelemetry from "../resourceTelemetry/ResourceTelemetry.ts";
import * as ProcessDiagnostics from "./ProcessDiagnostics.ts";

// ProcessDiagnostics treats process.pid as the server, so the fixture PID is an
// offset from it. A fixed PID collides whenever the test worker is assigned it.
const SERVER_PID = process.pid;
const CHILD_PID = SERVER_PID + 1;

function makeNativeSnapshot(
  processes: ResourceMonitorSnapshotEvent["processes"],
): ResourceMonitorSnapshotEvent {
  return {
    version: 3,
    type: "snapshot",
    sequence: 1,
    sampledAtUnixMs: DateTime.toEpochMillis(DateTime.makeUnsafe("2026-05-05T10:00:00.000Z")),
    collectionDurationMicros: 250,
    scannedProcessCount: processes.length,
    retainedProcessCount: processes.length,
    inaccessibleProcessCount: 0,
    processes,
  };
}

function layerTelemetryFor(snapshot: ResourceMonitorSnapshotEvent) {
  const layerNative = NativeTelemetryClient.layerTest({
    sampleNow: Effect.succeed({ generation: 0, snapshot }),
    health: Effect.succeed({
      status: "healthy",
      hello: Option.none(),
      lastSampleAt: Option.some(DateTime.makeUnsafe(snapshot.sampledAtUnixMs)),
      lastError: Option.none(),
      restartCount: 0,
      sampleIntervalMs: 1_000,
    }),
  });
  return ResourceTelemetry.layer.pipe(
    Layer.provide(Layer.mergeAll(layerNative, ResourceAttribution.layer)),
  );
}

describe("ProcessDiagnostics", () => {
  it.effect("rejects stale process identities before signaling", () =>
    Effect.gen(function* () {
      const snapshot = makeNativeSnapshot([]);
      const layerTelemetry = layerTelemetryFor(snapshot);
      const layer = ProcessDiagnostics.layer.pipe(Layer.provide(layerTelemetry));

      const result = yield* Effect.service(ProcessDiagnostics.ProcessDiagnostics).pipe(
        Effect.flatMap((processDiagnostics) =>
          processDiagnostics.signal({
            pid: CHILD_PID,
            startTimeMs: 2_000,
            signal: "SIGINT",
          }),
        ),
        Effect.provide(layer),
      );

      expect(result).toEqual({
        pid: CHILD_PID,
        signal: "SIGINT",
        signaled: false,
        message: Option.some(
          `Process ${CHILD_PID} no longer matches the selected process identity.`,
        ),
      });
    }),
  );

  it.effect("refuses to signal when a fresh identity check cannot be collected", () =>
    Effect.gen(function* () {
      const snapshot = makeNativeSnapshot([
        {
          pid: CHILD_PID,
          ppid: SERVER_PID,
          startTimeMs: 2_000,
          runTimeMs: 4_000,
          name: "agent",
          command: "codex app-server",
          status: "Running",
          cpuPercent: 1.5,
          cpuTimeMs: 60,
          residentBytes: 2_048,
          virtualBytes: 4_096,
          ioReadBytes: 300,
          ioWriteBytes: 400,
          ioSemantics: "storage",
        },
      ]);
      const staleTelemetry = yield* Effect.service(ResourceTelemetry.ResourceTelemetry).pipe(
        Effect.flatMap((telemetry) => telemetry.latest),
        Effect.provide(layerTelemetryFor(snapshot)),
      );
      const layerTelemetry = Layer.succeed(
        ResourceTelemetry.ResourceTelemetry,
        ResourceTelemetry.ResourceTelemetry.of({
          latest: Effect.succeed(staleTelemetry),
          changes: Stream.empty,
          subscribe: Effect.die("unused"),
          readHistory: () => Effect.die("unused"),
          refresh: Effect.fail(
            new ResourceTelemetry.ResourceTelemetryRefreshFailed({
              operation: "refresh",
              cause: new Error("collector unavailable"),
            }),
          ),
          retry: Effect.die("unused"),
        }),
      );
      const layer = ProcessDiagnostics.layer.pipe(Layer.provide(layerTelemetry));

      const result = yield* Effect.service(ProcessDiagnostics.ProcessDiagnostics).pipe(
        Effect.flatMap((processDiagnostics) =>
          processDiagnostics.signal({
            pid: CHILD_PID,
            startTimeMs: 2_000,
            signal: "SIGINT",
          }),
        ),
        Effect.provide(layer),
      );

      expect(result).toEqual({
        pid: CHILD_PID,
        signal: "SIGINT",
        signaled: false,
        message: Option.some(
          `Could not refresh process ${CHILD_PID}; refusing to signal a stale identity.`,
        ),
      });
    }),
  );
});

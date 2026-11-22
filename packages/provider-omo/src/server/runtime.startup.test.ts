import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";
import { makeOmoRpcConnection } from "./runtime.ts";
import { omoProbeFailureMessage } from "./status.ts";

const bootingOmo = Effect.gen(function* () {
  const stdout = yield* Queue.unbounded<Uint8Array>();
  const received = yield* Queue.unbounded<string>();
  const booted = yield* Deferred.make<void>();
  const spawner = ChildProcessSpawner.make(() =>
    Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(98765433),
        exitCode: Effect.never,
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((bytes: Uint8Array) => {
          const command: { readonly id: string; readonly type: string } = JSON.parse(
            Buffer.from(bytes).toString(),
          );
          const data =
            command.type === "get_protocol_info"
              ? { capabilities: ["session_lifecycle", "set_permission_preset_v1"] }
              : {};
          return Queue.offer(received, command.type).pipe(
            Effect.andThen(Deferred.await(booted)),
            Effect.andThen(
              Queue.offer(
                stdout,
                Buffer.from(
                  `${JSON.stringify({ type: "response", id: command.id, success: true, data })}\n`,
                ),
              ),
            ),
            Effect.asVoid,
          );
        }),
        stdout: Stream.fromQueue(stdout),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    ),
  );
  const connecting = yield* makeOmoRpcConnection({
    command: "omo",
    args: [],
    cwd: undefined,
    env: {},
  }).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.forkChild,
  );
  assert.strictEqual(yield* Queue.take(received), "set_client_info");
  return { booted, connecting };
});

describe("OMO Native startup", () => {
  it.effect("keeps waiting for a cold start past the default request timeout", () =>
    Effect.gen(function* () {
      const { booted, connecting } = yield* bootingOmo;
      yield* TestClock.adjust("119 seconds");
      yield* Deferred.succeed(booted, undefined);
      const exit = yield* Fiber.await(connecting);
      assert.isTrue(Exit.isSuccess(exit));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("gives up when OMO Native never answers within the startup budget", () =>
    Effect.gen(function* () {
      const { connecting } = yield* bootingOmo;
      yield* TestClock.adjust("120 seconds");
      const error = yield* Fiber.join(connecting).pipe(Effect.flip);
      assert.strictEqual(
        omoProbeFailureMessage(error),
        "Cox could not start OMO Native: set_client_info timed out after 120000ms.",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

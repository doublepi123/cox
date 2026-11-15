import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { makePiRpcConnection } from "./rpc.ts";

describe("Pi RPC optional incoming decoder", () => {
  it.effect("routes a decoded logical response to its pending request", () =>
    Effect.gen(function* () {
      const stdout = yield* Queue.unbounded<Uint8Array>();
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(98765432),
            exitCode: Effect.never,
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.forEach((bytes: Uint8Array) => {
              const command: { readonly id: string } = JSON.parse(Buffer.from(bytes).toString());
              return Queue.offer(
                stdout,
                Buffer.from(
                  `${JSON.stringify({ type: "response", id: command.id, success: true, data: { decoded: false } })}\n`,
                ),
              ).pipe(Effect.asVoid);
            }),
            stdout: Stream.fromQueue(stdout),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        ),
      );
      const connection = yield* makePiRpcConnection({
        command: "pi",
        args: [],
        cwd: undefined,
        env: {},
        decodeIncomingRecord: (record) => ({
          type: "response",
          id: record.id,
          command: "get_state",
          success: true,
          data: { decoded: true },
        }),
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
      assert.deepEqual(yield* connection.request({ type: "get_state" }), { decoded: true });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

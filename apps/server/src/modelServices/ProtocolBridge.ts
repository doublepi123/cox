import { ModelServiceError, type ModelServiceProtocol } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const formats: Record<ModelServiceProtocol, string> = {
  "openai-responses": "openai-response",
  "openai-chat": "openai",
  "anthropic-messages": "claude",
  gemini: "gemini",
};
const Response = Schema.Struct({
  body: Schema.optional(Schema.Unknown),
  chunks: Schema.optional(Schema.Array(Schema.String)),
  error: Schema.optional(Schema.String),
  replay: Schema.optional(
    Schema.Struct({
      opaqueItemsOmitted: Schema.Int,
      unavailableFieldsOmitted: Schema.Int,
    }),
  ),
  state: Schema.optional(
    Schema.Struct({
      doneReceived: Schema.Boolean,
      doneAccepted: Schema.Boolean,
      terminal: Schema.Boolean,
      finalized: Schema.Boolean,
      failed: Schema.Boolean,
    }),
  ),
});
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Response));
const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const encoder = new TextEncoder();
const isModelServiceError = Schema.is(ModelServiceError);

export const openProtocolBridge = Effect.fn("openProtocolBridge")(
  function* (options: {
    readonly from: ModelServiceProtocol;
    readonly to: ModelServiceProtocol;
    readonly model: string;
    readonly stream: boolean;
    readonly body: unknown;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const platform = yield* HostProcess.Platform;
    const architecture = yield* HostProcess.Architecture;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const name = `cox-protocol-bridge-${platform}-${architecture}${platform === "win32" ? ".exe" : ""}`;
    const bundled = yield* path.fromFileUrl(new URL(`./${name}`, import.meta.url));
    const source = yield* path.fromFileUrl(
      new URL(`../../../../native/protocol-bridge/dist/${name}`, import.meta.url),
    );
    const binary = (yield* fs.exists(bundled)) ? bundled : source;
    if (!(yield* fs.exists(binary)))
      return yield* new ModelServiceError({
        status: 503,
        detail:
          "The protocol converter is unavailable. Build Cox before using protocol conversion.",
      });
    const child = yield* spawner.spawn(
      ChildProcess.make(binary, [], { stdin: "pipe", stdout: "pipe", stderr: "pipe" }),
    );
    const input = yield* Queue.bounded<Uint8Array>(1);
    const output = yield* Queue.bounded<string, ModelServiceError>(1);
    const stopped = new ModelServiceError({
      detail: "The protocol converter stopped unexpectedly.",
    });
    yield* Stream.fromQueue(input).pipe(
      Stream.run(child.stdin),
      Effect.catchCause(() => Queue.fail(output, stopped)),
      Effect.forkScoped,
    );
    let buffer = "";
    yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) =>
        Effect.gen(function* () {
          buffer += chunk;
          if (buffer.length > 64 * 1024 * 1024) return yield* Queue.fail(output, stopped);
          let index: number;
          while ((index = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, index);
            buffer = buffer.slice(index + 1);
            if (line) yield* Queue.offer(output, line);
          }
        }),
      ),
      Effect.ensuring(Queue.fail(output, stopped)),
      Effect.forkScoped,
    );
    yield* child.stderr.pipe(Stream.runDrain, Effect.ignore, Effect.forkScoped);
    const lock = yield* Semaphore.make(1);
    let state: typeof Response.Type.state;
    const exchange = (value: unknown) =>
      lock
        .withPermit(
          Effect.gen(function* () {
            yield* Queue.offer(input, encoder.encode((yield* encode(value)) + "\n"));
            const result = yield* Queue.take(output).pipe(Effect.flatMap(decode));
            state = result.state;
            if (result.error) return yield* new ModelServiceError({ detail: result.error });
            return result;
          }),
        )
        .pipe(
          Effect.timeout("15 seconds"),
          Effect.mapError((error) =>
            isModelServiceError(error)
              ? error
              : new ModelServiceError({ detail: "Protocol conversion failed." }),
          ),
        );
    const converted = yield* exchange({
      type: "request",
      from: formats[options.from],
      to: formats[options.to],
      model: options.model,
      stream: options.stream,
      body: options.body,
    }).pipe(
      Effect.mapError((error) => new ModelServiceError({ detail: error.detail, status: 422 })),
    );
    return {
      body: converted.body,
      replay: converted.replay,
      snapshot: () => state,
      response: (body: unknown) =>
        exchange({ type: "response", body }).pipe(Effect.map((result) => result.body)),
      chunk: (chunk: string) =>
        exchange({ type: "chunk", chunk }).pipe(
          Effect.map((result) =>
            (result.chunks ?? []).map((value) => Uint8Array.from(Buffer.from(value, "base64"))),
          ),
        ),
      finish: () =>
        exchange({ type: "finish" }).pipe(
          Effect.map((result) =>
            (result.chunks ?? []).map((value) => Uint8Array.from(Buffer.from(value, "base64"))),
          ),
        ),
    };
  },
  Effect.mapError((error) =>
    isModelServiceError(error)
      ? error
      : new ModelServiceError({ detail: "Could not start the protocol converter." }),
  ),
);

import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { TextGenerationError } from "@t3tools/contracts";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import { makeDshAcpRuntime, resolveDshModelValue, type DshRuntimeLaunch } from "./acpSupport.ts";
import { withDshEphemeralSessions } from "./ephemeralSessions.ts";

const DSH_TEXT_TIMEOUT_MS = 180_000;
const isTextGenerationError = Schema.is(TextGenerationError);

export const makeDshTextGeneration = Effect.fn("makeDshTextGeneration")(function* (
  launch: DshRuntimeLaunch,
  environment: NodeJS.ProcessEnv,
) {
  const random = yield* SecureRandom.SecureRandom;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const run: TextGenerationOperations.Runner = Effect.fn("DshTextGeneration.run")(
    function* (request) {
      const { operation, cwd, prompt, modelSelection } = request;
      const output = yield* Ref.make("");
      const runtime = yield* withDshEphemeralSessions((patch) =>
        makeDshAcpRuntime({
          launch,
          environment,
          cwd,
          extraPatches: [patch],
          clientInfo: { name: "cox-text-generation", version: "0.0.0" },
        }),
      ).pipe(
        Effect.provideService(SecureRandom.SecureRandom, random),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
      yield* runtime.handleSessionUpdate((notification) => {
        const update = notification.update;
        if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text") {
          return Effect.void;
        }
        const text = update.content.text;
        return Ref.update(output, (current) => current + text);
      });
      const result = yield* Effect.gen(function* () {
        const started = yield* runtime.start();
        const model = resolveDshModelValue(modelSelection.model);
        if (started.modelConfigId !== undefined && model !== undefined) {
          yield* runtime.setConfigOption(started.modelConfigId, model);
        }
        return yield* runtime.prompt({ prompt: [{ type: "text", text: prompt }] });
      }).pipe(
        Effect.timeoutOption(DSH_TEXT_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({
                  operation,
                  detail: "DeepSeek Harness request timed out.",
                }),
              ),
            onSome: Effect.succeed,
          }),
        ),
      );
      const text = (yield* Ref.get(output)).trim();
      if (!text) {
        return yield* new TextGenerationError({
          operation,
          detail:
            result.stopReason === "cancelled"
              ? "DeepSeek Harness request was cancelled."
              : "DeepSeek Harness returned empty output.",
        });
      }
      return yield* TextGenerationOperations.decodeJsonReply(request, "DeepSeek Harness", text);
    },
    (effect, request) =>
      effect.pipe(
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation: request.operation,
                detail: "DeepSeek Harness text generation failed.",
                cause,
              }),
        ),
        Effect.scoped,
      ),
  );

  return TextGenerationOperations.fromRunner(
    "DshTextGeneration",
    TextGenerationOperations.withoutInvestigation("DeepSeek Harness", run),
  );
});

import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";

import { TextGenerationError } from "@t3tools/contracts";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import type { CursorCliSettings } from "../settings.ts";
import { makeCursorCliAcpRuntime, resolveCursorCliModelId } from "./acpSupport.ts";

const CURSOR_CLI_TEXT_TIMEOUT_MS = 180_000;
const isTextGenerationError = Schema.is(TextGenerationError);

export const makeCursorCliTextGeneration = Effect.fn("makeCursorCliTextGeneration")(function* (
  settings: CursorCliSettings,
  environment: NodeJS.ProcessEnv,
) {
  const random = yield* SecureRandom.SecureRandom;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const run: TextGenerationOperations.Runner = Effect.fn("CursorCliTextGeneration.run")(
    function* (request) {
      const { operation, cwd, prompt, modelSelection } = request;
      const output = yield* Ref.make("");
      const runtime = yield* makeCursorCliAcpRuntime({
        settings,
        environment,
        cwd,
        clientInfo: { name: "cox-git-text", version: "0.0.0" },
      }).pipe(
        Effect.provideService(SecureRandom.SecureRandom, random),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
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
        yield* runtime.start();
        yield* runtime.setMode("ask");
        yield* runtime.setModel(resolveCursorCliModelId(modelSelection.model));
        return yield* runtime.prompt({ prompt: [{ type: "text", text: prompt }] });
      }).pipe(
        Effect.timeoutOption(CURSOR_CLI_TEXT_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({ operation, detail: "Cursor CLI request timed out." }),
              ),
            onSome: Effect.succeed,
          }),
        ),
        Effect.mapError((cause: EffectAcpErrors.AcpError | TextGenerationError) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({ operation, detail: "Cursor CLI request failed.", cause }),
        ),
      );
      const text = (yield* Ref.get(output)).trim();
      if (!text) {
        return yield* new TextGenerationError({
          operation,
          detail:
            result.stopReason === "cancelled"
              ? "Cursor CLI request was cancelled."
              : "Cursor CLI returned empty output.",
        });
      }
      return yield* TextGenerationOperations.decodeJsonReply(request, "Cursor CLI", text);
    },
    (effect, request) =>
      effect.pipe(
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation: request.operation,
                detail: "Cursor CLI text generation failed.",
                cause,
              }),
        ),
        Effect.scoped,
      ),
  );

  return TextGenerationOperations.fromRunner(
    "CursorCliTextGeneration",
    TextGenerationOperations.withoutInvestigation("Cursor CLI", run),
  );
});

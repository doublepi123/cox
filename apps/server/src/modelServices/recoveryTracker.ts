import type { ProviderSessionId, OrchestrationV2ProviderTurn } from "@t3tools/contracts";
import type {
  ProviderAdapterV2Event,
  ProviderAdapterV2TurnInput,
} from "@t3tools/provider-core/server/ProviderAdapter";
import { makeProviderRetryTurnItem } from "@t3tools/provider-core/server/failure";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type { RecoveryProgress } from "./recovery.ts";
import type { ModelServiceRequestFailure } from "./recovery.ts";

type RecoveryTurn = Pick<ProviderAdapterV2TurnInput, "threadId" | "runId" | "rootNodeId"> & {
  readonly providerThread: Pick<ProviderAdapterV2TurnInput["providerThread"], "id" | "driver">;
};

export function makeRecoveryTracker() {
  const sessions = new Map<
    ProviderSessionId,
    {
      readonly input: RecoveryTurn;
      readonly emit: (event: ProviderAdapterV2Event) => Effect.Effect<void>;
      turn: OrchestrationV2ProviderTurn | undefined;
      ordinal: number;
      cancelled: boolean;
      latest: RecoveryProgress | undefined;
      started: DateTime.Utc | undefined;
      readonly failures: Map<string, ModelServiceRequestFailure>;
      readonly requests: Map<string, RecoveryProgress>;
    }
  >();
  const flush = Effect.fnUntraced(function* (entry: NonNullable<ReturnType<typeof sessions.get>>) {
    const progress = entry.latest;
    if (!progress || !entry.turn) return;
    const now = yield* DateTime.now;
    entry.started ??= now;
    const { input } = entry;
    const message =
      progress.phase === "hedging"
        ? "The model service is slow; a backup request is running."
        : progress.phase === "recovered"
          ? "The model service recovered."
          : progress.phase === "failed"
            ? "The model service recovery budget was exhausted."
            : progress.phase === "cancelled"
              ? "Model service recovery was stopped."
              : "The model service is temporarily unavailable; retrying.";
    yield* entry.emit({
      type: "turn_item.updated",
      driver: input.providerThread.driver,
      turnItem: makeProviderRetryTurnItem({
        driver: input.providerThread.driver,
        threadId: input.threadId,
        runId: input.runId,
        nodeId: input.rootNodeId,
        providerThreadId: input.providerThread.id,
        providerTurnId: entry.turn.id,
        itemOrdinal: entry.ordinal,
        failure: {
          class: "provider_error",
          message,
          code: `cox_model_service_${progress.phase}`,
          retryable: progress.phase !== "failed",
        },
        retry: {
          attempt: Math.max(1, progress.attempt),
          maxAttempts: progress.maxAttempts,
          retryDelayMs: progress.delayMs,
        },
        status:
          progress.phase === "recovered"
            ? "completed"
            : progress.phase === "failed"
              ? "failed"
              : progress.phase === "cancelled"
                ? "cancelled"
                : "running",
        startedAt: entry.started,
        updatedAt: now,
      }),
    });
  });
  return {
    begin: (
      sessionId: ProviderSessionId,
      input: RecoveryTurn,
      emit: (event: ProviderAdapterV2Event) => Effect.Effect<void>,
    ) =>
      Effect.sync(() => {
        const old = sessions.get(sessionId);
        if (old) old.cancelled = true;
        sessions.set(sessionId, {
          input: {
            threadId: input.threadId,
            runId: input.runId,
            rootNodeId: input.rootNodeId,
            providerThread: { id: input.providerThread.id, driver: input.providerThread.driver },
          },
          emit,
          turn: undefined,
          ordinal: 0,
          cancelled: false,
          latest: undefined,
          started: undefined,
          failures: new Map(),
          requests: new Map(),
        });
      }),
    observe: Effect.fnUntraced(function* (
      sessionId: ProviderSessionId,
      event: ProviderAdapterV2Event,
    ) {
      const entry = sessions.get(sessionId);
      if (!entry) return;
      if (
        event.type === "provider_turn.updated" &&
        event.providerTurn.nodeId === entry.input.rootNodeId
      ) {
        entry.turn = event.providerTurn;
        yield* flush(entry);
      }
      if (
        event.type === "turn_item.updated" &&
        event.turnItem.providerTurnId === entry.turn?.id &&
        entry.started === undefined &&
        !event.turnItem.id.includes("terminal-failure")
      )
        entry.ordinal = Math.max(entry.ordinal, event.turnItem.ordinal + 1);
      if (
        event.type === "turn.terminal" &&
        event.providerThreadId === entry.input.providerThread.id
      ) {
        entry.cancelled = true;
        sessions.delete(sessionId);
      }
    }),
    cancel: (sessionId: ProviderSessionId) =>
      Effect.sync(() => {
        const entry = sessions.get(sessionId);
        if (entry) entry.cancelled = true;
      }),
    close: (sessionId: ProviderSessionId) =>
      Effect.sync(() => {
        const entry = sessions.get(sessionId);
        if (entry) entry.cancelled = true;
        sessions.delete(sessionId);
      }),
    request: (sessionId: ProviderSessionId | undefined, key: string) => {
      const entry = sessionId ? sessions.get(sessionId) : undefined;
      return {
        cancelled: Effect.sync(() => entry?.cancelled === true),
        failure: entry?.failures.get(key),
        failed: (error: ModelServiceRequestFailure) =>
          Effect.sync(() => {
            entry?.failures.set(key, error);
          }),
        progress: (progress: RecoveryProgress) =>
          entry
            ? Effect.suspend(() => {
                entry.requests.set(key, progress);
                entry.latest =
                  [...entry.requests.values()].find(
                    (value) => value.phase === "retrying" || value.phase === "hedging",
                  ) ?? progress;
                return flush(entry);
              })
            : Effect.void,
      };
    },
  };
}

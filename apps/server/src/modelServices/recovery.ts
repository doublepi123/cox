import type { ModelServiceRecovery } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Scope from "effect/Scope";
import * as Option from "effect/Option";

export class ModelServiceRequestFailure extends Data.TaggedError("ModelServiceRequestFailure")<{
  readonly detail: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly code?: string | undefined;
  readonly source?: "gateway" | "upstream" | undefined;
  readonly timeoutMs?: number;
  readonly terminationReason?: string;
  readonly budgetMs?: number;
  readonly elapsedMs?: number;
  readonly attempts?: number;
  readonly lastAttemptFailure?: {
    readonly code?: string | undefined;
    readonly source?: "gateway" | "upstream" | undefined;
    readonly status: number;
    readonly detail: string;
    readonly timeoutMs?: number | undefined;
  };
}> {}

export class ModelServiceRequestCancelled extends Data.TaggedError("ModelServiceRequestCancelled")<{
  readonly detail: string;
}> {}

export interface RecoveryProgress {
  readonly phase: "retrying" | "hedging" | "recovered" | "failed" | "cancelled";
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly reason?: string;
}

export interface RecoveryDiagnostic {
  readonly event:
    | "attempt_started"
    | "attempt_closed"
    | "attempt_failed"
    | "hedge_waiting"
    | "terminal";
  readonly attempt?: number;
  readonly reason?: string;
  readonly hedge?: boolean;
  readonly status?: number;
  readonly code?: string | undefined;
  readonly source?: "gateway" | "upstream" | undefined;
  readonly elapsedMs: number;
}

export interface ModelServiceRecoveryLoad {
  inFlight: number;
  hedges: number;
  cooldownUntil: number;
}

export const retryAfterMilliseconds = (value: string | undefined, now: number): number => {
  if (!value) return 0;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.max(0, delay) : 0;
};

export function isRetryableModelServiceError(
  status: number,
  error: Record<string, unknown>,
): boolean {
  const code = String(error.code ?? error.type ?? error.reason);
  if (
    [
      "no_available_channel",
      "no_available_channels",
      "channel_unavailable",
      "upstream_timeout",
      "overloaded_error",
      "server_error",
      "rate_limit_error",
    ].includes(code)
  )
    return true;
  if (
    [
      "insufficient_quota",
      "insufficient_user_quota",
      "billing_hard_limit_reached",
      "context_length_exceeded",
      "invalid_api_key",
      "authentication_error",
      "permission_error",
      "model_not_found",
      "unsupported_parameter",
      "unsupported_value",
      "invalid_request_error",
      "max_output_tokens",
      "content_filter",
    ].includes(code)
  )
    return false;
  return [408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529].includes(status);
}

export const recoverModelServiceRequest = Effect.fn("recoverModelServiceRequest")(function* <
  A,
>(options: {
  readonly policy: ModelServiceRecovery;
  readonly reasoning: boolean;
  readonly load: ModelServiceRecoveryLoad;
  readonly enabled: Effect.Effect<boolean>;
  readonly cancelled?: Effect.Effect<boolean>;
  readonly attempt: (attempt: number) => Effect.Effect<A, ModelServiceRequestFailure, Scope.Scope>;
  readonly progress: (progress: RecoveryProgress) => Effect.Effect<void>;
  readonly diagnostic?: (event: RecoveryDiagnostic) => Effect.Effect<void>;
}) {
  const { policy, load } = options;
  const respectRetryAfter = !policy.retryOn429;
  const scope = yield* Scope.Scope;
  const started = yield* Clock.currentTimeMillis;
  const deadline = started + policy.budgetMs;
  const delay = options.reasoning ? policy.reasoningHedgeDelayMs : policy.hedgeDelayMs;
  type Event =
    | { readonly type: "ready"; readonly id: number; readonly value: A }
    | { readonly type: "failed"; readonly id: number; readonly error: ModelServiceRequestFailure };
  const events = yield* Queue.unbounded<Event>();
  const active = new Map<number, { readonly scope: Scope.Closeable; readonly hedge: boolean }>();
  let attempts = 0;
  let nextHedgeAt = started + delay;
  let retryAt = Infinity;
  let announced = false;
  let settled = false;
  let terminationReason = "recovery_budget_exhausted";
  let permanentFailure: ModelServiceRequestFailure | undefined;
  let lastAttemptFailure: ModelServiceRequestFailure | undefined;
  let closeReason = "client_disconnected";
  const waits = new Set<string>();
  let lastFailure = new ModelServiceRequestFailure({
    detail: "The model service did not produce a usable response within its recovery budget.",
    status: 504,
    retryable: false,
  });
  const diagnostic = (event: Omit<RecoveryDiagnostic, "elapsedMs">) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap(
        (now) => options.diagnostic?.({ ...event, elapsedMs: now - started }) ?? Effect.void,
      ),
    );
  const report = (phase: RecoveryProgress["phase"], delayMs = 0, reason?: string) => {
    announced = true;
    return options.progress({
      phase,
      attempt: attempts,
      maxAttempts: policy.maxAttempts,
      delayMs,
      ...(reason ? { reason } : {}),
    });
  };
  const close = Effect.fnUntraced(function* (id: number, reason = closeReason) {
    const entry = active.get(id);
    if (!entry) return;
    active.delete(id);
    load.inFlight--;
    if (entry.hedge) load.hedges--;
    yield* diagnostic({ event: "attempt_closed", attempt: id, reason });
    yield* Scope.close(entry.scope, Exit.void);
  });
  yield* Effect.addFinalizer((exit) =>
    Effect.gen(function* () {
      if (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause))
        closeReason = "client_disconnected";
      for (const id of active.keys()) yield* close(id);
      if (!settled && announced) yield* report("cancelled");
    }),
  );
  const launch = Effect.fnUntraced(function* (hedge: boolean) {
    const attemptScope = yield* Scope.fork(scope);
    const id = ++attempts;
    active.set(id, { scope: attemptScope, hedge });
    load.inFlight++;
    if (hedge) load.hedges++;
    nextHedgeAt = (yield* Clock.currentTimeMillis) + delay;
    yield* diagnostic({ event: "attempt_started", attempt: id, hedge });
    yield* options.attempt(id).pipe(
      Scope.provide(attemptScope),
      Effect.catchCause((cause) => {
        if (Cause.hasInterrupts(cause)) return Effect.interrupt;
        const error = Cause.findErrorOption(cause);
        return Effect.fail(
          Option.isSome(error)
            ? error.value
            : new ModelServiceRequestFailure({
                detail: "The model service request failed unexpectedly.",
                status: 502,
                retryable: false,
              }),
        );
      }),
      Effect.matchEffect({
        onSuccess: (value) => Queue.offer(events, { type: "ready", id, value }),
        onFailure: (error) => Queue.offer(events, { type: "failed", id, error }),
      }),
      Effect.forkIn(attemptScope),
    );
    if (hedge) yield* report("hedging");
  });
  while (true) {
    if (options.cancelled && (yield* options.cancelled)) {
      closeReason = "request_cancelled";
      yield* diagnostic({ event: "terminal", reason: closeReason });
      return yield* new ModelServiceRequestCancelled({
        detail: "The model service request was cancelled.",
      });
    }
    const now = yield* Clock.currentTimeMillis;
    if (!(yield* options.enabled)) {
      lastFailure = new ModelServiceRequestFailure({
        detail: "This model service is unavailable.",
        status: 503,
        retryable: false,
        code: "model_service_unavailable",
        source: "gateway",
      });
      terminationReason = "service_disabled";
      break;
    }
    if (now >= deadline) break;
    const queued = yield* Queue.poll(events);
    const cooled = !respectRetryAfter || now >= load.cooldownUntil;
    if (policy.hedgeEnabled && active.size > 0 && now >= nextHedgeAt) {
      const reason = permanentFailure
        ? "permanent_attempt_failure"
        : !cooled
          ? "retry_after_cooldown"
          : attempts >= policy.maxAttempts
            ? "attempt_limit"
            : active.size >= policy.maxConcurrent
              ? "concurrency_limit"
              : load.hedges >= 9 || load.inFlight >= 16
                ? "service_load_limit"
                : undefined;
      if (reason && !waits.has(reason)) {
        waits.add(reason);
        yield* diagnostic({ event: "hedge_waiting", reason });
      }
    }
    if (Option.isNone(queued) && attempts === 0 && cooled) yield* launch(false);
    else if (
      Option.isNone(queued) &&
      !permanentFailure &&
      attempts < policy.maxAttempts &&
      cooled &&
      active.size < policy.maxConcurrent &&
      (active.size === 0 || (load.hedges < 9 && load.inFlight < 16))
    ) {
      if (policy.retryEnabled && now >= retryAt) {
        retryAt = Infinity;
        yield* launch(active.size > 0);
      } else if (policy.hedgeEnabled && active.size > 0 && now >= nextHedgeAt && load.hedges < 9) {
        yield* launch(true);
      }
    }
    if (
      active.size === 0 &&
      attempts > 0 &&
      (permanentFailure || !policy.retryEnabled || attempts >= policy.maxAttempts)
    ) {
      if (permanentFailure) lastFailure = permanentFailure;
      terminationReason = permanentFailure
        ? "non_retryable_error"
        : attempts >= policy.maxAttempts
          ? "recovery_attempts_exhausted"
          : "retry_disabled";
      break;
    }
    const next = Option.isSome(queued)
      ? queued
      : yield* Queue.take(events).pipe(
          Effect.timeoutOption(
            Math.max(
              1,
              Math.min(
                250,
                deadline - now,
                !permanentFailure &&
                  cooled &&
                  active.size < policy.maxConcurrent &&
                  attempts < policy.maxAttempts
                  ? Math.min(
                      policy.hedgeEnabled && active.size > 0 ? nextHedgeAt - now : Infinity,
                      policy.retryEnabled ? retryAt - now : Infinity,
                    )
                  : Infinity,
              ),
            ),
          ),
        );
    if (Option.isNone(next)) continue;
    const event = next.value;
    if (!active.has(event.id)) continue;
    if (event.type === "ready") {
      for (const id of active.keys()) if (id !== event.id) yield* close(id, "winner_selected");
      closeReason = "response_finished";
      settled = true;
      yield* diagnostic({ event: "terminal", reason: "response_ready", attempt: event.id });
      if (announced) yield* report("recovered");
      return event.value;
    }
    yield* close(event.id, "attempt_failed");
    lastFailure = event.error;
    lastAttemptFailure = event.error;
    yield* diagnostic({
      event: "attempt_failed",
      attempt: event.id,
      status: lastFailure.status,
      code: lastFailure.code,
      source: lastFailure.source,
    });
    const forceRetry =
      lastFailure.status === 429
        ? policy.retryOn429
        : policy.retryNonTransientErrors &&
          lastFailure.source === "upstream" &&
          lastFailure.status >= 400 &&
          lastFailure.status < 600;
    if (!lastFailure.retryable && !forceRetry) {
      permanentFailure ??= lastFailure;
      retryAt = Infinity;
      continue;
    }
    const failedAt = yield* Clock.currentTimeMillis;
    if (respectRetryAfter && lastFailure.retryAfterMs) {
      load.cooldownUntil = Math.max(load.cooldownUntil, failedAt + lastFailure.retryAfterMs);
    }
    if (!permanentFailure && policy.retryEnabled && attempts < policy.maxAttempts) {
      const ladder = [250, 500, 1000, 2000, 3000, 5000];
      const jitter = 0.75 + (yield* Random.next) * 0.5;
      const wait = Math.round(ladder[Math.min(attempts - 1, ladder.length - 1)]! * jitter);
      retryAt = Math.max(failedAt + wait, respectRetryAfter ? load.cooldownUntil : 0);
      yield* report("retrying", retryAt - failedAt);
    }
  }
  closeReason = terminationReason;
  for (const id of active.keys()) yield* close(id);
  settled = true;
  yield* diagnostic({ event: "terminal", reason: terminationReason });
  yield* report("failed", 0, terminationReason);
  const budgetExhausted = terminationReason === "recovery_budget_exhausted";
  return yield* new ModelServiceRequestFailure({
    detail: budgetExhausted
      ? `The model service did not produce a usable response within its ${policy.budgetMs} ms recovery budget.`
      : lastFailure.detail,
    status: budgetExhausted ? 504 : lastFailure.status,
    retryable: false,
    code:
      budgetExhausted || terminationReason === "recovery_attempts_exhausted"
        ? terminationReason
        : lastFailure.code,
    source:
      budgetExhausted || terminationReason === "recovery_attempts_exhausted"
        ? "gateway"
        : lastFailure.source,
    terminationReason,
    budgetMs: policy.budgetMs,
    elapsedMs: (yield* Clock.currentTimeMillis) - started,
    attempts,
    ...(lastAttemptFailure
      ? {
          lastAttemptFailure: {
            code: lastAttemptFailure.code,
            source: lastAttemptFailure.source,
            status: lastAttemptFailure.status,
            detail: lastAttemptFailure.detail,
            timeoutMs: lastAttemptFailure.timeoutMs,
          },
        }
      : {}),
  });
});

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
}> {}

export interface RecoveryProgress {
  readonly phase: "retrying" | "hedging" | "recovered" | "failed" | "cancelled";
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly delayMs: number;
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
}) {
  const { policy, load } = options;
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
  let lastFailure = new ModelServiceRequestFailure({
    detail: "The model service did not produce a usable response within its recovery budget.",
    status: 504,
    retryable: false,
  });
  const report = (phase: RecoveryProgress["phase"], delayMs = 0) => {
    announced = true;
    return options.progress({ phase, attempt: attempts, maxAttempts: policy.maxAttempts, delayMs });
  };
  const close = Effect.fnUntraced(function* (id: number) {
    const entry = active.get(id);
    if (!entry) return;
    active.delete(id);
    load.inFlight--;
    if (entry.hedge) load.hedges--;
    yield* Scope.close(entry.scope, Exit.void);
  });
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
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
    if (options.cancelled && (yield* options.cancelled)) return yield* Effect.interrupt;
    const now = yield* Clock.currentTimeMillis;
    if (!(yield* options.enabled)) {
      lastFailure = new ModelServiceRequestFailure({
        detail: "This model service is unavailable.",
        status: 503,
        retryable: false,
      });
      break;
    }
    if (now >= deadline) break;
    const queued = yield* Queue.poll(events);
    const cooled = !policy.respectRetryAfter || now >= load.cooldownUntil;
    if (Option.isNone(queued) && attempts === 0 && cooled) yield* launch(false);
    else if (
      Option.isNone(queued) &&
      attempts < policy.maxAttempts &&
      cooled &&
      active.size < policy.maxConcurrent &&
      (active.size === 0 || (load.hedges < 4 && load.inFlight < 16))
    ) {
      if (policy.retryEnabled && now >= retryAt) {
        retryAt = Infinity;
        yield* launch(active.size > 0);
      } else if (policy.hedgeEnabled && active.size > 0 && now >= nextHedgeAt && load.hedges < 4) {
        yield* launch(true);
      }
    }
    if (
      active.size === 0 &&
      attempts > 0 &&
      (!policy.retryEnabled || attempts >= policy.maxAttempts)
    )
      break;
    const next = Option.isSome(queued)
      ? queued
      : yield* Queue.take(events).pipe(
          Effect.timeoutOption(
            Math.max(
              1,
              Math.min(
                250,
                deadline - now,
                cooled && active.size < policy.maxConcurrent && attempts < policy.maxAttempts
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
      for (const id of active.keys()) if (id !== event.id) yield* close(id);
      settled = true;
      if (announced) yield* report("recovered");
      return event.value;
    }
    yield* close(event.id);
    lastFailure = event.error;
    if (!lastFailure.retryable && !(policy.retryOn429 && lastFailure.status === 429)) break;
    const failedAt = yield* Clock.currentTimeMillis;
    if (policy.respectRetryAfter && lastFailure.retryAfterMs) {
      load.cooldownUntil = Math.max(load.cooldownUntil, failedAt + lastFailure.retryAfterMs);
    }
    if (policy.retryEnabled && attempts < policy.maxAttempts) {
      const ladder = [250, 500, 1000, 2000, 3000, 5000];
      const jitter = 0.75 + (yield* Random.next) * 0.5;
      const wait = Math.round(ladder[Math.min(attempts - 1, ladder.length - 1)]! * jitter);
      retryAt = Math.max(failedAt + wait, policy.respectRetryAfter ? load.cooldownUntil : 0);
      yield* report("retrying", retryAt - failedAt);
    }
  }
  for (const id of active.keys()) yield* close(id);
  settled = true;
  if (announced) yield* report("failed");
  return yield* lastFailure;
});

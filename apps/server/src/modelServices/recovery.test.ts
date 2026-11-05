import { expect, it } from "@effect/vitest";
import { DEFAULT_MODEL_SERVICE_RECOVERY, type ModelServiceRecovery } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import { TestClock } from "effect/testing";
import {
  ModelServiceRequestFailure,
  recoverModelServiceRequest,
  retryAfterMilliseconds,
  isRetryableModelServiceError,
  type RecoveryProgress,
} from "./recovery.ts";

const failure = (retryAfterMs = 0) =>
  new ModelServiceRequestFailure({
    detail: "Temporary test failure",
    status: 503,
    retryable: true,
    retryAfterMs,
  });

const harness = (policy: Partial<ModelServiceRecovery> = {}) => {
  const load = { inFlight: 0, hedges: 0, cooldownUntil: 0 };
  const phases: RecoveryProgress[] = [];
  const started: number[] = [];
  const closed: number[] = [];
  let enabled = true;
  let cancelled = false;
  const run = (attempt: (id: number) => Effect.Effect<number, ModelServiceRequestFailure>) =>
    recoverModelServiceRequest({
      policy: { ...DEFAULT_MODEL_SERVICE_RECOVERY, ...policy },
      reasoning: false,
      load,
      enabled: Effect.sync(() => enabled),
      cancelled: Effect.sync(() => cancelled),
      attempt: (id) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            started.push(id);
            return id;
          }),
          () =>
            Effect.sync(() => {
              closed.push(id);
            }),
        ).pipe(Effect.andThen(attempt(id))),
      progress: (event) =>
        Effect.sync(() => {
          phases.push(event);
        }),
    }).pipe(Effect.scoped);
  return {
    run,
    load,
    phases,
    started,
    closed,
    disable: () => {
      enabled = false;
    },
    cancel: () => {
      cancelled = true;
    },
  };
};

it.effect("retries transient errors and releases every attempt", () =>
  Effect.gen(function* () {
    const h = harness();
    const fiber = yield* h
      .run((id) => (id < 3 ? Effect.fail(failure()) : Effect.succeed(id)))
      .pipe(Effect.forkChild);
    yield* TestClock.adjust("3 seconds");
    expect(yield* Fiber.join(fiber)).toBe(3);
    expect(h.started).toEqual([1, 2, 3]);
    expect(h.closed).toEqual([1, 2, 3]);
    expect(h.load.inFlight).toBe(0);
    expect(h.phases.at(-1)?.phase).toBe("recovered");
  }),
);

it.effect("starts one backup after the threshold and cancels the stalled primary", () =>
  Effect.gen(function* () {
    const h = harness({ retryEnabled: false });
    const fiber = yield* h
      .run((id) => Effect.sleep(id === 1 ? "1 minute" : "1 second").pipe(Effect.as(id)))
      .pipe(Effect.forkChild);
    yield* TestClock.adjust("14 seconds");
    expect(h.started).toEqual([1]);
    yield* TestClock.adjust("3 seconds");
    expect(yield* Fiber.join(fiber)).toBe(2);
    expect(h.closed).toEqual([1, 2]);
    expect(h.phases.map((event) => event.phase)).toEqual(["hedging", "recovered"]);
  }),
);

it.effect("keeps waiting for the primary when the backup fails", () =>
  Effect.gen(function* () {
    const h = harness({ retryEnabled: false });
    const fiber = yield* h
      .run((id) =>
        id === 1 ? Effect.sleep("20 seconds").pipe(Effect.as(id)) : Effect.fail(failure()),
      )
      .pipe(Effect.forkChild);
    yield* TestClock.adjust("21 seconds");
    expect(yield* Fiber.join(fiber)).toBe(1);
    expect(h.started).toEqual([1, 2]);
  }),
);

it.effect("commits exactly one winner when both attempts become ready together", () =>
  Effect.gen(function* () {
    const h = harness();
    const fiber = yield* h
      .run((id) => Effect.sleep(id === 1 ? "16 seconds" : "1 second").pipe(Effect.as(id)))
      .pipe(Effect.forkChild);
    yield* TestClock.adjust("17 seconds");
    expect([1, 2]).toContain(yield* Fiber.join(fiber));
    expect(h.started).toHaveLength(2);
    expect(h.phases.filter((event) => event.phase === "recovered")).toHaveLength(1);
    expect(h.closed.toSorted()).toEqual([1, 2]);
  }),
);

it.effect.each([true, false])(
  "respects the configurable Retry-After policy (%s)",
  (respectRetryAfter) =>
    Effect.gen(function* () {
      const h = harness({ respectRetryAfter, hedgeEnabled: false });
      const fiber = yield* h
        .run((id) => (id === 1 ? Effect.fail(failure(5000)) : Effect.succeed(id)))
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("1 second");
      expect(h.started).toHaveLength(respectRetryAfter ? 1 : 2);
      yield* TestClock.adjust("5 seconds");
      expect(yield* Fiber.join(fiber)).toBe(2);
    }),
);

it.effect("counts retries and backups against the same attempt limit", () =>
  Effect.gen(function* () {
    const h = harness({ maxAttempts: 2, hedgeDelayMs: 100 });
    const fiber = yield* h
      .run(() => Effect.sleep("1 second").pipe(Effect.andThen(Effect.fail(failure()))))
      .pipe(Effect.exit, Effect.forkChild);
    yield* TestClock.adjust("4 seconds");
    expect(Exit.isFailure(yield* Fiber.join(fiber))).toBe(true);
    expect(h.started).toEqual([1, 2]);
    expect(h.load.inFlight).toBe(0);
  }),
);

it.effect("cancels every stalled attempt when the recovery budget expires", () =>
  Effect.gen(function* () {
    const h = harness({ budgetMs: 1000, hedgeDelayMs: 100 });
    const fiber = yield* h.run(() => Effect.never).pipe(Effect.flip, Effect.forkChild);
    yield* TestClock.adjust("2 seconds");
    expect((yield* Fiber.join(fiber)).status).toBe(504);
    expect(h.started).toHaveLength(2);
    expect(h.closed.toSorted()).toEqual([1, 2]);
  }),
);

it.effect("stops rather than retrying when the user cancels", () =>
  Effect.gen(function* () {
    const h = harness({ hedgeDelayMs: 100 });
    const fiber = yield* h.run(() => Effect.never).pipe(Effect.forkChild);
    yield* TestClock.adjust("1 second");
    h.cancel();
    yield* TestClock.adjust("1 second");
    const result = yield* Fiber.await(fiber);
    expect(Exit.isFailure(result) && Cause.hasInterrupts(result.cause)).toBe(true);
    expect(h.load.inFlight).toBe(0);
  }),
);

it.effect("stops when the service is disabled and never retries permanent errors", () =>
  Effect.gen(function* () {
    const h = harness();
    const fiber = yield* h.run(() => Effect.never).pipe(Effect.flip, Effect.forkChild);
    yield* TestClock.adjust("1 second");
    h.disable();
    yield* TestClock.adjust("1 second");
    expect((yield* Fiber.join(fiber)).status).toBe(503);
    const permanent = harness();
    expect(
      (yield* permanent
        .run(() =>
          Effect.fail(
            new ModelServiceRequestFailure({
              detail: "Invalid credentials",
              status: 401,
              retryable: false,
            }),
          ),
        )
        .pipe(Effect.flip)).status,
    ).toBe(401);
    expect(permanent.started).toEqual([1]);
  }),
);

it.effect("parses Retry-After seconds and dates", () =>
  Effect.sync(() => {
    expect(retryAfterMilliseconds("2", 0)).toBe(2000);
    expect(retryAfterMilliseconds("Thu, 01 Jan 1970 00:00:05 GMT", 1000)).toBe(4000);
    expect(retryAfterMilliseconds("invalid", 0)).toBe(0);
  }),
);

it.effect("distinguishes channel failures from permanent quota and request errors", () =>
  Effect.sync(() => {
    expect(isRetryableModelServiceError(400, { code: "no_available_channels" })).toBe(true);
    expect(isRetryableModelServiceError(429, { code: "insufficient_quota" })).toBe(false);
    expect(isRetryableModelServiceError(503, { code: "context_length_exceeded" })).toBe(false);
    expect(isRetryableModelServiceError(401, {})).toBe(false);
    expect(isRetryableModelServiceError(529, {})).toBe(true);
  }),
);

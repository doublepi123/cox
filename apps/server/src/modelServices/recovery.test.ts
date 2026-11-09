import { expect, it } from "@effect/vitest";
import { DEFAULT_MODEL_SERVICE_RECOVERY, type ModelServiceRecovery } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import { TestClock } from "effect/testing";
import {
  ModelServiceRequestFailure,
  recoverModelServiceRequest,
  retryAfterMilliseconds,
  isRetryableModelServiceError,
  type RecoveryProgress,
  type RecoveryDiagnostic,
} from "./recovery.ts";

const failure = (retryAfterMs = 0) =>
  new ModelServiceRequestFailure({
    detail: "Temporary test failure",
    status: 503,
    retryable: true,
    retryAfterMs,
  });

const harness = (policy: Partial<ModelServiceRecovery> = {}, reasoning = false) => {
  const load = { inFlight: 0, hedges: 0, cooldownUntil: 0 };
  const phases: RecoveryProgress[] = [];
  const diagnostics: RecoveryDiagnostic[] = [];
  const started: number[] = [];
  const closed: number[] = [];
  let enabled = true;
  let cancelled = false;
  const run = (
    attempt: (id: number) => Effect.Effect<number, ModelServiceRequestFailure>,
    progress: (event: RecoveryProgress) => Effect.Effect<void> = () => Effect.void,
    repair?: () => Effect.Effect<boolean>,
  ) =>
    recoverModelServiceRequest({
      policy: { ...DEFAULT_MODEL_SERVICE_RECOVERY, ...policy },
      reasoning,
      load,
      enabled: Effect.sync(() => enabled),
      ...(repair ? { repair } : {}),
      cancelled: Effect.sync(() => cancelled),
      diagnostic: (event) =>
        Effect.sync(() => {
          diagnostics.push(event);
        }),
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
        }).pipe(Effect.andThen(progress(event))),
    }).pipe(Effect.scoped);
  return {
    run,
    load,
    phases,
    diagnostics,
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

const encryptedFailure = () =>
  new ModelServiceRequestFailure({
    detail: "Encrypted reasoning could not be verified.",
    status: 400,
    code: "invalid_encrypted_content",
    source: "upstream",
    retryable: false,
    requestId: "4171489b-838f-4e4c-9366-18cf20dadc55",
  });

it.effect("repairs encrypted content once without enabling arbitrary HTTP 400 retries", () =>
  Effect.gen(function* () {
    const h = harness({ retryNonTransientErrors: false });
    let repairs = 0;
    const result = yield* h.run(
      (id) => (id === 1 ? Effect.fail(encryptedFailure()) : Effect.succeed(id)),
      () => Effect.void,
      () =>
        Effect.sync(() => {
          repairs++;
          return true;
        }),
    );
    expect(result).toBe(2);
    expect(repairs).toBe(1);
    expect(h.started).toEqual([1, 2]);
    expect(h.closed).toEqual([1, 2]);
    expect(h.phases).toContainEqual(
      expect.objectContaining({ phase: "retrying", reason: "invalid_encrypted_content" }),
    );
    expect(h.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "invalid_encrypted_content",
        upstreamRequestId: "4171489b-838f-4e4c-9366-18cf20dadc55",
      }),
    );
  }),
);

it.effect.each([false, true])(
  "never repeats an unrepairable encrypted request despite forced retries (%s)",
  (repairable) =>
    Effect.gen(function* () {
      const h = harness({ retryNonTransientErrors: true, maxAttempts: 100 });
      let repairs = 0;
      const error = yield* h
        .run(
          () => Effect.fail(encryptedFailure()),
          () => Effect.void,
          () =>
            Effect.sync(() => {
              repairs++;
              return repairable;
            }),
        )
        .pipe(Effect.flip);
      expect(h.started).toHaveLength(repairable ? 2 : 1);
      expect(repairs).toBe(1);
      expect(error).toMatchObject({
        code: "invalid_encrypted_content",
        terminationReason: "non_retryable_error",
      });
    }),
);

it.effect.each([
  { retryEnabled: false, maxAttempts: 100 },
  { retryEnabled: true, maxAttempts: 1 },
])("does not bypass disabled retries or the attempt budget (%j)", (policy) =>
  Effect.gen(function* () {
    const h = harness({ ...policy, retryNonTransientErrors: true });
    let repairs = 0;
    yield* h
      .run(
        () => Effect.fail(encryptedFailure()),
        () => Effect.void,
        () =>
          Effect.sync(() => {
            repairs++;
            return true;
          }),
      )
      .pipe(Effect.flip);
    expect(h.started).toEqual([1]);
    expect(repairs).toBe(0);
  }),
);

it.effect("ends recovery if the single repaired attempt fails with a different error", () =>
  Effect.gen(function* () {
    const h = harness({ retryNonTransientErrors: true, maxAttempts: 100 });
    const error = yield* h
      .run(
        (id) => Effect.fail(id === 1 ? encryptedFailure() : failure()),
        () => Effect.void,
        () => Effect.succeed(true),
      )
      .pipe(Effect.flip);
    expect(error).toMatchObject({ status: 503 });
    expect(h.started).toEqual([1, 2]);
    expect(h.load.inFlight).toBe(0);
  }),
);

it.effect("cancels old hedges and never hedges the single repaired attempt", () =>
  Effect.gen(function* () {
    const h = harness({ hedgeDelayMs: 100, maxConcurrent: 5, retryNonTransientErrors: true });
    const fiber = yield* h
      .run(
        (id) =>
          id === 1
            ? Effect.sleep(150).pipe(Effect.andThen(Effect.fail(encryptedFailure())))
            : id === 2
              ? Effect.never
              : Effect.sleep(500).pipe(Effect.as(id)),
        () => Effect.void,
        () => Effect.succeed(true),
      )
      .pipe(Effect.forkChild);
    yield* TestClock.adjust("1 second");
    expect(yield* Fiber.join(fiber)).toBe(3);
    expect(h.started).toEqual([1, 2, 3]);
    expect(h.closed.toSorted()).toEqual([1, 2, 3]);
    expect(h.diagnostics).toContainEqual(
      expect.objectContaining({ event: "attempt_closed", attempt: 2, reason: "request_repaired" }),
    );
    expect(h.load.inFlight).toBe(0);
    expect(h.load.hedges).toBe(0);
  }),
);

it.effect.each(["cancel", "budget"] as const)("releases the repaired attempt on %s", (end) =>
  Effect.gen(function* () {
    const h = harness({ budgetMs: 1000 });
    const startedRepair = yield* Deferred.make<void>();
    const fiber = yield* h
      .run(
        (id) =>
          id === 1
            ? Effect.fail(encryptedFailure())
            : Deferred.succeed(startedRepair, undefined).pipe(Effect.andThen(Effect.never)),
        () => Effect.void,
        () => Effect.succeed(true),
      )
      .pipe(Effect.flip, Effect.forkChild);
    yield* Deferred.await(startedRepair);
    if (end === "cancel") h.cancel();
    yield* TestClock.adjust("2 seconds");
    const failure = yield* Fiber.join(fiber);
    expect(failure).toMatchObject(
      end === "cancel"
        ? { _tag: "ModelServiceRequestCancelled" }
        : { status: 504, code: "recovery_budget_exhausted" },
    );
    expect(h.started).toEqual([1, 2]);
    expect(h.closed.toSorted()).toEqual([1, 2]);
    expect(h.load.inFlight).toBe(0);
  }),
);

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
    yield* TestClock.adjust("29 seconds");
    expect(h.started).toEqual([1]);
    yield* TestClock.adjust("3 seconds");
    expect(yield* Fiber.join(fiber)).toBe(2);
    expect(h.closed).toEqual([1, 2]);
    expect(h.phases.map((event) => event.phase)).toEqual(["hedging", "recovered"]);
  }),
);

it.effect("uses the 60 second default for reasoning backups", () =>
  Effect.gen(function* () {
    const h = harness({ retryEnabled: false }, true);
    const fiber = yield* h
      .run((id) => (id === 1 ? Effect.never : Effect.succeed(id)))
      .pipe(Effect.forkChild);
    yield* TestClock.adjust("59 seconds");
    expect(h.started).toEqual([1]);
    yield* TestClock.adjust("2 seconds");
    expect(yield* Fiber.join(fiber)).toBe(2);
    expect(h.started).toEqual([1, 2]);
  }),
);

it.effect("keeps waiting for the primary when the backup fails", () =>
  Effect.gen(function* () {
    const h = harness({ retryEnabled: false });
    const fiber = yield* h
      .run((id) =>
        id === 1 ? Effect.sleep("40 seconds").pipe(Effect.as(id)) : Effect.fail(failure()),
      )
      .pipe(Effect.forkChild);
    yield* TestClock.adjust("41 seconds");
    expect(yield* Fiber.join(fiber)).toBe(1);
    expect(h.started).toEqual([1, 2]);
  }),
);

it.effect("commits exactly one winner when both attempts become ready together", () =>
  Effect.gen(function* () {
    const h = harness();
    const fiber = yield* h
      .run((id) => Effect.sleep(id === 1 ? "31 seconds" : "1 second").pipe(Effect.as(id)))
      .pipe(Effect.forkChild);
    yield* TestClock.adjust("32 seconds");
    expect([1, 2]).toContain(yield* Fiber.join(fiber));
    expect(h.started).toHaveLength(2);
    expect(h.phases.filter((event) => event.phase === "recovered")).toHaveLength(1);
    expect(h.closed.toSorted()).toEqual([1, 2]);
  }),
);

it.effect.each([true, false])(
  "derives cooldown handling from forced 429 retries (%s)",
  (retryOn429) =>
    Effect.gen(function* () {
      const h = harness({ retryOn429, hedgeEnabled: false });
      const fiber = yield* h
        .run((id) => (id === 1 ? Effect.fail(failure(5000)) : Effect.succeed(id)))
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("1 second");
      expect(h.started).toHaveLength(retryOn429 ? 2 : 1);
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

it.effect.each([
  { status: 400, enabled: false, automatic: true, source: "upstream" as const, attempts: 1 },
  { status: 400, enabled: true, automatic: true, source: "upstream" as const, attempts: 2 },
  { status: 401, enabled: true, automatic: true, source: "upstream" as const, attempts: 2 },
  { status: 422, enabled: true, automatic: true, source: "upstream" as const, attempts: 2 },
  { status: 501, enabled: true, automatic: true, source: "upstream" as const, attempts: 2 },
  { status: 400, enabled: true, automatic: false, source: "upstream" as const, attempts: 1 },
  { status: 429, enabled: true, automatic: true, source: "upstream" as const, attempts: 1 },
  { status: 502, enabled: true, automatic: true, source: "gateway" as const, attempts: 1 },
  { status: 200, enabled: true, automatic: true, source: "upstream" as const, attempts: 1 },
])("bounds optional non-transient retries without changing local failures (%j)", (scenario) =>
  Effect.gen(function* () {
    const h = harness({
      retryNonTransientErrors: scenario.enabled,
      retryEnabled: scenario.automatic,
      maxAttempts: 2,
    });
    const fiber = yield* h
      .run(() =>
        Effect.fail(
          new ModelServiceRequestFailure({
            detail: "Non-transient test failure",
            status: scenario.status,
            source: scenario.source,
            retryable: false,
          }),
        ),
      )
      .pipe(Effect.flip, Effect.forkChild);
    yield* TestClock.adjust("2 seconds");
    expect(yield* Fiber.join(fiber)).toMatchObject({ status: scenario.status });
    expect(h.started).toHaveLength(scenario.attempts);
    expect(h.load.inFlight).toBe(0);
  }),
);

it.effect.each([
  { retryOn429: false, retryEnabled: true, status: 429, attempts: 1 },
  { retryOn429: true, retryEnabled: true, status: 429, attempts: 2 },
  { retryOn429: true, retryEnabled: false, status: 429, attempts: 1 },
  { retryOn429: true, retryEnabled: true, status: 401, attempts: 1 },
  { retryOn429: true, retryEnabled: true, status: 422, attempts: 1 },
])("bounds forced 429 retries and preserves other failures (%j)", (scenario) =>
  Effect.gen(function* () {
    const h = harness({
      retryOn429: scenario.retryOn429,
      retryEnabled: scenario.retryEnabled,
      maxAttempts: 2,
    });
    const fiber = yield* h
      .run(() =>
        Effect.fail(
          new ModelServiceRequestFailure({
            detail: "Permanent test failure",
            status: scenario.status,
            retryable: false,
          }),
        ),
      )
      .pipe(Effect.flip, Effect.forkChild);
    yield* TestClock.adjust("2 seconds");
    expect(yield* Fiber.join(fiber)).toMatchObject({ status: scenario.status });
    expect(h.started).toHaveLength(scenario.attempts);
    expect(h.load.inFlight).toBe(0);
  }),
);

it.effect("ignores quota cooldown without disabling local retry backoff", () =>
  Effect.gen(function* () {
    const h = harness({ retryOn429: true, hedgeEnabled: false, budgetMs: 10000 });
    const fiber = yield* h
      .run((attempt) =>
        attempt === 1
          ? Effect.fail(
              new ModelServiceRequestFailure({
                detail: "Quota exhausted",
                status: 429,
                retryable: false,
                retryAfterMs: 60000,
              }),
            )
          : Effect.succeed(attempt),
      )
      .pipe(Effect.forkChild);
    yield* TestClock.adjust("100 millis");
    expect(h.started).toHaveLength(1);
    yield* TestClock.adjust("1 second");
    expect(yield* Fiber.join(fiber)).toBe(2);
    expect(h.load.cooldownUntil).toBe(0);
  }),
);

it.effect.each([false, true])(
  "applies the same policy to an existing shared cooldown (%s)",
  (retryOn429) =>
    Effect.gen(function* () {
      const h = harness({ retryOn429, hedgeEnabled: false });
      h.load.cooldownUntil = (yield* Clock.currentTimeMillis) + 5000;
      const fiber = yield* h.run((attempt) => Effect.succeed(attempt)).pipe(Effect.forkChild);
      yield* TestClock.adjust("1 second");
      expect(h.started).toHaveLength(retryOn429 ? 1 : 0);
      yield* TestClock.adjust("5 seconds");
      expect(yield* Fiber.join(fiber)).toBe(1);
    }),
);

it.effect.each([5, 10])("honors the configured concurrency limit of %s", (maxConcurrent) =>
  Effect.gen(function* () {
    const h = harness({ maxConcurrent, hedgeDelayMs: 100, budgetMs: 5000 });
    const fiber = yield* h.run(() => Effect.never).pipe(Effect.forkChild);
    for (let tick = 0; tick < 12; tick++) yield* TestClock.adjust("250 millis");
    expect(h.started).toHaveLength(maxConcurrent);
    expect(h.load.inFlight).toBe(maxConcurrent);
    yield* Fiber.interrupt(fiber);
    expect(h.load.inFlight).toBe(0);
  }),
);

it.effect("stops forced 429 retries when the recovery time budget expires", () =>
  Effect.gen(function* () {
    const h = harness({ retryOn429: true, budgetMs: 100 });
    const retrying = yield* Deferred.make<void>();
    const fiber = yield* h
      .run(
        () =>
          Effect.fail(
            new ModelServiceRequestFailure({
              detail: "Quota exhausted",
              status: 429,
              retryable: false,
            }),
          ),
        (event) =>
          event.phase === "retrying"
            ? Deferred.succeed(retrying, undefined).pipe(Effect.asVoid)
            : Effect.void,
      )
      .pipe(Effect.flip, Effect.forkChild);
    yield* Deferred.await(retrying);
    yield* TestClock.adjust("1 second");
    expect(yield* Fiber.join(fiber)).toMatchObject({
      status: 504,
      code: "recovery_budget_exhausted",
      lastAttemptFailure: { status: 429 },
    });
    expect(h.started).toEqual([1]);
    expect(h.load.inFlight).toBe(0);
  }),
);

it.effect("cancels every stalled attempt when the recovery budget expires", () =>
  Effect.gen(function* () {
    const h = harness({ budgetMs: 1000, hedgeDelayMs: 100, maxConcurrent: 2 });
    const fiber = yield* h.run(() => Effect.never).pipe(Effect.flip, Effect.forkChild);
    yield* TestClock.adjust("2 seconds");
    const error = yield* Fiber.join(fiber);
    expect(error).toMatchObject({ status: 504, code: "recovery_budget_exhausted", attempts: 2 });
    expect(error).not.toHaveProperty("lastAttemptFailure");
    expect(h.started).toHaveLength(2);
    expect(h.closed.toSorted()).toEqual([1, 2]);
  }),
);

it.effect.each([1, 2])(
  "keeps the other in-flight request alive when attempt %s fails permanently",
  (failedId) =>
    Effect.gen(function* () {
      const h = harness({ hedgeDelayMs: 100, maxConcurrent: 3 });
      const fiber = yield* h
        .run((id) =>
          id === failedId
            ? Effect.sleep(id === 1 ? 150 : 10).pipe(
                Effect.andThen(
                  Effect.fail(
                    new ModelServiceRequestFailure({
                      detail: "Invalid credentials",
                      status: 401,
                      retryable: false,
                    }),
                  ),
                ),
              )
            : Effect.sleep(400).pipe(Effect.as(id)),
        )
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("1 second");
      expect(yield* Fiber.join(fiber)).toBe(failedId === 1 ? 2 : 1);
      expect(h.started).toEqual([1, 2]);
      expect(h.load.inFlight).toBe(0);
      expect(h.diagnostics).toContainEqual(
        expect.objectContaining({ event: "terminal", reason: "response_ready" }),
      );
    }),
);

it.effect(
  "stops additional launches after a permanent failure and preserves it if the sibling fails",
  () =>
    Effect.gen(function* () {
      const h = harness({ hedgeDelayMs: 100 });
      const fiber = yield* h
        .run((id) =>
          Effect.sleep(id === 1 ? 400 : 10).pipe(
            Effect.andThen(
              Effect.fail(
                id === 1
                  ? failure()
                  : new ModelServiceRequestFailure({
                      detail: "Invalid credentials",
                      status: 401,
                      retryable: false,
                    }),
              ),
            ),
          ),
        )
        .pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust("1 second");
      expect(yield* Fiber.join(fiber)).toMatchObject({
        status: 401,
        terminationReason: "non_retryable_error",
        attempts: 2,
        lastAttemptFailure: { status: 503 },
      });
      expect(h.started).toEqual([1, 2]);
    }),
);

it.effect("reports the budget as the terminal cause after four overlapping header waits", () =>
  Effect.gen(function* () {
    const h = harness({ hedgeDelayMs: 45000, budgetMs: 180000, maxConcurrent: 2 });
    const fiber = yield* h
      .run(() =>
        Effect.sleep("120 seconds").pipe(
          Effect.andThen(
            Effect.fail(
              new ModelServiceRequestFailure({
                detail: "Headers timed out",
                status: 504,
                retryable: true,
                code: "upstream_response_headers_timeout",
                source: "gateway",
                timeoutMs: 120000,
              }),
            ),
          ),
        ),
      )
      .pipe(Effect.flip, Effect.forkChild);
    yield* TestClock.adjust("181 seconds");
    expect(yield* Fiber.join(fiber)).toMatchObject({
      code: "recovery_budget_exhausted",
      status: 504,
      attempts: 4,
      elapsedMs: 180000,
      lastAttemptFailure: {
        code: "upstream_response_headers_timeout",
        source: "gateway",
        timeoutMs: 120000,
      },
    });
    expect(h.closed.toSorted()).toEqual([1, 2, 3, 4]);
    expect(h.phases.at(-1)).toMatchObject({ phase: "failed", reason: "recovery_budget_exhausted" });
    expect(h.diagnostics).toContainEqual(
      expect.objectContaining({
        event: "attempt_closed",
        attempt: 3,
        reason: "recovery_budget_exhausted",
      }),
    );
  }),
);

it.effect("distinguishes the attempt limit from the time budget", () =>
  Effect.gen(function* () {
    const h = harness({ maxAttempts: 1 });
    expect(yield* h.run(() => Effect.fail(failure())).pipe(Effect.flip)).toMatchObject({
      status: 503,
      code: "recovery_attempts_exhausted",
      terminationReason: "recovery_attempts_exhausted",
      attempts: 1,
    });
    expect(h.phases.at(-1)).toMatchObject({
      phase: "failed",
      reason: "recovery_attempts_exhausted",
    });
  }),
);

it.effect("stops rather than retrying when the user cancels", () =>
  Effect.gen(function* () {
    const h = harness({ hedgeDelayMs: 100 });
    const fiber = yield* h.run(() => Effect.never).pipe(Effect.flip, Effect.forkChild);
    yield* TestClock.adjust("1 second");
    h.cancel();
    yield* TestClock.adjust("1 second");
    expect(yield* Fiber.join(fiber)).toMatchObject({
      _tag: "ModelServiceRequestCancelled",
      detail: "The model service request was cancelled.",
    });
    expect(h.load.inFlight).toBe(0);
    expect(h.closed.toSorted()).toEqual(h.started);
    expect(h.phases.at(-1)?.phase).toBe("cancelled");
  }),
);

it.effect("preserves external interruption and releases its upstream attempts", () =>
  Effect.gen(function* () {
    const h = harness({ hedgeDelayMs: 100 });
    const fiber = yield* h.run(() => Effect.never).pipe(Effect.forkChild);
    yield* TestClock.adjust("1 second");
    yield* Fiber.interrupt(fiber);
    const result = yield* Fiber.await(fiber);
    expect(Exit.isFailure(result) && Cause.hasInterrupts(result.cause)).toBe(true);
    expect(h.load.inFlight).toBe(0);
    expect(h.closed.toSorted()).toEqual(h.started);
  }),
);

it.effect("stops when the service is disabled and never retries permanent errors", () =>
  Effect.gen(function* () {
    const h = harness();
    const fiber = yield* h.run(() => Effect.never).pipe(Effect.flip, Effect.forkChild);
    yield* TestClock.adjust("1 second");
    h.disable();
    yield* TestClock.adjust("1 second");
    expect(yield* Fiber.join(fiber)).toMatchObject({ status: 503 });
    const permanent = harness();
    expect(
      yield* permanent
        .run(() =>
          Effect.fail(
            new ModelServiceRequestFailure({
              detail: "Invalid credentials",
              status: 401,
              retryable: false,
            }),
          ),
        )
        .pipe(Effect.flip),
    ).toMatchObject({ status: 401 });
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
    expect(isRetryableModelServiceError(503, { code: "invalid_encrypted_content" })).toBe(false);
    expect(isRetryableModelServiceError(401, {})).toBe(false);
    expect(isRetryableModelServiceError(529, {})).toBe(true);
  }),
);

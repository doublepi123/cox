import { EnvironmentNotificationTestRateLimitedError } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { currentEnvironmentTraceId } from "../auth/http.ts";

const TEST_NOTIFICATION_LIMIT = 5;
const TEST_NOTIFICATION_WINDOW_MS = 60_000;

export const makeNotificationTestQuota = Effect.gen(function* () {
  const attemptLog = yield* Ref.make(new Map<string, ReadonlyArray<number>>());
  return Effect.fn("environment.notifications.consumeTestQuota")(function* (sessionId: string) {
    const now = yield* Clock.currentTimeMillis;
    const cutoff = now - TEST_NOTIFICATION_WINDOW_MS;
    const retained = new Map<string, ReadonlyArray<number>>();
    let sessionAttempts: ReadonlyArray<number> = [];
    for (const [key, timestamps] of yield* Ref.get(attemptLog)) {
      const fresh = timestamps.filter((timestamp) => timestamp > cutoff);
      if (key === sessionId) sessionAttempts = fresh;
      else if (fresh.length > 0) retained.set(key, fresh);
    }
    if (sessionAttempts.length >= TEST_NOTIFICATION_LIMIT) {
      const retryAfterSeconds = Math.max(
        1,
        Math.min(
          ...sessionAttempts.map((timestamp) =>
            Math.ceil((timestamp + TEST_NOTIFICATION_WINDOW_MS - now) / 1000),
          ),
        ),
      );
      const traceId = yield* currentEnvironmentTraceId;
      return yield* new EnvironmentNotificationTestRateLimitedError({
        code: "test_rate_limited",
        retryAfterSeconds,
        traceId,
      });
    }
    yield* Ref.set(attemptLog, retained.set(sessionId, [...sessionAttempts, now]));
  });
});

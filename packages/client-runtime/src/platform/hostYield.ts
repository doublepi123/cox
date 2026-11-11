import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";

export const yieldToHostTimer = Effect.sleep(0).pipe(
  Effect.provideService(Clock.Clock, Clock.Clock.defaultValue()),
);

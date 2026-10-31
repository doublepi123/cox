import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Registry from "./registry.ts";
import * as Connectivity from "./connectivity.ts";
import * as Wakeups from "./wakeups.ts";
import * as Driver from "./driver.ts";
import { PrimaryConnectionRegistration } from "./catalog.ts";
import { target } from "./localTestFixtures.ts";
const dependencies = Layer.mergeAll(
  Connectivity.layer({ status: Effect.succeed("offline"), changes: Stream.empty }),
  Wakeups.layer({ changes: Stream.empty }),
  Layer.succeed(Driver.ConnectionDriver, {
    connect: () => Effect.die("Offline registry must not connect"),
    checkHost: () => Effect.succeed("unchecked" as const),
  }),
);
describe("local connection registry", () => {
  it.effect("registers just the primary server and tolerates repeated discovery", () =>
    Effect.gen(function* () {
      const registry = yield* Registry.make;
      const registrations = [new PrimaryConnectionRegistration({ target })];
      yield* registry.reconcilePlatform(registrations);
      yield* registry.reconcilePlatform(registrations);
      const entries = yield* SubscriptionRef.get(registry.entries);
      expect([...entries.keys()]).toEqual([target.environmentId]);
      expect(entries.get(target.environmentId)?.target).toEqual(target);
      expect(yield* SubscriptionRef.get(registry.networkStatus)).toBe("offline");
    }).pipe(Effect.provide(dependencies)),
  );
  it.effect("rejects requests for unknown servers", () =>
    Effect.gen(function* () {
      const registry = yield* Registry.make;
      const result = yield* registry.state(EnvironmentId.make("missing")).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
    }).pipe(Effect.provide(dependencies)),
  );
});

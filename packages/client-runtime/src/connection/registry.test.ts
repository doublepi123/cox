import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import * as Registry from "./registry.ts";
import * as Supervisor from "./supervisor.ts";
import * as Connectivity from "./connectivity.ts";
import * as Wakeups from "./wakeups.ts";
import * as Driver from "./driver.ts";
import type { ConnectionCatalogEntry } from "./catalog.ts";
import { PrimaryConnectionRegistration } from "./catalog.ts";
import { PrimaryConnectionTarget, type PreparedConnection } from "./model.ts";
import type * as RpcSession from "../rpc/session.ts";
import { target } from "./localTestFixtures.ts";

const offlineDependencies = Layer.mergeAll(
  Connectivity.layer({ status: Effect.succeed("offline"), changes: Stream.empty }),
  Wakeups.layer({ changes: Stream.empty }),
  Layer.succeed(Driver.ConnectionDriver, {
    connect: () => Effect.die("Offline registry must not connect"),
    checkHost: () => Effect.succeed("unchecked" as const),
  }),
);

function preparedFor(entry: ConnectionCatalogEntry): PreparedConnection {
  return {
    environmentId: entry.target.environmentId,
    label: entry.target.label,
    target: entry.target,
    httpBaseUrl: entry.target.httpBaseUrl,
    socketUrl: `${entry.target.wsBaseUrl}/ws`,
    httpAuthorization: null,
  };
}

function awaitRef<A>(ref: SubscriptionRef.SubscriptionRef<A>, predicate: (value: A) => boolean) {
  return SubscriptionRef.changes(ref).pipe(
    Stream.filter(predicate),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );
}

const makeHarness = Effect.fn("TestRegistryHarness.make")(function* () {
  const connectedEntries = yield* SubscriptionRef.make<ReadonlyArray<ConnectionCatalogEntry>>([]);
  const connectivitySubscriptions = yield* SubscriptionRef.make(0);
  const wakeupSubscriptions = yield* SubscriptionRef.make(0);
  const wakeupReleases = yield* SubscriptionRef.make(0);
  const connectivity = Connectivity.Connectivity.of({
    status: Effect.succeed("online" as const),
    changes: Stream.callback(() =>
      Effect.acquireRelease(
        SubscriptionRef.update(connectivitySubscriptions, (count) => count + 1),
        () => SubscriptionRef.update(connectivitySubscriptions, (count) => count - 1),
      ).pipe(Effect.asVoid),
    ),
  });
  const wakeups = Wakeups.ConnectionWakeups.of({
    changes: Stream.callback<Wakeups.ConnectionWakeup>(() =>
      Effect.acquireRelease(
        SubscriptionRef.update(wakeupSubscriptions, (count) => count + 1),
        () =>
          SubscriptionRef.update(wakeupReleases, (count) => count + 1).pipe(
            Effect.andThen(SubscriptionRef.update(wakeupSubscriptions, (count) => count - 1)),
          ),
      ).pipe(Effect.asVoid),
    ),
  });
  const session = {
    client: {} as RpcSession.RpcSession["client"],
    initialConfig: Effect.die("The registry test session never loads config."),
    subscribeServerConfig: () => Stream.empty,
    ready: Effect.void,
    probe: Effect.void,
    inboundFrames: Effect.succeed(0),
    closed: Effect.never,
  } satisfies RpcSession.RpcSession;
  const driver = Driver.ConnectionDriver.of({
    connect: (entry, reportProgress) =>
      Effect.gen(function* () {
        yield* SubscriptionRef.update(connectedEntries, (entries) => [...entries, entry]);
        const prepared = preparedFor(entry);
        yield* reportProgress({ stage: "preparing" });
        yield* reportProgress({ stage: "opening", prepared });
        yield* reportProgress({ stage: "synchronizing", prepared });
        return { prepared, session };
      }),
    checkHost: () => Effect.succeed("unchecked" as const),
  });
  const dependencies = Layer.mergeAll(
    Layer.succeed(Connectivity.Connectivity, connectivity),
    Layer.succeed(Wakeups.ConnectionWakeups, wakeups),
    Layer.succeed(Driver.ConnectionDriver, driver),
  );
  return {
    dependencies,
    connectedEntries,
    connectivitySubscriptions,
    wakeupSubscriptions,
    wakeupReleases,
  };
});

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
    }).pipe(Effect.provide(offlineDependencies)),
  );
  it.effect("rejects requests for unknown servers", () =>
    Effect.gen(function* () {
      const registry = yield* Registry.make;
      const result = yield* registry.state(EnvironmentId.make("missing")).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
    }).pipe(Effect.provide(offlineDependencies)),
  );
  it.effect("publishes changed primary metadata to entries and the replacement connection", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const registry = yield* Registry.make.pipe(Effect.provide(harness.dependencies));
      yield* registry.reconcilePlatform([new PrimaryConnectionRegistration({ target })]);
      yield* awaitRef(harness.connectedEntries, (entries) => entries.length === 1);
      yield* awaitRef(harness.wakeupSubscriptions, (count) => count === 1);
      const renamed = new PrimaryConnectionTarget({
        environmentId: target.environmentId,
        label: "Renamed server",
        httpBaseUrl: target.httpBaseUrl,
        wsBaseUrl: target.wsBaseUrl,
      });
      yield* registry.reconcilePlatform([new PrimaryConnectionRegistration({ target: renamed })]);
      const entries = yield* SubscriptionRef.get(registry.entries);
      expect(entries.get(target.environmentId)?.target.label).toBe("Renamed server");
      yield* awaitRef(harness.connectedEntries, (entries) => entries.length === 2);
      expect((yield* SubscriptionRef.get(harness.connectedEntries)).at(-1)?.target.label).toBe(
        "Renamed server",
      );
      expect(yield* SubscriptionRef.get(harness.wakeupReleases)).toBe(1);
    }),
  );
  it.effect("does not reconnect identical primary registrations", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const registry = yield* Registry.make.pipe(Effect.provide(harness.dependencies));
      yield* registry.reconcilePlatform([new PrimaryConnectionRegistration({ target })]);
      yield* awaitRef(harness.connectedEntries, (entries) => entries.length === 1);
      yield* registry.reconcilePlatform([new PrimaryConnectionRegistration({ target })]);
      expect(yield* SubscriptionRef.get(harness.connectedEntries)).toHaveLength(1);
      expect(yield* SubscriptionRef.get(harness.wakeupReleases)).toBe(0);
    }),
  );
  it.effect("rebinds mounted followers after same-ID supervisor replacement", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const registry = yield* Registry.make.pipe(Effect.provide(harness.dependencies));
      const observations = yield* SubscriptionRef.make<ReadonlyArray<string>>([]);
      const starts = yield* SubscriptionRef.make<ReadonlyArray<string>>([]);
      const releases = yield* SubscriptionRef.make<ReadonlyArray<string>>([]);
      yield* registry.reconcilePlatform([new PrimaryConnectionRegistration({ target })]);
      yield* registry
        .followStream(
          target.environmentId,
          Stream.unwrap(
            Effect.gen(function* () {
              const supervisor = yield* Supervisor.EnvironmentSupervisor;
              const label = supervisor.target.label;
              yield* Effect.acquireRelease(
                SubscriptionRef.update(starts, (labels) => [...labels, label]),
                () => SubscriptionRef.update(releases, (labels) => [...labels, label]),
              );
              return SubscriptionRef.changes(supervisor.state).pipe(
                Stream.map((state) => `${label}:${state.phase}`),
              );
            }),
          ),
        )
        .pipe(
          Stream.runForEach((label) =>
            SubscriptionRef.update(observations, (labels) => [...labels, label]),
          ),
          Effect.forkScoped,
        );
      yield* awaitRef(observations, (labels) =>
        labels.some((label) => label.startsWith(`${target.label}:`)),
      );
      expect(yield* SubscriptionRef.get(starts)).toEqual([target.label]);
      const renamed = new PrimaryConnectionTarget({ ...target, label: "Renamed server" });
      yield* registry.reconcilePlatform([new PrimaryConnectionRegistration({ target: renamed })]);
      yield* awaitRef(observations, (labels) =>
        labels.some((label) => label.startsWith(`${renamed.label}:`)),
      );
      expect(yield* SubscriptionRef.get(starts)).toEqual([target.label, renamed.label]);
      expect(yield* SubscriptionRef.get(releases)).toEqual([target.label]);
      yield* registry.reconcilePlatform([new PrimaryConnectionRegistration({ target: renamed })]);
      yield* Effect.yieldNow;
      expect(yield* SubscriptionRef.get(starts)).toEqual([target.label, renamed.label]);
      expect(yield* SubscriptionRef.get(releases)).toEqual([target.label]);
    }),
  );
  it.effect("keeps followers silent while absent and resumes when registered again", () =>
    Effect.gen(function* () {
      const registry = yield* Registry.make;
      const observations = yield* SubscriptionRef.make<ReadonlyArray<string>>([]);
      const releases = yield* SubscriptionRef.make<ReadonlyArray<string>>([]);
      yield* registry
        .followStream(
          target.environmentId,
          Stream.unwrap(
            Effect.gen(function* () {
              const supervisor = yield* Supervisor.EnvironmentSupervisor;
              const label = supervisor.target.label;
              yield* Effect.acquireRelease(Effect.void, () =>
                SubscriptionRef.update(releases, (labels) => [...labels, label]),
              );
              return Stream.make(label).pipe(Stream.concat(Stream.never));
            }),
          ),
        )
        .pipe(
          Stream.runForEach((label) =>
            SubscriptionRef.update(observations, (labels) => [...labels, label]),
          ),
          Effect.forkScoped,
        );
      yield* Effect.yieldNow;
      expect(yield* SubscriptionRef.get(observations)).toEqual([]);
      yield* registry.reconcilePlatform([new PrimaryConnectionRegistration({ target })]);
      yield* awaitRef(observations, (labels) => labels.length === 1);
      const other = new PrimaryConnectionTarget({
        ...target,
        environmentId: EnvironmentId.make("other"),
      });
      yield* registry.reconcilePlatform([new PrimaryConnectionRegistration({ target: other })]);
      const released = yield* awaitRef(releases, (labels) => labels.length === 1).pipe(
        Effect.timeoutOption("1 second"),
        Effect.forkScoped,
      );
      yield* TestClock.adjust("1 second");
      expect(Option.isSome(yield* Fiber.join(released))).toBe(true);
      expect(yield* SubscriptionRef.get(observations)).toEqual([target.label]);
      yield* registry.reconcilePlatform([new PrimaryConnectionRegistration({ target })]);
      yield* awaitRef(observations, (labels) => labels.length === 2);
      expect(yield* SubscriptionRef.get(observations)).toEqual([target.label, target.label]);
    }).pipe(Effect.provide(offlineDependencies)),
  );
  it.effect("finalizes superseded connectivity and wakeup subscriptions before shutdown", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const registry = yield* Registry.make.pipe(Effect.provide(harness.dependencies));
      yield* registry.reconcilePlatform([new PrimaryConnectionRegistration({ target })]);
      yield* awaitRef(harness.wakeupSubscriptions, (count) => count === 1);
      const replacement = new PrimaryConnectionTarget({
        environmentId: EnvironmentId.make("replacement"),
        label: "Replacement server",
        httpBaseUrl: target.httpBaseUrl,
        wsBaseUrl: target.wsBaseUrl,
      });
      yield* registry.reconcilePlatform([
        new PrimaryConnectionRegistration({ target: replacement }),
      ]);
      expect(yield* SubscriptionRef.get(harness.wakeupReleases)).toBe(1);
      yield* awaitRef(harness.wakeupSubscriptions, (count) => count === 1);
      yield* awaitRef(harness.connectivitySubscriptions, (count) => count === 2);
      expect([...(yield* SubscriptionRef.get(registry.entries)).keys()]).toEqual([
        replacement.environmentId,
      ]);
    }),
  );
});

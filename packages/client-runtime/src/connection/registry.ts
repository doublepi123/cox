import { EnvironmentId } from "@t3tools/contracts";
import * as ConnectionDriver from "./driver.ts";
import * as ConnectionWakeups from "./wakeups.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";

import * as Layer from "effect/Layer";

import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { ConnectionCatalogEntry, PlatformConnectionRegistration } from "./catalog.ts";
import { connectionRegistrationCatalogEntry } from "./catalog.ts";
import { type NetworkStatus, type SupervisorConnectionState } from "./model.ts";

import * as Connectivity from "./connectivity.ts";
import * as EnvironmentSupervisor from "./supervisor.ts";

export class EnvironmentNotRegisteredError extends Schema.TaggedError<EnvironmentNotRegisteredError>()(
  "EnvironmentNotRegisteredError",
  {
    environmentId: EnvironmentId,
  },
) {
  override get message(): string {
    return `Environment ${this.environmentId} is not registered.`;
  }
}

export class EnvironmentRegistry extends Context.Service<
  EnvironmentRegistry,
  {
    readonly entries: SubscriptionRef.SubscriptionRef<
      ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>
    >;
    readonly networkStatus: SubscriptionRef.SubscriptionRef<NetworkStatus>;
    readonly reconcilePlatform: (
      registrations: ReadonlyArray<PlatformConnectionRegistration>,
    ) => Effect.Effect<void>;
    readonly retryNow: (environmentId: EnvironmentId) => Effect.Effect<void>;
    readonly state: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<SupervisorConnectionState, EnvironmentNotRegisteredError>;
    readonly stateChanges: (
      environmentId: EnvironmentId,
    ) => Stream.Stream<SupervisorConnectionState, EnvironmentNotRegisteredError>;
    readonly run: <A, E, R>(
      environmentId: EnvironmentId,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<
      A,
      E | EnvironmentNotRegisteredError,
      Exclude<R, EnvironmentSupervisor.EnvironmentSupervisor>
    >;
    readonly runStream: <A, E, R>(
      environmentId: EnvironmentId,
      stream: Stream.Stream<A, E, R>,
    ) => Stream.Stream<
      A,
      E | EnvironmentNotRegisteredError,
      Exclude<R, EnvironmentSupervisor.EnvironmentSupervisor>
    >;
    readonly followStream: <A, E, R>(
      environmentId: EnvironmentId,
      stream: Stream.Stream<A, E, R>,
    ) => Stream.Stream<A, E, Exclude<R, EnvironmentSupervisor.EnvironmentSupervisor>>;
  }
>()("@t3tools/client-runtime/connection/registry/EnvironmentRegistry") {}

export const make = Effect.gen(function* () {
  const services = yield* Effect.context<
    | ConnectionDriver.ConnectionDriver
    | ConnectionWakeups.ConnectionWakeups
    | Connectivity.Connectivity
  >();
  const connectivity = yield* Connectivity.Connectivity;
  const entries = yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
    new Map(),
  );
  const networkStatus = yield* SubscriptionRef.make<NetworkStatus>(yield* connectivity.status);
  const supervisors = new Map<
    EnvironmentId,
    EnvironmentSupervisor.EnvironmentSupervisor["Service"]
  >();
  const supervisorScopes = new Map<EnvironmentId, Scope.Closeable>();
  const lock = yield* Semaphore.make(1);
  const acquireSupervisor = (environmentId: EnvironmentId) =>
    Effect.suspend(() => {
      const supervisor = supervisors.get(environmentId);
      return supervisor
        ? Effect.succeed(supervisor)
        : Effect.fail(new EnvironmentNotRegisteredError({ environmentId }));
    });
  const reconcilePlatform = (registrations: ReadonlyArray<PlatformConnectionRegistration>) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const registration = registrations.find(
          (candidate) => candidate._tag === "PrimaryConnectionRegistration",
        );
        if (!registration || registration._tag !== "PrimaryConnectionRegistration") return;
        const environmentId = registration.target.environmentId;
        const currentTarget = (yield* SubscriptionRef.get(entries)).get(environmentId)?.target;
        if (currentTarget && Equal.equals(currentTarget, registration.target)) return;
        const entry = connectionRegistrationCatalogEntry(registration);
        const supervisorScope = yield* Scope.make();
        const supervisor = yield* EnvironmentSupervisor.make(entry, {
          initiallyDesired: true,
        }).pipe(Scope.provide(supervisorScope), Effect.provide(services));
        for (const [existingId, existingScope] of supervisorScopes) {
          supervisors.delete(existingId);
          supervisorScopes.delete(existingId);
          yield* Scope.close(existingScope, Exit.void);
        }
        supervisors.set(environmentId, supervisor);
        supervisorScopes.set(environmentId, supervisorScope);
        yield* SubscriptionRef.set(entries, new Map([[environmentId, entry]]));
        yield* supervisor.connect;
      }),
    );
  const state = (environmentId: EnvironmentId) =>
    acquireSupervisor(environmentId).pipe(
      Effect.flatMap((supervisor) => SubscriptionRef.get(supervisor.state)),
    );
  const stateChanges = (environmentId: EnvironmentId) =>
    Stream.unwrap(
      acquireSupervisor(environmentId).pipe(
        Effect.map((supervisor) => SubscriptionRef.changes(supervisor.state)),
      ),
    );
  const run: EnvironmentRegistry["Service"]["run"] = (environmentId, effect) =>
    acquireSupervisor(environmentId).pipe(
      Effect.flatMap((supervisor) =>
        effect.pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor)),
      ),
    );
  const runStream: EnvironmentRegistry["Service"]["runStream"] = (environmentId, stream) =>
    Stream.unwrap(
      acquireSupervisor(environmentId).pipe(
        Effect.map((supervisor) =>
          stream.pipe(
            Stream.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          ),
        ),
      ),
    );
  const followStream: EnvironmentRegistry["Service"]["followStream"] = (environmentId, stream) =>
    Stream.unwrap(
      SubscriptionRef.changes(entries).pipe(
        Stream.filter((current) => current.has(environmentId)),
        Stream.take(1),
        Stream.runHead,
        Effect.map(() =>
          runStream(environmentId, stream).pipe(
            Stream.catchTags({ EnvironmentNotRegisteredError: () => Stream.empty }),
          ),
        ),
      ),
    );
  yield* connectivity.changes.pipe(
    Stream.runForEach((status) => SubscriptionRef.set(networkStatus, status)),
    Effect.forkScoped,
  );
  yield* Effect.addFinalizer(() =>
    Effect.forEach(supervisorScopes.values(), (scope) => Scope.close(scope, Exit.void), {
      discard: true,
    }),
  );
  return EnvironmentRegistry.of({
    entries,
    networkStatus,
    reconcilePlatform,
    state,
    stateChanges,
    run,
    runStream,
    followStream,
    retryNow: Effect.fn("EnvironmentRegistry.retryNow")((environmentId) =>
      acquireSupervisor(environmentId).pipe(
        Effect.flatMap((supervisor) => supervisor.retryNow),
        Effect.catchTags({ EnvironmentNotRegisteredError: () => Effect.void }),
      ),
    ),
  });
});

export const layer = Layer.effect(EnvironmentRegistry, make);

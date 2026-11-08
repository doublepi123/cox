import {
  EnvironmentId,
  ServerObservability,
  EnvironmentThemeId,
  UsageLimitSourceId,
  type ServerConfig,
  type ServerConfigStreamEvent,
  type ServerLifecycleWelcomePayload,
  WS_METHODS,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Layer from "effect/Layer";
import { Atom, AtomRegistry } from "effect/reactivity";

import * as Deferred from "effect/Deferred";

import * as Effect from "effect/Effect";

import * as Fiber from "effect/Fiber";

import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as TestClock from "effect/testing/TestClock";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";

import * as Persistence from "../platform/persistence.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  applyServerWelcomeEvent,
  makeEnvironmentServerWelcomeState,
  makeEnvironmentServerConfigState,
  resolveServerConfigValue,
  resolveServerWelcomeState,
  createServerEnvironmentAtoms,
} from "./server.ts";

const CONFIG = {
  availableEditors: [],
  issues: [],
  keybindings: {},
  keybindingsConfigPath: null,
  observability: null,
  providers: [],
  settings: {},
  environment: { capabilities: { environmentThemes: true } },
} as unknown as ServerConfig;

const snapshotEvent = (config: ServerConfig): ServerConfigStreamEvent => ({
  version: 1,
  type: "snapshot",
  config,
});

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

function session(client: WsRpcProtocolClient): RpcSession {
  return {
    client,
    initialConfig: Effect.succeed(CONFIG),
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    inboundFrames: Effect.succeed(0),
    closed: Effect.never,
  };
}

const makeConfigPersistenceHarness = Effect.fn("test.makeConfigPersistenceHarness")(function* (
  saveServerConfig: Persistence.EnvironmentCacheStore["Service"]["saveServerConfig"],
) {
  const events = yield* Queue.unbounded<ServerConfigStreamEvent>();
  const client = {
    [WS_METHODS.subscribeServerConfig]: () => Stream.fromQueue(events),
  } as unknown as WsRpcProtocolClient;
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
    session: yield* SubscriptionRef.make(Option.some(session(client))),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const cache = Persistence.EnvironmentCacheStore.of({
    loadShell: () => Effect.succeedNone,
    saveShell: () => Effect.void,
    loadThread: () => Effect.succeedNone,
    saveThread: () => Effect.void,
    removeThread: () => Effect.void,
    loadServerConfig: () => Effect.succeedSome(CONFIG),
    saveServerConfig,
    loadVcsRefs: () => Effect.succeedNone,
    saveVcsRefs: () => Effect.void,
    removeVcsRefs: () => Effect.void,
    clearVcsRefs: () => Effect.void,
    clear: () => Effect.void,
  });
  const state = yield* makeEnvironmentServerConfigState({
    environmentThemes: true,
    usageLimitSources: true,
  }).pipe(
    Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    Effect.provideService(Persistence.EnvironmentCacheStore, cache),
  );
  const send = Effect.fn("test.sendConfigEvent")(function* (event: ServerConfigStreamEvent) {
    yield* Queue.offer(events, event);
    return yield* SubscriptionRef.changes(state).pipe(
      Stream.filter(Option.isSome),
      Stream.map((value) => value.value),
      Stream.filter((projection) => projection.latestEvent === event),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    );
  });
  return { send };
});

describe("server state projection", () => {
  it.effect("skips duplicate keybinding saves but persists changed keybindings", () =>
    Effect.gen(function* () {
      const saved = yield* Ref.make<ReadonlyArray<ServerConfig>>([]);
      const keybindingsEvent = (key: string): ServerConfigStreamEvent => ({
        version: 1,
        type: "keybindingsUpdated",
        payload: {
          keybindings: [
            {
              command: "terminal.toggle",
              shortcut: {
                key,
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: true,
              },
            },
          ],
          issues: [],
        },
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const h = yield* makeConfigPersistenceHarness((_id, config) =>
            Ref.update(saved, (values) => [...values, config]),
          );
          const first = yield* h.send(keybindingsEvent("p"));
          yield* TestClock.adjust("500 millis");
          expect(yield* Ref.get(saved)).toEqual([first.config]);

          yield* h.send(keybindingsEvent("p"));
          yield* TestClock.adjust("10 seconds");
          expect(yield* Ref.get(saved)).toEqual([first.config]);

          const changed = yield* h.send(keybindingsEvent("q"));
          yield* TestClock.adjust("10 seconds");
          expect(yield* Ref.get(saved)).toEqual([first.config, changed.config]);
        }),
      );
    }),
  );

  it.effect(
    "compares nested durable values independently of key order and omitted undefined fields",
    () =>
      Effect.gen(function* () {
        const saved = yield* Ref.make<ReadonlyArray<ServerConfig>>([]);
        const observability = {
          logsDirectoryPath: "/synthetic/logs",
          localTracingEnabled: false,
          otlpTracesEnabled: false,
          otlpMetricsEnabled: false,
          otlpLogsEnabled: false,
        };
        yield* Effect.scoped(
          Effect.gen(function* () {
            const h = yield* makeConfigPersistenceHarness((_id, config) =>
              Ref.update(saved, (values) => [...values, config]),
            );
            const first = yield* h.send(snapshotEvent({ ...CONFIG, observability }));
            yield* TestClock.adjust("500 millis");
            const reordered = Object.fromEntries(
              Object.entries(observability).toReversed(),
            ) as typeof observability;
            for (const next of [
              { ...CONFIG, observability: reordered },
              { ...CONFIG, observability: { ...reordered, otlpTracesUrl: undefined } },
              { ...CONFIG, observability: { ...observability } },
            ]) {
              const encode = Schema.encodeEffect(Schema.fromJsonString(ServerObservability));
              expect(JSON.parse(yield* encode(next.observability))).toEqual(
                JSON.parse(yield* encode(observability)),
              );
              const projection = yield* h.send(snapshotEvent(next));
              expect(projection.config.observability).toEqual(next.observability);
              yield* TestClock.adjust("10 seconds");
              expect.soft(yield* Ref.get(saved)).toEqual([first.config]);
            }
            const writesBeforeChange = (yield* Ref.get(saved)).length;
            const changed = yield* h.send(
              snapshotEvent({
                ...CONFIG,
                observability: { ...observability, otlpTracesUrl: "https://traces.example.test" },
              }),
            );
            yield* TestClock.adjust("10 seconds");
            expect((yield* Ref.get(saved)).length).toBe(writesBeforeChange + 1);
            expect((yield* Ref.get(saved)).at(-1)).toEqual(changed.config);
          }),
        );
      }),
  );

  it.effect("saves once across transient themes, usage sources and stall updates", () =>
    Effect.gen(function* () {
      const saved = yield* Ref.make<ReadonlyArray<ServerConfig>>([]);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const h = yield* makeConfigPersistenceHarness((_id, config) =>
            Ref.update(saved, (values) => [...values, config]),
          );
          yield* h.send(snapshotEvent(CONFIG));
          yield* TestClock.adjust("500 millis");
          expect((yield* Ref.get(saved)).length).toBe(1);
          for (const event of [
            {
              version: 1,
              type: "environmentThemesUpdated",
              payload: {
                themes: [
                  {
                    id: EnvironmentThemeId.make("theme-test"),
                    name: "Test theme",
                    appearance: "dark",
                  },
                ],
              },
            },
            {
              version: 1,
              type: "usageLimitSourcesUpdated",
              payload: {
                sources: [
                  {
                    id: UsageLimitSourceId.make("source-test"),
                    kind: "cliproxy",
                    label: "Test source",
                    checkedAt: "2026-10-20T07:50:37.633Z",
                    accounts: [],
                  },
                ],
              },
            },
            snapshotEvent({
              ...CONFIG,
              lastEventLoopStall: {
                detectedAt: "2026-10-20T07:50:37.633Z",
                durationMs: 1000,
                loadAverage: 1,
                cpuCount: 8,
              },
            }),
          ] satisfies ReadonlyArray<ServerConfigStreamEvent>) {
            const projection = yield* h.send(event);
            expect(projection.latestEvent).toBe(event);
            if (event.type === "environmentThemesUpdated")
              expect(projection.config.environmentThemes).toEqual(event.payload.themes);
            if (event.type === "usageLimitSourcesUpdated")
              expect(projection.config.usageLimitSources).toEqual(event.payload.sources);
            yield* TestClock.adjust("10 seconds");
          }
        }),
      );
      expect(yield* Ref.get(saved)).toEqual([CONFIG]);
    }),
  );

  it.effect("flushes pending durable changes after a transient event", () =>
    Effect.gen(function* () {
      const saved = yield* Ref.make<ReadonlyArray<ServerConfig>>([]);
      const changed = { ...CONFIG, keybindingsConfigPath: "/changed/keybindings.json" };
      yield* Effect.scoped(
        Effect.gen(function* () {
          const h = yield* makeConfigPersistenceHarness((_id, config) =>
            Ref.update(saved, (values) => [...values, config]),
          );
          yield* h.send(snapshotEvent(CONFIG));
          yield* TestClock.adjust("500 millis");
          yield* h.send(snapshotEvent(changed));
          yield* h.send({ version: 1, type: "environmentThemesUpdated", payload: { themes: [] } });
        }),
      );
      expect(yield* Ref.get(saved)).toEqual([CONFIG, changed]);
    }),
  );

  it.effect("retries a failed durable save on a transient event", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make<ReadonlyArray<ServerConfig>>([]);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const h = yield* makeConfigPersistenceHarness((_id, config) =>
            Effect.gen(function* () {
              const values = yield* Ref.updateAndGet(attempts, (values) => [...values, config]);
              if (values.length === 1)
                return yield* new Persistence.ConnectionPersistenceError({
                  operation: "save-server-config",
                  message: "test failure",
                });
            }),
          );
          yield* h.send(snapshotEvent(CONFIG));
          yield* TestClock.adjust("500 millis");
          yield* h.send({ version: 1, type: "usageLimitSourcesUpdated", payload: { sources: [] } });
          yield* TestClock.adjust("10 seconds");
        }),
      );
      expect(yield* Ref.get(attempts)).toEqual([CONFIG, CONFIG]);
    }),
  );

  it("keeps a current welcome on ready and rejects a buffered welcome from the old session", () => {
    const firstSession = session({} as WsRpcProtocolClient);
    const secondSession = session({} as WsRpcProtocolClient);
    const welcome = {
      environment: {} as ServerLifecycleWelcomePayload["environment"],
      cwd: "/repo",
      projectName: "repo",
    } as ServerLifecycleWelcomePayload;
    const initial = {
      currentSession: firstSession,
      welcomeSession: firstSession,
      welcome: null,
    };
    const afterWelcome = applyServerWelcomeEvent(initial, firstSession, {
      type: "welcome",
      payload: welcome,
    });
    const afterReady = applyServerWelcomeEvent(afterWelcome, firstSession, {
      type: "ready",
      payload: {},
    });
    const afterSwitch = { ...afterReady, currentSession: secondSession };
    const afterBufferedOldWelcome = applyServerWelcomeEvent(afterSwitch, firstSession, {
      type: "welcome",
      payload: { ...welcome, cwd: "/stale" },
    });

    expect(afterReady).toBe(afterWelcome);
    expect(resolveServerWelcomeState(afterReady)).toBe(welcome);
    expect(afterBufferedOldWelcome).toBe(afterSwitch);
    expect(resolveServerWelcomeState(afterBufferedOldWelcome)).toBeNull();
  });

  it.effect("checks the authoritative session before accepting a buffered welcome", () =>
    Effect.gen(function* () {
      const firstEvents = yield* Queue.unbounded<{
        readonly type: "welcome" | "ready";
        readonly payload: unknown;
      }>();
      const firstSubscribed = yield* Deferred.make<void>();
      const firstClient = {
        [WS_METHODS.subscribeServerLifecycle]: () =>
          Stream.fromEffect(Deferred.succeed(firstSubscribed, undefined)).pipe(
            Stream.drain,
            Stream.concat(Stream.fromQueue(firstEvents)),
          ),
      } as unknown as WsRpcProtocolClient;
      const firstSession = session(firstClient);
      const secondSession = session({} as WsRpcProtocolClient);
      const supervisorSession = yield* SubscriptionRef.make(Option.some(firstSession));
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: supervisorSession,
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const staleWelcome = {
        environment: {} as ServerLifecycleWelcomePayload["environment"],
        cwd: "/stale",
        projectName: "stale",
      } as ServerLifecycleWelcomePayload;

      yield* Effect.scoped(
        Effect.gen(function* () {
          const state = yield* makeEnvironmentServerWelcomeState().pipe(
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          );
          yield* Deferred.await(firstSubscribed);

          supervisorSession.value = Option.some(secondSession);
          const handled = yield* SubscriptionRef.changes(state).pipe(
            Stream.filter(
              (value) => value.currentSession === secondSession || value.welcome === staleWelcome,
            ),
            Stream.runHead,
            Effect.map(Option.getOrThrow),
            Effect.forkChild,
          );
          yield* Queue.offer(firstEvents, { type: "welcome", payload: staleWelcome });

          const next = yield* Fiber.join(handled);
          expect(next.currentSession).toBe(secondSession);
          expect(resolveServerWelcomeState(next)).toBeNull();
        }),
      );
    }),
  );

  it.effect("reads the authoritative session after waiting for the welcome state lock", () =>
    Effect.gen(function* () {
      const firstSubscribed = yield* Deferred.make<void>();
      const firstClient = {
        [WS_METHODS.subscribeServerLifecycle]: () =>
          Stream.fromEffect(Deferred.succeed(firstSubscribed, undefined)).pipe(Stream.drain),
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.subscribeServerLifecycle]: () => Stream.never,
      } as unknown as WsRpcProtocolClient;
      const firstSession = session(firstClient);
      const secondSession = session(secondClient);
      const thirdSession = session({} as WsRpcProtocolClient);
      const supervisorSession = yield* SubscriptionRef.make(Option.some(firstSession));
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: supervisorSession,
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);

      yield* Effect.scoped(
        Effect.gen(function* () {
          const state = yield* makeEnvironmentServerWelcomeState().pipe(
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          );
          yield* Deferred.await(firstSubscribed);
          const changed = yield* SubscriptionRef.changes(state).pipe(
            Stream.filter((value) => value.currentSession !== firstSession),
            Stream.runHead,
            Effect.map(Option.getOrThrow),
            Effect.forkChild,
          );

          yield* state.semaphore.withPermit(
            Effect.gen(function* () {
              yield* SubscriptionRef.set(supervisorSession, Option.some(secondSession));
              yield* Effect.yieldNow;
              yield* Effect.yieldNow;
              yield* Effect.yieldNow;
              supervisorSession.value = Option.some(thirdSession);
            }),
          );

          expect((yield* Fiber.join(changed)).currentSession).toBe(thirdSession);
        }),
      );
    }),
  );

  it.effect("clears a welcome until the reconnected session sends its own", () =>
    Effect.gen(function* () {
      const firstEvents = yield* Queue.unbounded<{
        readonly type: "welcome" | "ready";
        readonly payload: unknown;
      }>();
      const secondEvents = yield* Queue.unbounded<{
        readonly type: "welcome" | "ready";
        readonly payload: unknown;
      }>();
      const firstClient = {
        [WS_METHODS.subscribeServerLifecycle]: () => Stream.fromQueue(firstEvents),
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.subscribeServerLifecycle]: () => Stream.fromQueue(secondEvents),
      } as unknown as WsRpcProtocolClient;
      const firstSession = session(firstClient);
      const secondSession = session(secondClient);
      const supervisorSession = yield* SubscriptionRef.make(Option.some(firstSession));
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: supervisorSession,
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const firstWelcome = {
        environment: {} as ServerLifecycleWelcomePayload["environment"],
        cwd: "/first",
        projectName: "first",
      } as ServerLifecycleWelcomePayload;
      const secondWelcome = {
        environment: {} as ServerLifecycleWelcomePayload["environment"],
        cwd: "/second",
        projectName: "second",
      } as ServerLifecycleWelcomePayload;

      yield* Effect.scoped(
        Effect.gen(function* () {
          const state = yield* makeEnvironmentServerWelcomeState().pipe(
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          );
          const nextResolved = (
            predicate: (value: ServerLifecycleWelcomePayload | null) => boolean,
          ) =>
            SubscriptionRef.changes(state).pipe(
              Stream.map(resolveServerWelcomeState),
              Stream.filter(predicate),
              Stream.runHead,
              Effect.map(Option.getOrThrow),
            );

          const first = yield* nextResolved((value) => value === firstWelcome).pipe(
            Effect.forkChild,
          );
          yield* Queue.offer(firstEvents, { type: "welcome", payload: firstWelcome });
          expect(yield* Fiber.join(first)).toBe(firstWelcome);

          const cleared = yield* nextResolved((value) => value === null).pipe(Effect.forkChild);
          yield* SubscriptionRef.set(supervisorSession, Option.some(secondSession));
          expect(yield* Fiber.join(cleared)).toBeNull();
          expect(resolveServerWelcomeState(yield* SubscriptionRef.get(state))).toBeNull();

          const second = yield* nextResolved((value) => value === secondWelcome).pipe(
            Effect.forkChild,
          );
          yield* Queue.offer(secondEvents, { type: "welcome", payload: secondWelcome });
          expect(yield* Fiber.join(second)).toBe(secondWelcome);
        }),
      );
    }),
  );

  it("prefers an active session config over cache until a live event arrives", () => {
    const config = (source: string, serverVersion: string) =>
      ({
        ...CONFIG,
        environment: { serverVersion },
        settings: { source },
      }) as unknown as ServerConfig;
    const cached = config("cache", "0.0.29");
    const staleLive = config("stale-live", "0.0.29");
    const initial = config("session", "0.0.30");
    const live = config("live", "0.0.30");

    expect(
      resolveServerConfigValue(
        {
          config: cached,
          latestEvent: snapshotEvent(cached),
          source: "cache",
        },
        initial,
      ),
    ).toBe(initial);
    expect(
      resolveServerConfigValue(
        {
          config: staleLive,
          latestEvent: snapshotEvent(staleLive),
          source: "live",
        },
        initial,
      ),
    ).toBe(initial);
    expect(
      resolveServerConfigValue(
        {
          config: live,
          latestEvent: snapshotEvent(live),
          source: "live",
        },
        initial,
      ),
    ).toBe(live);
  });

  it.effect("starts from cached configuration and persists the live projection", () =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<ServerConfigStreamEvent>();
      const client = {
        [WS_METHODS.subscribeServerConfig]: () => Stream.fromQueue(events),
      } as unknown as WsRpcProtocolClient;
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: yield* SubscriptionRef.make(Option.some(session(client))),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const savedConfigs = yield* Queue.unbounded<ServerConfig>();
      const cache = Persistence.EnvironmentCacheStore.of({
        loadShell: () => Effect.succeedNone,
        saveShell: () => Effect.void,
        loadThread: () => Effect.succeedNone,
        saveThread: () => Effect.void,
        removeThread: () => Effect.void,
        loadServerConfig: () => Effect.succeedSome(CONFIG),
        saveServerConfig: (_environmentId, config) => Queue.offer(savedConfigs, config),
        loadVcsRefs: () => Effect.succeedNone,
        saveVcsRefs: () => Effect.void,
        removeVcsRefs: () => Effect.void,
        clearVcsRefs: () => Effect.void,
        clear: () => Effect.void,
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const state = yield* makeEnvironmentServerConfigState({}).pipe(
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
            Effect.provideService(Persistence.EnvironmentCacheStore, cache),
          );
          expect(Option.getOrThrow(yield* SubscriptionRef.get(state)).config).toBe(CONFIG);

          const providers: ServerConfig["providers"] = [];
          yield* Queue.offer(events, {
            version: 1,
            type: "providerStatuses",
            payload: { providers },
          });
          const projected = yield* SubscriptionRef.changes(state).pipe(
            Stream.filter((value) =>
              Option.match(value, {
                onNone: () => false,
                onSome: (projection) => projection.latestEvent.type === "providerStatuses",
              }),
            ),
            Stream.runHead,
          );
          expect(Option.getOrThrow(Option.getOrThrow(projected)).config.providers).toEqual(
            providers,
          );
        }),
      );

      expect((yield* Queue.take(savedConfigs)).providers).toEqual([]);
    }),
  );

  it.effect("shows a reported stall but never caches it", () =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<ServerConfigStreamEvent>();
      const client = {
        [WS_METHODS.subscribeServerConfig]: () => Stream.fromQueue(events),
      } as unknown as WsRpcProtocolClient;
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: yield* SubscriptionRef.make(Option.some(session(client))),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const savedConfigs = yield* Queue.unbounded<ServerConfig>();
      const cache = Persistence.EnvironmentCacheStore.of({
        loadShell: () => Effect.succeedNone,
        saveShell: () => Effect.void,
        loadThread: () => Effect.succeedNone,
        saveThread: () => Effect.void,
        removeThread: () => Effect.void,
        loadServerConfig: () => Effect.succeedSome(CONFIG),
        saveServerConfig: (_environmentId, config) => Queue.offer(savedConfigs, config),
        loadVcsRefs: () => Effect.succeedNone,
        saveVcsRefs: () => Effect.void,
        removeVcsRefs: () => Effect.void,
        clearVcsRefs: () => Effect.void,
        clear: () => Effect.void,
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const state = yield* makeEnvironmentServerConfigState({}).pipe(
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
            Effect.provideService(Persistence.EnvironmentCacheStore, cache),
          );
          expect(Option.getOrThrow(yield* SubscriptionRef.get(state)).config).toBe(CONFIG);

          const lastEventLoopStall = {
            detectedAt: "2026-10-20T07:50:37.633Z",
            durationMs: 12_422,
            loadAverage: 219.4,
            cpuCount: 18,
          };
          yield* Queue.offer(events, {
            version: 1,
            type: "snapshot",
            config: { ...CONFIG, lastEventLoopStall },
          });
          const projected = yield* SubscriptionRef.changes(state).pipe(
            Stream.filter((value) =>
              Option.match(value, {
                onNone: () => false,
                onSome: (projection) => projection.source === "live",
              }),
            ),
            Stream.runHead,
          );
          expect(Option.getOrThrow(Option.getOrThrow(projected)).config.lastEventLoopStall).toEqual(
            lastEventLoopStall,
          );
        }),
      );

      // Cached, it would read as a fresh freeze on the next launch.
      expect(yield* Queue.take(savedConfigs)).not.toHaveProperty("lastEventLoopStall");
    }),
  );
});

describe("resource telemetry history", () => {
  it.effect("refreshes an initially empty history while mounted and stops after unmount", () =>
    Effect.gen(function* () {
      vi.useFakeTimers();
      try {
        yield* Effect.scoped(
          Effect.gen(function* () {
            let reads = 0;
            const client = {
              [WS_METHODS.serverGetResourceTelemetryHistory]: () =>
                Effect.sync(() => ({
                  retainedSampleCount: reads++,
                })),
            } as unknown as WsRpcProtocolClient;
            const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
              target: TARGET,
              state: yield* SubscriptionRef.make<SupervisorConnectionState>({
                ...AVAILABLE_CONNECTION_STATE,
                phase: "connected",
              }),
              session: yield* SubscriptionRef.make(Option.some(session(client))),
              prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
              connect: Effect.void,
              disconnect: Effect.void,
              retryNow: Effect.void,
            });
            const environments = EnvironmentRegistry.EnvironmentRegistry.of({
              run: (_id, effect) =>
                Effect.provideService(
                  effect,
                  EnvironmentSupervisor.EnvironmentSupervisor,
                  supervisor,
                ),
              followStream: (_id, stream) =>
                Stream.provideService(
                  stream,
                  EnvironmentSupervisor.EnvironmentSupervisor,
                  supervisor,
                ),
            } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
            const runtime = Atom.runtime(
              Layer.merge(
                Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environments),
                Layer.succeed(Persistence.EnvironmentCacheStore, {
                  loadServerConfig: () => Effect.succeedNone,
                } as unknown as Persistence.EnvironmentCacheStore["Service"]),
              ),
            );
            const atoms = createServerEnvironmentAtoms(runtime, {
              initialConfigValueAtom: () => Atom.make(CONFIG),
            });
            const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (value) =>
              Effect.sync(() => value.dispose()),
            );
            const history = atoms.resourceTelemetryHistory({
              environmentId: TARGET.environmentId,
              input: { windowMs: 900_000, bucketMs: 30_000 },
            });
            const unmount = registry.mount(history);
            const initial = yield* AtomRegistry.getResult(registry, history, {
              suspendOnWaiting: true,
            });
            expect(initial.retainedSampleCount).toBe(0);
            yield* Effect.promise(() => vi.advanceTimersByTimeAsync(5_000));
            expect(reads).toBe(2);
            const updated = yield* AtomRegistry.getResult(registry, history, {
              suspendOnWaiting: true,
            });
            expect(updated.retainedSampleCount).toBe(1);
            unmount();
            yield* Effect.promise(() => vi.advanceTimersByTimeAsync(10_000));
            expect(reads).toBe(2);
          }),
        );
      } finally {
        vi.useRealTimers();
      }
    }),
  );
});

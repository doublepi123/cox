import * as NetAddress from "effect/net/NetAddress";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  ModelServiceId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type ProviderInstanceConfigMap,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  NodeId,
  RunAttemptId,
  RunId,
  MessageId,
  ThreadId,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import {
  HttpClient,
  HttpClientResponse,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as ModelServiceGateway from "../modelServices/ModelServiceGateway.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { materializeInstances } from "../provider/ProviderInstanceRegistryHydration.ts";
import * as ProviderInstanceRegistryMutator from "../provider/ProviderInstanceRegistryMutator.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import type { AnyProviderDriver, ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandOutputHub from "./CommandOutputHub.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

export const OMO_DRIVER = ProviderDriverKind.make("omo");
export const SERVICE_A = ModelServiceId.make("service-a");
export const SERVICE_B = ModelServiceId.make("service-b");
export const INSTANCE_MAIN = ProviderInstanceId.make("omo_main");
export const INSTANCE_PEER = ProviderInstanceId.make("omo_peer");

const SingleSessionCapabilities = {
  ...CodexProviderCapabilitiesV2,
  sessions: {
    ...CodexProviderCapabilitiesV2.sessions,
    supportsMultipleProviderThreadsPerSession: false,
  },
};

export interface InstanceRuntimeMetrics {
  openCount: number;
  closeCount: number;
  tokensAtOpen: Array<string | undefined>;
  resumedThreads: Array<{
    readonly nativeThreadId: string | undefined;
    readonly cwd: string | null;
    readonly model: string;
    readonly thinking: unknown;
  }>;
  turnCreationSources: Array<string>;
  turnGatewayStatuses: Array<number>;
  pendingWakeOnActiveRuntime: boolean;
}

export const makeMetrics = (): InstanceRuntimeMetrics => ({
  openCount: 0,
  closeCount: 0,
  tokensAtOpen: [],
  resumedThreads: [],
  turnCreationSources: [],
  turnGatewayStatuses: [],
  pendingWakeOnActiveRuntime: false,
});

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export const invokeGatewayModels = Effect.fn("invokeGatewayModels")(function* (
  gateway: ModelServiceGateway.ModelServiceGateway["Service"],
  token: string | undefined,
) {
  const request = HttpServerRequest.fromWeb(
    new Request("http://127.0.0.1/api/model-gateway/v1/chat/completions", {
      method: "POST",
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "content-type": "application/json",
      },
      body: encodeJson({
        model: "gpt-6.1-sol",
        messages: [{ role: "user", content: "continue" }],
      }),
    }),
  );
  const response = yield* gateway.handle.pipe(
    Effect.provideService(HttpServerRequest.HttpServerRequest, request),
    Effect.scoped,
  );
  const body = yield* Effect.promise(() => HttpServerResponse.toWeb(response).json());
  return { status: response.status, body };
});

export const buildCredentialRotationHarness = Effect.fn("buildCredentialRotationHarness")(
  function* (options?: {
    readonly onDriverCreate?: (instanceId: ProviderInstanceId) => Effect.Effect<void>;
  }) {
    const upstreamHits: Array<{ readonly url: string; readonly auth: string | undefined }> = [];
    const metricsByInstance = new Map<ProviderInstanceId, InstanceRuntimeMetrics>([
      [INSTANCE_MAIN, makeMetrics()],
      [INSTANCE_PEER, makeMetrics()],
    ]);
    const metricsFor = (id: ProviderInstanceId) => {
      const existing = metricsByInstance.get(id);
      if (existing !== undefined) return existing;
      const created = makeMetrics();
      metricsByInstance.set(id, created);
      return created;
    };

    const httpClient = HttpClient.make((request) =>
      Effect.sync(() => {
        upstreamHits.push({ url: request.url, auth: request.headers.authorization });
        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            id: "chat-ok",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "ok" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
          }),
        );
      }),
    );

    const settingsLayer = ServerSettings.ServerSettingsService.layerTest({
      deletedDefaultProviderInstances: [
        ProviderInstanceId.make("codex"),
        ProviderInstanceId.make("claudeAgent"),
        ProviderInstanceId.make("cursor"),
        ProviderInstanceId.make("grok"),
        ProviderInstanceId.make("fx"),
        ProviderInstanceId.make("opencode"),
        ProviderInstanceId.make("antigravity"),
        ProviderInstanceId.make("pi"),
        ProviderInstanceId.make("omo"),
        ProviderInstanceId.make("muse"),
      ],
      modelServices: {
        [SERVICE_A]: {
          name: "Service A",
          revision: 0,
          baseUrl: "https://service-a.example",
          apiKey: "upstream-key-a",
          headers: {},
          protocols: ["openai-chat"],
          models: [{ id: "gpt-6.1-sol", capabilities: null }],
          enabled: true,
        },
        [SERVICE_B]: {
          name: "Service B",
          revision: 0,
          baseUrl: "https://service-b.example",
          apiKey: "upstream-key-b",
          headers: {},
          protocols: ["openai-chat"],
          models: [{ id: "gpt-6.1-sol", capabilities: null }],
          enabled: true,
        },
      },
      providerInstances: {
        [INSTANCE_MAIN]: {
          driver: OMO_DRIVER,
          enabled: true,
          modelService: { serviceId: SERVICE_A, modelIds: [], defaultModel: "gpt-6.1-sol" },
          config: {},
        },
        [INSTANCE_PEER]: {
          driver: OMO_DRIVER,
          enabled: true,
          modelService: { serviceId: SERVICE_A, modelIds: [], defaultModel: "gpt-6.1-sol" },
          config: {},
        },
      },
    });

    const baseInfra = ModelServiceGateway.layer.pipe(
      Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, httpClient)),
      Layer.provideMerge(settingsLayer),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "cred-rotation-test-" })),
      Layer.provideMerge(NodeServices.layer),
    );
    const infraCtx = yield* Layer.build(baseInfra);
    const gateway = Context.get(infraCtx, ModelServiceGateway.ModelServiceGateway);
    const serverSettings = Context.get(infraCtx, ServerSettings.ServerSettingsService);

    const omoDriver: AnyProviderDriver = {
      driverKind: OMO_DRIVER,
      metadata: { displayName: "OMO Native", supportsMultipleInstances: true },
      configSchema: Schema.Record(Schema.String, Schema.Unknown),
      defaultConfig: () => ({}),
      create: (createInput) =>
        Effect.gen(function* () {
          if (options?.onDriverCreate !== undefined) {
            yield* options.onDriverCreate(createInput.instanceId);
          }
          const launchToken = createInput.environment.find(
            (entry) => entry.name === "COX_MODEL_SERVICE_KEY",
          )?.value;
          const adapter = ProviderAdapter.ProviderAdapterV2.of({
            instanceId: createInput.instanceId,
            driver: OMO_DRIVER,
            getCapabilities: () => Effect.succeed(SingleSessionCapabilities),
            planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
            openSession: (openInput) =>
              Effect.gen(function* () {
                const metrics = metricsFor(createInput.instanceId);
                metrics.openCount += 1;
                metrics.tokensAtOpen.push(launchToken);
                const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
                yield* Effect.addFinalizer(() =>
                  Effect.sync(() => {
                    metrics.closeCount += 1;
                  }).pipe(Effect.andThen(Queue.shutdown(events))),
                );
                const now = yield* DateTime.now;
                const providerSession: OrchestrationV2ProviderSession = {
                  id: openInput.providerSessionId,
                  driver: OMO_DRIVER,
                  providerInstanceId: createInput.instanceId,
                  status: "ready",
                  cwd: openInput.runtimePolicy.cwd ?? process.cwd(),
                  model: openInput.modelSelection.model,
                  capabilities: SingleSessionCapabilities,
                  createdAt: now,
                  updatedAt: now,
                  lastError: null,
                };
                const unusedProtocolError = () =>
                  Effect.fail(
                    new ProviderAdapter.ProviderAdapterProtocolError({
                      driver: OMO_DRIVER,
                      detail: "unused",
                    }),
                  );
                return {
                  instanceId: createInput.instanceId,
                  driver: OMO_DRIVER,
                  providerSessionId: openInput.providerSessionId,
                  providerSession,
                  events: Stream.fromQueue(events),
                  hasPendingBackgroundWork: Effect.sync(() => metrics.pendingWakeOnActiveRuntime),
                  ensureThread: (ensureInput) =>
                    DateTime.now.pipe(
                      Effect.map((ts): OrchestrationV2ProviderThread => ({
                        id: ProviderThreadId.make("provider-thread:omo:native-omo-session-1"),
                        driver: OMO_DRIVER,
                        providerInstanceId: createInput.instanceId,
                        providerSessionId: openInput.providerSessionId,
                        appThreadId: ensureInput.threadId,
                        ownerNodeId: null,
                        nativeThreadRef: {
                          driver: OMO_DRIVER,
                          nativeId: "native-omo-session-1",
                          strength: "strong",
                        },
                        nativeConversationHeadRef: null,
                        status: "idle",
                        firstRunOrdinal: null,
                        lastRunOrdinal: null,
                        handoffIds: [],
                        forkedFrom: null,
                        createdAt: ts,
                        updatedAt: ts,
                      })),
                    ),
                  resumeThread: (resumeInput) =>
                    Effect.sync(() => {
                      metrics.resumedThreads.push({
                        nativeThreadId:
                          resumeInput.providerThread.nativeThreadRef?.nativeId ?? undefined,
                        cwd: resumeInput.runtimePolicy?.cwd ?? null,
                        model: resumeInput.modelSelection?.model ?? "",
                        thinking: resumeInput.modelSelection
                          ? getModelSelectionStringOptionValue(
                              resumeInput.modelSelection,
                              "thinking",
                            )
                          : undefined,
                      });
                      return resumeInput.providerThread;
                    }),
                  forkThread: unusedProtocolError,
                  readThreadSnapshot: unusedProtocolError,
                  rollbackThread: unusedProtocolError,
                  startTurn: (turnInput) =>
                    Effect.gen(function* () {
                      metrics.pendingWakeOnActiveRuntime = false;
                      metrics.turnCreationSources.push(turnInput.message.creationSource);
                      const gatewayResult = yield* invokeGatewayModels(gateway, launchToken);
                      metrics.turnGatewayStatuses.push(gatewayResult.status);
                      if (gatewayResult.status !== 200) {
                        return yield* new ProviderAdapter.ProviderAdapterTurnStartError({
                          driver: OMO_DRIVER,
                          threadId: turnInput.threadId,
                          providerThreadId: turnInput.providerThread.id,
                          runId: turnInput.runId,
                          cause: `HTTP ${gatewayResult.status}`,
                        });
                      }
                      yield* Queue.offer(events, {
                        type: "turn.terminal",
                        driver: OMO_DRIVER,
                        providerThreadId: turnInput.providerThread.id,
                        providerTurnId: ProviderTurnId.make(
                          `provider-turn:omo:${turnInput.runOrdinal}`,
                        ),
                        runOrdinal: turnInput.runOrdinal,
                        status: "completed",
                        failure: null,
                        threadDisposition: "reusable",
                      });
                    }),
                  steerTurn: () => Effect.void,
                  interruptTurn: () => Effect.void,
                  respondToRuntimeRequest: () => Effect.void,
                };
              }),
          });
          return {
            instanceId: createInput.instanceId,
            driverKind: OMO_DRIVER,
            continuationIdentity: {
              driverKind: OMO_DRIVER,
              continuationKey: `omo:instance:${createInput.instanceId}`,
            },
            enabled: createInput.enabled,
            orchestrationAdapter: adapter,
          } as unknown as ProviderInstance;
        }),
    };

    const initialSettings = yield* serverSettings.getSettings;
    const initialConfigMap: ProviderInstanceConfigMap = yield* materializeInstances(
      initialSettings,
    ).pipe(Effect.provideService(ModelServiceGateway.ModelServiceGateway, gateway));

    const syncLock = yield* Semaphore.make(1);
    let lastSyncedSettings = initialSettings;

    const layerRegistryBase = ProviderInstanceRegistry.layer({
      drivers: [omoDriver],
      configMap: initialConfigMap,
    }).pipe(
      Layer.provide(
        Layer.succeed(SecretResolver.SecretResolver, {
          label: Effect.succeed,
          read: () => Effect.succeed([]),
          invalidate: () => Effect.void,
        }),
      ),
    );

    const registryCtx = yield* Layer.build(layerRegistryBase);
    const baseRegistry = Context.get(
      registryCtx,
      ProviderInstanceRegistry.ProviderInstanceRegistry,
    );
    const mutator = Context.get(
      registryCtx,
      ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator,
    );

    const reconcileNow = syncLock.withPermits(1)(
      serverSettings.getSettings.pipe(
        Effect.flatMap((current) =>
          materializeInstances(current).pipe(
            Effect.provideService(ModelServiceGateway.ModelServiceGateway, gateway),
            Effect.flatMap((entries) => mutator.reconcile(entries)),
            Effect.tap(() =>
              Effect.sync(() => {
                lastSyncedSettings = current;
              }),
            ),
          ),
        ),
      ),
    );

    const synchronize = syncLock.withPermits(1)(
      serverSettings.getSettings.pipe(
        Effect.flatMap((current) =>
          lastSyncedSettings === current
            ? Effect.void
            : materializeInstances(current).pipe(
                Effect.provideService(ModelServiceGateway.ModelServiceGateway, gateway),
                Effect.flatMap((entries) => mutator.reconcile(entries)),
                Effect.tap(() =>
                  Effect.sync(() => {
                    lastSyncedSettings = current;
                  }),
                ),
              ),
        ),
        Effect.orDie,
        Effect.andThen(baseRegistry.synchronize ?? Effect.void),
      ),
    );

    const hydratedRegistry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"] = {
      ...baseRegistry,
      get streamChanges() {
        return baseRegistry.streamChanges;
      },
      get subscribeChanges() {
        return baseRegistry.subscribeChanges;
      },
      synchronize,
    };

    const layerDb = SqlitePersistence.layerMemory;
    const layerStores = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(
      Layer.provide(layerDb),
    );
    const layerSink = EventSink.layer.pipe(Layer.provide(Layer.mergeAll(layerStores, layerDb)));
    const layerIngestor = ProviderEventIngestor.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, hydratedRegistry),
          layerSink,
          IdAllocator.layer,
          layerStores,
          ThreadCommandExecutor.layer,
          Layer.mock(GitVcsDriver.GitVcsDriver)({ resolveBranchName: () => Effect.succeed(null) }),
        ),
      ),
    );
    const fakeServer = HttpServer.HttpServer.of({
      address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43124),
      serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
    });
    const fakeEnv = ServerEnvironment.ServerEnvironment.of({
      getEnvironmentId: Effect.succeed(EnvironmentId.make("env-cred-rotation")),
      getDescriptor: Effect.die("unused"),
    });
    const layerMcp = Layer.effect(
      McpSessionRegistry.McpSessionRegistry,
      McpSessionRegistry.__testing.make(),
    ).pipe(
      Layer.provide(Layer.succeed(HttpServer.HttpServer, fakeServer)),
      Layer.provide(Layer.succeed(ServerEnvironment.ServerEnvironment, fakeEnv)),
      Layer.provide(NodeServices.layer),
    );

    const sessionCtx = yield* Layer.build(
      Layer.mergeAll(
        layerStores,
        layerSink,
        IdAllocator.layer,
        ProviderSessionManager.layerWithOptions({ idleTimeoutMs: 60_000 }).pipe(
          Layer.provide(
            Layer.mergeAll(
              ProviderAdapterRegistry.layerFromProviderInstanceRegistry.pipe(
                Layer.provide(
                  Layer.succeed(
                    ProviderInstanceRegistry.ProviderInstanceRegistry,
                    hydratedRegistry,
                  ),
                ),
              ),
              CommandOutputHub.layer.pipe(Layer.provide(Layer.merge(layerSink, layerStores))),
              layerSink,
              IdAllocator.layer,
              layerIngestor,
              layerMcp,
              McpProviderSessions.layer,
              layerStores,
              Layer.succeed(ModelServiceGateway.ModelServiceGateway, gateway),
              Layer.succeed(ServerSettings.ServerSettingsService, serverSettings),
            ),
          ),
        ),
      ).pipe(Layer.provide(NodeServices.layer)),
    );

    const manager = Context.get(sessionCtx, ProviderSessionManager.ProviderSessionManagerV2);
    const eventSink = Context.get(sessionCtx, EventSink.EventSinkV2);
    const idAllocator = Context.get(sessionCtx, IdAllocator.IdAllocatorV2);

    const createThreadFixture = Effect.fn("createThreadFixture")(function* (input: {
      readonly threadId: ThreadId;
      readonly instanceId: ProviderInstanceId;
      readonly cwd: string;
      readonly nativeThreadId: string;
    }) {
      const now = yield* DateTime.now;
      const projectId = yield* idAllocator.allocate.project({ fixtureName: input.threadId });
      const selection: ModelSelection = {
        instanceId: input.instanceId,
        model: "gpt-6.1-sol",
        options: [{ id: "thinking", value: "high" }],
      };
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: input.instanceId,
        threadId: input.threadId,
      });
      const providerThread: OrchestrationV2ProviderThread = {
        id: idAllocator.derive.providerThread({
          driver: OMO_DRIVER,
          nativeThreadId: input.nativeThreadId,
        }),
        driver: OMO_DRIVER,
        providerInstanceId: input.instanceId,
        providerSessionId,
        appThreadId: input.threadId,
        ownerNodeId: null,
        nativeThreadRef: {
          driver: OMO_DRIVER,
          nativeId: input.nativeThreadId,
          strength: "strong",
        },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };
      const appThread: OrchestrationV2AppThread = {
        createdBy: "user",
        creationSource: "web",
        id: input.threadId,
        projectId,
        title: "Credential rotation thread",
        providerInstanceId: input.instanceId,
        modelSelection: selection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "feat/rebind",
        worktreePath: input.cwd,
        activeProviderThreadId: providerThread.id,
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: input.threadId,
        },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      };
      yield* eventSink.write({
        events: [
          {
            id: yield* idAllocator.allocate.event({ threadId: input.threadId }),
            type: "thread.created",
            threadId: input.threadId,
            occurredAt: now,
            payload: appThread,
          },
        ],
      });
      const runTurn = Effect.fn("runTurn")(function* (
        runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime,
        ordinal: number,
        creationSource: "web" | "provider" | "server" = "web",
      ) {
        const runId = RunId.make(`run-${input.threadId}-${ordinal}`);
        yield* runtime.startTurn({
          threadId: input.threadId,
          runId,
          runOrdinal: ordinal,
          attemptId: RunAttemptId.make(`attempt-${input.threadId}-${ordinal}`),
          rootNodeId: NodeId.make(`node-${input.threadId}-${ordinal}`),
          providerTurnOrdinal: ordinal,
          appThread,
          providerThread,
          message: {
            messageId: MessageId.make(`msg-${input.threadId}-${ordinal}`),
            text: "continue",
            attachments: [],
            createdBy: creationSource === "web" ? "user" : "agent",
            creationSource,
          },
          modelSelection: selection,
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: input.cwd,
          },
        });
      });
      return { selection, providerSessionId, providerThread, appThread, runTurn };
    });

    return {
      gateway,
      serverSettings,
      manager,
      reconcileNow,
      hydratedRegistry,
      metricsFor,
      upstreamHits,
      createThreadFixture,
      scope: Scope.Scope,
    };
  },
);

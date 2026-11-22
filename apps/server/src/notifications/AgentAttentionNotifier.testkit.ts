import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  NotificationWebhookChannelId,
  type NotificationWebhookChannel,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
} from "@t3tools/contracts";
import { SecretResolver } from "@t3tools/secret-provider-core/server/SecretResolver";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Config from "../config.ts";
import * as Secrets from "../auth/ServerSecretStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Subscriptions from "../persistence/NotificationSubscriptions.ts";
import * as Events from "../orchestration-v2/EventStore.ts";
import * as Sink from "../orchestration-v2/EventSink.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import * as Push from "./WebPushService.ts";
import * as Notifier from "./AgentAttentionNotifier.ts";
import { SECRET_REDACTED } from "../settingsSecrets.ts";
import { OmoLifecycle } from "../../../../packages/provider-omo/src/server/lifecycle.ts";

export const syntheticAttention = (kind: string) =>
  new OmoLifecycle().observe({
    type: "session_lifecycle",
    sessionId: "root-session",
    lifecycle: {
      role: "root",
      seq: 1,
      state: "waiting_human",
      persisted: true,
      runId: "run-1",
      runActive: true,
      runPaused: false,
      holds: [],
      waitingOn: { children: 0, background: [], human: [{ kind, requestId: `${kind}:root:1` }] },
    },
  });

export const now = DateTime.makeUnsafe("2026-11-15T12:00:00.000Z");
export const threadId = ThreadId.make("attention-thread");
const instanceId = ProviderInstanceId.make("omo");
export const thread: OrchestrationV2AppThread = {
  id: threadId,
  projectId: ProjectId.make("project"),
  title: "Attention",
  providerInstanceId: instanceId,
  modelSelection: { instanceId, model: "test" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  createdBy: "user",
  creationSource: "web",
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
};
export const run = (
  id: string,
  status: OrchestrationV2Run["status"] = "running",
): OrchestrationV2Run => ({
  id: RunId.make(id),
  threadId,
  ordinal: Number(id.replace(/\D/g, "")) || 1,
  providerInstanceId: instanceId,
  modelSelection: thread.modelSelection,
  providerThreadId: null,
  userMessageId: MessageId.make(`message-${id}`),
  rootNodeId: NodeId.make(`root-${id}`),
  activeAttemptId: null,
  status,
  requestedAt: now,
  startedAt: now,
  completedAt: status === "running" ? null : now,
  checkpointId: null,
  contextHandoffId: null,
});
export const request = (
  id: string,
  kind: OrchestrationV2RuntimeRequest["kind"] = "user_input",
): OrchestrationV2RuntimeRequest => ({
  id: RuntimeRequestId.make(id),
  nodeId: NodeId.make("dialog-node"),
  providerTurnId: null,
  nativeRequestRef: null,
  kind,
  status: "pending",
  responseCapability: { type: "live", providerSessionId: ProviderSessionId.make("session") },
  createdAt: now,
  resolvedAt: null,
});
export const secret = (id: string) => ({
  id: TurnItemId.make(id),
  threadId,
  runId: RunId.make("run-1"),
  nodeId: NodeId.make("root-run-1"),
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  title: "Secret",
  status: "waiting" as const,
  startedAt: now,
  completedAt: null,
  updatedAt: now,
  type: "secret_request" as const,
  label: "Password",
  reason: "Test",
  secretStatus: "pending" as const,
});
type EventInput = OrchestrationV2DomainEvent extends infer E
  ? E extends OrchestrationV2DomainEvent
    ? Omit<E, "id" | "threadId" | "occurredAt">
    : never
  : never;
let sequence = 0;
export const commit = (event: EventInput, owner = threadId) =>
  Effect.flatMap(Sink.EventSinkV2, (sink) =>
    sink.write({
      events: [
        { ...event, id: EventId.make(`event-${++sequence}`), threadId: owner, occurredAt: now },
      ],
    }),
  );

export const layers = (
  webhookUrl: string,
  options: {
    readonly publicBaseUrl?: string;
    readonly environmentId?: string;
    readonly webhooks?: readonly NotificationWebhookChannel[];
  } = {},
) => {
  const settings = {
    ...DEFAULT_SERVER_SETTINGS,
    notifications: {
      publicBaseUrl: options.publicBaseUrl ?? null,
      webPushEnabled: true,
      webhooks: options.webhooks ?? [
        {
          id: NotificationWebhookChannelId.make("hook"),
          label: "Probe",
          provider: "json" as const,
          url: webhookUrl,
          enabled: true,
          allowPrivateNetwork: true,
          secret: SECRET_REDACTED,
          events: ["human_attention", "turn_completed", "turn_failed"] as const,
        },
      ],
    },
  };
  const stores = Layer.mergeAll(Projections.layer, Events.layer, Subscriptions.layer);
  const dependencies = Layer.mergeAll(
    Layer.mock(ServerSettingsService)({ getSettings: Effect.succeed(settings) }),
    Layer.mock(ServerEnvironment)({
      getEnvironmentId: Effect.succeed(EnvironmentId.make(options.environmentId ?? "environment")),
    }),
    Layer.mock(SecretResolver)({}),
    Layer.effect(Push.WebPushService, Push.make({ allowLoopbackHttpForTest: true })).pipe(
      Layer.provideMerge(Secrets.layer),
    ),
  );
  return Notifier.layer.pipe(
    Layer.provideMerge(Sink.layer.pipe(Layer.provideMerge(stores))),
    Layer.provideMerge(dependencies),
    Layer.provideMerge(Sqlite.layerConfig),
    Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "attention-notifier-" })),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
};

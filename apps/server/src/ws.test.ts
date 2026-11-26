import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AuthAccessReadScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  AuthSourceControlWriteScope,
  AuthTerminalOperateScope,
  AuthEnvironmentScope,
  type WorkflowRun,
  type WorkflowStep,
  EventId,
  MessageId,
  mcpClientScopes,
  TurnItemId,
  EnvironmentId,
  ProjectId,
  ThreadId,
  ProviderDriverKind,
  ProviderInstanceId,
  WS_METHODS,
  WsServerRefreshProvidersRpc,
  WsSubscribeServerConfigRpc,
  WsRpcGroup,
  type AuthAccessStreamEvent,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadShell,
  type OrchestrationProjectShell,
  type ServerConfig,
  type ServerConfigStreamEvent,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { Headers } from "effect/http";
import { RpcGroup, RpcMessage, RpcServer } from "effect/rpc";
import * as SqlClient from "effect/sql/SqlClient";
import { vi } from "vite-plus/test";

import * as WorkspacePreviewRevisions from "./assets/WorkspacePreviewRevisions.ts";
import * as PreviewAutomationBroker from "./mcp/PreviewAutomationBroker.ts";
import * as ServerBrowser from "./preview/ServerBrowser.ts";
import * as AcpRegistryRuntimeCoordinator from "@t3tools/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as AgentSessionImporter from "./project/AgentSessionImporter.ts";
import * as AgentSessionScanner from "./project/AgentSessionScanner.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";
import * as AntigravityInstallation from "./provider/AntigravityInstallation.ts";
import * as BackgroundPolicy from "./background/BackgroundPolicy.ts";
import * as CheckpointDiffQuery from "./checkpointing/CheckpointDiffQuery.ts";
import * as CommandOutputHub from "./orchestration-v2/CommandOutputHub.ts";
import * as ThreadViewers from "./orchestration-v2/ThreadViewers.ts";
import * as CodexInstallation from "./provider/CodexInstallation.ts";
import * as DocumentText from "./provider/DocumentText.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as RpcTest from "effect/rpc/RpcTest";
import * as RpcAuthorization from "./auth/RpcAuthorization.ts";
import * as EnvironmentTheme from "./environmentTheme.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import * as HostResources from "./resourceTelemetry/HostResources.ts";
import * as ManagedProjectFolders from "./project/ManagedProjectFolders.ts";
import * as ScratchThreadPromotion from "./project/ScratchThreadPromotion.ts";
import * as McpAppRequests from "./mcpApps/McpAppRequests.ts";
import * as McpSignIn from "./mcpApps/McpSignIn.ts";
import * as ModelManifest from "./provider/ModelManifest.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as OtlpEndpointCheck from "./observability/OtlpEndpointCheck.ts";
import * as PortScanner from "./preview/PortScanner.ts";
import * as PreviewManager from "./preview/Manager.ts";
import * as ProcessDiagnostics from "./diagnostics/ProcessDiagnostics.ts";
import * as ProcessResourceMonitor from "./diagnostics/ProcessResourceMonitor.ts";
import * as ProjectCloneTracker from "./project/ProjectCloneTracker.ts";
import * as ProjectSetupScriptRunner from "./project/ProjectSetupScriptRunner.ts";
import * as ProviderAuthService from "./provider/ProviderAuthService.ts";
import * as ProviderInstanceRegistry from "./provider/ProviderInstanceRegistry.ts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ProviderMaintenanceRunner from "./provider/providerMaintenanceRunner.ts";
import * as ProviderRegistry from "./provider/ProviderRegistry.ts";
import * as ProviderSessionManager from "./orchestration-v2/ProviderSessionManager.ts";
import * as PullRequestReviewGuideService from "./pullRequest/PullRequestReviewGuideService.ts";
import * as PullRequestService from "./pullRequest/PullRequestService.ts";
import * as PullRequestSyncReactor from "./orchestration-v2/PullRequestSyncReactor.ts";
import * as RepositoryIdentityResolver from "./project/RepositoryIdentityResolver.ts";
import * as ResourceTelemetry from "./resourceTelemetry/ResourceTelemetry.ts";
import * as ReviewService from "./review/ReviewService.ts";
import * as ScheduledTasks from "./scheduledTasks/ScheduledTaskService.ts";
import * as Workflows from "./workflows/Workflows.ts";
import * as WorkflowRuntime from "./workflows/WorkflowRuntime.ts";
import * as SecretRequests from "./secrets/SecretRequests.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as SessionStore from "./auth/SessionStore.ts";
import * as SourceControlDiscovery from "./sourceControl/SourceControlDiscovery.ts";
import * as SourceControlRepositoryService from "./sourceControl/SourceControlRepositoryService.ts";
import * as SourceControlSignIn from "./sourceControl/SourceControlSignIn.ts";
import * as StorageCleanup from "./storageCleanup.ts";
import * as DatabaseStorage from "./persistence/DatabaseStorage.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as ThreadLaunchService from "./orchestration-v2/ThreadLaunchService.ts";
import * as ThreadSearch from "./orchestration-v2/ThreadSearch.ts";
import * as UsageLimitSources from "./usage/UsageLimitSources.ts";
import * as UsageService from "./usage/UsageService.ts";
import * as VcsProvisioningService from "./vcs/VcsProvisioningService.ts";
import * as VcsStatusBroadcaster from "./vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "./workspace/WorkspaceEntries.ts";
import * as WorkspaceFolders from "./workspace/WorkspaceFolders.ts";
import * as LayoutCommandApprovalWrites from "./workspace/LayoutCommandApprovalWrites.ts";
import * as TaskFolders from "./workspace/TaskFolders.ts";
import * as WorkspaceFileSystem from "./workspace/WorkspaceFileSystem.ts";
import * as WorktreeSetupTracker from "./project/WorktreeSetupTracker.ts";
import * as ProjectFaviconResolver from "./project/ProjectFaviconResolver.ts";
import * as TraceDiagnostics from "./diagnostics/TraceDiagnostics.ts";
import * as TriageService from "./triage/TriageService.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfigModule from "./config.ts";
import * as Keybindings from "./keybindings.ts";
import * as ProviderInstallation from "./provider/providerInstallation.ts";
import * as FeatureFlags from "@t3tools/shared/FeatureFlags";
import * as ServerSettings from "./serverSettings.ts";
import { USAGE_LIMITS_COMMAND } from "@t3tools/shared/usageLimits";

import * as EventStore from "./orchestration-v2/EventStore.ts";
import * as ProjectionMaintenance from "./orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "./orchestration-v2/ThreadManagementService.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as OrchestrationEventStore from "./persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as ProjectEnrichment from "./project/ProjectEnrichmentService.ts";
import * as ProjectService from "./project/ProjectService.ts";
import {
  layerWsRpc,
  subscribeOrchestrationV2Shell,
  subscribeOrchestrationV2Thread,
  WS_RPC_SERVER_OPTIONS,
  withLateEditorConfig,
} from "./ws.ts";

const snapshotConfig = (fields: Partial<ServerConfig>) =>
  ({ availableEditors: [], settings: {}, ...fields }) as unknown as ServerConfig;

const settingsUpdated = (settings: object): ServerConfigStreamEvent => ({
  version: 1,
  type: "settingsUpdated",
  payload: { settings: settings as ServerConfig["settings"] },
});

it.effect("resends late editors without rolling back updates already sent", () =>
  Effect.gen(function* () {
    const settingsSent = yield* Deferred.make<void>();
    const events = yield* withLateEditorConfig(
      snapshotConfig({ settings: { enableProviderUpdateChecks: true } as never }),
      Stream.make(settingsUpdated({ enableProviderUpdateChecks: false })),
      {
        resolveAvailableEditors: () => Effect.succeed(["file-manager"]),
        resolveFileManagerRevealKind: () =>
          Deferred.await(settingsSent).pipe(Effect.as("file-explorer" as const)),
      },
    ).pipe(
      Stream.tap((event) =>
        event.type === "settingsUpdated" ? Deferred.succeed(settingsSent, undefined) : Effect.void,
      ),
      Stream.runCollect,
    );

    const [first, second] = Array.from(events);
    assert.equal(events.length, 2);
    assert.equal(first?.type, "settingsUpdated");
    assert.equal(second?.type, "snapshot");
    if (second?.type === "snapshot") {
      assert.deepEqual(second.config.availableEditors, ["file-manager"]);
      assert.equal(second.config.shellRevealInFileManagerKind, "file-explorer");
      assert.deepEqual(second.config.settings, { enableProviderUpdateChecks: false } as never);
    }
  }),
);

it.effect("resends a file manager reveal kind that missed the snapshot", () =>
  Effect.gen(function* () {
    const events = yield* withLateEditorConfig(
      snapshotConfig({ availableEditors: ["file-manager"] }),
      Stream.empty,
      {
        resolveAvailableEditors: () => Effect.succeed(["file-manager"]),
        resolveFileManagerRevealKind: () => Effect.succeed("file-explorer"),
      },
    ).pipe(Stream.runCollect);

    const [late] = Array.from(events);
    assert.equal(events.length, 1);
    assert.equal(late?.type, "snapshot");
    if (late?.type === "snapshot") {
      assert.equal(late.config.shellRevealInFileManagerKind, "file-explorer");
    }
  }),
);

const ReplayTestLayer = OrchestrationEventStore.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

it.live.each(["thread", "shell"] as const)(
  "%s resume skips unknown types, synchronizes, and receives the live tail",
  (scope) =>
    Effect.gen(function* () {
      const store = yield* OrchestrationEventStore.OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-05T00:00:00.000Z";
      const threadId = ThreadId.make("thread:replay");
      const projectId = ProjectId.make("project:replay");
      const project = {
        id: projectId,
        title: "Replay",
        workspaceRoot: "/tmp/replay",
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      } satisfies OrchestrationProjectShell;
      const insert = (version: number, unknown = false) => sql<{ sequence: number }>`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json, application_event_version
        ) VALUES (
          ${`replay:${version}`}, ${scope === "thread" ? "thread" : "project"},
          ${scope === "thread" ? threadId : projectId}, ${version},
          ${unknown ? "future.event" : scope === "thread" ? "provider-session.detached" : "project.meta-updated"},
          ${now}, 'server', ${JSON.stringify(
            scope === "thread"
              ? { providerSessionId: "session:replay", detachedAt: now }
              : { projectId, updatedAt: now },
          )}, '{}', 2
        ) RETURNING sequence
      `;
      const [before] = yield* insert(0);
      yield* insert(1, true);
      const [after] = yield* insert(2);
      const [highWater] = yield* insert(3, true);
      const updates = yield* PubSub.unbounded();
      let liveSequence = 0;
      const consume = <A extends { readonly kind: string; readonly sequence?: number }, E, R>(
        stream: Stream.Stream<A, E, R>,
      ) =>
        stream.pipe(
          Stream.tap((item) =>
            Effect.gen(function* () {
              if (item.kind !== "synchronized") return;
              const [live] = yield* insert(4);
              liveSequence = live!.sequence;
              const events = yield* store
                .readApplicationEvents({
                  afterSequence: highWater!.sequence,
                  throughSequence: liveSequence,
                })
                .pipe(Stream.runCollect);
              yield* store.publishCommitted(events);
            }),
          ),
          Stream.takeUntil((item) => item.sequence === liveSequence),
          Stream.map((item) => ({ kind: item.kind as string, sequence: item.sequence })),
          Stream.runCollect,
        );
      const subscription = Effect.gen(function* () {
        return scope === "thread"
          ? yield* subscribeOrchestrationV2Thread({
              threadId,
              afterSequence: before!.sequence,
              requestCompletionMarker: true,
            }).pipe(Effect.flatMap(consume))
          : yield* subscribeOrchestrationV2Shell({
              afterSequence: before!.sequence,
              requestCompletionMarker: true,
            }).pipe(Effect.flatMap(consume));
      });
      const items = yield* subscription.pipe(
        Effect.provideService(ThreadManagement.ThreadManagementService, {
          ensureLegacyTranscript: () => Effect.void,
          getShellSnapshot: () => Effect.die("shell resume must not load a full snapshot"),
          listActiveSubagentThreadIds: () => Effect.succeed([]),
          streamStoredEventsFrom: (
            input: Parameters<
              ThreadManagement.ThreadManagementService["Service"]["streamStoredEventsFrom"]
            >[0],
          ) => {
            assert.equal(input?.afterSequence, highWater!.sequence);
            return store
              .streamApplicationEvents({ afterSequence: input?.afterSequence ?? 0 })
              .pipe(
                Stream.filter((event): event is OrchestrationV2StoredEvent => "event" in event),
              );
          },
        } as unknown as ThreadManagement.ThreadManagementService["Service"]),
        Effect.provideService(ProjectStore.ProjectStoreV2, {
          listShells: () => Effect.succeed([]),
        } as unknown as ProjectStore.ProjectStoreV2["Service"]),
        Effect.provideService(ProjectService.ProjectService, {
          getShell: () => Effect.succeedSome(project),
        } as unknown as ProjectService.ProjectService["Service"]),
        Effect.provideService(ProjectEnrichment.ProjectEnrichmentService, {
          subscribeChanges: PubSub.subscribe(updates),
        } as ProjectEnrichment.ProjectEnrichmentService["Service"]),
      );
      assert.deepEqual(
        items.map((item) => item.kind),
        scope === "thread"
          ? ["event", "synchronized", "event"]
          : ["project.updated", "synchronized", "project.updated"],
      );
      assert.deepEqual(
        items.flatMap((item) => (item.sequence === undefined ? [] : [item.sequence])),
        [after!.sequence, liveSequence],
      );
    }).pipe(Effect.scoped, Effect.provide(ReplayTestLayer)),
);

it.effect("coalesces streaming replay before synchronization and the live tail", () =>
  Effect.gen(function* () {
    const store = yield* OrchestrationEventStore.OrchestrationEventStore;
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make("thread:streaming-replay");
    const now = "2026-10-27T00:00:00.000Z";
    const insert = (version: number, text: string, streaming: boolean) => sql<{
      sequence: number;
    }>`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type,
        occurred_at, actor_kind, payload_json, metadata_json, application_event_version
      ) VALUES (
        ${`streaming-replay:${version}`}, 'thread', ${threadId}, ${version}, 'message.updated',
        ${now}, 'server', ${JSON.stringify({
          createdBy: "agent",
          creationSource: "web",
          id: "message:streaming-replay",
          threadId,
          runId: null,
          nodeId: null,
          role: "assistant",
          text,
          attachments: [],
          streaming,
          createdAt: now,
          updatedAt: now,
        })}, '{}', 2
      ) RETURNING sequence
    `;
    yield* insert(0, "H", true);
    yield* insert(1, "He", true);
    const [latest] = yield* insert(2, "Hello", true);
    const [completed] = yield* insert(3, "Hello!", false);
    const items = yield* subscribeOrchestrationV2Thread({
      threadId,
      afterSequence: 0,
      requestCompletionMarker: true,
    }).pipe(
      Effect.flatMap(Stream.runCollect),
      Effect.provideService(ThreadManagement.ThreadManagementService, {
        ensureLegacyTranscript: () => Effect.void,
        streamStoredEventsFrom: () =>
          Stream.unwrap(
            insert(4, "Next", false).pipe(
              Effect.map(() =>
                store.readAgentEvents({ threadId, afterSequence: completed!.sequence }),
              ),
            ),
          ),
      } as unknown as ThreadManagement.ThreadManagementService["Service"]),
    );
    assert.deepEqual(
      items.map((item) =>
        item.kind === "event"
          ? [item.sequence, item.event.type === "message.updated" ? item.event.payload.text : null]
          : [item.kind],
      ),
      [
        [latest!.sequence, "Hello"],
        [completed!.sequence, "Hello!"],
        ["synchronized"],
        [completed!.sequence + 1, "Next"],
      ],
    );
  }).pipe(Effect.scoped, Effect.provide(ReplayTestLayer)),
);

it.effect("shell groups read distinct threads once and keep each event's own sequence", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = "2026-10-27T00:00:00.000Z";
    const insert = (aggregateKind: "thread" | "project", streamId: string, version: number) =>
      sql<{ sequence: number }>`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type,
        occurred_at, actor_kind, payload_json, metadata_json, application_event_version
      ) VALUES (
        ${`shell-group:${streamId}:${version}`}, ${aggregateKind}, ${streamId}, ${version},
        ${aggregateKind === "thread" ? "provider-session.detached" : "project.meta-updated"},
        ${now}, 'server', ${JSON.stringify(
          aggregateKind === "thread"
            ? { providerSessionId: "session:shell-group", detachedAt: now }
            : { projectId: streamId, updatedAt: now },
        )}, '{}', 2
      ) RETURNING sequence
    `.pipe(Effect.map(([row]) => row!.sequence));
    const shell = (id: string, archivedAt: string | null = null) =>
      ({ id: ThreadId.make(id), archivedAt }) as unknown as OrchestrationV2ThreadShell;
    const project = {
      id: ProjectId.make("project:group"),
    } as unknown as OrchestrationProjectShell;

    const after = yield* insert("project", "project:before", 0);
    yield* insert("thread", "thread:active", 0);
    const archived = yield* insert("thread", "thread:archived", 0);
    const projectUpdated = yield* insert("project", project.id, 0);
    const active = yield* insert("thread", "thread:active", 1);
    const missing = yield* insert("thread", "thread:missing", 0);

    const shellReads: Array<ReadonlyArray<string> | undefined> = [];
    let batchFails = false;
    const collect = (afterSequence: number) =>
      subscribeOrchestrationV2Shell({ afterSequence, requestCompletionMarker: true }).pipe(
        Effect.flatMap((stream) =>
          stream.pipe(
            Stream.takeUntil((item) => item.kind === "synchronized"),
            Stream.runCollect,
          ),
        ),
        Effect.provideService(ThreadManagement.ThreadManagementService, {
          listActiveSubagentThreadIds: () => Effect.succeed([]),
          getShellSnapshot: (options?: { readonly threadIds?: ReadonlyArray<string> }) =>
            Effect.suspend(() => {
              shellReads.push(options?.threadIds);
              return batchFails
                ? Effect.fail("batch failed")
                : Effect.succeed({
                    schemaVersion: 1,
                    snapshotSequence: Number.MAX_SAFE_INTEGER,
                    threads: [shell("thread:active")],
                    archivedThreads: [shell("thread:archived", now)],
                  });
            }),
          getThreadShell: (threadId: string) =>
            Effect.sync(() => {
              shellReads.push([`scalar:${threadId}`]);
              return threadId === "thread:missing"
                ? null
                : shell(threadId, threadId === "thread:archived" ? now : null);
            }),
        } as unknown as ThreadManagement.ThreadManagementService["Service"]),
        Effect.provideService(ProjectStore.ProjectStoreV2, {
          listShells: () => Effect.succeed([]),
        } as unknown as ProjectStore.ProjectStoreV2["Service"]),
        Effect.provideService(ProjectService.ProjectService, {
          getShell: () => Effect.succeedSome(project),
        } as unknown as ProjectService.ProjectService["Service"]),
        Effect.provideServiceEffect(
          ProjectEnrichment.ProjectEnrichmentService,
          PubSub.unbounded().pipe(
            Effect.map(
              (changes) =>
                ({
                  subscribeChanges: PubSub.subscribe(changes),
                }) as unknown as ProjectEnrichment.ProjectEnrichmentService["Service"],
            ),
          ),
        ),
      );

    const collectSummary = (afterSequence: number) =>
      collect(afterSequence).pipe(
        Effect.map((items) =>
          items.flatMap((item): ReadonlyArray<ReadonlyArray<string | number>> =>
            item.kind === "thread.updated"
              ? [[item.kind, item.sequence, item.thread.id]]
              : item.kind === "thread.removed"
                ? [[item.kind, item.sequence, item.threadId]]
                : item.kind === "project.updated"
                  ? [[item.kind, item.sequence, item.project.id]]
                  : [],
          ),
        ),
      );
    const expectedGroup = [
      ["thread.removed", archived, "thread:archived"],
      ["project.updated", projectUpdated, project.id],
      ["thread.updated", active, "thread:active"],
      ["thread.removed", missing, "thread:missing"],
    ];

    assert.deepEqual(yield* collectSummary(after), expectedGroup);
    assert.deepEqual(shellReads, [["thread:archived", "thread:active", "thread:missing"]]);

    shellReads.length = 0;
    assert.deepEqual(yield* collectSummary(active), [
      ["thread.removed", missing, "thread:missing"],
    ]);
    assert.deepEqual(shellReads, [["scalar:thread:missing"]]);

    shellReads.length = 0;
    batchFails = true;
    assert.deepEqual(yield* collectSummary(after), expectedGroup);
    assert.deepEqual(shellReads, [
      ["thread:archived", "thread:active", "thread:missing"],
      ["scalar:thread:archived"],
      ["scalar:thread:active"],
      ["scalar:thread:missing"],
    ]);
  }).pipe(Effect.scoped, Effect.provide(ReplayTestLayer)),
);

it.effect("shares each live event item across subscribers and dedupes bodies per subscriber", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:shared-live");
    const messageId = MessageId.make("message:shared-live");
    const at = DateTime.makeUnsafe("2026-10-31T00:00:00.000Z");
    const owner = { threadId, runId: null, nodeId: null, createdAt: at, updatedAt: at };
    const freeze = <A>(value: A): A => {
      if (typeof value === "object" && value !== null && !DateTime.isDateTime(value)) {
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
      }
      return value;
    };
    const live: ReadonlyArray<OrchestrationV2StoredEvent> = freeze([
      {
        sequence: 1,
        commandId: null,
        event: {
          id: EventId.make("event:shared-live:message"),
          type: "message.updated",
          threadId,
          occurredAt: at,
          payload: {
            ...owner,
            id: messageId,
            role: "assistant",
            text: "Done",
            attachments: [],
            streaming: false,
            createdBy: "agent",
            creationSource: "provider",
          },
        },
      },
      {
        sequence: 2,
        commandId: null,
        event: {
          id: EventId.make("event:shared-live:reply"),
          type: "turn-item.updated",
          threadId,
          occurredAt: at,
          payload: {
            ...owner,
            id: TurnItemId.make("item:shared-live:reply"),
            type: "assistant_message",
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            title: null,
            status: "completed",
            messageId,
            text: "Done",
            streaming: false,
            startedAt: at,
            completedAt: at,
          },
        },
      },
    ] as ReadonlyArray<OrchestrationV2StoredEvent>);
    const stringify = yield* Effect.acquireRelease(
      Effect.sync(() => vi.spyOn(JSON, "stringify")),
      (spy) => Effect.sync(() => spy.mockRestore()),
    );
    const subscribe = (acceptDedupedBodies: boolean) =>
      subscribeOrchestrationV2Thread({ threadId, afterSequence: 0, acceptDedupedBodies }).pipe(
        Effect.flatMap(Stream.runCollect),
        Effect.map((items) => Array.from(items)),
        Effect.provideService(ThreadManagement.ThreadManagementService, {
          ensureLegacyTranscript: () => Effect.void,
          streamStoredEventsFrom: () => Stream.fromIterable(live),
        } as unknown as ThreadManagement.ThreadManagementService["Service"]),
      );
    const [deduped, first, second] = yield* Effect.forEach([true, false, false], subscribe);

    assert.lengthOf(first!, live.length);
    first!.forEach((item, index) => {
      assert.strictEqual(item, second![index]);
      assert.strictEqual(item.kind === "event" && item.event, live[index]!.event);
    });
    assert.strictEqual(deduped![0], first![0]);
    const reply = deduped![1];
    assert.deepInclude(reply?.kind === "event" ? reply.event.payload : undefined, {
      text: "",
      textOmitted: true,
    });
    assert.lengthOf(
      stringify.mock.calls.filter(([value]) => value?.kind === "event"),
      live.length,
    );
  }).pipe(Effect.scoped, Effect.provide(ReplayTestLayer)),
);

it.effect("shell snapshots omit idle children and older settled threads only on request", () =>
  Effect.gen(function* () {
    const shell = (
      id: string,
      parent: string | null,
      activityRunStatus: "running" | null,
      settledDaysAgo: number | null = null,
    ) =>
      ({
        id: ThreadId.make(id),
        projectId: "project",
        archivedAt: null,
        status: activityRunStatus ?? "completed",
        activityRunStatus,
        pendingRuntimeRequest: null,
        pendingBackgroundTasks: [],
        settledOverride: settledDaysAgo === null ? null : "settled",
        settledAt:
          settledDaysAgo === null ? null : DateTime.makeUnsafe(-settledDaysAgo * 86_400_000),
        lineage: {
          parentThreadId: parent === null ? null : ThreadId.make(parent),
          relationshipToParent: parent === null ? null : "subagent",
          rootThreadId: ThreadId.make(parent ?? id),
        },
      }) as unknown as OrchestrationV2ThreadShell;
    const threads = [
      shell("parent", null, null),
      shell("idle", "parent", null),
      shell("live", "parent", "running"),
      ...Array.from({ length: 25 }, (_, index) => shell(`recent-${index}`, null, null, 1)),
      shell("old", null, null, 30),
    ];
    const firstSnapshot = (input: {
      readonly omitIdleSubagents?: boolean;
      readonly omitOlderSettled?: boolean;
    }) =>
      subscribeOrchestrationV2Shell(input).pipe(
        Effect.flatMap((stream) => stream.pipe(Stream.take(1), Stream.runCollect)),
        Effect.map(([item]) => (item?.kind === "snapshot" ? item.snapshot : null)),
        Effect.provideService(ThreadManagement.ThreadManagementService, {
          listActiveShellIndex: () =>
            Effect.succeed(
              threads.map((thread) => ({
                ...thread,
                pinnedAt: null,
                snoozedUntil: null,
                mayBeLive: thread.activityRunStatus !== null,
              })),
            ),
          readShellSnapshot: (options?: { readonly threadIds?: ReadonlyArray<string> }) =>
            Effect.succeed(
              Effect.succeed({
                schemaVersion: 1,
                snapshotSequence: 0,
                threads: threads.filter(
                  (thread) => options?.threadIds?.includes(thread.id) ?? true,
                ),
                archivedThreads: [],
              }),
            ),
        } as unknown as ThreadManagement.ThreadManagementService["Service"]),
        Effect.provideService(ProjectStore.ProjectStoreV2, {
          listShells: () => Effect.succeed([]),
        } as unknown as ProjectStore.ProjectStoreV2["Service"]),
        Effect.provideService(ProjectService.ProjectService, {
          getShell: () => Effect.succeedNone,
        } as unknown as ProjectService.ProjectService["Service"]),
        Effect.provideServiceEffect(
          ProjectEnrichment.ProjectEnrichmentService,
          PubSub.unbounded().pipe(
            Effect.map(
              (changes) =>
                ({
                  subscribeChanges: PubSub.subscribe(changes),
                }) as unknown as ProjectEnrichment.ProjectEnrichmentService["Service"],
            ),
          ),
        ),
      );

    const recent = threads.slice(3, 28).map((thread) => thread.id);
    const full = yield* firstSnapshot({});
    assert.deepEqual(
      full?.threads.map((thread) => thread.id),
      threads.map((thread) => thread.id),
    );
    assert.isUndefined(full?.olderSettled);
    const withoutChildren = yield* firstSnapshot({ omitIdleSubagents: true });
    assert.deepEqual(
      withoutChildren?.threads.map((thread) => thread.id),
      ["parent", "live", ...recent, "old"],
    );
    const withoutOld = yield* firstSnapshot({ omitIdleSubagents: true, omitOlderSettled: true });
    assert.deepEqual(
      withoutOld?.threads.map((thread) => thread.id),
      ["parent", "live", ...recent],
    );
    assert.deepEqual(withoutOld?.olderSettled?.counts, [
      { projectId: ProjectId.make("project"), count: 1 },
    ]);
  }).pipe(Effect.scoped, Effect.provide(ReplayTestLayer)),
);

// Build the production RPC layer; unrelated capabilities fail if this test calls them.
const layerUnusedConfigRpcServices = Layer.mergeAll(
  Layer.mock(DocumentText.DocumentText)({}),
  Layer.mock(ServerSecretStore.ServerSecretStore)({}),
  Layer.mock(WorkspacePaths.WorkspacePaths)({}),
  Layer.mock(TraceDiagnostics.TraceDiagnostics)({}),
  Layer.mock(TriageService.TriageService)({}),
  Layer.mock(ProjectFaviconResolver.ProjectFaviconResolver)({}),
  Layer.mock(ProjectEnrichment.ProjectEnrichmentService)({}),
  Layer.mock(AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator)({}),
  Layer.mock(AcpRegistrySupport.AcpRegistryCatalog)({}),
  Layer.mock(AgentSessionImporter.AgentSessionImporter)({}),
  Layer.mock(AgentSessionScanner.AgentSessionScanner)({}),
  Layer.mock(AnalyticsService.AnalyticsService)({}),
  Layer.mock(AntigravityInstallation.AntigravityInstallation)({ managedDirectory: "/unused" }),
  Layer.mock(BackgroundPolicy.BackgroundPolicy)({}),
  Layer.mock(CheckpointDiffQuery.CheckpointDiffQuery)({}),
  Layer.mock(CommandOutputHub.CommandOutputHub)({}),
  ThreadViewers.layer,
  Layer.mock(CodexInstallation.CodexInstallation)({ managedDirectory: "/unused" }),
  Layer.mock(EnvironmentTheme.EnvironmentThemeService)({}),
  Layer.mock(GitWorkflowService.GitWorkflowService)({}),
  Layer.mock(HostResources.HostResources)({}),
  Layer.mock(McpAppRequests.McpAppRequests)({}),
  Layer.mock(McpSignIn.McpSignIn)({}),
  Layer.mock(ModelManifest.ModelManifest)({}),
  Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({}),
  Layer.mock(Orchestrator.OrchestratorV2)({}),
  Layer.mock(OtlpEndpointCheck.OtlpEndpointCheck)({}),
  Layer.mock(PortScanner.PortDiscovery)({ trackAgent: () => () => undefined }),
  Layer.mock(PreviewManager.PreviewManager)({}),
  Layer.mock(ProcessDiagnostics.ProcessDiagnostics)({}),
  Layer.mock(ProcessResourceMonitor.ProcessResourceMonitor)({}),
  Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({}),
  Layer.mock(ProjectService.ProjectService)({ workspaceScanDirectory: Effect.succeed }),
  Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
  Layer.mock(ProjectStore.ProjectStoreV2)({}),
  Layer.mock(ProviderAuthService.ProviderAuthService)({}),
  Layer.mock(ProviderInstallation.ProviderInstallation)({}),
  Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({}),
  Layer.mock(ProviderLatestVersions.ProviderLatestVersions)({}),
  Layer.mock(ProviderMaintenanceRunner.ProviderMaintenanceRunner)({}),
  Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
  Layer.mock(PullRequestReviewGuideService.PullRequestReviewGuideService)({}),
  Layer.mock(PullRequestService.PullRequestService)({}),
  Layer.mock(PullRequestSyncReactor.PullRequestSyncReactor)({}),
  Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({}),
  Layer.mock(ResourceTelemetry.ResourceTelemetry)({}),
  Layer.mock(ReviewService.ReviewService)({}),
  Layer.mock(ScheduledTasks.ScheduledTaskService)({}),
  Workflows.layerDisabled,
  Layer.mock(WorkflowRuntime.WorkflowDefinitions)({}),
  Layer.mock(SecretRequests.SecretRequests)({}),
  Layer.mock(SecretResolver.SecretResolver)({}),
  Layer.mock(ServerLifecycleEvents.ServerLifecycleEvents)({}),
  Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({}),
  Layer.mock(SessionStore.SessionStore)({ cookieName: "config-test", legacyCookieName: undefined }),
  Layer.mock(SourceControlDiscovery.SourceControlDiscovery)({}),
  Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({}),
  Layer.mock(SourceControlSignIn.SourceControlSignIn)({}),
  Layer.mock(StorageCleanup.StorageCleanup)({}),
  Layer.mock(DatabaseStorage.DatabaseStorage)({}),
  Layer.mock(TerminalManager.TerminalManager)({}),
  Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
  Layer.mock(ThreadManagement.ThreadManagementService)({}),
  Layer.mock(ThreadSearch.ThreadSearch)({}),
  Layer.mock(UsageService.UsageService)({}),
  Layer.mock(VcsProvisioningService.VcsProvisioningService)({}),
  Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({}),
  Layer.mock(WorkspaceEntries.WorkspaceEntries)({}),
  Layer.mock(WorkspaceFolders.WorkspaceFolders)({}),
  Layer.mock(TaskFolders.TaskFolders)({}),
  Layer.mock(LayoutCommandApprovalWrites.LayoutCommandApprovalWrites)({}),
  Layer.mock(WorkspaceFileSystem.WorkspaceFileSystem)({}),
  Layer.mock(WorktreeSetupTracker.WorktreeSetupTracker)({}),
  FeatureFlags.layerTest(),
);

const layerConfigSources = Layer.mergeAll(
  Keybindings.layer,
  ServerSettings.layer.pipe(Layer.provide(ServerSecretStore.layer)),
  WorkspacePreviewRevisions.layer,
).pipe(
  Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
  Layer.provideMerge(
    Layer.fresh(
      ServerConfigModule.layerTest(process.cwd(), { prefix: "t3-config-subscription-test-" }),
    ),
  ),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

it.effect(
  "preserves settings during discovery and keybindings during snapshot ACK at the config RPC boundary",
  () =>
    Effect.gen(function* () {
      const keybindings = yield* Keybindings.Keybindings;
      const settings = yield* ServerSettings.ServerSettingsService;
      const keybindingsSubscribed = yield* Deferred.make<void>();
      const settingsSubscribed = yield* Deferred.make<void>();
      const keybindingsChanges = keybindings.subscribeChanges.pipe(
        Effect.tap(() => Deferred.succeed(keybindingsSubscribed, undefined)),
      );
      const settingsChanges = settings.subscribeChanges.pipe(
        Effect.tap(() => Deferred.succeed(settingsSubscribed, undefined)),
      );
      const initialKeybindings = (yield* keybindings.getSnapshot).keybindings;
      const discoveryStarted = yield* Deferred.make<void>();
      const finishDiscovery = yield* Deferred.make<void>();
      const responses = yield* Queue.unbounded<ServerConfigStreamEvent>();
      const configRpcServices = Layer.mergeAll(
        layerUnusedConfigRpcServices,
        Layer.mock(ExternalLauncher.ExternalLauncher)({
          resolveAvailableEditors: () =>
            Deferred.succeed(discoveryStarted, undefined).pipe(
              Effect.andThen(Deferred.await(finishDiscovery)),
              Effect.as([]),
            ),
          // @effect-diagnostics-next-line effectSucceedWithVoid:off - This optional result requires undefined, not the wider void type.
          resolveFileManagerRevealKind: () => Effect.succeed(undefined),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([]),
          streamChanges: Stream.never,
        }),
        Layer.mock(UsageLimitSources.UsageLimitSources)({ streamChanges: Stream.make([]) }),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          scratchRoot: Effect.succeedNone,
          namedProjectsRoot: process.cwd(),
        }),
        Layer.mock(ScratchThreadPromotion.ScratchThreadPromotion)({}),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getDescriptor: Effect.succeed({
            environmentId: EnvironmentId.make("config-test"),
            label: "Config test",
            platform: { os: "linux", arch: "x64" },
            serverVersion: "0.0.0",
            capabilities: { repositoryIdentity: false },
          }),
        }),
        Layer.mock(EnvironmentAuth.EnvironmentAuth)({
          getDescriptor: () =>
            Effect.succeed({
              policy: "loopback-browser",
              loginMode: "local",
              sessionMethods: ["browser-session-cookie"],
              sessionCookieName: "config-test-session",
            }),
        }),
        // Signal subscription on either accessor so the test also fails, rather
        // than hangs, against a handler that subscribes after the snapshot.
        Layer.succeed(Keybindings.Keybindings, {
          ...keybindings,
          streamChanges: Stream.unwrap(keybindingsChanges),
          subscribeChanges: keybindingsChanges,
        }),
        Layer.succeed(ServerSettings.ServerSettingsService, {
          ...settings,
          streamChanges: Stream.unwrap(settingsChanges),
          subscribeChanges: settingsChanges,
        }),
      );
      const server = yield* RpcServer.makeNoSerialization(
        RpcGroup.make(WsSubscribeServerConfigRpc),
        {
          ...WS_RPC_SERVER_OPTIONS,
          onFromServer: (response) =>
            response._tag === "Chunk"
              ? Effect.forEach(response.values, (event) => Queue.offer(responses, event), {
                  discard: true,
                })
              : Effect.void,
        },
      ).pipe(
        Effect.provide(
          layerWsRpc(
            {
              sessionId: AuthSessionId.make("config-test"),
              subject: "config-test",
              method: "browser-session-cookie",
              scopes: [],
            },
            {},
            yield* ServerBrowser.ServerBrowser,
            () => Effect.void,
          ).pipe(Layer.provide(configRpcServices)),
        ),
      );
      const requestId = RpcMessage.RequestId("config");
      const acknowledge = server.write(0, { _tag: "Ack", requestId });
      yield* server.write(0, {
        _tag: "Request",
        id: requestId,
        tag: WS_METHODS.subscribeServerConfig,
        payload: {},
        headers: Headers.empty,
      });
      yield* Deferred.await(discoveryStarted);

      const duringDiscovery = yield* settings.updateSettings({ defaultAutoPull: true });
      yield* Deferred.succeed(finishDiscovery, undefined);
      const snapshot = yield* Queue.take(responses);
      assert.equal(snapshot.type, "snapshot");
      if (snapshot.type !== "snapshot") return yield* Effect.die("Missing initial snapshot");
      assert.isFalse(snapshot.config.settings.defaultAutoPull);
      assert.deepEqual(snapshot.config.keybindings, initialKeybindings);
      const duringAck = yield* keybindings.upsertKeybindingRule({
        key: "mod+alt+y",
        command: "terminal.toggle",
      });
      yield* acknowledge;
      yield* Deferred.await(keybindingsSubscribed);
      yield* Deferred.await(settingsSubscribed);

      // Later updates expose a dropped buffered event as a value mismatch, not a timeout.
      const latestSettings = yield* settings.updateSettings({ enableProviderUpdateChecks: false });
      const latestKeybindings = yield* keybindings.upsertKeybindingRule({
        key: "mod+alt+z",
        command: "terminal.split",
      });
      const expectedSettings = [duringDiscovery, latestSettings].map((settings) =>
        ServerSettings.redactServerSettingsForClient(settings, false),
      );
      const expectedKeybindings = [duringAck, latestKeybindings];
      // The two sources can interleave, but each must retain its own publication order.
      for (let i = 0; i < 4; i++) {
        const event = yield* Queue.take(responses);
        if (event.type === "settingsUpdated") {
          assert.deepEqual(event.payload.settings, expectedSettings.shift());
        } else {
          assert.equal(event.type, "keybindingsUpdated");
          if (event.type !== "keybindingsUpdated")
            return yield* Effect.die("Unexpected config event");
          assert.deepEqual(event.payload.keybindings, expectedKeybindings.shift());
          assert.deepEqual(event.payload.issues, []);
        }
        yield* acknowledge;
      }
      assert.isEmpty(expectedSettings);
      assert.isEmpty(expectedKeybindings);
      yield* server.write(0, { _tag: "Interrupt", requestId, interruptors: [] });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.fresh(layerConfigSources),
          Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
          Layer.mock(ServerBrowser.ServerBrowser)({}),
        ),
      ),
      Effect.scoped,
    ),
);

it.effect("on-demand clients get provider config without workspace snapshots", () =>
  Effect.gen(function* () {
    const instanceId = ProviderInstanceId.make("claudeAgent");
    const snapshotFor = (cwd: string, checkedAt: string) => ({
      cwd,
      checkedAt,
      slashCommands: [{ name: `${cwd.slice(1)}-command` }],
      skills: [],
    });
    const provider: ServerProvider = {
      instanceId,
      driver: ProviderDriverKind.make("claudeAgent"),
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-10-25T00:00:00.000Z",
      models: [],
      slashCommands: [{ name: "machine-command", description: "A machine command" }],
      skills: [
        {
          name: "machine-skill",
          description: "Machine skill",
          path: "/skills/machine-skill",
          enabled: true,
        },
      ],
      workspaceSnapshots: [
        snapshotFor("/a", "2026-10-25T00:00:00.000Z"),
        snapshotFor("/b", "2026-10-25T00:00:00.000Z"),
      ],
    };
    let scansCwd = true;
    const providerChanges = yield* Queue.unbounded<ReadonlyArray<ServerProvider>>();
    const pulled = yield* Queue.unbounded<void>();
    const responses = yield* Queue.unbounded<unknown>();
    const configRpcServices = Layer.mergeAll(
      layerUnusedConfigRpcServices,
      Layer.mock(ExternalLauncher.ExternalLauncher)({
        resolveAvailableEditors: () => Effect.succeed([]),
        // @effect-diagnostics-next-line effectSucceedWithVoid:off - This optional result requires undefined, not the wider void type.
        resolveFileManagerRevealKind: () => Effect.succeed(undefined),
      }),
      Layer.mock(ProviderRegistry.ProviderRegistry)({
        getProviders: Effect.succeed([provider]),
        streamChanges: Stream.fromQueue(providerChanges).pipe(
          Stream.tap(() => Queue.offer(pulled, undefined)),
        ),
        refreshWorkspaceSnapshot: () => Effect.succeed([provider]),
      }),
      Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
        listInstances: Effect.sync(() => [
          (scansCwd
            ? { instanceId, snapshotForCwd: () => Effect.die("unused") }
            : { instanceId }) as never,
        ]),
        getInstance: () =>
          Effect.sync(
            () =>
              (scansCwd
                ? { instanceId, snapshotForCwd: () => Effect.die("unused") }
                : { instanceId }) as never,
          ),
      }),
      Layer.mock(UsageLimitSources.UsageLimitSources)({
        current: Effect.succeed([]),
        streamChanges: Stream.make([]),
      }),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        scratchRoot: Effect.succeedNone,
        namedProjectsRoot: process.cwd(),
      }),
      Layer.mock(ScratchThreadPromotion.ScratchThreadPromotion)({}),
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getDescriptor: Effect.succeed({
          environmentId: EnvironmentId.make("config-test"),
          label: "Config test",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "0.0.0",
          capabilities: { repositoryIdentity: false },
        }),
      }),
      Layer.mock(EnvironmentAuth.EnvironmentAuth)({
        getDescriptor: () =>
          Effect.succeed({
            policy: "loopback-browser",
            loginMode: "local",
            sessionMethods: ["browser-session-cookie"],
            sessionCookieName: "config-test-session",
          }),
      }),
    );
    const server = yield* RpcServer.makeNoSerialization(
      RpcGroup.make(WsSubscribeServerConfigRpc, WsServerRefreshProvidersRpc),
      {
        ...WS_RPC_SERVER_OPTIONS,
        onFromServer: (response) =>
          response._tag === "Chunk"
            ? Effect.forEach(response.values, (value) => Queue.offer(responses, value), {
                discard: true,
              })
            : response._tag === "Exit" && response.exit._tag === "Success"
              ? Queue.offer(responses, response.exit.value)
              : Effect.void,
      },
    ).pipe(
      Effect.provide(
        layerWsRpc(
          {
            sessionId: AuthSessionId.make("config-test"),
            subject: "config-test",
            method: "browser-session-cookie",
            scopes: [],
          },
          {},
          yield* ServerBrowser.ServerBrowser,
          () => Effect.void,
        ).pipe(Layer.provide(configRpcServices)),
      ),
    );
    const configRequest = RpcMessage.RequestId("config");
    yield* server.write(0, {
      _tag: "Request",
      id: configRequest,
      tag: WS_METHODS.subscribeServerConfig,
      payload: { workspaceSnapshotsOnDemand: true, providerCatalogsOnDemand: true },
      headers: Headers.empty,
    });
    const snapshot = (yield* Queue.take(responses)) as ServerConfigStreamEvent;
    if (snapshot.type !== "snapshot") return yield* Effect.die("Missing initial snapshot");
    assert.isUndefined(snapshot.config.providers[0]?.workspaceSnapshots);
    assert.deepEqual(snapshot.config.providers[0]?.slashCommands, [{ name: "machine-command" }]);
    assert.deepEqual(snapshot.config.providers[0]?.skills, [
      { name: "machine-skill", path: "/skills/machine-skill", enabled: true },
    ]);
    yield* server.write(0, { _tag: "Ack", requestId: configRequest });

    // A rescan that only touches a snapshot sends nothing; the next real change does.
    yield* Queue.offer(providerChanges, [
      { ...provider, workspaceSnapshots: [snapshotFor("/a", "2026-10-25T00:05:00.000Z")] },
    ]);
    yield* Queue.take(pulled);
    yield* TestClock.adjust("1 second");
    yield* Queue.offer(providerChanges, [
      {
        ...provider,
        status: "warning",
        slashCommands: [...provider.slashCommands, USAGE_LIMITS_COMMAND],
      },
    ]);
    yield* Queue.take(pulled);
    yield* TestClock.adjust("1 second");
    const update = (yield* Queue.take(responses)) as ServerConfigStreamEvent;
    if (update.type !== "providerStatuses") return yield* Effect.die("Expected provider update");
    assert.equal(update.payload.providers[0]?.status, "warning");
    assert.isUndefined(update.payload.providers[0]?.workspaceSnapshots);
    assert.deepEqual(update.payload.providers[0]?.slashCommands, [
      { name: "machine-command" },
      { name: USAGE_LIMITS_COMMAND.name },
    ]);
    yield* server.write(0, { _tag: "Ack", requestId: configRequest });
    scansCwd = false;
    yield* Queue.offer(providerChanges, [{ ...provider, status: "warning" }]);
    yield* Queue.take(pulled);
    yield* TestClock.adjust("1 second");
    const replaced = (yield* Queue.take(responses)) as ServerConfigStreamEvent;
    if (replaced.type !== "providerStatuses") return yield* Effect.die("Expected provider update");
    assert.deepEqual(replaced.payload.providers[0]?.slashCommands, provider.slashCommands);
    assert.deepEqual(replaced.payload.providers[0]?.skills, provider.skills);

    yield* server.write(0, {
      _tag: "Request",
      id: RpcMessage.RequestId("refresh"),
      tag: WS_METHODS.serverRefreshProviders,
      payload: { instanceId, cwd: "/b", workspaceSnapshotsOnDemand: true },
      headers: Headers.empty,
    });
    const refreshed = (yield* Queue.take(responses)) as {
      readonly providers: ReadonlyArray<ServerProvider>;
    };
    assert.deepEqual(
      refreshed.providers.map((entry) => [entry.workspaceSnapshots, entry.slashCommands]),
      [[[snapshotFor("/b", "2026-10-25T00:00:00.000Z")], []]],
    );
    scansCwd = true;
    yield* server.write(0, {
      _tag: "Request",
      id: RpcMessage.RequestId("refresh-failed-scan"),
      tag: WS_METHODS.serverRefreshProviders,
      payload: {
        instanceId,
        cwd: "/c",
        workspaceSnapshotsOnDemand: true,
        providerCatalogsOnDemand: true,
      },
      headers: Headers.empty,
    });
    const fallback = (yield* Queue.take(responses)) as {
      readonly providers: ReadonlyArray<ServerProvider>;
    };
    assert.deepEqual(fallback.providers[0]?.workspaceSnapshots, [
      {
        cwd: "/c",
        checkedAt: provider.checkedAt,
        slashCommands: provider.slashCommands,
        slashCommandsPending: true,
        skills: provider.skills,
      },
    ]);
    yield* server.write(0, { _tag: "Interrupt", requestId: configRequest, interruptors: [] });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.fresh(layerConfigSources),
        Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
        Layer.mock(ServerBrowser.ServerBrowser)({}),
      ),
    ),
    Effect.scoped,
  ),
);

// Compaction keeps the oldest and newest event per message, so a cursor older
// than the deleted rows still replays each message where the client would
// first have seen it (reducers append on first sight) and reaches the same
// final state. No snapshot fallback is needed.
it.effect("thread resume replays a deleted thread's deletion and nothing recorded before it", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = "2026-10-13T00:00:00.000Z";
    const threadId = ThreadId.make("thread:deleted-resume");
    const insert = (version: number, type: string, payload: object) => sql`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type,
        occurred_at, actor_kind, payload_json, metadata_json, application_event_version
      ) VALUES (
        ${`deleted-resume:${version}`}, 'thread', ${threadId}, ${version}, ${type},
        ${now}, 'server', ${JSON.stringify(payload)}, '{}', 2
      )
    `;
    const detached = { providerSessionId: "session:deleted-resume", detachedAt: now };
    yield* insert(0, "provider-session.detached", detached);
    yield* insert(1, "provider-session.detached", detached);
    yield* insert(2, "thread.deleted", {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: "project:deleted-resume",
      title: "Deleted",
      providerInstanceId: "codex",
      modelSelection: { instanceId: "codex", model: "default" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      deletedAt: now,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
    });

    const items = yield* subscribeOrchestrationV2Thread({ threadId, afterSequence: 0 }).pipe(
      Effect.flatMap(Stream.runCollect),
      Effect.provideService(ThreadManagement.ThreadManagementService, {
        ensureLegacyTranscript: () => Effect.void,
        streamStoredEventsFrom: () => Stream.empty,
      } as unknown as ThreadManagement.ThreadManagementService["Service"]),
    );
    assert.deepEqual(
      Array.from(items).map((item) => item.kind === "event" && item.event.type),
      ["thread.deleted"],
    );
  }).pipe(Effect.scoped, Effect.provide(ReplayTestLayer)),
);

it.effect("thread resume across compacted history keeps message order and final state", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const now = "2026-10-13T00:00:00.000Z";
    const threadId = ThreadId.make("thread:compacted");
    const insertMessage = (version: number, id: string, text: string) => sql<{
      sequence: number;
    }>`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type,
        occurred_at, actor_kind, payload_json, metadata_json, application_event_version
      ) VALUES (
        ${`compacted:${version}`}, 'thread', ${threadId}, ${version}, 'message.updated',
        ${now}, 'server', ${JSON.stringify({
          createdBy: "user",
          creationSource: "web",
          id,
          threadId,
          runId: null,
          nodeId: null,
          role: "user",
          text,
          attachments: [],
          streaming: false,
          createdAt: now,
          updatedAt: now,
        })}, '{}', 2
      ) RETURNING sequence
    `;
    const [first] = yield* insertMessage(0, "message:a", "a created");
    const [second] = yield* insertMessage(1, "message:b", "b created");
    yield* insertMessage(2, "message:a", "a superseded");
    const [head] = yield* insertMessage(3, "message:a", "a final");
    // thread.deleted is never superseded: clients switch on the event type.
    for (const version of [0, 1]) {
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json, application_event_version
        ) VALUES (
          ${`deleted:${version}`}, 'thread', 'thread:deleted-twice', ${version}, 'thread.deleted',
          ${now}, 'server', '{}', '{}', 2
        )
      `;
    }
    assert.equal((yield* maintenance.compactEventStore()).deletedEventCount, 1);

    const items = yield* subscribeOrchestrationV2Thread({
      threadId,
      afterSequence: first!.sequence - 1,
      requestCompletionMarker: true,
    }).pipe(
      Effect.flatMap((stream) =>
        stream.pipe(
          Stream.takeUntil((item) => item.kind === "synchronized"),
          Stream.runCollect,
        ),
      ),
      Effect.provideService(ThreadManagement.ThreadManagementService, {
        ensureLegacyTranscript: () => Effect.void,
        streamStoredEventsFrom: () => Stream.never,
      } as unknown as ThreadManagement.ThreadManagementService["Service"]),
    );
    assert.deepEqual(
      Array.from(items, (item) =>
        item.kind === "event"
          ? [item.sequence, item.event.type === "message.updated" ? item.event.payload.text : null]
          : [item.kind],
      ),
      [
        [first!.sequence, "a created"],
        [second!.sequence, "b created"],
        [head!.sequence, "a final"],
        ["synchronized"],
      ],
    );
  }).pipe(
    Effect.provide(
      ProjectionMaintenance.layer.pipe(
        Layer.provide(Layer.merge(EventStore.layer, ProjectionStore.layer)),
        Layer.provideMerge(ReplayTestLayer),
      ),
    ),
  ),
);
it.effect("access changes made while the snapshot loads reach the client after it", () =>
  Effect.gen(function* () {
    const sessionChanges = yield* PubSub.unbounded<SessionStore.SessionCredentialChange>();
    const subscribed = yield* Queue.unbounded<void>();
    const subscribe = <A>(changes: PubSub.PubSub<A>) =>
      Stream.unwrap(
        PubSub.subscribe(changes).pipe(
          Effect.tap(() => Queue.offer(subscribed, undefined)),
          Effect.map(Stream.fromSubscription),
        ),
      );
    const revokedElsewhere = AuthSessionId.make("revoked-elsewhere");
    const responses = yield* Queue.unbounded<AuthAccessStreamEvent>();
    const server = yield* RpcServer.makeNoSerialization(WsRpcGroup, {
      ...WS_RPC_SERVER_OPTIONS,
      onFromServer: (response) =>
        response._tag === "Chunk"
          ? Effect.forEach(
              response.values,
              (event) => Queue.offer(responses, event as AuthAccessStreamEvent),
              {
                discard: true,
              },
            )
          : Effect.void,
    }).pipe(
      Effect.provide(
        layerWsRpc(
          {
            sessionId: AuthSessionId.make("current"),
            subject: "current",
            method: "browser-session-cookie",
            scopes: [],
          },
          {},
          yield* ServerBrowser.ServerBrowser,
          () => Effect.void,
        ).pipe(
          Layer.provide(
            Layer.mergeAll(
              layerUnusedConfigRpcServices,
              Layer.mock(ExternalLauncher.ExternalLauncher)({}),
              Layer.mock(ProviderRegistry.ProviderRegistry)({}),
              Layer.mock(UsageLimitSources.UsageLimitSources)({}),
              Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
                namedProjectsRoot: "/unused",
              }),
              Layer.mock(ScratchThreadPromotion.ScratchThreadPromotion)({}),
              Layer.mock(ServerEnvironment.ServerEnvironment)({}),
              Layer.mock(EnvironmentAuth.EnvironmentAuth)({
                listClientSessions: () =>
                  PubSub.publish(sessionChanges, {
                    type: "clientRemoved",
                    sessionId: revokedElsewhere,
                  }).pipe(Effect.as([])),
              }),
              Layer.mock(SessionStore.SessionStore)({
                cookieName: "auth-access-test",
                legacyCookieName: undefined,
                streamChanges: subscribe(sessionChanges),
              }),
            ),
          ),
          Layer.merge(RpcAuthorization.layer([AuthAccessReadScope])),
        ),
      ),
    );
    const requestId = RpcMessage.RequestId("auth-access");
    yield* server.write(0, {
      _tag: "Request",
      id: requestId,
      tag: WS_METHODS.subscribeAuthAccess,
      payload: {},
      headers: Headers.empty,
    });
    const snapshot = yield* Queue.take(responses);
    assert.equal(snapshot.type, "snapshot");
    yield* server.write(0, { _tag: "Ack", requestId });
    yield* Queue.take(subscribed);

    yield* PubSub.publish(sessionChanges, {
      type: "clientRemoved",
      sessionId: AuthSessionId.make("later"),
    });
    const next = yield* Queue.take(responses);
    assert.deepEqual(next, {
      version: 1,
      revision: 2,
      type: "clientRemoved",
      payload: { sessionId: revokedElsewhere },
    });
    yield* server.write(0, { _tag: "Interrupt", requestId, interruptors: [] });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.fresh(layerConfigSources),
        Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
        Layer.mock(ServerBrowser.ServerBrowser)({}),
      ),
    ),
    Effect.scoped,
  ),
);

const workflowTags = [
  WS_METHODS.workflowsGet,
  WS_METHODS.workflowsAnswer,
  WS_METHODS.workflowsResume,
  WS_METHODS.workflowsCancel,
] as const;
const workflowRpcs = WsRpcGroup.omit(
  ...[...WsRpcGroup.requests.keys()].filter(
    (
      tag,
    ): tag is Exclude<
      keyof typeof RpcAuthorization.RPC_REQUIRED_SCOPES,
      (typeof workflowTags)[number]
    > => !(workflowTags as ReadonlyArray<string>).includes(tag),
  ),
);
const workflowRun: WorkflowRun = {
  runId: "run-1",
  workflow: "release",
  version: 1,
  title: "Release 1.2",
  status: "paused",
  detail: "build failed: exit 1",
  result: null,
  pauses: 1,
  retired: false,
  resumesAt: null,
  parentRunId: null,
  parentStep: null,
  startedAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:01:00.000Z",
  endedAt: null,
};
const workflowStep: WorkflowStep = {
  name: "build",
  kind: "step",
  status: "failed",
  attempts: 2,
  detail: "exit 1",
  threadId: null,
  environmentId: null,
  result: null,
  said: null,
  startedAt: "2026-11-01T00:00:10.000Z",
  endedAt: "2026-11-01T00:01:00.000Z",
};

/** A client for the workflow RPCs whose session holds `scopes`; `calls` records what reached the service. */
const makeWorkflowClient = Effect.fn("test.makeWorkflowClient")(function* (
  scopes: ReadonlyArray<AuthEnvironmentScope>,
  calls: Array<unknown>,
) {
  const services = Layer.mergeAll(
    layerUnusedConfigRpcServices,
    Layer.mock(ExternalLauncher.ExternalLauncher)({}),
    Layer.mock(ProviderRegistry.ProviderRegistry)({}),
    Layer.mock(UsageLimitSources.UsageLimitSources)({}),
    Layer.mock(ScratchThreadPromotion.ScratchThreadPromotion)({}),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/unused" }),
    Layer.mock(ServerEnvironment.ServerEnvironment)({}),
    Layer.mock(EnvironmentAuth.EnvironmentAuth)({
      // Another client's session beside this one: the answer names only the one that sent it.
      listClientSessions: () =>
        Effect.succeed([
          { current: false, client: { label: "Desktop", deviceType: "desktop" } },
          { current: true, client: { label: "Pixel 9", deviceType: "mobile" } },
        ] as never),
    }),
    Layer.mock(Workflows.Workflows)({
      get: (runId) =>
        runId === workflowRun.runId
          ? Effect.succeed({ run: workflowRun, steps: [workflowStep], references: [] })
          : Effect.fail(new Workflows.WorkflowRunNotFoundError({ runId })),
      answer: (runId, name, value, answeredBy) =>
        Effect.sync(() => calls.push({ answer: [runId, name], value, answeredBy })),
      resume: (runId) => Effect.sync(() => calls.push({ resume: runId })),
      cancel: (runId, reason) => Effect.sync(() => calls.push({ cancel: runId, reason })),
    }),
  );
  return yield* RpcTest.makeClient(workflowRpcs).pipe(
    Effect.provide(
      layerWsRpc(
        {
          sessionId: AuthSessionId.make("workflow-test"),
          subject: "workflow-test",
          method: "browser-session-cookie",
          scopes: [...scopes],
        },
        {},
        yield* ServerBrowser.ServerBrowser,
        () => Effect.void,
      ).pipe(Layer.provide(services), Layer.merge(RpcAuthorization.layer(scopes))),
    ),
  );
});
const layerWorkflowRpcTest = Layer.mergeAll(
  Layer.fresh(layerConfigSources),
  Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
  Layer.mock(ServerBrowser.ServerBrowser)({}),
);

it.effect(
  "worktree requests run a project's layout commands only for a session that may run commands",
  () =>
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const requested = Effect.fnUntraced(function* (scopes: ReadonlyArray<AuthEnvironmentScope>) {
        const seen: TaskFolders.ProjectCommandsNow[] = [];
        const exits = yield* Queue.unbounded<string>();
        const services = Layer.mergeAll(
          layerUnusedConfigRpcServices,
          Layer.mock(TaskFolders.TaskFolders)({
            createForProjectFolder: (_input, options) =>
              Effect.sync(() => seen.push(options.projectCommands)).pipe(
                Effect.as({ worktree: { path: "/repo-worktrees/feature", refName: "feature" } }),
              ),
            removeIfTaskFolder: (input) =>
              Effect.sync(() => seen.push(input.projectCommands)).pipe(Effect.as(true)),
          }),
          Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
            refreshStatus: () => Effect.die("unused status"),
            refreshLocalStatus: () => Effect.die("unused local status"),
          }),
          Layer.mock(ExternalLauncher.ExternalLauncher)({}),
          Layer.mock(ProviderRegistry.ProviderRegistry)({}),
          Layer.mock(UsageLimitSources.UsageLimitSources)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/unused" }),
          Layer.mock(ScratchThreadPromotion.ScratchThreadPromotion)({}),
          Layer.mock(ServerEnvironment.ServerEnvironment)({}),
          Layer.mock(EnvironmentAuth.EnvironmentAuth)({}),
        );
        const server = yield* RpcServer.makeNoSerialization(WsRpcGroup, {
          ...WS_RPC_SERVER_OPTIONS,
          onFromServer: (response) =>
            response._tag === "Exit" ? Queue.offer(exits, response.exit._tag) : Effect.void,
        }).pipe(
          Effect.provide(
            layerWsRpc(
              {
                sessionId: AuthSessionId.make("worktree-test"),
                subject: "worktree-test",
                method: "browser-session-cookie",
                scopes: [...scopes],
              },
              {},
              browser,
              () => Effect.void,
            ).pipe(Layer.provide(services), Layer.merge(RpcAuthorization.layer(scopes))),
          ),
        );
        yield* server.write(0, {
          _tag: "Request",
          id: RpcMessage.RequestId("create"),
          tag: WS_METHODS.vcsCreateWorktree,
          payload: { cwd: "/repo", refName: "main", newRefName: "feature", path: null },
          headers: Headers.empty,
        });
        assert.equal(yield* Queue.take(exits), "Success");
        yield* server.write(0, {
          _tag: "Request",
          id: RpcMessage.RequestId("remove"),
          tag: WS_METHODS.vcsRemoveWorktree,
          payload: { cwd: "/repo", path: "/repo-worktrees/feature" },
          headers: Headers.empty,
        });
        assert.equal(yield* Queue.take(exits), "Success");
        return seen;
      }, Effect.scoped);

      assert.deepEqual(yield* requested([AuthSourceControlWriteScope]), [
        "request-not-permitted",
        "request-not-permitted",
      ]);
      assert.deepEqual(
        yield* requested([AuthSourceControlWriteScope, AuthOrchestrationOperateScope]),
        ["permitted", "permitted"],
      );
      assert.deepEqual(yield* requested([AuthSourceControlWriteScope, AuthTerminalOperateScope]), [
        "permitted",
        "permitted",
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.fresh(layerConfigSources),
          Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
          Layer.mock(ServerBrowser.ServerBrowser)({}),
        ),
      ),
    ),
);

it.effect(
  "a project's layout command is approved only from a session that may use the terminal",
  () =>
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const projectId = ProjectId.make("project:layout");
      const approval = { kind: "create", command: "make worktree" } as const;
      const requested = Effect.fnUntraced(function* (scopes: ReadonlyArray<AuthEnvironmentScope>) {
        const recorded: unknown[] = [];
        const exits = yield* Queue.unbounded<string>();
        const services = Layer.mergeAll(
          layerUnusedConfigRpcServices,
          Layer.mock(TaskFolders.TaskFolders)({
            layoutCommands: () => Effect.succeed({ commands: [{ ...approval, approved: true }] }),
          }),
          Layer.mock(LayoutCommandApprovalWrites.LayoutCommandApprovalWrites)({
            set: (input) => Effect.sync(() => void recorded.push(input)),
          }),
          Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({}),
          Layer.mock(ExternalLauncher.ExternalLauncher)({}),
          Layer.mock(ProviderRegistry.ProviderRegistry)({}),
          Layer.mock(UsageLimitSources.UsageLimitSources)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/unused" }),
          Layer.mock(ScratchThreadPromotion.ScratchThreadPromotion)({}),
          Layer.mock(ServerEnvironment.ServerEnvironment)({}),
          Layer.mock(EnvironmentAuth.EnvironmentAuth)({}),
        );
        const server = yield* RpcServer.makeNoSerialization(WsRpcGroup, {
          ...WS_RPC_SERVER_OPTIONS,
          onFromServer: (response) =>
            response._tag === "Exit" ? Queue.offer(exits, response.exit._tag) : Effect.void,
        }).pipe(
          Effect.provide(
            layerWsRpc(
              {
                sessionId: AuthSessionId.make("layout-test"),
                subject: "layout-test",
                method: "browser-session-cookie",
                scopes: [...scopes],
              },
              {},
              browser,
              () => Effect.void,
            ).pipe(Layer.provide(services), Layer.merge(RpcAuthorization.layer(scopes))),
          ),
        );
        yield* server.write(0, {
          _tag: "Request",
          id: RpcMessage.RequestId("approve"),
          tag: WS_METHODS.workspaceApproveLayoutCommands,
          payload: { projectId, approvals: [approval] },
          headers: Headers.empty,
        });
        return { exit: yield* Queue.take(exits), recorded };
      }, Effect.scoped);

      // Everything the broadest agent session holds, and every other scope short of the terminal.
      assert.deepEqual(yield* requested(mcpClientScopes("full-access")), {
        exit: "Failure",
        recorded: [],
      });
      assert.deepEqual(
        yield* requested(
          AuthEnvironmentScope.literals.filter((scope) => scope !== AuthTerminalOperateScope),
        ),
        { exit: "Failure", recorded: [] },
      );
      assert.deepEqual(yield* requested([AuthTerminalOperateScope]), {
        exit: "Success",
        recorded: [{ projectId, ...approval }],
      });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.fresh(layerConfigSources),
          Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
          Layer.mock(ServerBrowser.ServerBrowser)({}),
        ),
      ),
    ),
);

it.effect("workflow RPCs read a run and pass an answer, a resume and a cancel to the service", () =>
  Effect.gen(function* () {
    const calls: Array<unknown> = [];
    const client = yield* makeWorkflowClient(
      [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
      calls,
    );

    assert.deepEqual(yield* client[WS_METHODS.workflowsGet]({ runId: "run-1" }), {
      run: workflowRun,
      steps: [workflowStep],
      references: [],
    });
    const missing = yield* client[WS_METHODS.workflowsGet]({ runId: "gone" }).pipe(Effect.flip);
    assert.deepEqual(
      [missing._tag, missing.message],
      ["WorkflowRequestError", "Workflow run gone was not found."],
    );

    yield* client[WS_METHODS.workflowsAnswer]({
      runId: "run-1",
      name: "approve",
      choice: "yes",
      reason: "Looks good",
    });
    yield* client[WS_METHODS.workflowsAnswer]({ runId: "run-1", name: "approve", choice: "no" });
    yield* client[WS_METHODS.workflowsResume]({ runId: "run-1" });
    yield* client[WS_METHODS.workflowsCancel]({ runId: "run-1" });
    yield* client[WS_METHODS.workflowsCancel]({ runId: "run-1", reason: "Wrong branch" });

    assert.deepEqual(calls, [
      {
        answer: ["run-1", "approve"],
        value: { choice: "yes", reason: "Looks good" },
        answeredBy: { label: "Pixel 9", sessionId: "workflow-test" },
      },
      {
        answer: ["run-1", "approve"],
        value: { choice: "no" },
        answeredBy: { label: "Pixel 9", sessionId: "workflow-test" },
      },
      { resume: "run-1" },
      { cancel: "run-1", reason: undefined },
      { cancel: "run-1", reason: "Wrong branch" },
    ]);
  }).pipe(Effect.provide(layerWorkflowRpcTest), Effect.scoped),
);

it.effect("a session that can only read sees a workflow run but cannot steer it", () =>
  Effect.gen(function* () {
    const calls: Array<unknown> = [];
    const client = yield* makeWorkflowClient([AuthOrchestrationReadScope], calls);

    assert.equal((yield* client[WS_METHODS.workflowsGet]({ runId: "run-1" })).run.runId, "run-1");
    const refused = yield* Effect.all([
      client[WS_METHODS.workflowsAnswer]({ runId: "run-1", name: "approve", choice: "yes" }).pipe(
        Effect.flip,
      ),
      client[WS_METHODS.workflowsResume]({ runId: "run-1" }).pipe(Effect.flip),
      client[WS_METHODS.workflowsCancel]({ runId: "run-1" }).pipe(Effect.flip),
    ]);
    assert.deepEqual(
      refused.map((error) => error._tag),
      Array.from({ length: 3 }, () => "EnvironmentAuthorizationError"),
    );
    assert.deepEqual(calls, []);
  }).pipe(Effect.provide(layerWorkflowRpcTest), Effect.scoped),
);

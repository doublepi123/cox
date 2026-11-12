import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type Project,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { McpSchema, McpServer } from "effect/ai";

import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import { OrchestratorDispatchError } from "../orchestration-v2/Orchestrator.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Schedules from "../scheduledTasks/ScheduledTaskService.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as Invocation from "./McpInvocationContext.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";
import * as Move from "./ThreadProjectMoveMcpService.ts";
import { ThreadToolkit } from "./toolkits/thread/tools.ts";
import * as Handlers from "./toolkits/thread/handlers.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import { advertisedJsonSchema } from "./advertisedJsonSchema.ts";

const threadId = ThreadId.make("move-thread");
const targetId = ProjectId.make("target-project");
const initialShell = liveThreadShell(threadId);
const sourceId = initialShell.projectId;
const scope: Invocation.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "original-session",
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
  thread: {
    threadId,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerSessionId: "original-session",
  },
  client: undefined,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "move-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "move-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

function harness(
  options: {
    readonly shell?: OrchestrationV2ThreadShell | null;
    readonly projectMissing?: boolean;
    readonly rejectDispatch?: boolean;
  } = {},
) {
  let shell = options.shell === undefined ? initialShell : options.shell;
  const commands: Array<OrchestrationV2ServerCommand> = [];
  const receipts = new Set<string>();
  const project = { id: targetId, workspaceRoot: "/projects/target" } as Project;
  const layer = Layer.mergeAll(
    NodeCrypto.layer,
    Layer.mock(Threads.ThreadManagementService)({
      getThreadShell: () => Effect.succeed(shell),
      hasReceipt: (id) => Effect.succeed(receipts.has(id)),
      getThreadRecords: () =>
        Effect.succeed({
          runs:
            shell?.activeRunId == null
              ? []
              : [
                  {
                    id: shell.activeRunId,
                    providerThreadId: ProviderThreadId.make("provider-thread"),
                    providerInstanceId: initialShell.providerInstanceId,
                  },
                ],
          providerThreads: [
            {
              id: ProviderThreadId.make("provider-thread"),
              providerSessionId: ProviderSessionId.make("runtime-session"),
            },
          ],
        } as never),
      dispatch: (command) =>
        Effect.gen(function* () {
          commands.push(command);
          if (options.rejectDispatch) {
            return yield* new OrchestratorDispatchError({
              commandId: command.commandId,
              commandType: command.type,
              cause: "The thread still has work in progress.",
            });
          }
          if (receipts.has(command.commandId)) {
            return { sequence: 5, storedEvents: [], replayed: true };
          }
          receipts.add(command.commandId);
          if (
            shell !== null &&
            (command.type === "thread.project.move-agent" || command.type === "thread.project.move")
          ) {
            shell = { ...shell, projectId: command.projectId, branch: null, worktreePath: null };
          }
          return { sequence: 5, storedEvents: [] };
        }),
    }),
    Layer.mock(Projects.ProjectService)({
      getById: () => Effect.succeed(options.projectMissing ? Option.none() : Option.some(project)),
    }),
    Layer.mock(ThreadSearch.ThreadSearch)({}),
    Layer.mock(Schedules.ScheduledTaskService)({}),
  );
  return {
    layer,
    commands,
    setShell: (value: OrchestrationV2ThreadShell) => {
      shell = value;
    },
  };
}

it.effect("moves the caller through the owned active-run command", () => {
  const test = harness();
  return Effect.gen(function* () {
    const service = yield* Move.ThreadProjectMoveMcpService;
    const result = yield* service.move(scope, {
      projectId: targetId,
      clientRequestId: "move-1",
      continuationPrompt: "Continue the work.",
    });
    expect(result).toMatchObject({
      threadId,
      projectId: targetId,
      workspaceRoot: "/projects/target",
      agent: "restart_scheduled",
    });
    expect(test.commands[0]).toMatchObject({
      type: "thread.project.move-agent",
      threadId,
      projectId: targetId,
      expectedProjectId: sourceId,
      runId: initialShell.activeRunId,
      providerSessionId: "runtime-session",
      continuationPrompt: "Continue the work.",
    });
  }).pipe(Effect.provide(Move.layer.pipe(Layer.provide(test.layer))));
});

it.effect("reuses a move receipt after the provider credential rotates without moving back", () => {
  const test = harness();
  return Effect.gen(function* () {
    const service = yield* Move.ThreadProjectMoveMcpService;
    const input = { projectId: targetId, expectedProjectId: sourceId, clientRequestId: "move-1" };
    yield* service.move(scope, input);
    test.setShell({ ...initialShell, projectId: targetId, activeRunId: RunId.make("new-run") });
    yield* service.move(
      {
        ...scope,
        requestNamespace: "replacement-session",
        thread: { ...scope.thread!, providerSessionId: "replacement-session" },
      },
      input,
    );
    expect(test.commands).toHaveLength(2);
    expect(test.commands[0]?.commandId).toBe(test.commands[1]?.commandId);
  }).pipe(Effect.provide(Move.layer.pipe(Layer.provide(test.layer))));
});

it.effect("moves idle targets with the same command as the UI", () => {
  const otherId = ThreadId.make("idle-target");
  const test = harness({ shell: { ...initialShell, id: otherId, activeRunId: null } });
  return Effect.gen(function* () {
    const service = yield* Move.ThreadProjectMoveMcpService;
    const result = yield* service.move(scope, { threadId: otherId, projectId: targetId });
    expect(test.commands[0]).toMatchObject({
      type: "thread.project.move",
      threadId: otherId,
      expectedProjectId: sourceId,
    });
    expect(result.agent).toBe("refresh_on_next_turn");
  }).pipe(Effect.provide(Move.layer.pipe(Layer.provide(test.layer))));
});

it.effect(
  "does not dispatch or detach an agent for missing destinations, missing threads or denied capabilities",
  () => {
    const test = harness({ projectMissing: true });
    return Effect.gen(function* () {
      const service = yield* Move.ThreadProjectMoveMcpService;
      expect((yield* service.move(scope, { projectId: targetId }).pipe(Effect.flip)).code).toBe(
        "invalid_request",
      );
      expect(
        (yield* service
          .move({ ...scope, capabilities: new Set() }, { projectId: targetId })
          .pipe(Effect.flip)).code,
      ).toBe("capability_denied");
      expect(
        (yield* service
          .move({ ...scope, thread: { ...scope.thread!, subagent: true } }, { projectId: targetId })
          .pipe(Effect.flip)).code,
      ).toBe("capability_denied");
      expect(
        (yield* service
          .move({ ...scope, thread: undefined }, { projectId: targetId })
          .pipe(Effect.flip)).code,
      ).toBe("target_required");
      expect(test.commands).toHaveLength(0);
    }).pipe(Effect.provide(Move.layer.pipe(Layer.provide(test.layer))));
  },
);

it.effect("reports a no-op without restarting when already in the destination", () => {
  const test = harness({ shell: { ...initialShell, projectId: targetId } });
  return Effect.gen(function* () {
    const service = yield* Move.ThreadProjectMoveMcpService;
    expect((yield* service.move(scope, { projectId: targetId })).agent).toBe("unchanged");
    expect(
      (yield* service
        .move(scope, { projectId: targetId, expectedProjectId: sourceId })
        .pipe(Effect.flip)).code,
    ).toBe("invalid_request");
    expect(test.commands).toHaveLength(0);
  }).pipe(Effect.provide(Move.layer.pipe(Layer.provide(test.layer))));
});

it.effect("reports busy or stale moves without attempting a separate interruption", () => {
  const test = harness({ rejectDispatch: true });
  return Effect.gen(function* () {
    const service = yield* Move.ThreadProjectMoveMcpService;
    expect(
      (yield* service.move(scope, { projectId: targetId }).pipe(Effect.flip)).message,
    ).toContain("work in progress");
    expect(test.commands).toHaveLength(1);
    expect(test.commands[0]?.type).toBe("thread.project.move-agent");
  }).pipe(Effect.provide(Move.layer.pipe(Layer.provide(test.layer))));
});

it.effect("rejects missing threads and continuation prompts targeting another conversation", () => {
  const missing = harness({ shell: null });
  const other = harness({
    shell: { ...initialShell, id: ThreadId.make("other-thread"), activeRunId: null },
  });
  return Effect.gen(function* () {
    const missingResult = yield* Move.ThreadProjectMoveMcpService.pipe(
      Effect.flatMap((service) => service.move(scope, { projectId: targetId })),
      Effect.flip,
      Effect.provide(Move.layer.pipe(Layer.provide(missing.layer))),
    );
    expect(missingResult.code).toBe("thread_not_found");
    const invalid = yield* Move.ThreadProjectMoveMcpService.pipe(
      Effect.flatMap((service) =>
        service.move(scope, {
          threadId: ThreadId.make("other-thread"),
          projectId: targetId,
          continuationPrompt: "Do not run this in another thread.",
        }),
      ),
      Effect.flip,
      Effect.provide(Move.layer.pipe(Layer.provide(other.layer))),
    );
    expect(invalid.code).toBe("invalid_request");
    expect(missing.commands).toHaveLength(0);
    expect(other.commands).toHaveLength(0);
  });
});

it.effect("accepts an agent call through the registered MCP tool", () => {
  const test = harness();
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({
        name: "cox_thread_move",
        arguments: { projectId: targetId, clientRequestId: "registered-move" },
      })
      .pipe(
        Effect.provideService(Invocation.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      threadId,
      projectId: targetId,
      workspaceRoot: "/projects/target",
    });
    expect(test.commands[0]?.type).toBe("thread.project.move-agent");
  }).pipe(
    Effect.provide(
      McpHttpServer.toolkitRegistration(ThreadToolkit, Handlers.layer).pipe(
        Layer.provide(Move.layer.pipe(Layer.provide(test.layer))),
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(test.layer),
      ),
    ),
  );
});

it("advertises the move as an object schema and distinguishes it from context transfer", () => {
  expect(advertisedJsonSchema(ThreadToolkit.tools.cox_thread_move)).toMatchObject({
    type: "object",
    required: ["projectId"],
  });
  expect(ThreadToolkit.tools.cox_thread_move.description).toContain(
    "preserving its ID and chat history",
  );
});

it.effect(
  "advertises the tool and refuses read-only clients at the production access boundary",
  () => {
    const test = harness();
    return Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      expect(server.tools.some(({ tool }) => tool.name === "cox_thread_move")).toBe(true);
      const result = yield* server
        .callTool({ name: "cox_thread_move", arguments: { threadId, projectId: targetId } })
        .pipe(
          Effect.provideService(Invocation.McpInvocationContext, {
            ...scope,
            thread: undefined,
            client: { sessionId: "external", label: "Read only", access: "read-only" },
          }),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(result.isError).toBe(true);
      expect(test.commands).toHaveLength(0);
    }).pipe(
      Effect.provide(
        McpHttpServer.toolkitRegistration(ThreadToolkit, Handlers.layer).pipe(
          Layer.provide(Move.layer.pipe(Layer.provide(test.layer))),
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provide(test.layer),
        ),
      ),
    );
  },
);

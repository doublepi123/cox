import {
  CommandId,
  OrchestratorMcpFailure,
  type ThreadProjectMoveMcpInput,
  type ThreadProjectMoveMcpResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Projects from "../project/ProjectService.ts";
import { type McpInvocationScope, threadLinkFor } from "./McpInvocationContext.ts";
import { dispatchFailure, threadNotFound, unavailable } from "./threadAccess.ts";

export class ThreadProjectMoveMcpService extends Context.Service<
  ThreadProjectMoveMcpService,
  {
    readonly move: (
      scope: McpInvocationScope,
      input: ThreadProjectMoveMcpInput,
    ) => Effect.Effect<ThreadProjectMoveMcpResult, OrchestratorMcpFailure>;
  }
>()("cox/mcp/ThreadProjectMoveMcpService") {}

export const layer = Layer.effect(
  ThreadProjectMoveMcpService,
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const projects = yield* Projects.ProjectService;

    const move = Effect.fn("ThreadProjectMoveMcpService.move")(function* (
      scope: McpInvocationScope,
      input: ThreadProjectMoveMcpInput,
    ) {
      if (!scope.capabilities.has("orchestration") || scope.thread?.subagent === true) {
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "This credential cannot move threads between projects.",
        });
      }
      const threadId = input.threadId ?? scope.thread?.threadId;
      if (threadId === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "target_required",
          message: "Pass threadId: this MCP client is not running inside a Cox thread.",
        });
      }
      const shell = yield* threads.getThreadShell(threadId).pipe(Effect.mapError(unavailable));
      if (shell === null || shell.deletedAt !== null) {
        return yield* threadNotFound(threads, threadId, `Thread ${threadId} was not found.`);
      }
      const project = yield* projects.getById(input.projectId).pipe(Effect.mapError(unavailable));
      if (Option.isNone(project)) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The target project was not found.",
        });
      }
      const ownsThread = scope.thread?.threadId === threadId;
      if (ownsThread && shell.providerInstanceId !== scope.thread?.providerInstanceId) {
        return yield* new OrchestratorMcpFailure({
          code: "parent_not_active",
          message: "The calling provider no longer owns this thread.",
        });
      }
      if (input.continuationPrompt !== undefined && !ownsThread) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "continuationPrompt is only supported when moving the calling agent's thread.",
        });
      }
      const requestKey = input.clientRequestId ?? (yield* crypto.randomUUIDv4().pipe(Effect.orDie));
      const commandId = CommandId.make(
        [
          "command",
          "mcp",
          ownsThread ? `thread:${threadId}` : scope.requestNamespace,
          "project-move",
          threadId,
          input.projectId,
          requestKey,
        ]
          .map(encodeURIComponent)
          .join(":"),
      );
      const result = (sequence: number | null, agent: ThreadProjectMoveMcpResult["agent"]) => ({
        threadId,
        projectId: input.projectId,
        workspaceRoot: project.value.workspaceRoot,
        sequence,
        agent,
        link: threadLinkFor(scope, threadId, shell.title),
      });
      const retry = yield* threads.hasReceipt(commandId);
      if (!retry && shell.projectId === input.projectId) {
        if (input.expectedProjectId !== undefined && input.expectedProjectId !== shell.projectId) {
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "The thread moved before this project change could be applied.",
          });
        }
        return result(null, "unchanged");
      }
      const common = {
        commandId,
        threadId,
        projectId: input.projectId,
        expectedProjectId: input.expectedProjectId ?? shell.projectId,
      };
      const activeProjection =
        !retry && ownsThread && shell.activeRunId !== null
          ? yield* threads
              .getThreadRecords(threadId, ["runs", "providerThreads"])
              .pipe(Effect.mapError(unavailable))
          : undefined;
      const activeRun = activeProjection?.runs.find((run) => run.id === shell.activeRunId);
      const activeProviderThread = activeProjection?.providerThreads.find(
        (providerThread) => providerThread.id === activeRun?.providerThreadId,
      );
      if (
        activeProjection !== undefined &&
        (activeRun === undefined ||
          activeProviderThread?.providerSessionId == null ||
          activeRun.providerInstanceId !== scope.thread?.providerInstanceId)
      ) {
        return yield* new OrchestratorMcpFailure({
          code: "parent_not_active",
          message: "The calling agent no longer owns an active provider run.",
        });
      }
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const dispatched = yield* threads
            .dispatch(
              activeRun !== undefined && activeProviderThread?.providerSessionId != null
                ? {
                    ...common,
                    type: "thread.project.move-agent",
                    runId: activeRun.id,
                    providerSessionId: activeProviderThread.providerSessionId,
                    continuationPrompt:
                      input.continuationPrompt ??
                      `The current conversation has moved to project ${input.projectId}, workspace ${project.value.workspaceRoot}. The thread ID and chat history are unchanged. Confirm the move and use this workspace for future work. Do not move it again.`,
                  }
                : { ...common, type: "thread.project.move" },
            )
            .pipe(Effect.mapError(dispatchFailure));
          return result(
            dispatched.sequence,
            activeRun !== undefined ||
              dispatched.storedEvents.some((stored) => stored.event.type === "run-attempt.created")
              ? "restart_scheduled"
              : "refresh_on_next_turn",
          );
        }),
      );
    });

    return ThreadProjectMoveMcpService.of({ move });
  }),
);

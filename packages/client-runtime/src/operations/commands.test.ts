import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  CommandId,
  EnvironmentId,
  MessageId,
  NodeId,
  ORCHESTRATION_V2_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  RunId,
  ThreadId,
  TurnItemId,
  WS_METHODS,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadLaunchInput,
  type OrchestrationV2ThreadLaunchResult,
  type OrchestrationV2ThreadProjection,
  type ProjectMutation,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { RpcClientError } from "effect/rpc";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as RpcSession from "../rpc/session.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import { v2Now, v2Projection, v2ThreadId } from "../state/orchestrationV2TestFixtures.ts";
import {
  archiveThread,
  interruptThreadTurn,
  moveThreadToProject,
  revertThreadCheckpoint,
  resumeThreadQueue,
  reorderQueuedRun,
  startThreadTurn,
} from "./commands.ts";

const layerTestCrypto = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => new Uint8Array(size),
    digest: (_algorithm, data) => Effect.succeed(data),
  }),
);

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const makeSupervisor = Effect.fn("TestEnvironmentCommands.makeSupervisor")(function* (input: {
  readonly commands: OrchestrationV2Command[];
  readonly projects: ProjectMutation[];
  readonly launches?: OrchestrationV2ThreadLaunchInput[];
  readonly launch?: (
    launchInput: OrchestrationV2ThreadLaunchInput,
  ) => Effect.Effect<OrchestrationV2ThreadLaunchResult, RpcClientError.RpcClientError>;
  readonly projection?: OrchestrationV2ThreadProjection;
  readonly projectionRequests?: ThreadId[];
  readonly advertiseThreadStop?: boolean;
  readonly dispatch?: (
    command: OrchestrationV2Command,
  ) => Effect.Effect<{ readonly sequence: number }, RpcClientError.RpcClientError>;
}) {
  const client = {
    [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command: OrchestrationV2Command) =>
      input.dispatch?.(command) ??
      Effect.sync(() => {
        input.commands.push(command);
        return { sequence: input.commands.length };
      }),
    [ORCHESTRATION_V2_WS_METHODS.getThreadProjection]: (requestInput: {
      readonly threadId: ThreadId;
    }) =>
      Effect.sync(() => {
        input.projectionRequests?.push(requestInput.threadId);
        return input.projection ?? v2Projection;
      }),
    [ORCHESTRATION_V2_WS_METHODS.launchThread]: (launchInput: OrchestrationV2ThreadLaunchInput) =>
      Effect.suspend(() => {
        input.launches?.push(launchInput);
        return (
          input.launch?.(launchInput) ??
          Effect.succeed({
            threadId: launchInput.threadId ?? v2ThreadId,
            projection: input.projection ?? v2Projection,
            resumed: false,
          })
        );
      }),
    [WS_METHODS.projectsMutate]: (mutation: ProjectMutation) =>
      Effect.sync(() => {
        input.projects.push(mutation);
        return {
          id: mutation.projectId,
          title: mutation.type === "project.create" ? mutation.title : "Project",
          workspaceRoot:
            mutation.type === "project.create" ? mutation.workspaceRoot : "/workspace/project",
          repositoryIdentity: null,
          faviconPath: null,
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-06-06T00:00:00.000Z",
          updatedAt: "2026-06-06T00:00:00.000Z",
          deletedAt: null,
        };
      }),
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession.RpcSession = {
    client,
    initialConfig: Effect.succeed({
      environment: {
        capabilities: {
          repositoryIdentity: true,
          ...(input.advertiseThreadStop === true ? { threadStop: true } : {}),
        },
      },
    } as never),
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    inboundFrames: Effect.succeed(0),
    closed: Effect.never,
  };
  return EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make<SupervisorConnectionState>({
      ...AVAILABLE_CONNECTION_STATE,
      desired: true,
      phase: "connected" as const,
    }),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
});

describe("V2 environment commands", () => {
  it.effect("reorders queued messages before a target or at the end without starting a run", () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor({ commands, projects: [] });
      const threadId = ThreadId.make("thread-queue");
      for (const beforeRunId of [RunId.make("next-run"), null]) {
        yield* reorderQueuedRun({
          commandId: CommandId.make(beforeRunId === null ? "move-last" : "move-before"),
          threadId,
          runId: RunId.make("moving-run"),
          beforeRunId,
        }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));
      }
      expect(commands).toEqual([
        {
          type: "queued-run.reorder",
          commandId: "move-before",
          threadId,
          runId: "moving-run",
          beforeRunId: "next-run",
        },
        {
          type: "queued-run.reorder",
          commandId: "move-last",
          threadId,
          runId: "moving-run",
          beforeRunId: null,
        },
      ]);
    }).pipe(Effect.provide(layerTestCrypto)),
  );
  it.effect("distinguishes sending a selected queued message from resuming queue order", () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor({ commands, projects: [] });
      const threadId = ThreadId.make("thread-1");
      yield* resumeThreadQueue({
        commandId: CommandId.make("send-selected"),
        threadId,
        runId: RunId.make("selected"),
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));
      yield* resumeThreadQueue({
        commandId: CommandId.make("resume-queue"),
        threadId,
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(commands).toEqual([
        { type: "queued-run.start", commandId: "send-selected", threadId, runId: "selected" },
        { type: "queue.resume", commandId: "resume-queue", threadId },
      ]);
    }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect("preserves caller command ids for idempotent V2 commands", () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor({ commands, projects: [] });

      yield* archiveThread({
        commandId: CommandId.make("queued-command"),
        threadId: ThreadId.make("thread-1"),
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(commands).toEqual([
        { type: "thread.archive", commandId: "queued-command", threadId: "thread-1" },
      ]);
    }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect("moves a thread with an explicit source project guard", () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor({ commands, projects: [] });
      yield* moveThreadToProject({
        commandId: CommandId.make("move-project"),
        threadId: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-b"),
        expectedProjectId: ProjectId.make("project-a"),
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(commands).toEqual([
        {
          type: "thread.project.move",
          commandId: "move-project",
          threadId: "thread-1",
          projectId: "project-b",
          expectedProjectId: "project-a",
        },
      ]);
    }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect("resolves run ordinal zero to the persisted thread-start checkpoint", () =>
    Effect.gen(function* () {
      const scopeId = CheckpointScopeId.make("checkpoint-scope-root");
      const checkpointId = CheckpointId.make("checkpoint-thread-start");
      const projection: OrchestrationV2ThreadProjection = {
        ...v2Projection,
        checkpoints: [
          {
            id: checkpointId,
            threadId: v2ThreadId,
            scopeId,
            runId: null,
            nodeId: NodeId.make("node-run-1"),
            parentCheckpointId: null,
            ordinalWithinScope: 0,
            appRunOrdinal: null,
            ref: CheckpointRef.make("refs/t3/thread-start"),
            status: "ready",
            files: [],
            capturedAt: v2Now,
          },
        ],
      };
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor({ commands, projects: [], projection });

      yield* revertThreadCheckpoint({
        commandId: CommandId.make("rollback-thread-start"),
        threadId: v2ThreadId,
        turnCount: 0,
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(commands).toEqual([
        {
          type: "checkpoint.rollback",
          commandId: "rollback-thread-start",
          threadId: v2ThreadId,
          scopeId,
          checkpointId,
        },
      ]);
    }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect("preserves an existing worktree and branch during first-message launch", () =>
    Effect.gen(function* () {
      const launches: OrchestrationV2ThreadLaunchInput[] = [];
      const supervisor = yield* makeSupervisor({ commands: [], projects: [], launches });

      yield* startThreadTurn({
        commandId: CommandId.make("launch-existing-worktree"),
        threadId: v2ThreadId,
        message: {
          messageId: MessageId.make("message-existing-worktree"),
          role: "user",
          text: "Continue here",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        titleSeed: "Continue here",
        bootstrap: {
          createThread: {
            projectId: ProjectId.make("project-1"),
            title: "Thread",
            modelSelection: v2Projection.thread.modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: "feature",
            worktreePath: "/workspace/project-worktrees/feature",
            createdAt: "2026-06-20T00:00:00.000Z",
          },
        },
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(launches[0]).toMatchObject({
        threadId: v2ThreadId,
        title: "Continue here",
        generateTitle: true,
        workspaceStrategy: {
          type: "existing_worktree",
          worktreePath: "/workspace/project-worktrees/feature",
          branch: "feature",
        },
      });
    }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect.each(["bootstrap", "worktree"] as const)(
    "recovers a %s launch on a replacement session with identical input",
    (launchKind) =>
      Effect.gen(function* () {
        const launches: OrchestrationV2ThreadLaunchInput[] = [];
        const lost = yield* Deferred.make<void>();
        const supervisor = yield* makeSupervisor({
          commands: [],
          projects: [],
          launches,
          launch: (): Effect.Effect<
            OrchestrationV2ThreadLaunchResult,
            RpcClientError.RpcClientError
          > =>
            Effect.gen(function* () {
              if (launches.length === 1) {
                yield* SubscriptionRef.set(supervisor.session, Option.none());
                yield* Deferred.succeed(lost, undefined);
                return yield* new RpcClientError.RpcClientError({
                  reason: new RpcClientError.RpcClientDefect({
                    message: "socket closed",
                    cause: new Error("socket closed"),
                  }),
                });
              }
              return { threadId: v2ThreadId, projection: v2Projection, resumed: false };
            }),
        });
        const session = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.session));
        const launch = yield* startThreadTurn({
          commandId: CommandId.make(`launch-${launchKind}`),
          threadId: v2ThreadId,
          message: {
            messageId: MessageId.make(`message-${launchKind}`),
            role: "user",
            text: "hello",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          bootstrap:
            launchKind === "bootstrap"
              ? {
                  createThread: {
                    projectId: ProjectId.make("project-1"),
                    title: "Thread",
                    modelSelection: v2Projection.thread.modelSelection,
                    runtimeMode: "full-access",
                    interactionMode: "default",
                    branch: null,
                    worktreePath: null,
                    createdAt: "2026-06-20T00:00:00.000Z",
                  },
                }
              : {
                  prepareWorktree: {
                    projectCwd: "/workspace/project",
                    baseBranch: "main",
                  },
                },
        }).pipe(
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.forkChild,
        );
        yield* Deferred.await(lost);
        yield* SubscriptionRef.set(supervisor.session, Option.some({ ...session }));

        expect(yield* Fiber.await(launch)).toEqual(
          Exit.succeed({ threadId: v2ThreadId, projection: v2Projection, resumed: false }),
        );
        expect(launches).toHaveLength(2);
        expect(launches[1]).toEqual(launches[0]);
        expect(launches[0]).toMatchObject({
          commandId: `launch-${launchKind}`,
          workspaceStrategy:
            launchKind === "bootstrap" ? { type: "root" } : { type: "worktree", baseRef: "main" },
        });
      }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect("fails an unanswered launch after one minute on a live socket", () =>
    Effect.gen(function* () {
      const supervisor = yield* makeSupervisor({
        commands: [],
        projects: [],
        launch: () => Effect.never,
      });
      const launch = yield* startThreadTurn({
        commandId: CommandId.make("silent-launch"),
        threadId: v2ThreadId,
        message: {
          messageId: MessageId.make("silent-launch-message"),
          role: "user",
          text: "hello",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        bootstrap: {
          createThread: {
            projectId: ProjectId.make("project-1"),
            title: "Thread",
            modelSelection: v2Projection.thread.modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: "2026-06-20T00:00:00.000Z",
          },
        },
      }).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.flip,
        Effect.forkChild,
      );
      yield* TestClock.adjust("1 minute");
      expect(launch.pollUnsafe()).toBeDefined();
      expect((yield* Fiber.join(launch))._tag).toBe("EnvironmentRpcUnavailableError");
    }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect("does not resend a launch after caller cancellation", () =>
    Effect.gen(function* () {
      const launches: OrchestrationV2ThreadLaunchInput[] = [];
      const lost = yield* Deferred.make<void>();
      const supervisor = yield* makeSupervisor({
        commands: [],
        projects: [],
        launches,
        launch: (): Effect.Effect<
          OrchestrationV2ThreadLaunchResult,
          RpcClientError.RpcClientError
        > =>
          Effect.gen(function* () {
            yield* SubscriptionRef.set(supervisor.session, Option.none());
            yield* Deferred.succeed(lost, undefined);
            return yield* new RpcClientError.RpcClientError({
              reason: new RpcClientError.RpcClientDefect({
                message: "socket closed",
                cause: new Error("socket closed"),
              }),
            });
          }),
      });
      const session = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.session));
      const launch = yield* startThreadTurn({
        commandId: CommandId.make("cancelled-launch"),
        threadId: v2ThreadId,
        message: {
          messageId: MessageId.make("cancelled-launch-message"),
          role: "user",
          text: "hello",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        bootstrap: {
          createThread: {
            projectId: ProjectId.make("project-1"),
            title: "Thread",
            modelSelection: v2Projection.thread.modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: "2026-06-20T00:00:00.000Z",
          },
        },
      }).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      yield* Deferred.await(lost);
      yield* Fiber.interrupt(launch);
      yield* SubscriptionRef.set(supervisor.session, Option.some({ ...session }));

      expect(launches).toHaveLength(1);
    }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect("uses server-resolved delivery intent without fetching the full projection", () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const projectionRequests: ThreadId[] = [];
      const supervisor = yield* makeSupervisor({ commands, projects: [], projectionRequests });

      for (const [mode, expectedType] of [
        ["queue", "queue_after_active"],
        ["auto", "start_immediately"],
        ["steer", "start_immediately"],
        ["restart", "start_immediately"],
      ] as const) {
        yield* startThreadTurn({
          commandId: CommandId.make(`command-${mode}`),
          threadId: v2ThreadId,
          message: {
            messageId: MessageId.make(`message-${mode}`),
            role: "user",
            text: mode,
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          dispatchMode: mode,
        }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

        expect(commands.at(-1)).toMatchObject({
          type: "message.dispatch",
          dispatchMode: { type: expectedType },
          ...(mode === "queue" ? {} : { deliveryIntent: mode }),
        });
      }
      expect(projectionRequests).toEqual([]);
    }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect.each(["protocol", "interrupt"] as const)(
    "resends a message lost to %s with the same receipt id after reconnect",
    (loss) =>
      Effect.gen(function* () {
        const accepted = new Map<CommandId, number>();
        const attempts: CommandId[] = [];
        const lost = yield* Deferred.make<void>();
        const supervisor = yield* makeSupervisor({
          commands: [],
          projects: [],
          dispatch: (
            command,
          ): Effect.Effect<{ readonly sequence: number }, RpcClientError.RpcClientError> =>
            Effect.gen(function* () {
              attempts.push(command.commandId);
              if (!accepted.has(command.commandId))
                accepted.set(command.commandId, accepted.size + 1);
              if (attempts.length === 1) {
                yield* SubscriptionRef.set(supervisor.session, Option.none());
                yield* Deferred.succeed(lost, undefined);
                return yield* loss === "interrupt"
                  ? Effect.failCause(Cause.interrupt())
                  : Effect.fail(
                      new RpcClientError.RpcClientError({
                        reason: new RpcClientError.RpcClientDefect({
                          message: "socket closed",
                          cause: new Error("socket closed"),
                        }),
                      }),
                    );
              }
              return { sequence: accepted.get(command.commandId) ?? 0 };
            }),
        });
        const session = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.session));
        const send = yield* startThreadTurn({
          commandId: CommandId.make("lost-ack"),
          threadId: v2ThreadId,
          message: {
            messageId: MessageId.make("lost-ack-message"),
            role: "user",
            text: "hello",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
        }).pipe(
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.forkChild,
        );
        yield* Deferred.await(lost);
        yield* SubscriptionRef.set(supervisor.session, Option.some({ ...session }));
        expect(yield* Fiber.await(send)).toEqual(Exit.succeed({ sequence: 1 }));
        expect(attempts).toEqual(["lost-ack", "lost-ack"]);
        expect(accepted.size).toBe(1);
      }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect("caps lost socket resends at two and leaves other commands unretried", () =>
    Effect.gen(function* () {
      const attempts: CommandId[] = [];
      const supervisor = yield* makeSupervisor({
        commands: [],
        projects: [],
        dispatch: (
          command,
        ): Effect.Effect<{ readonly sequence: number }, RpcClientError.RpcClientError> =>
          Effect.gen(function* () {
            attempts.push(command.commandId);
            const session = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.session));
            yield* SubscriptionRef.set(supervisor.session, Option.some({ ...session }));
            return yield* new RpcClientError.RpcClientError({
              reason: new RpcClientError.RpcClientDefect({
                message: "socket closed",
                cause: new Error("socket closed"),
              }),
            });
          }),
      });
      const messageError = yield* startThreadTurn({
        commandId: CommandId.make("socket-killer"),
        threadId: v2ThreadId,
        message: {
          messageId: MessageId.make("socket-killer-message"),
          role: "user",
          text: "hello",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        dispatchMode: "start",
      }).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.flip,
      );
      const archiveError = yield* archiveThread({
        commandId: CommandId.make("archive"),
        threadId: v2ThreadId,
      }).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.flip,
      );
      expect(messageError._tag).toBe("RpcClientError");
      expect(archiveError._tag).toBe("RpcClientError");
      expect(attempts).toEqual(["socket-killer", "socket-killer", "socket-killer", "archive"]);
    }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect("fails an unanswered message after one minute on a live socket", () =>
    Effect.gen(function* () {
      const supervisor = yield* makeSupervisor({
        commands: [],
        projects: [],
        dispatch: () => Effect.never,
      });
      const send = yield* startThreadTurn({
        commandId: CommandId.make("silent-host"),
        threadId: v2ThreadId,
        message: {
          messageId: MessageId.make("silent-message"),
          role: "user",
          text: "hello",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
      }).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.flip,
        Effect.forkChild,
      );
      yield* TestClock.adjust("1 minute");
      expect(send.pollUnsafe()).toBeDefined();
      expect((yield* Fiber.join(send))._tag).toBe("EnvironmentRpcUnavailableError");
    }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect("holds a lost send through backoff until disconnect and honors resend opt-out", () =>
    Effect.gen(function* () {
      const lost = yield* Deferred.make<void>();
      const supervisor = yield* makeSupervisor({
        commands: [],
        projects: [],
        dispatch: (): Effect.Effect<{ readonly sequence: number }, RpcClientError.RpcClientError> =>
          SubscriptionRef.set(supervisor.session, Option.none()).pipe(
            Effect.andThen(Deferred.succeed(lost, undefined)),
            Effect.andThen(
              Effect.fail(
                new RpcClientError.RpcClientError({
                  reason: new RpcClientError.RpcClientDefect({
                    message: "socket closed",
                    cause: new Error("socket closed"),
                  }),
                }),
              ),
            ),
          ),
      });
      const session = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.session));
      const input = {
        commandId: CommandId.make("backoff"),
        threadId: v2ThreadId,
        message: {
          messageId: MessageId.make("backoff-message"),
          role: "user" as const,
          text: "hello",
          attachments: [],
        },
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
      };
      const optedOut = yield* startThreadTurn({ ...input, resendAfterSocketLoss: false }).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.flip,
      );
      expect(optedOut._tag).toBe("RpcClientError");
      yield* SubscriptionRef.set(supervisor.session, Option.some(session));
      const send = yield* startThreadTurn(input).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.flip,
        Effect.forkChild,
      );
      yield* Deferred.await(lost);
      yield* SubscriptionRef.update(supervisor.state, (state) => ({
        ...state,
        phase: "backoff" as const,
      }));
      yield* TestClock.adjust("2 minutes");
      expect(send.pollUnsafe()).toBeUndefined();
      yield* SubscriptionRef.set(supervisor.state, AVAILABLE_CONNECTION_STATE);
      expect((yield* Fiber.join(send))._tag).toBe("RpcClientError");
    }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect("Stop with no run left ends the thread's pull request watches", () =>
    Effect.gen(function* () {
      const link = {
        host: "github.com",
        repository: "pingdotgg/t3code",
        url: "https://github.com/pingdotgg/t3code/pull/7",
        source: "agent" as const,
        linkedAt: "2026-10-05T00:00:00.000Z",
        snapshot: null,
        stack: null,
      };
      const watch = {
        startedAt: "2026-10-05T00:00:00.000Z",
        headSha: null,
        failedChecks: [],
        passed: false,
        passedChecks: [],
        remarksThrough: "2026-10-05T00:00:00.000Z",
        remarkIds: [],
        conflicting: false,
        wakes: 0,
      };
      const projection: OrchestrationV2ThreadProjection = {
        ...v2Projection,
        thread: {
          ...v2Projection.thread,
          pullRequests: [
            { ...link, number: 7, watch },
            { ...link, number: 8 },
            { ...link, number: 9, source: "stack-dismissed", watch },
          ],
        },
      };
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor({ commands, projects: [], projection });

      yield* interruptThreadTurn({ threadId: v2ThreadId }).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      );

      expect(commands).toEqual([
        {
          type: "thread.pull-request.watch",
          commandId: expect.any(String),
          threadId: v2ThreadId,
          host: "github.com",
          repository: "pingdotgg/t3code",
          number: 7,
          watching: false,
        },
      ]);
    }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect.each(["waiting", "completed", "rolled_back"] as const)(
    "dispatches Stop for %s runs with background commands except rollback",
    (status) =>
      Effect.gen(function* () {
        const waitingRunId = RunId.make("run-waiting");
        const projection: OrchestrationV2ThreadProjection = {
          ...v2Projection,
          runs: [
            {
              id: waitingRunId,
              threadId: v2ThreadId,
              ordinal: 1,
              providerInstanceId: v2Projection.thread.providerInstanceId,
              modelSelection: v2Projection.thread.modelSelection,
              providerThreadId: null,
              userMessageId: MessageId.make("message-waiting"),
              rootNodeId: null,
              activeAttemptId: null,
              status,
              requestedAt: v2Now,
              startedAt: v2Now,
              completedAt: null,
              checkpointId: null,
              contextHandoffId: null,
            },
          ],
          turnItems: [
            {
              id: TurnItemId.make("background-command"),
              threadId: v2ThreadId,
              runId: waitingRunId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 1,
              status: "running",
              title: null,
              startedAt: v2Now,
              completedAt: null,
              updatedAt: v2Now,
              type: "command_execution",
              input: "vp run dev",
            },
          ],
        };
        const commands: OrchestrationV2Command[] = [];
        const supervisor = yield* makeSupervisor({ commands, projects: [], projection });

        const result = yield* interruptThreadTurn({ threadId: v2ThreadId }).pipe(
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        );

        expect(result).toEqual({ sequence: status === "rolled_back" ? 0 : 1 });
        expect(commands).toEqual(
          status === "rolled_back"
            ? []
            : [
                {
                  type: "run.interrupt",
                  commandId: expect.any(String),
                  threadId: v2ThreadId,
                  runId: waitingRunId,
                  holdQueue: true,
                },
              ],
        );
      }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect(
    "a native subagent stop targets its owning run rather than holding the parent queue",
    () =>
      Effect.gen(function* () {
        const subagentId = NodeId.make("native-subagent");
        const runId = RunId.make("settled-owner-run");
        const commands: OrchestrationV2Command[] = [];
        const supervisor = yield* makeSupervisor({
          commands,
          projects: [],
          projection: {
            ...v2Projection,
            subagents: [
              {
                id: subagentId,
                threadId: v2ThreadId,
                runId,
                parentNodeId: NodeId.make("owner-node"),
                origin: "provider_native",
                createdBy: "agent",
                driver: ProviderDriverKind.make("claudeAgent"),
                providerInstanceId: ProviderInstanceId.make("claudeAgent"),
                providerThreadId: null,
                childThreadId: ThreadId.make("native-child-thread"),
                nativeTaskRef: null,
                prompt: "Work",
                title: null,
                model: null,
                result: null,
                status: "running",
                startedAt: v2Now,
                completedAt: null,
                updatedAt: v2Now,
              },
            ],
          },
        });
        yield* interruptThreadTurn({
          commandId: CommandId.make("native-stop"),
          threadId: v2ThreadId,
          subagentId,
        }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));
        expect(commands).toEqual([
          {
            type: "subagent.stop",
            commandId: "native-stop",
            threadId: v2ThreadId,
            runId,
            subagentId,
          },
        ]);
      }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect(
    "an app-owned subagent stop asks the parent to clear an orphan, then stops the child",
    () =>
      Effect.gen(function* () {
        const subagentId = NodeId.make("app-owned-subagent");
        const runId = RunId.make("parent-run");
        const childThreadId = ThreadId.make("app-owned-child-thread");
        const commands: OrchestrationV2Command[] = [];
        const supervisor = yield* makeSupervisor({
          commands,
          projects: [],
          advertiseThreadStop: true,
          projection: {
            ...v2Projection,
            subagents: [
              {
                id: subagentId,
                threadId: v2ThreadId,
                runId,
                parentNodeId: NodeId.make("owner-node"),
                origin: "app_owned",
                createdBy: "agent",
                driver: ProviderDriverKind.make("codex"),
                providerInstanceId: ProviderInstanceId.make("codex"),
                providerThreadId: null,
                childThreadId,
                nativeTaskRef: null,
                prompt: "Work",
                title: null,
                model: null,
                result: null,
                status: "running",
                startedAt: v2Now,
                completedAt: null,
                updatedAt: v2Now,
              },
            ],
          },
        });
        yield* interruptThreadTurn({
          commandId: CommandId.make("lineage-stop"),
          threadId: v2ThreadId,
          subagentId,
          // A parent run must not be interrupted on the child thread.
          runId,
        }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));
        expect(commands).toEqual([
          {
            type: "subagent.stop",
            commandId: expect.any(String),
            threadId: v2ThreadId,
            runId,
            subagentId,
          },
          { type: "thread.stop", commandId: "lineage-stop", threadId: childThreadId },
        ]);
      }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect("stops a thread without relying on background work in the history window", () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const projectionRequests: ThreadId[] = [];
      const supervisor = yield* makeSupervisor({
        commands,
        projects: [],
        projectionRequests,
        advertiseThreadStop: true,
      });

      const result = yield* interruptThreadTurn({
        commandId: CommandId.make("stop-outside-history-window"),
        threadId: v2ThreadId,
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(result).toEqual({ sequence: 1 });
      expect(projectionRequests).toEqual([]);
      expect(commands).toEqual([
        {
          type: "thread.stop",
          commandId: "stop-outside-history-window",
          threadId: v2ThreadId,
        },
      ]);
    }).pipe(Effect.provide(layerTestCrypto)),
  );
});

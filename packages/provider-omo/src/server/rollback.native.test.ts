import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { createServer } from "node:http";
import {
  CheckpointId,
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { expect, it } from "vite-plus/test";
import { OmoAdapterDriver } from "./adapter.ts";

const INSTANCE_ID = ProviderInstanceId.make("omo");

it.skipIf(!process.env.COX_OMO_NPM_TEST_LAUNCHER)(
  "rolls back and forks an OMO thread through the native adapter",
  async () => {
    const bodies: Array<string> = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += String(chunk);
      });
      request.on("end", () => {
        bodies.push(body);
        const chunk = (delta: object, finish: string | null) =>
          `data: ${JSON.stringify({
            id: `offline-${bodies.length}`,
            object: "chat.completion.chunk",
            created: 1,
            model: "fixture",
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(chunk({ role: "assistant", content: `ANSWER-${bodies.length}` }, null));
        response.write(chunk({}, "stop"));
        response.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Fixture port missing");
      await Effect.runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "cox-omo-rollback-" });
          const agent = path.join(temporary, "agent");
          const workspace = path.join(temporary, "workspace");
          yield* fs.makeDirectory(path.join(temporary, ".cache"), { recursive: true });
          yield* fs.makeDirectory(agent);
          yield* fs.makeDirectory(workspace);
          yield* fs.writeFileString(
            path.join(agent, "settings.json"),
            JSON.stringify({
              enabledBuiltinExtensions: ["permission-system", "goal"],
              retry: { enabled: false },
              defaultProvider: "cox",
              defaultModel: "fixture",
            }),
          );
          yield* fs.writeFileString(
            path.join(agent, "models.json"),
            JSON.stringify({
              providers: {
                cox: {
                  baseUrl: `http://127.0.0.1:${address.port}/v1`,
                  api: "openai-completions",
                  apiKey: "offline-fixture",
                  models: [
                    { id: "fixture", name: "fixture", contextWindow: 200000, maxTokens: 1024 },
                  ],
                },
              },
            }),
          );
          const environment = {
            HOME: temporary,
            USERPROFILE: temporary,
            PATH: process.env.PATH,
            TMPDIR: process.env.TMPDIR,
            XDG_CONFIG_HOME: temporary,
            XDG_CACHE_HOME: path.join(temporary, ".cache"),
            OMO_RUNTIME: "node",
            CI: "1",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: path.join(temporary, "gitconfig"),
          };
          const adapter = yield* OmoAdapterDriver.create({
            instanceId: INSTANCE_ID,
            displayName: undefined,
            enabled: true,
            environment: [],
            config: {
              ...OmoAdapterDriver.defaultConfig(),
              binaryPath: process.env.COX_OMO_NPM_TEST_LAUNCHER!,
              agentDir: agent,
              automaticMemory: false,
              launchArgs: "--no-extensions --no-skills --no-prompt-templates --no-themes",
            },
          }).pipe(Effect.provideService(HostProcess.Environment, environment));
          const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: workspace,
          });
          const threadId = ThreadId.make("thread-omo-rollback");
          const modelSelection = { instanceId: INSTANCE_ID, model: "cox/fixture" };
          const runtime = yield* adapter.openSession({
            threadId,
            providerSessionId: ProviderSessionId.make("session-omo-rollback"),
            modelSelection,
            runtimePolicy,
          });
          const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
          yield* runtime.events.pipe(
            Stream.runForEach((event) => Queue.offer(events, event)),
            Effect.forkScoped,
          );
          const turns = new Map<string, OrchestrationV2ProviderTurn>();
          let providerThread: OrchestrationV2ProviderThread = yield* runtime.ensureThread({
            threadId,
            modelSelection,
            runtimePolicy,
          });
          const now = yield* DateTime.now;
          const appThread = {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: "project:fixture:omo" as OrchestrationV2AppThread["projectId"],
            title: "OMO rollback",
            providerInstanceId: INSTANCE_ID,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          } satisfies OrchestrationV2AppThread;
          const turn = (runOrdinal: number, text: string) =>
            Effect.gen(function* () {
              const runId = RunId.make(`run-${runOrdinal}`);
              yield* runtime.startTurn({
                appThread,
                threadId,
                runId,
                runOrdinal,
                providerTurnOrdinal: runOrdinal,
                attemptId: RunAttemptId.make(`attempt-${runOrdinal}`),
                rootNodeId: NodeId.make(`node-${runOrdinal}`),
                providerThread,
                message: {
                  messageId: `message-${runOrdinal}` as never,
                  text,
                  attachments: [],
                  createdBy: "user",
                  creationSource: "web",
                },
                modelSelection,
                runtimePolicy,
              });
              while (true) {
                const event = yield* Queue.take(events);
                if (event.type === "provider_turn.updated")
                  turns.set(event.providerTurn.id, event.providerTurn);
                if (event.type === "provider_thread.updated") providerThread = event.providerThread;
                if (event.type === "turn.terminal" && event.runOrdinal === runOrdinal) {
                  expect(event.status).toBe("completed");
                  return;
                }
              }
            });
          yield* turn(1, "ALPHA-TURN-ONE");
          yield* turn(2, "BRAVO-TURN-TWO");
          yield* Effect.yieldNow;
          const recorded = [...turns.values()]
            .filter((value) => value.providerThreadId === providerThread.id)
            .sort((a, b) => a.ordinal - b.ordinal);
          expect(recorded.map((value) => value.ordinal)).toEqual([1, 2]);

          const sourceFile = providerThread.nativeThreadRef?.nativeId;
          const rolledBack = yield* runtime.rollbackThread({
            providerThread,
            target: {
              type: "provider_turn",
              checkpointId: CheckpointId.make("checkpoint-1"),
              appRunOrdinal: 1,
              providerTurn: recorded[0]!,
            },
            providerThreadTurns: recorded,
          });
          providerThread = rolledBack.providerThread;
          expect(providerThread.nativeThreadRef?.nativeId).not.toBe(sourceFile);
          const beforeRollbackTurn = bodies.length;
          yield* turn(3, "CHARLIE-TURN-THREE");
          const afterRollback = bodies.slice(beforeRollbackTurn);
          expect(afterRollback.length).toBeGreaterThan(0);
          expect(afterRollback.at(-1)).toContain("ALPHA-TURN-ONE");
          expect(afterRollback.at(-1)).toContain("CHARLIE-TURN-THREE");
          for (const body of afterRollback) expect(body).not.toContain("BRAVO-TURN-TWO");

          const current = [...turns.values()]
            .filter((value) => value.providerThreadId === providerThread.id && value.ordinal !== 2)
            .sort((a, b) => a.ordinal - b.ordinal);
          expect(current.map((value) => value.ordinal)).toEqual([1, 3]);
          const forked = yield* runtime.forkThread({
            sourceProviderThread: providerThread,
            sourceProviderTurns: current,
            providerTurnId: current[0]!.id,
            targetThreadId: ThreadId.make("thread-omo-fork"),
          });
          const forkFile = forked.nativeThreadRef?.nativeId;
          expect(forkFile).toBeTypeOf("string");
          expect(forkFile).not.toBe(providerThread.nativeThreadRef?.nativeId);
          const forkTranscript = yield* fs.readFileString(forkFile!);
          expect(forkTranscript).toContain("ALPHA-TURN-ONE");
          expect(forkTranscript).not.toContain("BRAVO-TURN-TWO");
          expect(forkTranscript).not.toContain("CHARLIE-TURN-THREE");
        }).pipe(
          Effect.scoped,
          Effect.provide(
            Layer.mergeAll(
              NodeServices.layer,
              IdAllocator.layer,
              McpProviderSessions.layer,
              TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
            ),
          ),
          Effect.timeout("50 seconds"),
        ),
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

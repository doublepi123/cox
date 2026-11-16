import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { strict as assert } from "node:assert";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { it } from "vite-plus/test";
import { OmpAdapterDriver } from "./adapter.ts";

const ModelRequest = Schema.Struct({
  model: Schema.String,
  messages: Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.Unknown })),
});
const decodeModelRequest = Schema.decodeUnknownSync(ModelRequest);

it.skipIf(!process.env.COX_OMP_NPM_TEST_LAUNCHER)(
  "projects native manual compaction lifecycle through the OMP adapter",
  async () => {
    const { createServer } = await import("node:http");
    const launcher = process.env.COX_OMP_NPM_TEST_LAUNCHER;
    const bun = process.env.COX_OMP_BUN_PATH;
    assert(launcher && bun, "Both native launcher and Bun must be configured");
    const requests: string[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      request.on("end", () => {
        const parsed = decodeModelRequest(JSON.parse(body));
        assert.equal(parsed.model, "fixture");
        requests.push(body);
        response.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (delta: object, finish: string | null) =>
          `data: ${JSON.stringify({
            id: `fixture-${requests.length}`,
            object: "chat.completion.chunk",
            created: 1,
            model: "fixture",
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`;
        response.write(
          chunk({ role: "assistant", content: "Deterministic compact summary or reply." }, null),
        );
        response.write(chunk({}, "stop"));
        response.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      assert(address && typeof address !== "string");
      await Effect.runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "omp-compact-native-" });
          const agent = path.join(temporary, "agent");
          const workspace = path.join(temporary, "workspace");
          yield* fs.makeDirectory(agent);
          yield* fs.makeDirectory(workspace);
          yield* fs.writeFileString(
            path.join(agent, "config.yml"),
            JSON.stringify({
              modelRoles: { default: "fixture/fixture" },
              retry: { enabled: false, maxRetries: 0 },
              compaction: { keepRecentTokens: 0, methodOrder: ["soft"], enabled: false },
            }),
          );
          yield* fs.writeFileString(
            path.join(agent, "models.yml"),
            JSON.stringify({
              providers: {
                fixture: {
                  baseUrl: `http://127.0.0.1:${address.port}/v1`,
                  api: "openai-completions",
                  apiKey: "offline-fixture",
                  models: [
                    {
                      id: "fixture",
                      name: "Fixture",
                      contextWindow: 32000,
                      maxTokens: 1024,
                      reasoning: false,
                    },
                  ],
                },
              },
            }),
          );
          const environment = {
            HOME: temporary,
            USERPROFILE: temporary,
            TMPDIR: temporary,
            PATH: `${path.dirname(bun)}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
            PI_CONFIG_DIR: agent,
            PI_CODING_AGENT_DIR: agent,
            XDG_CONFIG_HOME: temporary,
            XDG_DATA_HOME: temporary,
            XDG_CACHE_HOME: path.join(temporary, "cache"),
            BUN_INSTALL_CACHE_DIR: path.join(temporary, "bun-install"),
            BUN_RUNTIME_TRANSPILER_CACHE_PATH: path.join(temporary, "bun-cache"),
            NODE_COMPILE_CACHE: path.join(temporary, "node-cache"),
            CI: "1",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: path.join(temporary, "gitconfig"),
          };
          const instanceId = ProviderInstanceId.make("omp-compact-native");
          const config = {
            ...OmpAdapterDriver.defaultConfig(),
            enabled: true,
            binaryPath: launcher,
            agentDir: agent,
            launchArgs:
              "--no-extensions --no-skills --no-rules --no-context-files --no-title --no-lsp --no-pty --no-judge --no-spotlight --no-prewalk --tools read",
          };
          const adapter = yield* OmpAdapterDriver.create({
            instanceId,
            displayName: undefined,
            enabled: true,
            environment: [],
            config,
          }).pipe(Effect.provideService(HostProcess.Environment, environment));
          const threadId = ThreadId.make("omp-compact-native-thread");
          const modelSelection = { instanceId, model: "fixture/fixture" };
          const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "approval-required",
            interactionMode: "default",
            cwd: workspace,
          });
          const runtime = yield* adapter.openSession({
            threadId,
            providerSessionId: ProviderSessionId.make("omp-compact-native-session"),
            modelSelection,
            runtimePolicy,
          });
          const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
          const captured: ProviderAdapter.ProviderAdapterV2Event[] = [];
          yield* runtime.events.pipe(
            Stream.runForEach((event) => {
              captured.push(event);
              return Queue.offer(events, event);
            }),
            Effect.forkScoped,
          );
          let providerThread = yield* runtime.ensureThread({
            threadId,
            modelSelection,
            runtimePolicy,
          });
          const now = yield* DateTime.now;
          const appThread = {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: ProjectId.make("omp-compact-native-project"),
            title: "Native OMP compaction fixture",
            providerInstanceId: instanceId,
            modelSelection,
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
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          } satisfies OrchestrationV2AppThread;
          let ordinal = 0;
          const runTurn = (compact: boolean, text = "Filler deterministic work.") =>
            Effect.gen(function* () {
              ordinal += 1;
              const input = {
                appThread,
                threadId,
                runId: RunId.make(`run-${ordinal}`),
                runOrdinal: ordinal,
                providerTurnOrdinal: ordinal,
                attemptId: RunAttemptId.make(`attempt-${ordinal}`),
                rootNodeId: NodeId.make(`node-${ordinal}`),
                providerThread,
                message: {
                  messageId: MessageId.make(`message-${ordinal}`),
                  text,
                  attachments: [],
                  createdBy: "user" as const,
                  creationSource: "web" as const,
                },
                modelSelection,
                runtimePolicy,
              };
              if (compact) {
                assert(runtime.compactThread !== undefined);
                yield* runtime.compactThread(input);
              } else yield* runtime.startTurn(input);
            });
          const settle = (status = "completed") =>
            Effect.gen(function* () {
              const approvals = new Set<string>();
              while (true) {
                const event = yield* Queue.take(events);
                if (event.type === "provider_thread.updated") providerThread = event.providerThread;
                if (
                  event.type === "runtime_request.updated" &&
                  event.runtimeRequest.status === "pending" &&
                  !approvals.has(event.runtimeRequest.id)
                ) {
                  approvals.add(event.runtimeRequest.id);
                  yield* runtime.respondToRuntimeRequest({
                    requestId: event.runtimeRequest.id,
                    decision: "accept",
                  });
                }
                if (event.type === "turn.terminal" && event.runOrdinal === ordinal) {
                  assert.equal(event.status, status, JSON.stringify(event));
                  return;
                }
              }
            });
          const compactionItems = () =>
            captured.flatMap((event) =>
              event.type === "turn_item.updated" && event.turnItem.type === "compaction"
                ? [event.turnItem]
                : [],
            );

          yield* runTurn(false);
          yield* settle();

          yield* runTurn(true);
          yield* settle();
          const completed = compactionItems().filter((item) => item.status === "completed");
          assert.equal(completed.length, 1, JSON.stringify(compactionItems()));
          const firstCompleted = completed[0];
          assert(firstCompleted !== undefined);
          assert(typeof firstCompleted.summary === "string");
          assert(firstCompleted.summary.length > 0);
          assert(typeof firstCompleted.beforeTokenCount === "number");
          assert(firstCompleted.beforeTokenCount >= 0);
          assert.equal(firstCompleted.afterTokenCount, undefined);

          yield* runTurn(true);
          yield* settle();
          const items = compactionItems();
          const last = items.at(-1);
          assert.equal(last?.status, "completed", JSON.stringify(items));
          assert.equal(last?.summary, "Already compacted");
          assert(
            items.every((item) => item.status !== "failed"),
            `No compaction may render as failed: ${JSON.stringify(items)}`,
          );
          assert(
            captured.every(
              (event) =>
                !(event.type === "turn_item.updated" && event.turnItem.type === "compaction") ||
                event.turnItem.title !== "Context compaction failed",
            ),
            "A benign skipped no-op must never render as a failed compaction",
          );
          assert(
            items.every((item) => item.status !== "cancelled"),
            "A benign skipped no-op must not render as a cancelled compaction",
          );
          yield* Effect.logInfo(
            "OMP_COMPACTION_NATIVE_RESULT",
            JSON.stringify({
              requests: requests.length,
              items: items.map((item) => ({
                status: item.status,
                summary: item.summary,
                beforeTokenCount: item.beforeTokenCount,
              })),
            }),
          );
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
          Effect.timeout("120 seconds"),
        ),
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { strict as assert } from "node:assert";
import {
  CheckpointId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { it } from "vite-plus/test";
import { OmpAdapterDriver } from "./adapter.ts";
import { checkOmpProviderStatus } from "./status.ts";

const ModelRequest = Schema.Struct({
  model: Schema.String,
  messages: Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.Unknown })),
});
const decodeModelRequest = Schema.decodeUnknownSync(ModelRequest);

it.skipIf(!process.env.COX_OMP_NPM_TEST_LAUNCHER)(
  "completes native tools, permissions, history branches and atomic stop through the OMP adapter",
  async () => {
    const { createServer } = await import("node:http");
    const launcher = process.env.COX_OMP_NPM_TEST_LAUNCHER;
    const bun = process.env.COX_OMP_BUN_PATH;
    assert(launcher && bun, "Both native launcher and Bun must be configured");
    const requests: string[] = [];
    const issued = new Set<string>();
    let workspace = "";
    const held = Promise.withResolvers<void>();
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      request.on("end", () => {
        const parsed = decodeModelRequest(JSON.parse(body));
        assert.equal(parsed.model, "fixture");
        requests.push(body);
        const user = JSON.stringify(
          parsed.messages.findLast(
            (message) => message.role === "user" && JSON.stringify(message.content).includes("QA_"),
          )?.content,
        );
        assert(user);
        const marker = /QA_[A-Z_]+/.exec(user)?.[0];
        assert(marker, user);
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (marker === "QA_HOLD") {
          held.resolve();
          return;
        }
        const chunk = (delta: object, finish: string | null) =>
          `data: ${JSON.stringify({
            id: `fixture-${requests.length}`,
            object: "chat.completion.chunk",
            created: 1,
            model: "fixture",
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`;
        const key = marker === "QA_TODO" && issued.has(marker) ? `${marker}_DONE` : marker;
        const tool =
          marker === "QA_READ"
            ? { name: "read", args: { path: `${workspace}/fixture.txt` } }
            : marker === "QA_ALLOW" || marker === "QA_DENY"
              ? { name: "write", args: { path: `${workspace}/${marker}.txt`, content: marker } }
              : marker === "QA_TODO"
                ? {
                    name: "todo",
                    args: issued.has(marker)
                      ? { op: "done", task: "Native fixture task" }
                      : { op: "init", items: ["Native fixture task"] },
                  }
                : marker === "QA_TASK"
                  ? {
                      name: "task",
                      args: {
                        task: "QA_CHILD",
                        solutionSpace: "Return fixture text",
                        agent: "task",
                        isolated: false,
                        tools: [],
                      },
                    }
                  : undefined;
        if (tool && !issued.has(key)) {
          issued.add(key);
          response.write(
            chunk(
              {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: `call-${key}`,
                    type: "function",
                    function: { name: tool.name, arguments: JSON.stringify(tool.args) },
                  },
                ],
              },
              null,
            ),
          );
          response.write(chunk({}, "tool_calls"));
        } else {
          response.write(chunk({ role: "assistant", content: `DONE_${marker}` }, null));
          response.write(chunk({}, "stop"));
        }
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
          const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "omp-native-fixture-" });
          const agent = path.join(temporary, "agent");
          workspace = path.join(temporary, "workspace");
          yield* fs.makeDirectory(agent);
          yield* fs.makeDirectory(workspace);
          yield* fs.writeFileString(path.join(workspace, "fixture.txt"), "NATIVE_READ_CONTENT");
          yield* fs.writeFileString(
            path.join(agent, "config.yml"),
            JSON.stringify({
              modelRoles: { default: "fixture/fixture" },
              retry: { enabled: false, maxRetries: 0 },
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
          const instanceId = ProviderInstanceId.make("omp-native");
          const config = {
            ...OmpAdapterDriver.defaultConfig(),
            enabled: true,
            binaryPath: launcher,
            agentDir: agent,
            launchArgs:
              "--no-extensions --no-skills --no-rules --no-context-files --no-title --no-lsp --no-pty --no-judge --no-spotlight --no-prewalk --tools read,write,todo,task",
          };
          const probeEnvironment = { ...environment, PI_CODING_AGENT_DIR: agent };
          const inventory = yield* checkOmpProviderStatus(config, probeEnvironment, workspace);
          assert(
            inventory?.installed &&
              inventory.models.some((model) => model.slug === "fixture/fixture"),
          );
          assert.equal(inventory.version, "18.20.2");
          for (const binaryPath of [path.join(temporary, "missing-omp"), bun]) {
            const unavailable = yield* checkOmpProviderStatus(
              { ...config, binaryPath },
              probeEnvironment,
              workspace,
            );
            assert.equal(unavailable?.status, "error");
            assert.equal(unavailable?.installed, binaryPath === bun);
          }
          const adapter = yield* OmpAdapterDriver.create({
            instanceId,
            displayName: undefined,
            enabled: true,
            environment: [],
            config,
          }).pipe(Effect.provideService(HostProcess.Environment, environment));
          const threadId = ThreadId.make("omp-native-thread");
          const modelSelection = { instanceId, model: "fixture/fixture" };
          const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "approval-required",
            interactionMode: "default",
            cwd: workspace,
          });
          const runtime = yield* adapter.openSession({
            threadId,
            providerSessionId: ProviderSessionId.make("omp-native-session"),
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
            projectId: ProjectId.make("omp-native-project"),
            title: "Native OMP fixture",
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
          const turns = new Map<string, OrchestrationV2ProviderTurn>();
          const failures: string[] = [];
          let ordinal = 0;
          const start = (text: string) =>
            Effect.gen(function* () {
              yield* Effect.logInfo("OMP_NATIVE_START", text);
              ordinal += 1;
              yield* runtime.startTurn({
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
                  createdBy: "user",
                  creationSource: "web",
                },
                modelSelection,
                runtimePolicy,
              });
            });
          const settle = (decision: "accept" | "decline" = "accept", status = "completed") =>
            Effect.gen(function* () {
              const approvals = new Set<string>();
              while (true) {
                const event = yield* Queue.take(events);
                if (event.type === "provider_thread.updated") providerThread = event.providerThread;
                if (event.type === "provider_turn.updated")
                  turns.set(event.providerTurn.id, event.providerTurn);
                if (
                  event.type === "runtime_request.updated" &&
                  event.runtimeRequest.status === "pending" &&
                  !approvals.has(event.runtimeRequest.id)
                ) {
                  approvals.add(event.runtimeRequest.id);
                  yield* runtime.respondToRuntimeRequest({
                    requestId: event.runtimeRequest.id,
                    decision,
                  });
                }
                if (event.type === "turn.terminal" && event.runOrdinal === ordinal) {
                  assert.equal(event.status, status, JSON.stringify(event));
                  yield* Effect.logInfo("OMP_NATIVE_SETTLED", ordinal, approvals.size);
                  return approvals.size;
                }
              }
            });
          yield* start("QA_READ");
          yield* settle();
          assert(
            requests.some((body) => body.includes("NATIVE_READ_CONTENT")),
            "Native read result reached model",
          );
          assert(
            captured.some(
              (event) =>
                event.type === "message.updated" &&
                JSON.stringify(event.message).includes("DONE_QA_READ"),
            ),
          );
          const first = [...turns.values()].find((turn) => turn.ordinal === 1);
          assert(first);
          yield* start("QA_ALLOW");
          const allowApprovals = yield* settle();
          assert.equal(yield* fs.readFileString(path.join(workspace, "QA_ALLOW.txt")), "QA_ALLOW");
          yield* start("QA_DENY");
          assert.equal(yield* settle("decline"), 1);
          assert.equal(yield* fs.exists(path.join(workspace, "QA_DENY.txt")), false);
          yield* start("QA_TODO");
          yield* settle();
          assert(
            captured.some(
              (event) =>
                event.type === "plan.updated" &&
                event.plan.kind === "todo_list" &&
                event.plan.steps.some((step) => step.text === "Tasks: Native fixture task"),
            ),
          );
          yield* start("QA_TASK");
          yield* settle();
          assert(
            captured.some(
              (event) => event.type === "subagent.updated" && event.subagent.status === "completed",
            ),
            "Native task completion must project through the Cox adapter",
          );
          const source = providerThread.nativeThreadRef?.nativeId;
          assert(source);
          const fork = yield* runtime.forkThread({
            sourceProviderThread: providerThread,
            sourceProviderTurns: [...turns.values()],
            providerTurnId: first.id,
            targetThreadId: ThreadId.make("omp-native-fork"),
          });
          assert(fork.nativeThreadRef?.nativeId);
          assert.notEqual(fork.nativeThreadRef.nativeId, source);
          const forkText = yield* fs.readFileString(fork.nativeThreadRef.nativeId);
          assert(forkText.includes("QA_READ"));
          if (forkText.includes("QA_ALLOW")) failures.push("fork retained the next user turn");
          yield* Effect.logInfo(
            "OMP_NATIVE_FORK",
            JSON.stringify({ retainedNextTurn: forkText.includes("QA_ALLOW") }),
          );
          providerThread = yield* runtime.resumeThread({
            providerThread,
            threadId,
            modelSelection,
            runtimePolicy,
          });
          assert.equal(providerThread.nativeThreadRef?.nativeId, source);
          const rollback = yield* runtime.rollbackThread({
            providerThread,
            target: {
              type: "provider_turn",
              checkpointId: CheckpointId.make("native-checkpoint"),
              appRunOrdinal: 1,
              providerTurn: first,
            },
            providerThreadTurns: [...turns.values()],
          });
          providerThread = rollback.providerThread;
          const before = requests.length;
          yield* start("QA_AFTER_ROLLBACK");
          yield* settle();
          assert(requests.slice(before).every((body) => body.includes("QA_READ")));
          if (requests.slice(before).some((body) => body.includes("QA_ALLOW")))
            failures.push("rollback retained the next user turn");
          yield* start("QA_HOLD");
          yield* Effect.promise(() => held.promise);
          const active = captured.findLast(
            (event) =>
              event.type === "provider_turn.updated" &&
              event.providerTurn.runAttemptId === RunAttemptId.make(`attempt-${ordinal}`),
          );
          assert(active?.type === "provider_turn.updated");
          const heldTurn = active.providerTurn;
          yield* runtime.steerTurn({
            threadId,
            runId: RunId.make(`run-${ordinal}`),
            providerThread,
            providerTurnId: heldTurn.id,
            message: {
              messageId: MessageId.make("queued"),
              text: "QA_QUEUED_MUST_NOT_RUN",
              attachments: [],
              createdBy: "user",
              creationSource: "web",
            },
          });
          const admitted = yield* Effect.gen(function* () {
            while (true) {
              const event = yield* Queue.take(events);
              if (
                event.type === "steer.updated" &&
                event.messageId === MessageId.make("queued") &&
                event.status === "pending"
              )
                return event;
            }
          }).pipe(Effect.timeoutOption("3 seconds"));
          if (Option.isNone(admitted)) failures.push("queued steer admission was not projected");
          yield* runtime.interruptTurn({ providerThread, providerTurnId: heldTurn.id });
          yield* settle("accept", "interrupted");
          if (
            !captured.some(
              (event) =>
                event.type === "steer.updated" &&
                event.messageId === MessageId.make("queued") &&
                event.status === "cancelled",
            )
          )
            failures.push("withdrawn steer cancellation was not projected");
          yield* start("QA_RECOVERED");
          yield* settle();
          assert(!requests.some((body) => body.includes("QA_QUEUED_MUST_NOT_RUN")));
          const rootRollback = yield* runtime.rollbackThread({
            providerThread,
            target: {
              type: "thread_start",
              checkpointId: CheckpointId.make("native-root-checkpoint"),
              appRunOrdinal: 0,
            },
            providerThreadTurns: [...turns.values()],
          });
          providerThread = rootRollback.providerThread;
          const rootSnapshot = yield* runtime.readThreadSnapshot({ providerThread });
          assert.equal(
            rootSnapshot.messages.filter((message) => message.role === "user").length,
            0,
          );
          const beforeRoot = requests.length;
          yield* start("QA_AFTER_ROOT");
          yield* settle();
          const rootRequests = requests.slice(beforeRoot);
          assert.equal(rootRequests.length, 1);
          assert(rootRequests[0]?.includes("QA_AFTER_ROOT"));
          const priorInput =
            /QA_(?:READ|ALLOW|DENY|TODO|TASK|CHILD|AFTER_ROLLBACK|HOLD|RECOVERED|QUEUED_MUST_NOT_RUN)/;
          assert(rootRequests.every((body) => !priorInput.test(body)));
          const rootFile = providerThread.nativeThreadRef?.nativeId;
          assert(rootFile);
          const rootText = yield* fs.readFileString(rootFile);
          assert(rootText.includes("QA_AFTER_ROOT"));
          assert(
            !priorInput.test(rootText),
            "Thread-start rollback must retain no earlier user input",
          );
          if (allowApprovals !== 1)
            failures.push(`write had ${allowApprovals} approvals instead of one`);
          const tracePath = process.env.COX_OMP_QA_TRACE;
          if (tracePath)
            yield* fs.writeFileString(
              tracePath,
              JSON.stringify({ requests, events: captured }, null, 2),
            );
          yield* Effect.logInfo(
            "OMP_NATIVE_ADAPTER_RESULT",
            JSON.stringify({
              requests: requests.length,
              events: captured.length,
              read: true,
              allow: true,
              deny: true,
              todo: true,
              tasks: true,
              models: true,
              installationErrors: true,
              resume: true,
              atomicStop: true,
              threadStartRollback: true,
              failures,
            }),
          );
          assert.deepEqual(
            failures,
            [],
            "Native adapter behavior must match the advertised contracts",
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
          Effect.timeout("100 seconds"),
        ),
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

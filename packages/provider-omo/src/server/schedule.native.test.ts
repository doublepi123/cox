import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Local HTTP fixtures exercise native launcher transport.
import { createServer } from "node:http";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { PI_T3_MCP_EXTENSION_SOURCE } from "@t3tools/provider-pi/server";
import { expect, it } from "vite-plus/test";
import { buildOmoLaunch, OMO_EXTENSION_SOURCE } from "./extension.ts";
import { makeOmoRpcConnection } from "./runtime.ts";

it.skipIf(!process.env.COX_OMO_NPM_TEST_LAUNCHER)(
  "overrides the enabled native scheduler with thread-bound Cox tasks",
  async () => {
    const calls: Array<{ readonly name: string; readonly arguments: Record<string, unknown> }> = [];
    const requests: Array<string> = [];
    const task = {
      scheduledTaskId: "scheduled-native",
      title: "Scheduled prompt: Check progress",
      prompt: "Check progress",
      enabled: true,
      projectId: "project-fixture",
      boundThreadId: "thread-fixture",
      freshSession: false,
      schedule: { type: "once", runAt: "2026-11-14T00:10:00.000Z" },
      nextRunAt: "2026-11-14T00:10:00.000Z",
      lastRunStatus: null,
    };
    const steps = [
      { action: "create", prompt: "Check progress", delaySeconds: 600 },
      { action: "list" },
      { action: "cancel", id: "unknown" },
      { action: "cancel", id: task.scheduledTaskId },
    ];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += String(chunk);
      });
      request.on("end", () => {
        if (request.url === "/mcp") {
          expect(request.headers.authorization).toBe("Bearer fixture-token");
          const rpc = JSON.parse(body) as {
            readonly id?: number;
            readonly method: string;
            readonly params?: {
              readonly name: string;
              readonly arguments: Record<string, unknown>;
            };
          };
          if (rpc.id === undefined) {
            response.writeHead(202);
            response.end();
            return;
          }
          let result: object = {};
          switch (rpc.method) {
            case "initialize":
              result = {
                protocolVersion: "2025-06-18",
                capabilities: { tools: {} },
                serverInfo: { name: "fixture", version: "1" },
              };
              break;
            case "tools/list":
              result = {
                tools: Object.entries({
                  schedule_task: {
                    prompt: { type: "string" },
                    schedule: { type: "object" },
                    bindToCurrentThread: { type: "boolean" },
                  },
                  delete_scheduled_task: { scheduledTaskId: { type: "string" } },
                  list_scheduled_tasks: {},
                  cox_thread_configure: {},
                  orchestrator_capabilities: {},
                  delegate_task: {},
                  task_status: {},
                }).map(([name, properties]) => ({
                  name,
                  inputSchema: { type: "object", properties },
                })),
              };
              break;
            case "tools/call": {
              if (!rpc.params) throw new Error("Missing fixture tool parameters");
              calls.push(rpc.params);
              const data =
                rpc.params.name === "schedule_task"
                  ? { ...task, ...rpc.params.arguments }
                  : rpc.params.name === "list_scheduled_tasks"
                    ? { tasks: [task] }
                    : rpc.params.name === "cox_thread_configure"
                      ? {
                          threadId: task.boundThreadId,
                          modelSelection: {},
                          runtimeMode: "full-access",
                          interactionMode: "default",
                        }
                      : { scheduledTaskId: rpc.params.arguments.scheduledTaskId, deleted: true };
              result = {
                content: [{ type: "text", text: JSON.stringify(data) }],
                structuredContent: data,
              };
              break;
            }
            default:
              throw new Error("Unexpected fixture MCP method: " + rpc.method);
          }
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
          return;
        }
        const step = steps[requests.length];
        requests.push(body);
        const chunk = (delta: object, finish: string | null) =>
          `data: ${JSON.stringify({
            id: "offline-" + requests.length,
            object: "chat.completion.chunk",
            created: 1,
            model: "fixture",
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`;
        response.writeHead(200, { "content-type": "text/event-stream" });
        const delta = step
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: "schedule-" + requests.length,
                  type: "function",
                  function: { name: "schedule_prompt", arguments: JSON.stringify(step) },
                },
              ],
            }
          : { content: "Scheduling verified." };
        response.write(chunk({ role: "assistant", ...delta }, null));
        response.write(chunk({}, step ? "tool_calls" : "stop"));
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
          const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "cox-omo-schedule-" });
          const agent = path.join(temporary, "agent");
          yield* fs.makeDirectory(agent);
          const extensionPath = path.join(temporary, "cox.ts");
          yield* fs.writeFileString(extensionPath, OMO_EXTENSION_SOURCE);
          yield* fs.writeFileString(
            path.join(temporary, "pi-t3-mcp-extension.ts"),
            PI_T3_MCP_EXTENSION_SOURCE,
          );
          yield* fs.writeFileString(
            path.join(agent, "settings.json"),
            JSON.stringify({
              enabledBuiltinExtensions: ["permission-system", "goal", "schedule"],
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
          const launch = buildOmoLaunch({
            launchArgs: ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes"],
            environment: {
              HOME: temporary,
              USERPROFILE: temporary,
              PATH: process.env.PATH,
              TMPDIR: process.env.TMPDIR,
              XDG_CONFIG_HOME: temporary,
              XDG_CACHE_HOME: temporary,
              OMO_CODING_AGENT_DIR: agent,
              SENPI_CODING_AGENT_DIR: agent,
              OMO_RUNTIME: "node",
              COX_OMO_AUTOMATIC_MEMORY: "0",
              CI: "1",
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_CONFIG_GLOBAL: path.join(temporary, "gitconfig"),
            },
            mcpSession: {
              environmentId: EnvironmentId.make("local"),
              threadId: ThreadId.make("thread-fixture"),
              providerSessionId: "fixture-session",
              providerInstanceId: ProviderInstanceId.make("omo"),
              endpoint: `http://127.0.0.1:${address.port}/mcp`,
              authorizationHeader: "Bearer fixture-token",
              browserToolsAvailable: false,
            },
            extensionPath,
            runtimeMode: "full-access",
            disableTools: false,
          });
          const launcher = process.env.COX_OMO_NPM_TEST_LAUNCHER;
          if (!launcher) throw new Error("Native launcher missing");
          const connection = yield* makeOmoRpcConnection({
            command: process.execPath,
            args: [launcher, ...launch.args],
            cwd: temporary,
            env: launch.env,
          });
          yield* connection.request({ type: "prompt", message: "Exercise scheduled prompts." });
          const toolResults: Array<Record<string, unknown>> = [];
          while (true) {
            const event = yield* Queue.take(connection.events);
            if (event.type === "tool_execution_end") toolResults.push(event);
            if (event.type === "agent_end") break;
          }
          expect(calls.find((call) => call.name === "schedule_task")?.arguments).toMatchObject({
            schedule: { type: "once" },
            bindToCurrentThread: true,
          });
          expect(calls.filter((call) => call.name === "list_scheduled_tasks")).toHaveLength(4);
          expect(calls.filter((call) => call.name === "delete_scheduled_task")).toEqual([
            { name: "delete_scheduled_task", arguments: { scheduledTaskId: task.scheduledTaskId } },
          ]);
          expect(toolResults).toHaveLength(4);
          expect(toolResults[2]).toMatchObject({ isError: true });
          expect(requests[3]).toContain("No scheduled job unknown in this session.");
          const pending = path.join(agent, "schedule", "pending");
          expect((yield* fs.exists(pending)) ? yield* fs.readDirectory(pending) : []).toEqual([]);
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.timeout("45 seconds")),
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

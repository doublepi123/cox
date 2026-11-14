import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Local HTTP fixtures exercise native launcher transport.
import { createServer } from "node:http";
import { PI_T3_MCP_EXTENSION_SOURCE, type PiRpcRecord } from "@t3tools/provider-pi/server";
import { expect, it } from "vite-plus/test";
import { OmoSettings } from "../settings.ts";
import { omoTaskConfiguration } from "./configuration.ts";
import {
  buildOmoLaunch,
  OMO_CHILD_COMPLETION_CONTRACT,
  OMO_EXTENSION_SOURCE,
} from "./extension.ts";
import { makeOmoRpcConnection, OMO_WAIT_STATUS_KEY } from "./runtime.ts";

const fixtureSettings = Schema.decodeSync(OmoSettings)({ provider: "cox", model: "fixture" });

it.skipIf(!process.env.COX_OMO_NPM_TEST_LAUNCHER)(
  "tells one-shot children that wakes are lost and settles a root that only waits on its monitor",
  async () => {
    const parentTools: Array<ReadonlyArray<string>> = [];
    const childPrompts: Array<string> = [];
    let report = "";
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += String(chunk);
      });
      request.on("end", () => {
        const parsed = JSON.parse(body) as {
          readonly tools?: ReadonlyArray<{ readonly function?: { readonly name?: string } }>;
          readonly messages?: ReadonlyArray<{ readonly role?: string; readonly content?: unknown }>;
        };
        const prompt = JSON.stringify(
          parsed.messages?.find((message) => message.role === "user")?.content ?? "",
        );
        const child = prompt.includes("PRODUCER:");
        if (child) childPrompts.push(prompt);
        else
          parentTools.push(
            (parsed.tools ?? []).flatMap((tool) =>
              typeof tool.function?.name === "string" ? [tool.function.name] : [],
            ),
          );
        const step = child
          ? undefined
          : [
              {
                name: "task",
                arguments: {
                  description: "Producer",
                  prompt: "PRODUCER: write the report once the copy finishes.",
                  category: "quick",
                  run_in_background: false,
                },
              },
              { name: "monitor", arguments: { description: "Producer report", path: report } },
            ][parentTools.length - 1];
        const chunk = (delta: object, finish: string | null) =>
          `data: ${JSON.stringify({
            id: "offline-" + (parentTools.length + childPrompts.length),
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
                  id: "call-" + parentTools.length,
                  type: "function",
                  function: { name: step.name, arguments: JSON.stringify(step.arguments) },
                },
              ],
            }
          : { content: child ? "Report pending: the copy is unfinished." : "Report handled." };
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
          const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "cox-omo-waits-" });
          report = path.join(temporary, "report.md");
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
              enabledBuiltinExtensions: ["permission-system", "goal", "terminal"],
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
          const config = omoTaskConfiguration(fixtureSettings, path.join(agent, "tasks"));
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
              COX_OMO_TASK_CONFIG: JSON.stringify(config),
              CI: "1",
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_CONFIG_GLOBAL: path.join(temporary, "gitconfig"),
            },
            mcpSession: undefined,
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
          const events: Array<PiRpcRecord> = [];
          const until = (predicate: (event: PiRpcRecord) => boolean) =>
            Effect.gen(function* () {
              while (true) {
                const event = yield* Queue.take(connection.events);
                events.push(event);
                if (predicate(event)) return event;
              }
            });
          const waitStatus = (event: PiRpcRecord) =>
            event.type === "extension_ui_request" &&
            event.method === "setStatus" &&
            event.statusKey === OMO_WAIT_STATUS_KEY;

          yield* connection.request({ type: "prompt", message: "Delegate, then wait." });
          yield* until((event) => event.type === "agent_settled");
          expect(childPrompts).toHaveLength(1);
          expect(childPrompts[0]).toContain(
            JSON.stringify(OMO_CHILD_COMPLETION_CONTRACT).slice(1, -1),
          );
          expect(parentTools).toHaveLength(3);
          expect(events.filter(waitStatus)).toEqual([
            expect.objectContaining({ statusText: expect.stringContaining("terminal monitors") }),
          ]);
          expect(yield* connection.request({ type: "get_state" })).toMatchObject({
            isStreaming: false,
            lifecycle: {
              state: "waiting_background",
              waitingOn: { children: 0, background: [{ source: "terminal-monitors" }] },
            },
          });

          yield* fs.writeFileString(report, "report\n");
          yield* until((event) => event.type === "agent_start");
          expect(events.filter(waitStatus).at(-1)).not.toHaveProperty("statusText");
          yield* until((event) => event.type === "agent_settled");
          expect(parentTools).toHaveLength(4);
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.timeout("60 seconds")),
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

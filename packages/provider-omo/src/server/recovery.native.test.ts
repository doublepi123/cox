import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { createServer } from "node:http";
import { ProviderInstanceId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { PI_T3_MCP_EXTENSION_SOURCE } from "@t3tools/provider-pi/server";
import { buildOmoLaunch, OMO_EXTENSION_SOURCE } from "./extension.ts";
import { makeOmoRpcConnection } from "./runtime.ts";

it.skipIf(!process.env.COX_OMO_NPM_TEST_LAUNCHER).each(["startup", "resume"])(
  "applies selection before native %s and reaps a failed turn with stranded input",
  async (reason) => {
    let releaseFailure: (() => void) | undefined;
    let receiveModel: (model: string) => void = () => {};
    const requestedModel = new Promise<string>((resolve) => {
      receiveModel = resolve;
    });
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += String(chunk);
      });
      request.on("end", () => {
        receiveModel((JSON.parse(body) as { model: string }).model);
        releaseFailure = () => {
          response.writeHead(503, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              error: { message: "Offline model rejection", code: "model_not_found" },
            }),
          );
        };
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
          const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "cox-omo-recovery-" });
          const agent = path.join(temporary, "agent");
          yield* fs.makeDirectory(agent);
          const extensionPath = path.join(temporary, "cox.ts");
          yield* fs.writeFileString(extensionPath, OMO_EXTENSION_SOURCE);
          yield* fs.writeFileString(
            path.join(temporary, "pi-t3-mcp-extension.ts"),
            PI_T3_MCP_EXTENSION_SOURCE,
          );
          yield* fs.writeFileString(
            path.join(temporary, "probe.ts"),
            `
export default function probe(pi) {
  pi.on("session_start", event => {
    if (event.reason === ${JSON.stringify(reason)}) pi.sendUserMessage("Offline automatic startup turn");
  });
}
`,
          );
          yield* fs.writeFileString(
            path.join(agent, "settings.json"),
            JSON.stringify({
              enabledBuiltinExtensions: ["permission-system", "goal"],
              retry: { enabled: false },
              defaultProvider: "cox",
              defaultModel: "wrong",
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
                  models: ["wrong", "selected"].map((id) => ({
                    id,
                    name: id,
                    contextWindow: 200000,
                    maxTokens: 1024,
                  })),
                },
              },
            }),
          );
          const launch = buildOmoLaunch({
            launchArgs: [
              "--no-extensions",
              "--no-skills",
              "--no-prompt-templates",
              "--no-themes",
              "--extension",
              path.join(temporary, "probe.ts"),
            ],
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
            modelSelection: {
              instanceId: ProviderInstanceId.make("omo"),
              model: reason === "startup" ? "cox/selected" : "cox/wrong",
              options: [],
            },
            mcpSession: undefined,
            extensionPath,
            runtimeMode: "approval-required",
            disableTools: true,
          });
          const connection = yield* makeOmoRpcConnection({
            command: process.execPath,
            args: [process.env.COX_OMO_NPM_TEST_LAUNCHER!, ...launch.args],
            cwd: temporary,
            env: launch.env,
          });
          if (reason === "resume") {
            const sessionPath = path.join(temporary, "resume.jsonl");
            const timestamp = "2026-11-13T00:00:00.000Z";
            yield* fs.writeFileString(
              sessionPath,
              [
                {
                  type: "session",
                  version: 3,
                  id: "00000000-0000-4000-8000-000000000001",
                  timestamp,
                  cwd: temporary,
                },
                {
                  type: "model_change",
                  id: "11111111",
                  parentId: null,
                  timestamp,
                  provider: "cox",
                  modelId: "wrong",
                },
                {
                  type: "message",
                  id: "22222222",
                  parentId: "11111111",
                  timestamp,
                  message: {
                    role: "user",
                    content: [{ type: "text", text: "Previous offline task" }],
                    timestamp: 1794528000000,
                  },
                },
              ]
                .map((entry) => JSON.stringify(entry))
                .join("\n") + "\n",
            );
            yield* connection.request({
              type: "extension_request",
              name: "cox.omo.prepare",
              data: { model: "cox/selected" },
            });
            yield* connection.request({ type: "switch_session", sessionPath });
          }
          expect(yield* Effect.promise(() => requestedModel)).toBe("selected");
          expect(yield* connection.request({ type: "get_state" })).toMatchObject({
            model: { provider: "cox", id: "selected" },
            coxBaselineModel: { provider: "cox", id: "wrong" },
          });
          yield* connection.request({
            type: "prompt",
            message: "Input arriving during the failed request",
            streamingBehavior: "steer",
          });
          yield* Effect.sync(() => releaseFailure?.());
          let sawFailure = false;
          while (!sawFailure) {
            const event = yield* Queue.take(connection.events);
            const message = event.message as { stopReason?: string } | undefined;
            sawFailure = event.type === "message_end" && message?.stopReason === "error";
          }
          yield* connection.exited.pipe(Effect.ignore);
          expect(sawFailure).toBe(true);
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.timeout("30 seconds")),
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

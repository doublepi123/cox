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

const chunk = (delta: unknown, finish_reason: string | null = null) =>
  `data: ${JSON.stringify({ id: "retry", object: "chat.completion.chunk", model: "selected", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;

type AssistantMessage = {
  readonly stopReason?: string;
  readonly content?: ReadonlyArray<{ readonly text?: string }>;
};

it.skipIf(!process.env.COX_OMO_NPM_TEST_LAUNCHER)(
  "retries a managed turn whose gateway stream was interrupted after output began",
  async () => {
    let requests = 0;
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        requests += 1;
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (requests === 1) {
          response.end(
            chunk({ role: "assistant", content: "partial" }) +
              `event: error\ndata: ${JSON.stringify({
                type: "error",
                error: {
                  type: "stream_error",
                  code: "cox_model_service_stream_interrupted",
                  message:
                    "Connection lost: the model service stream was interrupted before protocol completion.",
                },
              })}\n\n`,
          );
          return;
        }
        response.end(
          chunk({ role: "assistant", content: "recovered" }) +
            chunk({}, "stop") +
            "data: [DONE]\n\n",
        );
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
          const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "cox-omo-retry-" });
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
              enabledBuiltinExtensions: ["permission-system"],
              retry: { enabled: true, modelFallback: false, baseDelayMs: 1 },
              defaultProvider: "cox",
              defaultModel: "selected",
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
                    { id: "selected", name: "selected", contextWindow: 200000, maxTokens: 1024 },
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
              COX_OMO_MANAGED_MODELS: "1",
              COX_OMO_ALLOWED_MODELS: JSON.stringify(["cox/selected"]),
              CI: "1",
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_CONFIG_GLOBAL: path.join(temporary, "gitconfig"),
            },
            modelSelection: {
              instanceId: ProviderInstanceId.make("omo"),
              model: "cox/selected",
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
          yield* connection.request({ type: "prompt", message: "Offline retry probe" });
          let retried = false;
          let final: AssistantMessage | undefined;
          while (final === undefined) {
            const event = yield* Queue.take(connection.events);
            if (event.type === "auto_retry_start") retried = true;
            const message = event.message as AssistantMessage | undefined;
            if (event.type === "message_end" && message?.stopReason === "stop") final = message;
          }
          expect(retried).toBe(true);
          expect(final.content?.map((part) => part.text).join("")).toBe("recovered");
          expect(requests).toBe(2);
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.timeout("30 seconds")),
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Context from "effect/Context";
import type { SDKAssistantMessage } from "@anthropic-ai/claude-agent-sdk";
import { expect, it } from "@effect/vitest";
import * as NodeModule from "node:module";
import {
  ModelServiceConfig,
  DEFAULT_MODEL_SERVICE_RECOVERY,
  ModelServiceId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  RunId,
  NodeId,
  type ProviderInstanceConfigMap,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import { TestClock } from "effect/testing";
import * as ServerConfig from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { make } from "./ModelServiceGateway.ts";
import { resolveClaudeModelServiceCatalog } from "../provider/ClaudeModelCatalog.ts";
import { makeClaudeQueryOptions } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { buildCodexTurnStartParams } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { createModelSelection } from "@t3tools/shared/model";
import { ClaudeSettings } from "@t3tools/contracts";
import type { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";

const serviceId = ModelServiceId.make("shared-test");
const instanceId = ProviderInstanceId.make("bound-test");
const decodeService = Schema.decodeSync(ModelServiceConfig);
const decodeClaudeSettings = Schema.decodeUnknownSync(ClaudeSettings);
const requireCjs = NodeModule.createRequire(import.meta.url);
const {
  default: Anthropic,
}: {
  default: new (options: {
    baseURL: string;
    apiKey: string;
    authToken: null;
    maxRetries: number;
    fetch: typeof globalThis.fetch;
  }) => {
    beta: {
      messages: {
        create: (
          body: {
            model: string;
            max_tokens: number;
            messages: { role: "user"; content: string }[];
          },
          options?: { query?: { beta: string } },
        ) => Promise<SDKAssistantMessage["message"]>;
      };
    };
  };
} = NodeModule.createRequire(requireCjs.resolve("@anthropic-ai/claude-agent-sdk"))(
  "@anthropic-ai/sdk",
);
const service = decodeService({
  name: "Shared test",
  baseUrl: "https://upstream.test/v1",
  apiKey: "private-upstream-key",
  headers: { "x-extra": "private-header" },
  protocols: ["openai-chat"],
  models: [
    {
      id: "Vendor/Exact",
      name: "Exact",
      capabilities: { contextWindow: 64000 },
      maxOutputTokens: 4000,
      supportsTools: true,
    },
    { id: "hidden", capabilities: null },
  ],
});
const layer = Layer.mergeAll(
  ServerSettingsService.layerTest({ modelServices: { [serviceId]: service } }),
  ServerConfig.layerTest(process.cwd(), { prefix: "cox-model-gateway-test-" }),
).pipe(Layer.provideMerge(NodeServices.layer));
const record = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;
const recoveryInput = (id: string) => ({
  threadId: ThreadId.make("recovery-thread"),
  runId: RunId.make(`recovery-run-${id}`),
  rootNodeId: NodeId.make(`recovery-node-${id}`),
  providerThread: {
    id: ProviderThreadId.make("recovery-provider-thread"),
    driver: ProviderDriverKind.make("claudeAgent"),
  },
});
const recoveryTurn = (id: string): ProviderAdapterV2Event => ({
  type: "provider_turn.updated",
  driver: ProviderDriverKind.make("claudeAgent"),
  providerTurn: {
    id: ProviderTurnId.make(`recovery-turn-${id}`),
    providerThreadId: recoveryInput(id).providerThread.id,
    nodeId: recoveryInput(id).rootNodeId,
    runAttemptId: null,
    nativeTurnRef: null,
    ordinal: 1,
    status: "running",
    startedAt: DateTime.makeUnsafe(0),
    completedAt: null,
  },
});
const recoveryTerminal = (
  id: string,
): Extract<ProviderAdapterV2Event, { type: "turn.terminal"; failure: null }> => ({
  type: "turn.terminal",
  driver: ProviderDriverKind.make("claudeAgent"),
  providerThreadId: recoveryInput(id).providerThread.id,
  providerTurnId: ProviderTurnId.make(`recovery-turn-${id}`),
  runOrdinal: 1,
  status: "completed",
  failure: null,
  threadDisposition: "reusable",
});

const encryptedReasoningInput = {
  model: "Vendor/Exact",
  input: [
    { role: "user", content: "keep this prompt" },
    {
      type: "reasoning",
      id: "rs_private",
      encrypted_content: "opaque-private-ciphertext",
      summary: [],
    },
    {
      type: "reasoning",
      id: "rs_summary",
      encrypted_content: "second-private-ciphertext",
      summary: [{ type: "summary_text", text: "keep this summary" }],
    },
    {
      type: "function_call",
      id: "fc_keep",
      call_id: "call_keep",
      name: "Read",
      arguments: '{"path":"file.txt"}',
    },
    { type: "function_call_output", call_id: "call_keep", output: "keep this result" },
  ],
  tools: [
    {
      type: "function",
      name: "Read",
      parameters: { type: "object", properties: {} },
      strict: false,
    },
  ],
};
const invalidEncryptedError = {
  code: "invalid_encrypted_content",
  type: "invalid_request_error",
  message:
    "The encrypted content for item rs_private could not be verified. Reason: Encrypted content could not be decrypted or parsed. opaque-private-ciphertext private-upstream-key private-header",
};
const responsesAnswer = {
  status: "completed",
  output: [
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "recovered safely" }],
    },
  ],
};
const sentBody = (request: import("effect/http/HttpClientRequest").HttpClientRequest) => {
  if (request.body._tag !== "Uint8Array") throw new Error("Expected JSON bytes");
  return JSON.parse(new TextDecoder().decode(request.body.body));
};
const sseFrame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const chatStreamFrame = (delta: unknown, finish_reason: string | null = null) =>
  sseFrame({ id: "chat-integrity", choices: [{ index: 0, delta, finish_reason }] });
const withGatewayDiagnostics = <A, E, R>(
  test: (messages: Record<string, unknown>[]) => Effect.Effect<A, E, R>,
) => {
  const messages: Record<string, unknown>[] = [];
  const logger = Logger.make(({ message }) => {
    if (Array.isArray(message))
      for (const entry of message)
        if (entry !== null && typeof entry === "object") messages.push(record(entry));
  });
  return test(messages).pipe(
    Effect.scoped,
    Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
  );
};

const harness = Effect.fn("ModelGateway.test.harness")(function* (
  options: {
    readonly driver?: string;
    readonly protocol?: ModelServiceConfig["protocols"][number];
    readonly protocols?: ModelServiceConfig["protocols"];
    readonly modelId?: string;
    readonly modelProtocols?: ModelServiceConfig["protocols"];
    readonly maxOutputTokens?: number | null;
    readonly recovery?: Partial<ModelServiceConfig["recovery"]>;
    readonly encryptedReasoningReplay?: ModelServiceConfig["encryptedReasoningReplay"];
    readonly modelReplay?: ModelServiceConfig["encryptedReasoningReplay"];
    readonly headersDelayMs?: number | ((attempt: number) => number);
    readonly respond?: (
      request: import("effect/http/HttpClientRequest").HttpClientRequest,
    ) => Response;
  } = {},
) {
  const calls: import("effect/http/HttpClientRequest").HttpClientRequest[] = [];
  const settings = yield* ServerSettingsService;
  const previous = (yield* settings.getSettings).modelServices[serviceId];
  yield* settings.updateSettings({
    modelServices: {
      [serviceId]: {
        ...service,
        revision: previous?.revision ?? 0,
        protocols: options.protocols ?? [options.protocol ?? "openai-chat"],
        ...(options.encryptedReasoningReplay
          ? { encryptedReasoningReplay: options.encryptedReasoningReplay }
          : {}),
        models: service.models.map((model) => {
          if (model.id !== "Vendor/Exact") return model;
          const { maxOutputTokens: defaultBudget, ...rest } = model;
          return {
            ...rest,
            id: options.modelId ?? model.id,
            ...(options.modelProtocols ? { protocols: options.modelProtocols } : {}),
            ...(options.modelReplay ? { encryptedReasoningReplay: options.modelReplay } : {}),
            ...(options.maxOutputTokens === null
              ? {}
              : { maxOutputTokens: options.maxOutputTokens ?? defaultBudget }),
          };
        }),
        recovery: {
          ...DEFAULT_MODEL_SERVICE_RECOVERY,
          retryEnabled: false,
          hedgeEnabled: false,
          ...options.recovery,
        },
      },
    },
  });
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      calls.push(request);
      const headersDelayMs =
        typeof options.headersDelayMs === "function"
          ? options.headersDelayMs(calls.length)
          : options.headersDelayMs;
      if (headersDelayMs) yield* Effect.sleep(headersDelayMs);
      return HttpClientResponse.fromWeb(
        request,
        options.respond?.(request) ??
          Response.json({
            id: "chat-test",
            model: "Vendor/Exact",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "answer" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
          }),
      );
    }),
  );
  let gateway = yield* make.pipe(Effect.provideService(HttpClient.HttpClient, http));
  const driver = ProviderDriverKind.make(options.driver ?? "codex");
  const instances: ProviderInstanceConfigMap = {
    [instanceId]: {
      driver,
      enabled: true,
      modelService: {
        serviceId,
        modelIds: [options.modelId ?? "Vendor/Exact"],
        defaultModel: options.modelId ?? "Vendor/Exact",
      },
      config: { launchArgs: "", retained: true },
    },
  };
  const materialized = yield* gateway.materialize(yield* settings.getSettings, instances);
  const config = record(materialized[instanceId]!.config);
  let token =
    typeof config.apiKey === "string" && config.apiKey
      ? config.apiKey
      : materialized[instanceId]!.environment?.find((item) => item.name === "COX_MODEL_SERVICE_KEY")
          ?.value;
  const invoke = Effect.fn("ModelGateway.test.invoke")(function* (
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    const request = HttpServerRequest.fromWeb(
      new Request("http://127.0.0.1/api/model-gateway" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          ...(typeof token === "string" ? { authorization: `Bearer ${token}` } : {}),
          "content-type": "application/json",
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    const response = yield* gateway.handle.pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, request),
    );
    const text = yield* Effect.promise(() => HttpServerResponse.toWeb(response).text());
    return { status: response.status, headers: response.headers, text };
  }, Effect.scoped);
  const restart = Effect.fn("ModelGateway.test.restart")(function* () {
    gateway = yield* make.pipe(Effect.provideService(HttpClient.HttpClient, http));
    const current = yield* gateway.materialize(yield* settings.getSettings, instances);
    const fresh = record(current[instanceId]!.config);
    token =
      typeof fresh.apiKey === "string" && fresh.apiKey
        ? fresh.apiKey
        : current[instanceId]!.environment?.find((item) => item.name === "COX_MODEL_SERVICE_KEY")
            ?.value;
    return current;
  });
  const context = yield* Effect.context<never>();
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    expect(new URL(request.url).origin).toBe("http://127.0.0.1:0");
    return Effect.runPromiseWith(context)(
      Effect.gen(function* () {
        const response = yield* gateway.handle.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(request),
          ),
        );
        const body = yield* Effect.promise(() => HttpServerResponse.toWeb(response).arrayBuffer());
        return new Response(body, { status: response.status, headers: response.headers });
      }).pipe(Effect.scoped),
    );
  };
  return {
    gateway,
    instances,
    materialized,
    config,
    token,
    calls,
    invoke,
    settings,
    restart,
    fetch,
  };
});

it.layer(layer)("model service gateway", (it) => {
  it.effect.each([false, true])(
    "passes native tool streams through and converts only mismatched clients (convert=%s)",
    (convert) =>
      withGatewayDiagnostics((logs) =>
        Effect.gen(function* () {
          for (const gpt of [false, true]) {
            const modelId = gpt ? "gpt-6.1-terra" : "claude-fable";
            const tool = {
              type: "function_call",
              id: "fc_test",
              call_id: "call_test",
              name: "read_file",
              arguments: '{"path":"a.txt"}',
              status: "completed",
            };
            const response = {
              id: "resp_test",
              status: "completed",
              model: modelId,
              output: [tool],
              usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 },
            };
            const frames = gpt
              ? [
                  {
                    type: "response.created",
                    response: { ...response, status: "in_progress", output: [] },
                  },
                  {
                    type: "response.output_item.added",
                    output_index: 0,
                    item: { ...tool, arguments: "", status: "in_progress" },
                  },
                  {
                    type: "response.function_call_arguments.delta",
                    item_id: tool.id,
                    output_index: 0,
                    delta: tool.arguments,
                  },
                  {
                    type: "response.function_call_arguments.done",
                    item_id: tool.id,
                    output_index: 0,
                    arguments: tool.arguments,
                  },
                  { type: "response.output_item.done", output_index: 0, item: tool },
                  { type: "response.completed", response },
                ]
              : [
                  {
                    type: "message_start",
                    message: {
                      id: "msg_test",
                      type: "message",
                      role: "assistant",
                      model: modelId,
                      content: [],
                      usage: { input_tokens: 2, output_tokens: 0 },
                    },
                  },
                  {
                    type: "content_block_start",
                    index: 0,
                    content_block: {
                      type: "tool_use",
                      id: "call_test",
                      name: "read_file",
                      input: {},
                    },
                  },
                  {
                    type: "content_block_delta",
                    index: 0,
                    delta: { type: "input_json_delta", partial_json: tool.arguments },
                  },
                  { type: "content_block_stop", index: 0 },
                  {
                    type: "message_delta",
                    delta: { stop_reason: "tool_use", stop_sequence: null },
                    usage: { output_tokens: 2 },
                  },
                  { type: "message_stop" },
                ];
            const text = frames.map((frame) => `event: ${frame.type}\n${sseFrame(frame)}`).join("");
            const h = yield* harness({
              driver: "omo",
              modelId,
              protocols: ["gemini", "openai-chat", "openai-responses", "anthropic-messages"],
              respond: () =>
                new Response(text, { headers: { "content-type": "text/event-stream" } }),
            });
            const result = yield* h.invoke(
              convert ? "/v1/chat/completions" : gpt ? "/v1/responses" : "/v1/messages",
              {
                model: modelId,
                stream: true,
                ...(gpt && !convert
                  ? { input: "read a.txt" }
                  : { messages: [{ role: "user", content: "read a.txt" }] }),
              },
            );
            expect(result.status).toBe(200);
            expect(result.text).toContain("read_file");
            expect(result.text).toContain("call_test");
            expect(result.text).not.toContain("cox_model_service_incomplete_stream");
            if (!convert) expect(result.text).toBe(text);
            else expect(result.text).toContain("[DONE]");
            expect(h.calls).toHaveLength(1);
            expect(h.calls[0]!.url).toBe(
              `https://upstream.test/v1/${gpt ? "responses" : "messages"}`,
            );
          }
          const terminals = logs.filter((entry) => entry.event === "stream_terminal");
          expect(terminals).toHaveLength(2);
          for (const terminal of terminals) expect(terminal.converted).toBe(convert);
        }),
      ),
  );

  it.effect.each(["pi", "omo", "opencode"])(
    "materializes mixed native protocols without conversion for %s",
    (driver) =>
      Effect.gen(function* () {
        const h = yield* harness({
          driver,
          modelId: "openai/gpt-6.1-terra",
          protocols: ["openai-chat", "openai-responses", "anthropic-messages"],
          respond: () => Response.json(responsesAnswer),
        });
        const current = yield* h.settings.getSettings;
        const baseService = current.modelServices[serviceId]!;
        yield* h.settings.updateSettings({
          modelServices: {
            [serviceId]: {
              ...baseService,
              models: [...baseService.models, { id: "kimi-k3.1-pro", capabilities: null }],
            },
          },
        });
        const instances = {
          [instanceId]: { ...h.instances[instanceId]!, modelService: { serviceId, modelIds: [] } },
        };
        for (const phase of ["initial", "restart"]) {
          if (phase === "restart") yield* h.restart();
          const materialized = yield* h.gateway.materialize(
            yield* h.settings.getSettings,
            instances,
          );
          const config = record(materialized[instanceId]!.config);
          if (driver === "opencode") {
            const generated = JSON.parse(
              String(
                materialized[instanceId]!.environment!.find(
                  (entry) => entry.name === "OPENCODE_CONFIG_CONTENT",
                )!.value,
              ),
            );
            expect(generated.provider.cox.models["openai/gpt-6.1-terra"]).toMatchObject({
              provider: { npm: "@ai-sdk/openai" },
            });
            expect(generated.provider.cox.models["kimi-k3.1-pro"]).toMatchObject({
              provider: { npm: "@ai-sdk/openai-compatible" },
            });
            expect(generated.provider.cox.options.baseURL).toBe(
              "http://127.0.0.1:0/api/model-gateway/v1",
            );
            expect(generated.provider.cox.models.hidden.provider.npm).toBe("@ai-sdk/anthropic");
          } else {
            const fs = yield* FileSystem.FileSystem;
            const generated = JSON.parse(
              yield* fs.readFileString(String(config.agentDir) + "/models.json"),
            );
            expect(generated.providers.cox.models).toMatchObject([
              {
                id: "openai/gpt-6.1-terra",
                api: "openai-responses",
                baseUrl: "http://127.0.0.1:0/api/model-gateway/v1",
                compat: { supportsStrictMode: true },
              },
              {
                id: "hidden",
                api: "anthropic-messages",
                baseUrl: "http://127.0.0.1:0/api/model-gateway",
              },
              {
                id: "kimi-k3.1-pro",
                api: "openai-completions",
                baseUrl: "http://127.0.0.1:0/api/model-gateway/v1",
              },
            ]);
            expect(generated.providers.cox.models[1].compat).toBeUndefined();
            expect(generated.providers.cox.models[2].compat).toBeUndefined();
          }
        }
        const response = yield* h.invoke("/v1/responses", {
          model: "openai/gpt-6.1-terra",
          input: "hello",
        });
        expect(response.status).toBe(200);
        expect(JSON.parse(response.text)).toEqual(responsesAnswer);
        expect(h.calls[0]!.url).toBe("https://upstream.test/v1/responses");
      }).pipe(Effect.scoped),
  );

  it.effect.each([
    { modelId: "gpt-6.1-terra", endpoint: "/responses", response: responsesAnswer },
    {
      modelId: "kimi-k3.1-pro",
      endpoint: "/chat/completions",
      response: {
        id: "chat_test",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "recovered safely" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
      },
    },
    {
      modelId: "gemini-3.8-flash",
      endpoint: "/messages",
      response: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "recovered safely" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 2, output_tokens: 2 },
      },
    },
  ])(
    "routes and converts Chat to the model-selected $endpoint",
    ({ modelId, endpoint, response }) =>
      Effect.gen(function* () {
        const h = yield* harness({
          modelId,
          protocols: ["openai-chat", "anthropic-messages", "openai-responses"],
          respond: () => Response.json(response),
        });
        const result = yield* h.invoke("/v1/chat/completions", {
          model: modelId,
          messages: [{ role: "user", content: "hello" }],
        });
        expect(result.status).toBe(200);
        expect(JSON.parse(result.text).choices[0].message.content).toBe("recovered safely");
        expect(h.calls).toHaveLength(1);
        expect(h.calls[0]!.url).toBe("https://upstream.test/v1" + endpoint);
        expect(sentBody(h.calls[0]!).model).toBe(modelId);
      }).pipe(Effect.scoped),
  );

  it.effect("rejects unavailable family protocols without calling upstream", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        modelId: "gpt-6.1-terra",
        protocols: ["openai-chat", "anthropic-messages"],
      });
      const result = yield* h.invoke("/v1/chat/completions", {
        model: "gpt-6.1-terra",
        messages: [],
      });
      expect(result.status).toBe(422);
      expect(h.calls).toHaveLength(0);
      const kimi = yield* harness({
        modelId: "kimi-k3.1-pro",
        protocols: ["anthropic-messages", "openai-responses"],
      });
      const kimiResult = yield* kimi.invoke("/v1/messages", {
        model: "kimi-k3.1-pro",
        messages: [],
      });
      expect(kimiResult.status).toBe(422);
      expect(kimi.calls).toHaveLength(0);
    }).pipe(Effect.scoped),
  );

  it.effect("respects model protocol restrictions and rejects cross-protocol token counting", () =>
    Effect.gen(function* () {
      const restricted = yield* harness({
        modelId: "kimi-k2.8-code",
        protocols: ["openai-chat", "anthropic-messages"],
        modelProtocols: ["anthropic-messages"],
      });
      expect(
        (yield* restricted.invoke("/v1/messages", {
          model: "kimi-k2.8-code",
          messages: [],
        })).status,
      ).toBe(422);
      expect(restricted.calls).toHaveLength(0);
      const kimi = yield* harness({
        modelId: "kimi-k3.1-pro",
        protocols: ["openai-chat", "anthropic-messages"],
      });
      expect(
        (yield* kimi.invoke("/v1/messages/count_tokens", {
          model: "kimi-k3.1-pro",
          messages: [],
        })).status,
      ).toBe(501);
      expect(kimi.calls).toHaveLength(0);
      const gpt = yield* harness({
        modelId: "gpt-6.1-terra",
        protocols: ["openai-responses", "anthropic-messages"],
      });
      expect(
        (yield* gpt.invoke("/v1/messages/count_tokens", {
          model: "gpt-6.1-terra",
          messages: [],
        })).status,
      ).toBe(501);
      expect(gpt.calls).toHaveLength(0);
    }).pipe(Effect.scoped),
  );

  it.effect.each(["codex", "claudeAgent", "omo", "pi", "opencode"])(
    "selects an offered model for %s after its default is delisted",
    (driver) =>
      Effect.gen(function* () {
        const h = yield* harness({ driver });
        const current = yield* h.settings.getSettings;
        const changed = {
          ...current,
          modelServices: {
            [serviceId]: {
              ...current.modelServices[serviceId]!,
              models: [{ ...service.models[0]!, available: false }, service.models[1]!],
            },
          },
        };
        const instances = {
          [instanceId]: {
            ...h.instances[instanceId]!,
            modelService: { serviceId, modelIds: [], defaultModel: "Vendor/Exact" },
          },
        };
        const result = yield* h.gateway.materialize(changed, instances);
        const instance = result[instanceId]!;
        const config = record(instance.config);
        if (driver === "codex") expect(config.launchArgs).toContain('model=\\"hidden\\"');
        if (driver === "pi" || driver === "omo") expect(config.model).toBe("hidden");
        if (driver === "claudeAgent") {
          for (const name of [
            "ANTHROPIC_MODEL",
            "ANTHROPIC_DEFAULT_SONNET_MODEL",
            "ANTHROPIC_DEFAULT_OPUS_MODEL",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL",
          ])
            expect(instance.environment?.find((entry) => entry.name === name)?.value).toBe(
              "hidden",
            );
        }
        if (driver === "opencode") {
          const content = instance.environment?.find(
            (entry) => entry.name === "OPENCODE_CONFIG_CONTENT",
          )?.value;
          expect(JSON.parse(String(content))).toMatchObject({
            model: "cox/hidden",
            small_model: "cox/hidden",
          });
        }
        const disabled = yield* h.gateway.materialize(
          {
            ...changed,
            modelServices: {
              [serviceId]: {
                ...changed.modelServices[serviceId]!,
                models: changed.modelServices[serviceId]!.models.map((model) => ({
                  ...model,
                  available: false,
                })),
              },
            },
          },
          instances,
        );
        expect(disabled[instanceId]?.enabled).toBe(false);
        expect((yield* h.invoke("/v1/models")).status).toBe(401);
      }).pipe(Effect.scoped),
  );

  it.effect("aligns managed Pi retry and HTTP timeouts while preserving settings", () =>
    Effect.gen(function* () {
      const h = yield* harness({ driver: "pi", recovery: { budgetMs: 600_000 } });
      const fs = yield* FileSystem.FileSystem;
      const file = `${h.config.agentDir}/settings.json`;
      expect(yield* fs.exists(file)).toBe(true);
      expect(JSON.parse(yield* fs.readFileString(file))).toMatchObject({
        httpIdleTimeoutMs: 630_000,
        retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0, timeoutMs: 630_000 } },
      });
      yield* fs.writeFileString(
        file,
        JSON.stringify({
          theme: "fixture",
          retry: {
            enabled: true,
            maxRetries: 7,
            baseDelayMs: 123,
            provider: { timeoutMs: 100, maxRetryDelayMs: 789 },
          },
        }),
      );
      yield* h.gateway.materialize(yield* h.settings.getSettings, h.instances);
      expect(JSON.parse(yield* fs.readFileString(file))).toMatchObject({
        theme: "fixture",
        httpIdleTimeoutMs: 630_000,
        retry: {
          enabled: false,
          maxRetries: 0,
          baseDelayMs: 123,
          provider: { maxRetries: 0, timeoutMs: 630_000, maxRetryDelayMs: 789 },
        },
      });
    }).pipe(Effect.scoped),
  );

  it.effect("preserves OpenCode context limits without a known output cap", () =>
    Effect.gen(function* () {
      const h = yield* harness({ driver: "opencode", maxOutputTokens: null });
      const content = h.materialized[instanceId]!.environment?.find(
        (entry) => entry.name === "OPENCODE_CONFIG_CONTENT",
      )?.value;
      expect(JSON.parse(String(content)).provider.cox.models["Vendor/Exact"].limit).toEqual({
        context: 64000,
        output: 32000,
      });
    }).pipe(Effect.scoped),
  );

  it.effect.each([4000, null])(
    "sets Claude output budget only for a known cap of %s",
    (maxOutputTokens) =>
      Effect.gen(function* () {
        const h = yield* harness({ driver: "claudeAgent", maxOutputTokens });
        expect(
          h.materialized[instanceId]!.environment?.find(
            (entry) => entry.name === "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
          )?.value,
        ).toBe(maxOutputTokens === null ? undefined : "4000");
      }).pipe(Effect.scoped),
  );

  it.effect.each(["agentModels", "categoryModels"])(
    "isolates a delisted OMO %s selection from other bindings",
    (field) =>
      Effect.gen(function* () {
        const h = yield* harness({ driver: "omo" });
        const current = yield* h.settings.getSettings;
        const changed = {
          ...current,
          modelServices: {
            [serviceId]: {
              ...current.modelServices[serviceId]!,
              models: [{ ...service.models[0]!, available: false }, service.models[1]!],
            },
          },
        };
        const otherId = ProviderInstanceId.make("other-binding");
        const original = h.instances[instanceId]!;
        const result = yield* h.gateway.materialize(changed, {
          [instanceId]: { ...original, config: { [field]: { oracle: "cox/Vendor/Exact" } } },
          [otherId]: {
            ...original,
            driver: ProviderDriverKind.make("codex"),
            modelService: { serviceId, modelIds: ["hidden"], defaultModel: "hidden" },
          },
        });
        expect(result[instanceId]?.enabled).toBe(false);
        expect(record(result[instanceId]?.config).enabled).toBe(false);
        expect(result[otherId]?.enabled).toBe(true);
        expect(record(result[otherId]?.config).launchArgs).toContain("hidden");
        expect((yield* h.invoke("/v1/models")).status).toBe(401);
      }).pipe(Effect.scoped),
  );

  it.effect.each([100, 600_000, 1_800_000])(
    "aligns managed OMO timeouts to the %s ms recovery budget",
    (budgetMs) =>
      Effect.gen(function* () {
        const h = yield* harness({ driver: "omo", recovery: { budgetMs } });
        const fs = yield* FileSystem.FileSystem;
        const file = `${h.config.agentDir}/settings.json`;
        const timeoutMs = budgetMs + 30_000;
        const expected = {
          httpIdleTimeoutMs: timeoutMs,
          retry: {
            enabled: false,
            provider: { timeoutMs, streamStartTimeoutMs: timeoutMs, keepAliveTimeoutMs: timeoutMs },
          },
        };
        expect(JSON.parse(yield* fs.readFileString(file))).toMatchObject(expected);
        expect(h.materialized[instanceId]?.environment).toContainEqual({
          name: "COX_OMO_GATEWAY_TIMEOUT_MS",
          value: String(timeoutMs),
          sensitive: false,
        });
        yield* fs.writeFileString(
          file,
          JSON.stringify({
            ...expected,
            theme: "fixture",
            retry: { ...expected.retry, maxRetries: 7 },
          }),
        );
        const current = (yield* h.settings.getSettings).modelServices[serviceId]!;
        yield* h.settings.updateSettings({
          modelServices: {
            [serviceId]: { ...current, recovery: { ...current.recovery, budgetMs: 900_000 } },
          },
        });
        const updated = yield* h.gateway.materialize(yield* h.settings.getSettings, h.instances);
        expect(JSON.parse(yield* fs.readFileString(file))).toMatchObject({
          theme: "fixture",
          httpIdleTimeoutMs: 930_000,
          retry: {
            enabled: false,
            maxRetries: 7,
            provider: {
              timeoutMs: 930_000,
              streamStartTimeoutMs: 930_000,
              keepAliveTimeoutMs: 930_000,
            },
          },
        });
        expect(updated[instanceId]?.environment).toContainEqual({
          name: "COX_OMO_GATEWAY_TIMEOUT_MS",
          value: "930000",
          sensitive: false,
        });
      }).pipe(Effect.scoped),
  );

  it.effect(
    "uses updated non-transient retry settings on the next request without restarting",
    () =>
      withGatewayDiagnostics((messages) =>
        Effect.gen(function* () {
          const h = yield* harness({
            driver: "omo",
            recovery: { retryEnabled: true, retryNonTransientErrors: false, maxAttempts: 2 },
            respond: () => Response.json({ error: { code: "not_acceptable" } }, { status: 406 }),
          });
          const body = { model: "Vendor/Exact", messages: [] };
          expect((yield* h.invoke("/v1/chat/completions", body)).status).toBe(406);
          expect(h.calls).toHaveLength(1);
          const current = (yield* h.settings.getSettings).modelServices[serviceId]!;
          yield* h.settings.updateSettings({
            modelServices: {
              [serviceId]: {
                ...current,
                recovery: { ...current.recovery, retryNonTransientErrors: true },
              },
            },
          });
          const next = yield* h.invoke("/v1/chat/completions", body).pipe(Effect.forkChild);
          yield* TestClock.adjust("2 seconds");
          expect((yield* Fiber.join(next)).status).toBe(406);
          expect(h.calls).toHaveLength(3);
          expect(
            messages
              .filter((message) => message.event === "policy")
              .map((message) => record(message.effective).retryNonTransientErrors),
          ).toEqual([false, true]);
        }),
      ),
  );
  it.effect.each([false, true])(
    "recovers unsupported forced tool choice while preserving thinking and tools (stream: %s)",
    (stream) =>
      Effect.gen(function* () {
        for (const choice of ["required", { type: "function", function: { name: "task" } }]) {
          let calls = 0;
          const h = yield* harness({
            driver: "omo",
            recovery: { retryEnabled: true, maxAttempts: 5 },
            respond: () =>
              ++calls % 2 === 1
                ? Response.json(
                    {
                      error: {
                        type: "invalid_request_error",
                        message:
                          "claude-opus-5-5 does not support forced tool_choice; use auto or none",
                      },
                    },
                    { status: 400 },
                  )
                : stream
                  ? new Response(
                      chatStreamFrame({ role: "assistant", content: "recovered" }) +
                        chatStreamFrame({}, "stop") +
                        "data: [DONE]\n\n",
                      { headers: { "content-type": "text/event-stream" } },
                    )
                  : Response.json({
                      choices: [
                        {
                          index: 0,
                          message: { role: "assistant", content: "recovered" },
                          finish_reason: "stop",
                        },
                      ],
                    }),
          });
          const body = {
            model: "Vendor/Exact",
            stream,
            tool_choice: choice,
            reasoning_effort: "high",
            messages: [{ role: "user", content: "do the task" }],
            tools: [
              {
                type: "function",
                function: { name: "task", parameters: { type: "object", properties: {} } },
              },
            ],
          };
          for (const offset of [0, 2]) {
            const response = yield* h.invoke("/v1/chat/completions", body);
            expect(response.status).toBe(200);
            expect(response.text).toContain("recovered");
            expect(sentBody(h.calls[offset]!)).toMatchObject(body);
            expect(sentBody(h.calls[offset + 1]!)).toMatchObject({ ...body, tool_choice: "auto" });
          }
          expect(h.calls).toHaveLength(4);
          expect(body.tool_choice).toEqual(choice);
        }
      }).pipe(Effect.scoped),
  );

  it.effect.each([
    { retryEnabled: false, maxAttempts: 5, choice: "required", attempts: 1 },
    { retryEnabled: true, maxAttempts: 1, choice: "required", attempts: 1 },
    { retryEnabled: true, maxAttempts: 5, choice: "auto", attempts: 1 },
    { retryEnabled: true, maxAttempts: 5, choice: "none", attempts: 1 },
    { retryEnabled: true, maxAttempts: 5, choice: "required", attempts: 2 },
  ])("bounds unsupported tool-choice repair and respects retry policy: %j", (test) =>
    Effect.gen(function* () {
      const h = yield* harness({
        recovery: { retryEnabled: test.retryEnabled, maxAttempts: test.maxAttempts },
        respond: () =>
          Response.json(
            {
              error: {
                type: "invalid_request_error",
                message: "claude-opus-5-5 does not support forced tool_choice; use auto or none",
              },
            },
            { status: 400 },
          ),
      });
      const response = yield* h.invoke("/v1/chat/completions", {
        model: "Vendor/Exact",
        messages: [],
        tool_choice: test.choice,
      });
      expect(response.status).toBe(400);
      expect(response.text).toContain("unsupported_forced_tool_choice");
      expect(h.calls).toHaveLength(test.attempts);
    }).pipe(Effect.scoped),
  );

  it.effect.each([false, true])(
    "repairs the proven forced-tool/thinking conflict once before delivery (stream: %s)",
    (stream) =>
      Effect.gen(function* () {
        let calls = 0;
        const h = yield* harness({
          driver: "omo",
          recovery: { retryEnabled: true, maxAttempts: 5 },
          respond: () => {
            calls++;
            if (calls % 2 === 1)
              return Response.json(
                {
                  error: {
                    type: "invalid_request_error",
                    message: "tool_choice 'specified' is incompatible with thinking enabled",
                  },
                },
                { status: 400 },
              );
            return stream
              ? new Response(
                  chatStreamFrame({ role: "assistant", content: "done" }) +
                    chatStreamFrame({}, "stop") +
                    "data: [DONE]\n\n",
                  { headers: { "content-type": "text/event-stream" } },
                )
              : Response.json({
                  choices: [
                    {
                      index: 0,
                      message: { role: "assistant", content: "done" },
                      finish_reason: "stop",
                    },
                  ],
                });
          },
        });
        const body = {
          model: "Vendor/Exact",
          messages: [{ role: "user", content: "ping" }],
          tools: [
            {
              type: "function",
              function: { name: "todo", parameters: { type: "object", properties: {} } },
            },
          ],
          tool_choice: { type: "function", function: { name: "todo" } },
          reasoning_effort: "max",
          stream,
        };
        for (const offset of [0, 2]) {
          const response = yield* h.invoke("/v1/chat/completions", body);
          expect(response.status).toBe(200);
          expect(response.text).toContain("done");
          expect(sentBody(h.calls[offset]!)).toMatchObject({
            reasoning_effort: "max",
            tool_choice: body.tool_choice,
          });
          expect(sentBody(h.calls[offset + 1]!)).toMatchObject({
            reasoning_effort: "none",
            tool_choice: body.tool_choice,
            tools: body.tools,
            messages: body.messages,
          });
        }
        expect(h.calls).toHaveLength(4);
        expect(body.reasoning_effort).toBe("max");
      }).pipe(Effect.scoped),
  );

  it.effect.each(["pi", "omo"] as const)(
    "routes %s Anthropic SDK requests without a duplicate /v1 after regeneration and restart",
    (driver) =>
      Effect.gen(function* () {
        const h = yield* harness({
          driver,
          protocol: "anthropic-messages",
          respond: () =>
            Response.json({
              id: "msg-local-test",
              type: "message",
              role: "assistant",
              model: "Vendor/Exact",
              content: [{ type: "text", text: "local gateway answer" }],
              stop_reason: "end_turn",
              stop_sequence: null,
              usage: { input_tokens: 5, output_tokens: 2 },
            }),
        });
        const fs = yield* FileSystem.FileSystem;
        const file = String(h.config.agentDir) + "/models.json";
        const requests: Request[] = [];
        let materialized = h.materialized;
        const body = {
          model: "Vendor/Exact",
          max_tokens: 128,
          messages: [{ role: "user" as const, content: "hello" }],
        };
        for (const phase of ["generated", "regenerated", "restarted"]) {
          if (phase !== "generated") {
            const stale = record(JSON.parse(yield* fs.readFileString(file)));
            record(record(stale.providers).cox).baseUrl = "http://127.0.0.1:0/api/model-gateway/v1";
            yield* fs.writeFileString(file, JSON.stringify(stale));
            materialized =
              phase === "restarted"
                ? yield* h.restart()
                : yield* h.gateway.materialize(yield* h.settings.getSettings, materialized);
          }
          const generated = record(JSON.parse(yield* fs.readFileString(file)));
          const provider = record(record(generated.providers).cox);
          const key = materialized[instanceId]!.environment?.find(
            (entry) => entry.name === "COX_MODEL_SERVICE_KEY",
          )?.value;
          if (typeof key !== "string") throw new Error("Expected a local gateway key");
          const client = new Anthropic({
            baseURL: String(provider.baseUrl),
            apiKey: key,
            authToken: null,
            maxRetries: 0,
            fetch: (input, init) => {
              const request = new Request(input, init);
              requests.push(request);
              return h.fetch(request);
            },
          });
          expect(provider.baseUrl).toBe("http://127.0.0.1:0/api/model-gateway");
          expect(provider.api).toBe("anthropic-messages");
          expect(provider.apiKey).toBe("$COX_MODEL_SERVICE_KEY");
          for (const query of [undefined, { beta: "true" }]) {
            const response = yield* Effect.promise(() =>
              client.beta.messages.create(body, query ? { query } : undefined),
            );
            expect(response.content).toEqual([{ type: "text", text: "local gateway answer" }]);
            const request = requests.at(-1)!;
            expect(new URL(request.url).pathname).toBe("/api/model-gateway/v1/messages");
            if (query) expect(new URL(request.url).searchParams.get("beta")).toBe("true");
            expect(
              request.headers.get("x-api-key") ??
                request.headers.get("authorization")?.replace(/^Bearer /i, ""),
            ).toBe(key);
            expect(h.calls.at(-1)?.url).toBe("https://upstream.test/v1/messages");
            expect(sentBody(h.calls.at(-1)!)).toMatchObject(body);
          }
        }
        expect(requests).toHaveLength(6);
        expect(h.calls).toHaveLength(6);
        expect((yield* h.invoke("/v1/v1/messages", body)).status).toBe(404);
        expect(h.calls).toHaveLength(6);
      }).pipe(Effect.scoped),
  );

  it.effect.each(
    (["pi", "omo"] as const).flatMap((driver) => [
      {
        driver,
        protocol: "openai-responses" as const,
        api: "openai-responses",
        suffix: "/v1",
        endpoint: "/responses",
        body: { input: "hello" },
        response: responsesAnswer,
      },
      {
        driver,
        protocol: "openai-chat" as const,
        api: "openai-completions",
        suffix: "/v1",
        endpoint: "/chat/completions",
        body: { messages: [{ role: "user", content: "hello" }] },
        response: {
          choices: [{ message: { role: "assistant", content: "answer" }, finish_reason: "stop" }],
        },
      },
      {
        driver,
        protocol: "anthropic-messages" as const,
        api: "anthropic-messages",
        suffix: "",
        endpoint: "/v1/messages",
        body: { messages: [{ role: "user", content: "hello" }], max_tokens: 128 },
        response: {
          type: "message",
          content: [{ type: "text", text: "answer" }],
          stop_reason: "end_turn",
        },
      },
      {
        driver,
        protocol: "gemini" as const,
        api: "google-generative-ai",
        suffix: "/v1beta",
        endpoint: "/models/Vendor%2FExact:generateContent",
        body: { contents: [{ role: "user", parts: [{ text: "hello" }] }] },
        response: { candidates: [{ content: { role: "model", parts: [{ text: "answer" }] } }] },
      },
    ]),
  )(
    "generates the native $driver endpoint and strict-field support for $protocol",
    ({ driver, protocol, api, suffix, endpoint, body, response }) =>
      Effect.gen(function* () {
        const h = yield* harness({ driver, protocol, respond: () => Response.json(response) });
        const fs = yield* FileSystem.FileSystem;
        const file = String(h.config.agentDir) + "/models.json";
        let materialized = h.materialized;
        for (const phase of ["generated", "regenerated", "restarted"]) {
          if (phase === "regenerated")
            materialized = yield* h.gateway.materialize(
              yield* h.settings.getSettings,
              materialized,
            );
          if (phase === "restarted") materialized = yield* h.restart();
          const generated = JSON.parse(yield* fs.readFileString(file));
          const provider = generated.providers.cox;
          expect(provider.baseUrl).toBe("http://127.0.0.1:0/api/model-gateway" + suffix);
          expect(provider.api).toBe(api);
          expect(provider.apiKey).toBe("$COX_MODEL_SERVICE_KEY");
          expect(provider.models[0]).toMatchObject({
            id: "Vendor/Exact",
            name: "Exact",
            contextWindow: 64000,
            maxTokens: 4000,
          });
          if (protocol === "openai-responses") {
            expect(provider.compat).toEqual({ supportsStrictMode: true });
          } else {
            expect(Object.hasOwn(provider, "compat")).toBe(false);
          }
          const key = materialized[instanceId]!.environment?.find(
            (entry) => entry.name === "COX_MODEL_SERVICE_KEY",
          )?.value;
          if (typeof key !== "string") throw new Error("Expected a local gateway key");
          const result = yield* Effect.promise(() =>
            h.fetch(String(provider.baseUrl) + endpoint, {
              method: "POST",
              headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
              body: JSON.stringify({ model: "Vendor/Exact", ...body }),
            }),
          );
          expect(result.status).toBe(200);
          expect(h.calls.at(-1)?.url).toBe(
            "https://upstream.test/v1" +
              (protocol === "anthropic-messages" ? "/messages" : endpoint),
          );
        }
        expect(h.calls).toHaveLength(3);
        expect(record(h.instances[instanceId]!.config)).toEqual({ launchArgs: "", retained: true });
      }).pipe(Effect.scoped),
  );

  it.effect.each([
    { retryEnabled: false, maxAttempts: 5, tool_choice: "required" },
    { retryEnabled: true, maxAttempts: 1, tool_choice: "required" },
    { retryEnabled: true, maxAttempts: 5, tool_choice: "auto" },
  ])(
    "does not bypass retry limits or change automatic tool choice for thinking conflicts: %j",
    (test) =>
      Effect.gen(function* () {
        const h = yield* harness({
          recovery: { retryEnabled: test.retryEnabled, maxAttempts: test.maxAttempts },
          respond: () =>
            Response.json(
              {
                error: {
                  type: "invalid_request_error",
                  message: "tool_choice 'specified' is incompatible with thinking enabled",
                },
              },
              { status: 400 },
            ),
        });
        const response = yield* h.invoke("/v1/chat/completions", {
          model: "Vendor/Exact",
          messages: [],
          reasoning_effort: "max",
          tool_choice: test.tool_choice,
        });
        expect(response.status).toBe(400);
        expect(h.calls).toHaveLength(1);
        expect(sentBody(h.calls[0]!)).toMatchObject({
          reasoning_effort: "max",
          tool_choice: test.tool_choice,
        });
      }).pipe(Effect.scoped),
  );

  it.effect.each([
    "tool_choice 'specified' is incompatible with thinking enabled",
    "claude-opus-5-5 does not support forced tool_choice; use auto or none",
  ])("does not replay a tool-choice conflict after streamed text was delivered: %s", (message) =>
    Effect.gen(function* () {
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      const h = yield* harness({
        recovery: { retryEnabled: true },
        respond: () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(output) {
                controller = output;
                output.enqueue(
                  new TextEncoder().encode(
                    chatStreamFrame({ role: "assistant", content: "already delivered" }),
                  ),
                );
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      });
      const fiber = yield* h
        .invoke("/v1/chat/completions", {
          model: "Vendor/Exact",
          messages: [],
          reasoning_effort: "max",
          tool_choice: "required",
          stream: true,
        })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("1 second");
      controller!.enqueue(
        new TextEncoder().encode(
          sseFrame({
            error: {
              type: "invalid_request_error",
              message,
            },
          }),
        ),
      );
      controller!.close();
      const response = yield* Fiber.join(fiber);
      expect(response.text).toContain("already delivered");
      expect(h.calls).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "omits opaque reasoning replay without changing visible history, tools or the effort",
    () =>
      withGatewayDiagnostics((messages) =>
        Effect.gen(function* () {
          const h = yield* harness();
          const reasoning = [
            {
              type: "reasoning",
              summary: [],
              content: null,
              encrypted_content: "opaque-private-ciphertext",
            },
            {
              type: "reasoning",
              summary: [],
              content: [{ type: "reasoning_text", text: "visible reasoning" }],
            },
          ];
          const original = {
            model: "Vendor/Exact",
            reasoning: { effort: "max" },
            input: [
              ...reasoning,
              {
                type: "function_call",
                call_id: "call_diag",
                name: "read_file",
                arguments: '{"path":"file.txt"}',
              },
              { type: "function_call_output", call_id: "call_diag", output: "keep exact result" },
              { role: "user", content: "hi" },
            ],
            tools: [{ type: "function", name: "read_file", parameters: { type: "object" } }],
          };
          const snapshot = structuredClone(original);
          const answer = yield* h.invoke("/v1/responses", original);
          expect(answer.status).toBe(200);
          const outgoing = sentBody(h.calls[0]!);
          expect(outgoing.reasoning_effort).toBe("max");
          expect(outgoing.messages).toEqual([
            {
              role: "assistant",
              reasoning_content: "visible reasoning",
              tool_calls: [
                {
                  id: "call_diag",
                  type: "function",
                  function: { name: "read_file", arguments: '{"path":"file.txt"}' },
                },
              ],
            },
            { role: "tool", tool_call_id: "call_diag", content: "keep exact result" },
            { role: "user", content: "hi" },
          ]);
          expect(JSON.stringify(outgoing)).not.toContain("opaque-private-ciphertext");
          expect(JSON.stringify(outgoing)).not.toContain("[reasoning unavailable]");
          expect(original).toEqual(snapshot);
          expect(h.calls).toHaveLength(1);
          expect(messages).toContainEqual(
            expect.objectContaining({
              event: "request_compatibility",
              action: "omitted_unavailable_reasoning_replay",
              opaqueItemsOmitted: 1,
            }),
          );
          const logs = JSON.stringify(messages);
          for (const value of [
            "opaque-private-ciphertext",
            "visible reasoning",
            "keep exact result",
            "file.txt",
          ])
            expect(logs).not.toContain(value);
        }),
      ),
  );

  it.effect(
    "preserves opaque reasoning on native Responses without applying Chat replay cleanup",
    () =>
      Effect.gen(function* () {
        const h = yield* harness({
          protocol: "openai-responses",
          maxOutputTokens: null,
          respond: () => Response.json(responsesAnswer),
        });
        const original = {
          model: "Vendor/Exact",
          input: [
            { type: "reasoning", summary: [], encrypted_content: "opaque-private-ciphertext" },
            { role: "user", content: "hi" },
          ],
        };
        expect((yield* h.invoke("/v1/responses", original)).status).toBe(200);
        expect(sentBody(h.calls[0]!)).toEqual(original);
      }).pipe(Effect.scoped),
  );

  it.effect.each([false, true])(
    "reports a completed zero-token Chat result without silent success or automatic replay (stream=%s)",
    (stream) =>
      withGatewayDiagnostics((messages) =>
        Effect.gen(function* () {
          const h = yield* harness({
            recovery: {
              retryEnabled: true,
              retryNonTransientErrors: true,
              hedgeEnabled: true,
              maxAttempts: 10,
            },
            respond: () =>
              stream
                ? new Response(
                    chatStreamFrame({ role: "assistant", content: "" }) +
                      chatStreamFrame({}, "stop") +
                      sseFrame({
                        choices: [],
                        usage: {
                          prompt_tokens: 301284,
                          completion_tokens: 0,
                          total_tokens: 301284,
                        },
                      }) +
                      "data: [DONE]\n\n",
                    { headers: { "content-type": "text/event-stream" } },
                  )
                : Response.json({
                    choices: [
                      {
                        index: 0,
                        message: { role: "assistant", content: null },
                        finish_reason: "stop",
                      },
                    ],
                    usage: { prompt_tokens: 301284, completion_tokens: 0, total_tokens: 301284 },
                  }),
          });
          const result = yield* h.invoke("/v1/responses", {
            model: "Vendor/Exact",
            input: "private prompt",
            stream,
          });
          expect(result.status).toBe(stream ? 200 : 502);
          expect(result.text).toContain("cox_model_service_zero_token_stop");
          expect(result.text).toContain("reported zero output tokens");
          expect(result.text).not.toContain('"type":"response.completed"');
          expect(result.text).not.toContain('"type":"response.incomplete"');
          expect(result.headers["x-should-retry"]).toBe(stream ? undefined : "false");
          expect(h.calls).toHaveLength(1);
          if (stream)
            expect(messages).toContainEqual(
              expect.objectContaining({
                event: "stream_terminal",
                outcome: "zero_token_stop",
                zeroTokenStopDetected: true,
                errorEmitted: true,
                upstream: expect.objectContaining({
                  terminal: "completed",
                  doneMarker: true,
                  output: expect.objectContaining({
                    outputTokens: 0,
                    textCharacters: 0,
                    toolCallFragments: 0,
                  }),
                }),
              }),
            );
          else
            expect(messages).toContainEqual(
              expect.objectContaining({
                event: "response_output",
                output: expect.objectContaining({ zeroTokenStop: true, outputTokens: 0 }),
              }),
            );
          const logs = JSON.stringify(messages);
          for (const secret of ["private prompt", "private-upstream-key", "private-header"])
            expect(logs).not.toContain(secret);
        }),
      ),
  );

  it.effect(
    "reports a zero-token stop after streamed headers without sending a completed Responses terminal",
    () =>
      withGatewayDiagnostics((messages) =>
        Effect.gen(function* () {
          let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
          const created = yield* Deferred.make<void>();
          const h = yield* harness({
            recovery: { retryEnabled: true, retryNonTransientErrors: true, maxAttempts: 10 },
            respond: () =>
              new Response(
                new ReadableStream<Uint8Array>({
                  start(output) {
                    controller = output;
                    output.enqueue(new TextEncoder().encode(chatStreamFrame({}, "stop")));
                  },
                }),
                { headers: { "content-type": "text/event-stream" } },
              ),
          });
          const request = HttpServerRequest.fromWeb(
            new Request("http://127.0.0.1/api/model-gateway/v1/responses", {
              method: "POST",
              headers: { authorization: `Bearer ${h.token}`, "content-type": "application/json" },
              body: JSON.stringify({ model: "Vendor/Exact", input: "hi", stream: true }),
            }),
          );
          const response = yield* h.gateway.handle.pipe(
            Effect.provideService(HttpServerRequest.HttpServerRequest, request),
          );
          if (response.body._tag !== "Stream") throw new Error("Expected streaming response");
          let text = "";
          const reading = yield* response.body.stream.pipe(
            Stream.decodeText(),
            Stream.runForEach((chunk) => {
              text += chunk;
              return text.includes("response.created")
                ? Deferred.succeed(created, undefined)
                : Effect.void;
            }),
            Effect.orDie,
            Effect.forkChild,
          );
          yield* Deferred.await(created);
          controller!.enqueue(
            new TextEncoder().encode(sseFrame({ choices: [], usage: { completion_tokens: 0 } })),
          );
          controller!.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          controller!.close();
          yield* Fiber.join(reading);
          expect(text).toContain("response.created");
          expect(text).toContain("cox_model_service_zero_token_stop");
          expect(text).not.toContain("event: response.completed");
          expect(h.calls).toHaveLength(1);
        }).pipe(
          Effect.scoped,
          Effect.tap(() =>
            Effect.sync(() => {
              expect(messages).toContainEqual(
                expect.objectContaining({ event: "stream_terminal", outcome: "zero_token_stop" }),
              );
            }),
          ),
        ),
      ),
  );

  it.effect.each([
    { name: "usage unknown", delta: {}, reason: "stop", usage: {} },
    {
      name: "generation known positive",
      delta: {},
      reason: "stop",
      usage: { completion_tokens: 3 },
    },
    {
      name: "reasoning only",
      delta: { reasoning_content: "thinking" },
      reason: "stop",
      usage: { completion_tokens: 0 },
    },
    { name: "length", delta: {}, reason: "length", usage: { completion_tokens: 0 } },
    { name: "filter", delta: {}, reason: "content_filter", usage: { completion_tokens: 0 } },
    {
      name: "tool-only",
      delta: {
        tool_calls: [
          {
            index: 0,
            id: "call_a",
            type: "function",
            function: { name: "read_file", arguments: "{}" },
          },
        ],
      },
      reason: "tool_calls",
      usage: { completion_tokens: 0 },
    },
  ])("retains legitimate converted $name completion semantics", (scenario) =>
    Effect.gen(function* () {
      const h = yield* harness({
        respond: () =>
          new Response(
            chatStreamFrame(scenario.delta) +
              chatStreamFrame({}, scenario.reason) +
              sseFrame({ choices: [], usage: scenario.usage }) +
              "data: [DONE]\n\n",
            { headers: { "content-type": "text/event-stream" } },
          ),
      });
      const result = yield* h.invoke("/v1/responses", {
        model: "Vendor/Exact",
        stream: true,
        input: "hi",
      });
      expect(result.text).not.toContain("cox_model_service_zero_token_stop");
      expect(result.text).toContain(
        ["length", "content_filter"].includes(scenario.reason)
          ? "event: response.incomplete"
          : "event: response.completed",
      );
      expect(h.calls).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect.each([false, true])(
    "preserves a native Chat refusal instead of classifying it as a zero-token stop (stream=%s)",
    (stream) =>
      Effect.gen(function* () {
        const h = yield* harness({
          driver: "pi",
          protocol: "openai-chat",
          respond: () =>
            stream
              ? new Response(
                  chatStreamFrame({ refusal: "Cannot comply" }) +
                    chatStreamFrame({}, "stop") +
                    sseFrame({ choices: [], usage: { completion_tokens: 0 } }) +
                    "data: [DONE]\n\n",
                  { headers: { "content-type": "text/event-stream" } },
                )
              : Response.json({
                  choices: [
                    { message: { content: null, refusal: "Cannot comply" }, finish_reason: "stop" },
                  ],
                  usage: { completion_tokens: 0 },
                }),
        });
        const result = yield* h.invoke("/v1/chat/completions", {
          model: "Vendor/Exact",
          messages: [],
          stream,
        });
        expect(result.status).toBe(200);
        expect(result.text).toContain("Cannot comply");
        expect(result.text).not.toContain("cox_model_service_zero_token_stop");
        expect(h.calls).toHaveLength(1);
      }).pipe(Effect.scoped),
  );

  it.effect.each([false, true])(
    "does not replay a native Chat zero-token stop (stream=%s)",
    (stream) =>
      Effect.gen(function* () {
        const h = yield* harness({
          driver: "pi",
          protocol: "openai-chat",
          recovery: { retryEnabled: true, retryNonTransientErrors: true, maxAttempts: 10 },
          respond: () =>
            stream
              ? new Response(
                  chatStreamFrame({}, "stop") +
                    sseFrame({ choices: [], usage: { completion_tokens: 0 } }) +
                    "data: [DONE]\n\n",
                  { headers: { "content-type": "text/event-stream" } },
                )
              : Response.json({
                  choices: [{ message: { content: null }, finish_reason: "stop" }],
                  usage: { completion_tokens: 0 },
                }),
        });
        const result = yield* h.invoke("/v1/chat/completions", {
          model: "Vendor/Exact",
          messages: [],
          stream,
        });
        expect(result.status).toBe(stream ? 200 : 502);
        expect(result.text).toContain("cox_model_service_zero_token_stop");
        if (stream) expect(result.text).not.toContain("data: [DONE]");
        expect(h.calls).toHaveLength(1);
      }).pipe(Effect.scoped),
  );

  it.effect.each(["", "data: [DONE]", 'data: {"choices":\n\n'])(
    "keeps incomplete zero-output streams distinct from a complete zero-token stop (%j)",
    (tail) =>
      withGatewayDiagnostics((messages) =>
        Effect.gen(function* () {
          const h = yield* harness({
            respond: () =>
              new Response(
                chatStreamFrame({}, "stop") +
                  sseFrame({ choices: [], usage: { completion_tokens: 0 } }) +
                  tail,
                { headers: { "content-type": "text/event-stream" } },
              ),
          });
          const result = yield* h.invoke("/v1/responses", {
            model: "Vendor/Exact",
            input: "hi",
            stream: true,
          });
          expect(result.text).not.toContain("cox_model_service_zero_token_stop");
          expect(result.text).not.toContain("event: response.completed");
          expect(result.text).toMatch(/incomplete|invalid JSON|terminal event/);
          expect(h.calls).toHaveLength(1);
          expect(messages).not.toContainEqual(
            expect.objectContaining({ zeroTokenStopDetected: true }),
          );
        }),
      ),
  );

  it.effect.each([
    {
      name: "text",
      delta: { content: "safe answer" },
      reason: "stop",
      status: "completed",
      items: 1,
    },
    {
      name: "reasoning only",
      delta: { reasoning_content: "safe reasoning" },
      reason: "stop",
      status: "completed",
      items: 1,
    },
    { name: "empty stop", delta: {}, reason: "stop", status: "completed", items: 0 },
    { name: "empty tool finish", delta: {}, reason: "tool_calls", status: "completed", items: 0 },
    {
      name: "text length",
      delta: { content: "partial" },
      reason: "length",
      status: "incomplete",
      items: 1,
    },
    {
      name: "reasoning filtered",
      delta: { reasoning_content: "partial" },
      reason: "content_filter",
      status: "incomplete",
      items: 1,
    },
    { name: "empty length", delta: {}, reason: "length", status: "incomplete", items: 0 },
  ])("strictly completes converted $name after DONE with usage-only tail", (scenario) =>
    withGatewayDiagnostics((messages) =>
      Effect.gen(function* () {
        const h = yield* harness({
          respond: () =>
            new Response(
              chatStreamFrame(scenario.delta) +
                chatStreamFrame({}, scenario.reason) +
                sseFrame({
                  choices: [],
                  usage: {
                    prompt_tokens: 11,
                    completion_tokens: 5,
                    total_tokens: 16,
                    prompt_tokens_details: { cached_tokens: 7 },
                    completion_tokens_details: { reasoning_tokens: 3 },
                  },
                }) +
                "data: [DONE]\n\n",
              { headers: { "content-type": "text/event-stream" } },
            ),
        });
        const result = yield* h.invoke("/v1/responses", {
          model: "Vendor/Exact",
          input: "test",
          stream: true,
        });
        expect(result.status).toBe(200);
        expect(result.text.match(/event: response\.(?:completed|incomplete)/g)).toHaveLength(1);
        const events = result.text
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => JSON.parse(line.slice(6)));
        const terminal = events.find((event) => event.type === `response.${scenario.status}`);
        expect(terminal.response.status).toBe(scenario.status);
        expect(terminal.response.output).toHaveLength(scenario.items);
        expect(terminal.response.usage).toMatchObject({
          input_tokens: 11,
          output_tokens: 5,
          total_tokens: 16,
          input_tokens_details: { cached_tokens: 7 },
          output_tokens_details: { reasoning_tokens: 3 },
        });
        expect(result.text).not.toContain("cox_model_service_incomplete_stream");
        expect(h.calls).toHaveLength(1);
        expect(messages).toContainEqual(
          expect.objectContaining({ event: "terminal", reason: "response_ready" }),
        );
        expect(messages).toContainEqual(
          expect.objectContaining({
            event: "stream_terminal",
            selectedResponse: true,
            upstreamEof: true,
            outcome: scenario.status,
            convertedFinalized: true,
            bridgeFinishAttempted: true,
            bridge: expect.objectContaining({ terminal: scenario.status, terminalEvents: 1 }),
            bridgeState: {
              doneReceived: true,
              doneAccepted: true,
              terminal: true,
              finalized: true,
              failed: false,
            },
            upstream: expect.objectContaining({ doneMarker: true, tailLength: 0 }),
            downstream: expect.objectContaining({ terminal: scenario.status, terminalEvents: 1 }),
            downstreamEnded: true,
            errorEmitted: false,
            downstreamExit: "exhausted",
            delivery: "network_receipt_unconfirmed",
          }),
        );
      }),
    ),
  );

  it.effect.each([
    { tail: "", reason: "missing_terminal_event" },
    { tail: "data: [DONE]", reason: "incomplete_sse_frame" },
    { tail: "data: [DONE]\r\n", reason: "incomplete_sse_frame" },
    { tail: 'data: {"choices":', reason: "incomplete_sse_frame" },
  ])("diagnoses post-output EOF without replay ($reason, $tail)", (scenario) =>
    withGatewayDiagnostics((messages) =>
      Effect.gen(function* () {
        const h = yield* harness({
          recovery: { retryEnabled: true, hedgeEnabled: true, maxAttempts: 10 },
          respond: () =>
            new Response(
              chatStreamFrame({ content: "private-response-body" }) +
                chatStreamFrame({}, "stop") +
                scenario.tail,
              {
                headers: {
                  "content-type": "text/event-stream",
                  "x-request-id": "req_safe_fixture",
                },
              },
            ),
        });
        const result = yield* h.invoke("/v1/responses", {
          model: "Vendor/Exact",
          input: "private-prompt",
          stream: true,
        });
        expect(result.status).toBe(200);
        expect(result.text).toContain("private-response-body");
        expect(result.text).toContain("cox_model_service_incomplete_stream");
        expect(result.text).not.toContain("response.completed");
        expect(h.calls).toHaveLength(1);
        expect(messages).toContainEqual(
          expect.objectContaining({ event: "terminal", reason: "response_ready" }),
        );
        expect(messages).toContainEqual(
          expect.objectContaining({
            event: "stream_terminal",
            selectedResponse: true,
            upstreamEof: true,
            outcome: scenario.reason,
            failureStage: "upstream",
            upstreamRequestId: "req_safe_fixture",
            errorEmitted: true,
            upstream: expect.objectContaining({
              doneMarker: false,
              tailLength: scenario.tail.length,
            }),
            bridge: expect.objectContaining({ terminal: "none" }),
            downstreamEnded: false,
          }),
        );
        expect(JSON.stringify(messages)).not.toMatch(
          /private-response-body|private-prompt|private-upstream-key|private-header/,
        );
      }),
    ),
  );

  it.effect("diagnoses bridge refusal independently from upstream completion metadata", () =>
    withGatewayDiagnostics((messages) =>
      Effect.gen(function* () {
        let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
        const h = yield* harness({
          recovery: { retryEnabled: true, hedgeEnabled: true, maxAttempts: 10 },
          respond: () =>
            new Response(
              new ReadableStream<Uint8Array>({
                start(output) {
                  controller = output;
                  output.enqueue(new TextEncoder().encode(chatStreamFrame({ content: "initial" })));
                },
              }),
              { headers: { "content-type": "text/event-stream" } },
            ),
        });
        const result = yield* Effect.gen(function* () {
          const response = yield* h.gateway.handle.pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              HttpServerRequest.fromWeb(
                new Request("http://127.0.0.1/api/model-gateway/v1/responses", {
                  method: "POST",
                  headers: {
                    authorization: `Bearer ${h.token}`,
                    "content-type": "application/json",
                  },
                  body: JSON.stringify({
                    model: "Vendor/Exact",
                    stream: true,
                    input: "test",
                    tools: [{ type: "function", name: "Read", parameters: { type: "object" } }],
                  }),
                }),
              ),
            ),
          );
          controller!.enqueue(
            new TextEncoder().encode(
              chatStreamFrame(
                { function_call: { name: "Read", arguments: '{"secret-path":"fixture"}' } },
                "function_call",
              ) + "data: [DONE]\n\n",
            ),
          );
          controller!.close();
          return {
            text: yield* Effect.promise(() => HttpServerResponse.toWeb(response).text()),
          };
        }).pipe(Effect.scoped);
        expect(result.text).toContain("response.output_item.added");
        expect(result.text).not.toContain("event: response.completed");
        expect(result.text).toContain("cox_model_service_incomplete_stream");
        expect(h.calls).toHaveLength(1);
        expect(messages).toContainEqual(
          expect.objectContaining({
            event: "stream_terminal",
            outcome: "bridge_error",
            failureStage: "bridge",
            upstream: expect.objectContaining({ doneMarker: true }),
            bridgeFrames: 2,
            bridge: expect.objectContaining({ terminal: "none" }),
            bridgeState: {
              doneReceived: false,
              doneAccepted: false,
              terminal: false,
              finalized: false,
              failed: true,
            },
            errorEmitted: true,
          }),
        );
        expect(JSON.stringify(messages)).not.toMatch(/secret-path|call_fixture/);
      }),
    ),
  );

  it.effect("reports upstream transport failure after usable output without replay", () =>
    withGatewayDiagnostics((messages) =>
      Effect.gen(function* () {
        let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
        const h = yield* harness({
          driver: "pi",
          recovery: { retryEnabled: true, hedgeEnabled: true, maxAttempts: 10 },
          respond: () =>
            new Response(
              new ReadableStream<Uint8Array>({
                start(output) {
                  controller = output;
                  output.enqueue(new TextEncoder().encode(chatStreamFrame({ content: "first" })));
                },
              }),
              { headers: { "content-type": "text/event-stream" } },
            ),
        });
        const fiber = yield* h
          .invoke("/v1/chat/completions", { model: "Vendor/Exact", messages: [], stream: true })
          .pipe(Effect.forkChild);
        yield* TestClock.adjust("1 second");
        controller!.error(new Error("private-transport-error"));
        const result = yield* Fiber.join(fiber);
        expect(result.text).toContain("first");
        expect(result.text).toContain("cox_model_service_stream_interrupted");
        expect(result.text).toContain("Connection lost");
        expect(result.text).not.toContain("private-transport-error");
        expect(h.calls).toHaveLength(1);
        expect(messages).toContainEqual(
          expect.objectContaining({
            event: "stream_terminal",
            upstreamEof: false,
            failureStage: "upstream",
            outcome: "upstream_transport_error",
            errorEmitted: true,
            downstreamEnded: false,
          }),
        );
      }),
    ),
  );

  it.effect.each([
    { tail: 'data: {"choices":\n\n', reason: "invalid_json" },
    { tail: "data: [DONE]\n\n", reason: "missing_terminal_event" },
    {
      tail:
        chatStreamFrame(
          {
            tool_calls: [
              {
                index: 0,
                id: "call_a",
                function: { name: "read", arguments: '{"private-argument":' },
              },
            ],
          },
          "tool_calls",
        ) + "data: [DONE]\n\n",
      reason: "invalid_stream_event",
    },
    {
      tail: chatStreamFrame({}, "stop") + "data: [DONE]\n\ndata: [DONE]\n\n",
      reason: "duplicate_terminal_event",
    },
    {
      tail: chatStreamFrame({}, "stop") + "data: [DONE]\n\n" + chatStreamFrame({ content: "late" }),
      reason: "event_after_terminal",
    },
  ])("diagnoses malformed post-output streams without replay ($reason)", (scenario) =>
    withGatewayDiagnostics((messages) =>
      Effect.gen(function* () {
        let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
        const h = yield* harness({
          driver: "pi",
          recovery: { retryEnabled: true, hedgeEnabled: true, maxAttempts: 10 },
          respond: () =>
            new Response(
              new ReadableStream<Uint8Array>({
                start(output) {
                  controller = output;
                  output.enqueue(new TextEncoder().encode(chatStreamFrame({ content: "initial" })));
                },
              }),
              { headers: { "content-type": "text/event-stream" } },
            ),
        });
        const fiber = yield* h
          .invoke("/v1/chat/completions", { model: "Vendor/Exact", messages: [], stream: true })
          .pipe(Effect.forkChild);
        yield* TestClock.adjust("1 second");
        controller!.enqueue(new TextEncoder().encode(scenario.tail));
        controller!.close();
        const result = yield* Fiber.join(fiber);
        expect(result.text).toContain("initial");
        expect(result.text).toContain("cox_model_service_incomplete_stream");
        expect(result.text).not.toContain("private-argument");
        expect(result.text).not.toContain("data: [DONE]");
        expect(h.calls).toHaveLength(1);
        expect(messages).toContainEqual(
          expect.objectContaining({
            event: "stream_terminal",
            outcome: scenario.reason,
            failureStage: "upstream",
            errorEmitted: true,
            downstreamEnded: false,
          }),
        );
      }),
    ),
  );

  it.effect(
    "does not turn native Responses incomplete into a gateway rejection or a successful completion",
    () =>
      withGatewayDiagnostics((messages) =>
        Effect.gen(function* () {
          const h = yield* harness({
            protocol: "openai-responses",
            recovery: { retryEnabled: true, retryNonTransientErrors: true, maxAttempts: 10 },
            respond: () =>
              new Response(
                sseFrame({
                  type: "response.incomplete",
                  response: {
                    status: "incomplete",
                    output: [],
                    incomplete_details: { reason: "max_output_tokens" },
                  },
                }),
                { headers: { "content-type": "text/event-stream" } },
              ),
          });
          const result = yield* h.invoke("/v1/responses", {
            model: "Vendor/Exact",
            input: "test",
            stream: true,
          });
          expect(result.status).toBe(200);
          expect(result.text).toContain("response.incomplete");
          expect(result.text).not.toContain("response.completed");
          expect(h.calls).toHaveLength(1);
          expect(messages).toContainEqual(
            expect.objectContaining({
              event: "stream_terminal",
              outcome: "incomplete",
              downstreamEnded: true,
              errorEmitted: false,
            }),
          );
        }),
      ),
  );

  it.effect.each([
    "cancel",
    "disable",
    "consumer_stop",
    "consumer_interrupt",
    "consumer_failure",
  ] as const)("keeps $0 distinct from protocol EOF and never replays output", (action) =>
    withGatewayDiagnostics((messages) =>
      Effect.gen(function* () {
        let cancelled = false;
        const h = yield* harness({
          driver: "pi",
          recovery: { retryEnabled: true, hedgeEnabled: true, maxAttempts: 10 },
          respond: () =>
            new Response(
              new ReadableStream<Uint8Array>({
                start(output) {
                  output.enqueue(
                    new TextEncoder().encode(chatStreamFrame({ content: "initial output" })),
                  );
                },
                cancel() {
                  cancelled = true;
                },
              }),
              { headers: { "content-type": "text/event-stream" } },
            ),
        });
        const session = ProviderSessionId.make("integrity-stop-session");
        yield* h.gateway.lifecycle.begin(
          session,
          recoveryInput("integrity-stop"),
          () => Effect.void,
        );
        yield* h.gateway.lifecycle.observe(session, recoveryTurn("integrity-stop"));
        yield* Effect.gen(function* () {
          const request = HttpServerRequest.fromWeb(
            new Request("http://127.0.0.1/api/model-gateway/v1/chat/completions", {
              method: "POST",
              headers: {
                authorization: `Bearer ${h.token}.${session}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({ model: "Vendor/Exact", messages: [], stream: true }),
            }),
          );
          const response = yield* h.gateway.handle.pipe(
            Effect.provideService(HttpServerRequest.HttpServerRequest, request),
          );
          if (response.body._tag !== "Stream") throw new Error("Expected stream");
          if (action === "consumer_failure") {
            const failed = yield* response.body.stream.pipe(
              Stream.runForEach(() => Effect.fail("private-consumer-failure")),
              Effect.exit,
            );
            expect(failed._tag).toBe("Failure");
          } else if (action === "consumer_stop") {
            const first = yield* response.body.stream.pipe(
              Stream.take(1),
              Stream.runCollect,
              Effect.orDie,
            );
            expect(new TextDecoder().decode(first[0])).toContain("initial output");
          } else {
            const reading = yield* response.body.stream.pipe(
              Stream.decodeText(),
              Stream.mkString,
              Effect.orDie,
              Effect.forkChild,
            );
            yield* TestClock.adjust("1 second");
            if (action === "consumer_interrupt") yield* Fiber.interrupt(reading);
            else {
              if (action === "cancel") yield* h.gateway.lifecycle.cancel(session);
              else {
                const current = (yield* h.settings.getSettings).modelServices[serviceId]!;
                yield* h.settings.updateSettings({
                  modelServices: { [serviceId]: { ...current, enabled: false } },
                });
              }
              yield* TestClock.adjust("1 second");
              const text = yield* Fiber.join(reading);
              expect(text).toContain(
                action === "cancel"
                  ? "cox_model_service_request_cancelled"
                  : "cox_model_service_unavailable",
              );
              expect(text).not.toContain("data: [DONE]");
            }
          }
        }).pipe(Effect.scoped);
        expect(cancelled).toBe(true);
        expect(h.calls).toHaveLength(1);
        expect(messages).toContainEqual(
          expect.objectContaining({
            event: "stream_terminal",
            upstreamEof: false,
            downstreamEnded: false,
            outcome:
              action === "cancel"
                ? "request_cancelled"
                : action === "disable"
                  ? "service_disabled"
                  : action === "consumer_interrupt"
                    ? "downstream_interrupted"
                    : action === "consumer_failure"
                      ? "downstream_failed"
                      : "downstream_stopped",
            delivery: "network_receipt_unconfirmed",
          }),
        );
      }),
    ),
  );

  it.effect.each(["\n", "\r\n"])("converts byte-split Chat terminal frames with %j", (newline) =>
    Effect.gen(function* () {
      const text = (
        chatStreamFrame({ content: "你好" }) +
        chatStreamFrame({}, "stop") +
        sseFrame({
          choices: [],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        }) +
        "data: [DONE]\n\n"
      ).replaceAll("\n", newline);
      const h = yield* harness({
        respond: () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(output) {
                for (const byte of new TextEncoder().encode(text))
                  output.enqueue(Uint8Array.of(byte));
                output.close();
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      });
      const result = yield* h.invoke("/v1/responses", {
        model: "Vendor/Exact",
        input: "test",
        stream: true,
      });
      expect(result.text).toContain("你好");
      expect(result.text.match(/event: response.completed/g)).toHaveLength(1);
      expect(result.text).not.toContain("cox_model_service_incomplete_stream");
      expect(h.calls).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("reports incomplete pre-output SSE without interpreting EOF as completion", () =>
    withGatewayDiagnostics((messages) =>
      Effect.gen(function* () {
        const h = yield* harness({
          respond: () =>
            new Response('data: {"private-key":', {
              headers: { "content-type": "text/event-stream" },
            }),
        });
        const result = yield* h.invoke("/v1/responses", {
          model: "Vendor/Exact",
          input: "test",
          stream: true,
        });
        expect(result.status).toBe(502);
        expect(result.text).toContain("upstream_incomplete_stream");
        expect(result.text).not.toContain("private-key");
        expect(messages).toContainEqual(
          expect.objectContaining({
            event: "stream_terminal",
            selectedResponse: false,
            upstreamEof: true,
            failureStage: "upstream",
            outcome: "incomplete_sse_frame",
            upstream: expect.objectContaining({ dataFrames: 0, tailLength: 21 }),
          }),
        );
        expect(messages).not.toContainEqual(
          expect.objectContaining({ event: "terminal", reason: "response_ready" }),
        );
      }),
    ),
  );

  it.effect.each(["codex", "pi", "claudeAgent"])(
    "omits Responses ciphertext on every first attempt across new requests and gateway restarts for %s",
    (driver) =>
      Effect.gen(function* () {
        const h = yield* harness({
          driver,
          protocol: "openai-responses",
          encryptedReasoningReplay: "omit",
          respond: () => Response.json(responsesAnswer),
        });
        const original = structuredClone(encryptedReasoningInput);
        for (let request = 0; request < 3; request++) {
          if (request === 2) yield* h.restart();
          expect((yield* h.invoke("/v1/responses", encryptedReasoningInput)).status).toBe(200);
        }
        expect(h.calls).toHaveLength(3);
        for (const request of h.calls)
          expect(sentBody(request)).toEqual({
            ...encryptedReasoningInput,
            max_output_tokens: 4000,
            input: [
              encryptedReasoningInput.input[0],
              {
                type: "reasoning",
                id: "rs_summary",
                summary: [{ type: "summary_text", text: "keep this summary" }],
              },
              ...encryptedReasoningInput.input.slice(3),
            ],
          });
        expect(encryptedReasoningInput).toEqual(original);
        expect(
          (yield* h.settings.getSettings).modelServices[serviceId]?.encryptedReasoningReplay,
        ).toBe("omit");
      }).pipe(Effect.scoped),
  );

  it.effect.each([
    { service: "omit", model: "preserve", omitted: false },
    { service: "preserve", model: "omit", omitted: true },
    { service: "omit", model: undefined, omitted: true },
    { service: undefined, model: undefined, omitted: false },
  ] as const)("applies model replay overrides only to the configured model (%j)", (policy) =>
    Effect.gen(function* () {
      const h = yield* harness({
        protocol: "openai-responses",
        encryptedReasoningReplay: policy.service,
        modelReplay: policy.model,
        respond: () => Response.json(responsesAnswer),
      });
      yield* h.invoke("/v1/responses", encryptedReasoningInput);
      const first = JSON.stringify(sentBody(h.calls[0]!));
      expect(first.includes('"encrypted_content"')).toBe(!policy.omitted);
      const current = (yield* h.settings.getSettings).modelServices[serviceId]!;
      yield* h.settings.updateSettings({
        modelServices: {
          [serviceId]: {
            ...current,
            models: current.models.map((model) => ({
              ...model,
              encryptedReasoningReplay: "preserve",
            })),
          },
        },
      });
      yield* h.invoke("/v1/responses", encryptedReasoningInput);
      expect(sentBody(h.calls[1]!)).toEqual({
        ...encryptedReasoningInput,
        max_output_tokens: 4000,
      });
    }).pipe(Effect.scoped),
  );

  it.effect("does not apply a model override to another model bound to the same service", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        protocol: "openai-responses",
        modelReplay: "omit",
        respond: () => Response.json(responsesAnswer),
      });
      yield* h.gateway.materialize(yield* h.settings.getSettings, {
        [instanceId]: { ...h.instances[instanceId]!, modelService: { serviceId, modelIds: [] } },
      });
      yield* h.invoke("/v1/responses", { ...encryptedReasoningInput, model: "hidden" });
      expect(sentBody(h.calls[0]!)).toEqual({ ...encryptedReasoningInput, model: "hidden" });
      expect(h.calls).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect.each(["preserve", "omit"] as const)(
    "handles Claude thinking signatures after the real Anthropic-to-Responses bridge with replay=%s",
    (policy) =>
      Effect.gen(function* () {
        const signatureBytes = Buffer.alloc(73);
        signatureBytes[0] = 128;
        const signature = signatureBytes.toString("base64url");
        const body = {
          model: "Vendor/Exact",
          max_tokens: 100,
          messages: [
            { role: "user", content: "visible prompt" },
            {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "thinking with signature", signature },
                { type: "text", text: "visible answer" },
                { type: "tool_use", id: "call_keep", name: "Read", input: { path: "file.txt" } },
              ],
            },
            {
              role: "user",
              content: [
                { type: "tool_result", tool_use_id: "call_keep", content: "visible result" },
              ],
            },
          ],
          tools: [{ name: "Read", input_schema: { type: "object", properties: {} } }],
        };
        const original = structuredClone(body);
        const h = yield* harness({
          driver: "claudeAgent",
          protocol: "openai-responses",
          encryptedReasoningReplay: policy,
          respond: () =>
            Response.json({
              ...responsesAnswer,
              id: "resp_fixture",
              object: "response",
              model: "Vendor/Exact",
            }),
        });
        for (let request = 0; request < 2; request++) {
          if (request) yield* h.restart();
          const response = yield* h.invoke("/v1/messages", body);
          expect(response.status).toBe(200);
          expect(response.text).toContain("recovered safely");
        }
        expect(h.calls).toHaveLength(2);
        for (const request of h.calls) {
          const wire = sentBody(request);
          const text = JSON.stringify(wire);
          expect(text.includes('"encrypted_content"')).toBe(policy === "preserve");
          if (policy === "preserve") expect(text).toContain(signature);
          else expect(text).not.toContain(signature);
          for (const retained of ["visible prompt", "visible answer", "visible result"])
            expect(text).toContain(retained);
          expect(wire.input).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: "function_call",
                call_id: "call_keep",
                name: "Read",
                arguments: '{"path":"file.txt"}',
              }),
              expect.objectContaining({
                type: "function_call_output",
                call_id: "call_keep",
                output: "visible result",
              }),
            ]),
          );
        }
        expect(body).toEqual(original);
      }).pipe(Effect.scoped),
  );

  it.effect("does not rewrite other protocols when the replay policy is omit", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        driver: "pi",
        protocol: "openai-chat",
        maxOutputTokens: null,
        encryptedReasoningReplay: "omit",
      });
      const body = {
        ...encryptedReasoningInput,
        messages: [
          {
            role: "assistant",
            content: "visible",
            reasoning_content: "keep other protocol reasoning",
          },
        ],
      };
      expect((yield* h.invoke("/v1/chat/completions", body)).status).toBe(200);
      expect(sentBody(h.calls[0]!)).toEqual(body);
    }).pipe(Effect.scoped),
  );

  it.effect("stops after one repair for the observed embedded error even with forced retries", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        protocol: "openai-responses",
        maxOutputTokens: null,
        recovery: { retryEnabled: true, retryNonTransientErrors: true, maxAttempts: 100 },
        respond: () =>
          Response.json(
            {
              error: {
                code: "-4003",
                type: "invalid_request_error",
                message:
                  "code: invalid_encrypted_content; message: The encrypted content could not be verified. Reason: Encrypted content could not be decrypted or parsed.",
              },
            },
            { status: 400 },
          ),
      });
      const response = yield* h.invoke("/v1/responses", encryptedReasoningInput);
      expect(h.calls).toHaveLength(2);
      expect(sentBody(h.calls[0]!)).toEqual(encryptedReasoningInput);
      expect(JSON.stringify(sentBody(h.calls[1]!))).not.toContain('"encrypted_content"');
      expect(JSON.parse(response.text).error).toMatchObject({
        code: "invalid_encrypted_content",
        attempts: 2,
        terminationReason: "non_retryable_error",
      });
    }).pipe(Effect.scoped),
  );

  it.effect("cancels old encrypted hedges and sends only one repaired body", () =>
    Effect.gen(function* () {
      let responses = 0;
      const h = yield* harness({
        driver: "pi",
        protocol: "openai-responses",
        headersDelayMs: (attempt) => (attempt === 2 ? 10000 : 150),
        maxOutputTokens: null,
        recovery: {
          retryEnabled: true,
          retryNonTransientErrors: true,
          hedgeEnabled: true,
          hedgeDelayMs: 100,
          maxConcurrent: 2,
          maxAttempts: 100,
        },
        respond: () =>
          ++responses === 1
            ? Response.json(
                {
                  error: {
                    code: "-4003",
                    type: "invalid_request_error",
                    message:
                      "code: invalid_encrypted_content; message: The encrypted content could not be verified. Reason: Encrypted content could not be decrypted or parsed.",
                  },
                },
                { status: 400 },
              )
            : Response.json(responsesAnswer),
      });
      const fiber = yield* h
        .invoke("/v1/responses", encryptedReasoningInput)
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("1 second");
      expect((yield* Fiber.join(fiber)).status).toBe(200);
      expect(h.calls).toHaveLength(3);
      expect(sentBody(h.calls[0]!)).toEqual(encryptedReasoningInput);
      expect(sentBody(h.calls[1]!)).toEqual(encryptedReasoningInput);
      expect(JSON.stringify(sentBody(h.calls[2]!))).not.toContain('"encrypted_content"');
      expect(responses).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "records safe compatibility and failure diagnostics without treating HTTP 200 as a completed user turn",
    () => {
      const messages: Record<string, unknown>[] = [];
      const logger = Logger.make(({ message }) => {
        if (Array.isArray(message))
          for (const entry of message)
            if (entry !== null && typeof entry === "object") messages.push(record(entry));
      });
      return Effect.gen(function* () {
        const upstreamRequestId = "4171489b-838f-4e4c-9366-18cf20dadc55";
        const h = yield* harness({
          protocol: "openai-responses",
          encryptedReasoningReplay: "omit",
          recovery: { retryEnabled: true, retryNonTransientErrors: true, maxAttempts: 100 },
          respond: () =>
            Response.json(
              {
                error: {
                  code: "-4003",
                  type: "invalid_request_error",
                  message:
                    "code: invalid_encrypted_content; message: The encrypted content could not be verified. Reason: Encrypted content could not be decrypted or parsed.",
                },
              },
              { status: 400, headers: { "x-request-id": upstreamRequestId } },
            ),
        });
        yield* h.invoke("/v1/responses", encryptedReasoningInput);
        expect(messages).toContainEqual(
          expect.objectContaining({
            event: "request_compatibility",
            action: "removed_encrypted_reasoning",
            reason: "configured_omit",
            attempt: 1,
          }),
        );
        expect(messages).toContainEqual(
          expect.objectContaining({
            event: "attempt_failed",
            code: "invalid_encrypted_content",
            upstreamRequestId,
          }),
        );
        const text = JSON.stringify(messages);
        for (const secret of [
          "opaque-private-ciphertext",
          "second-private-ciphertext",
          "keep this prompt",
          "private-upstream-key",
          "private-header",
          "rs_private",
        ])
          expect(text).not.toContain(secret);
        expect(messages).not.toContainEqual(
          expect.objectContaining({ event: "terminal", reason: "response_ready" }),
        );
      }).pipe(Effect.scoped, Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
    },
  );

  it.effect(
    "retains bounded failure handling if an omit-configured request is still rejected",
    () =>
      Effect.gen(function* () {
        const h = yield* harness({
          protocol: "openai-responses",
          encryptedReasoningReplay: "omit",
          recovery: { retryEnabled: true, retryNonTransientErrors: true, maxAttempts: 100 },
          respond: () =>
            Response.json(
              {
                error: {
                  code: "-4003",
                  type: "invalid_request_error",
                  message:
                    "code: invalid_encrypted_content; message: The encrypted content could not be verified. Reason: Encrypted content could not be decrypted or parsed.",
                },
              },
              { status: 400 },
            ),
        });
        const response = yield* h.invoke("/v1/responses", encryptedReasoningInput);
        expect(response.status).toBe(400);
        expect(h.calls).toHaveLength(1);
        expect(JSON.parse(response.text).error).toMatchObject({
          code: "invalid_encrypted_content",
          attempts: 1,
          terminationReason: "non_retryable_error",
        });
      }).pipe(Effect.scoped),
  );

  it.effect.each([
    "http",
    "wrapped-http",
    "encoded-error",
    "json",
    "wrapped-json",
    "sse-flat",
    "sse-failed",
    "embedded-http",
    "embedded-json",
    "embedded-sse",
  ] as const)(
    "repairs encrypted Responses reasoning only after an explicit pre-output rejection (%s)",
    (format) =>
      Effect.gen(function* () {
        let calls = 0;
        const stream = format.startsWith("sse") || format === "embedded-sse";
        const h = yield* harness({
          driver: "pi",
          protocol: "openai-responses",
          recovery: { retryEnabled: true, retryNonTransientErrors: false, maxAttempts: 100 },
          respond: () => {
            if (++calls === 1) {
              if (format.startsWith("embedded")) {
                const error = {
                  code: "-4003",
                  type: "invalid_request_error",
                  message:
                    "code: invalid_encrypted_content; message: The encrypted content could not be verified. Reason: Encrypted content could not be decrypted or parsed.",
                };
                return format === "embedded-sse"
                  ? new Response(`data: ${JSON.stringify({ type: "error", error })}\n\n`, {
                      headers: { "content-type": "text/event-stream" },
                    })
                  : Response.json({ error }, { status: format === "embedded-http" ? 400 : 200 });
              }
              if (format === "http")
                return Response.json({ error: invalidEncryptedError }, { status: 400 });
              if (format === "wrapped-http")
                return Response.json(
                  { message: JSON.stringify({ error: invalidEncryptedError }) },
                  { status: 400 },
                );
              if (format === "encoded-error")
                return Response.json(
                  { error: { message: JSON.stringify({ error: invalidEncryptedError }) } },
                  { status: 400 },
                );
              if (format === "json") return Response.json({ error: invalidEncryptedError });
              if (format === "wrapped-json")
                return Response.json({ message: JSON.stringify({ error: invalidEncryptedError }) });
              const event =
                format === "sse-flat"
                  ? { ...invalidEncryptedError, type: "error" }
                  : { type: "response.failed", response: { error: invalidEncryptedError } };
              return new Response(`data: ${JSON.stringify(event)}\n\n`, {
                headers: { "content-type": "text/event-stream" },
              });
            }
            return stream
              ? new Response(
                  'data: {"type":"response.output_text.delta","delta":"recovered safely"}\n\ndata: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n',
                  { headers: { "content-type": "text/event-stream" } },
                )
              : Response.json(responsesAnswer);
          },
        });
        const result = yield* h.invoke("/v1/responses", { ...encryptedReasoningInput, stream });
        expect(result.status).toBe(200);
        expect(result.text).toContain("recovered safely");
        expect(result.text).not.toContain("opaque-private-ciphertext");
        expect(result.text).not.toContain("invalid_encrypted_content");
        expect(h.calls).toHaveLength(2);
        expect(sentBody(h.calls[0]!)).toEqual({
          ...encryptedReasoningInput,
          max_output_tokens: 4000,
          stream,
        });
        expect(sentBody(h.calls[1]!)).toEqual({
          ...encryptedReasoningInput,
          max_output_tokens: 4000,
          stream,
          input: [
            encryptedReasoningInput.input[0],
            {
              type: "reasoning",
              id: "rs_summary",
              summary: [{ type: "summary_text", text: "keep this summary" }],
            },
            ...encryptedReasoningInput.input.slice(3),
          ],
        });
        expect(encryptedReasoningInput.input[1]).toHaveProperty(
          "encrypted_content",
          "opaque-private-ciphertext",
        );
      }).pipe(Effect.scoped),
  );

  it.effect("limits encrypted-history cleanup to the failed request rather than future turns", () =>
    Effect.gen(function* () {
      let calls = 0;
      const h = yield* harness({
        driver: "pi",
        protocol: "openai-responses",
        maxOutputTokens: null,
        recovery: { retryEnabled: true },
        respond: () =>
          ++calls === 1
            ? Response.json({ error: invalidEncryptedError }, { status: 400 })
            : Response.json(responsesAnswer),
      });
      expect((yield* h.invoke("/v1/responses", encryptedReasoningInput)).status).toBe(200);
      expect((yield* h.invoke("/v1/responses", encryptedReasoningInput)).status).toBe(200);
      expect(h.calls).toHaveLength(3);
      expect(sentBody(h.calls[0]!)).toEqual(encryptedReasoningInput);
      expect(sentBody(h.calls[1]!)).not.toEqual(encryptedReasoningInput);
      expect(sentBody(h.calls[2]!)).toEqual(encryptedReasoningInput);
    }).pipe(Effect.scoped),
  );

  it.effect("does not sanitize other upstream protocols on an encrypted-content error", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        driver: "pi",
        protocol: "openai-chat",
        maxOutputTokens: null,
        recovery: { retryEnabled: true, retryNonTransientErrors: true, maxAttempts: 100 },
        respond: () => Response.json({ error: invalidEncryptedError }, { status: 400 }),
      });
      const body = { ...encryptedReasoningInput, messages: [] };
      expect((yield* h.invoke("/v1/chat/completions", body)).status).toBe(400);
      expect(h.calls).toHaveLength(1);
      expect(sentBody(h.calls[0]!)).toEqual(body);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "bounds encrypted-content recovery to one repaired attempt and preserves safe upstream diagnostics",
    () =>
      Effect.gen(function* () {
        const id = "4171489b-838f-4e4c-9366-18cf20dadc55";
        const h = yield* harness({
          driver: "pi",
          protocol: "openai-responses",
          recovery: { retryEnabled: true, retryNonTransientErrors: true, maxAttempts: 100 },
          respond: () =>
            Response.json(
              { message: JSON.stringify({ error: invalidEncryptedError }) },
              { status: 400, headers: { "x-request-id": id } },
            ),
        });
        const result = yield* h.invoke("/v1/responses", encryptedReasoningInput);
        expect(h.calls).toHaveLength(2);
        expect(result.status).toBe(400);
        expect(result.headers["x-should-retry"]).toBe("false");
        expect(JSON.parse(result.text)).toMatchObject({
          error: {
            code: "invalid_encrypted_content",
            requestId: id,
            attempts: 2,
            terminationReason: "non_retryable_error",
            lastAttemptFailure: { code: "invalid_encrypted_content", requestId: id },
          },
        });
        expect(result.text).toContain("could not be verified, decrypted or parsed");
        for (const privateText of [
          "private-upstream-key",
          "private-header",
          "opaque-private-ciphertext",
          "rs_private",
        ])
          expect(result.text).not.toContain(privateText);
      }).pipe(Effect.scoped),
  );

  it.effect.each([
    { retryEnabled: false, maxAttempts: 100, extra: {} },
    { retryEnabled: true, maxAttempts: 1, extra: {} },
    { retryEnabled: true, maxAttempts: 100, extra: { previous_response_id: "resp_stateful" } },
    { retryEnabled: true, maxAttempts: 100, extra: { conversation: "conv_stateful" } },
    { retryEnabled: true, maxAttempts: 100, extra: { background: true } },
    { retryEnabled: true, maxAttempts: 100, extra: { tools: [{ type: "web_search" }] } },
    {
      retryEnabled: true,
      maxAttempts: 100,
      extra: { input: [{ role: "user", content: "no ciphertext" }] },
    },
  ])(
    "does not replay encrypted errors when the request cannot safely be repaired (%j)",
    (scenario) =>
      Effect.gen(function* () {
        const h = yield* harness({
          driver: "pi",
          protocol: "openai-responses",
          maxOutputTokens: null,
          recovery: {
            retryEnabled: scenario.retryEnabled,
            maxAttempts: scenario.maxAttempts,
            retryNonTransientErrors: true,
          },
          respond: () => Response.json({ error: invalidEncryptedError }, { status: 400 }),
        });
        const body = { ...encryptedReasoningInput, ...scenario.extra };
        const result = yield* h.invoke("/v1/responses", body);
        expect(result.status).toBe(400);
        expect(h.calls).toHaveLength(1);
        expect(sentBody(h.calls[0]!)).toEqual(body);
      }).pipe(Effect.scoped),
  );

  it.effect.each(["success", "transient", "different-400"] as const)(
    "keeps original encrypted history unless the exact error is returned (%s)",
    (kind) =>
      Effect.gen(function* () {
        let calls = 0;
        const h = yield* harness({
          driver: "pi",
          protocol: "openai-responses",
          maxOutputTokens: null,
          recovery: { retryEnabled: true },
          respond: () =>
            ++calls === 1 && kind !== "success"
              ? Response.json(
                  {
                    error:
                      kind === "transient"
                        ? { code: "server_error" }
                        : {
                            code: "invalid_request_error",
                            message: "invalid_encrypted_content appeared in user input",
                          },
                  },
                  { status: kind === "transient" ? 503 : 400 },
                )
              : Response.json(responsesAnswer),
        });
        const fiber = yield* h
          .invoke("/v1/responses", encryptedReasoningInput)
          .pipe(Effect.forkChild);
        yield* TestClock.adjust("2 seconds");
        const result = yield* Fiber.join(fiber);
        expect(result.status).toBe(kind === "different-400" ? 400 : 200);
        expect(h.calls).toHaveLength(kind === "transient" ? 2 : 1);
        for (const request of h.calls) expect(sentBody(request)).toEqual(encryptedReasoningInput);
      }).pipe(Effect.scoped),
  );

  it.effect("does not sanitize or replay encrypted-content stream errors after output starts", () =>
    Effect.gen(function* () {
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      const h = yield* harness({
        driver: "pi",
        protocol: "openai-responses",
        maxOutputTokens: null,
        recovery: { retryEnabled: true, retryNonTransientErrors: true, maxAttempts: 100 },
        respond: () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(output) {
                controller = output;
                output.enqueue(
                  new TextEncoder().encode(
                    'data: {"type":"response.output_text.delta","delta":"already delivered"}\n\n',
                  ),
                );
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      });
      const fiber = yield* h
        .invoke("/v1/responses", { ...encryptedReasoningInput, stream: true })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("1 second");
      controller!.enqueue(
        new TextEncoder().encode(
          `data: ${JSON.stringify({ ...invalidEncryptedError, type: "error" })}\n\n`,
        ),
      );
      controller!.close();
      const result = yield* Fiber.join(fiber);
      expect(result.text).toContain("already delivered");
      expect(h.calls).toHaveLength(1);
      expect(sentBody(h.calls[0]!)).toEqual({ ...encryptedReasoningInput, stream: true });
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    { nextTurn: false, stream: false },
    { nextTurn: true, stream: false },
    { nextTurn: false, stream: true },
    { nextTurn: true, stream: true },
  ])(
    "keeps sibling background requests alive across parent completion and the next turn (%j)",
    ({ nextTurn, stream }) =>
      Effect.gen(function* () {
        const firstReady = yield* Deferred.make<void>();
        const ready = yield* Deferred.make<void>();
        const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
        const cancelled: number[] = [];
        const h = yield* harness({
          driver: "claudeAgent",
          protocol: "openai-responses",
          respond: () => {
            const id = controllers.length;
            return new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controllers.push(controller);
                  if (controllers.length === 1) Deferred.doneUnsafe(firstReady, Effect.void);
                  if (controllers.length === 2) Deferred.doneUnsafe(ready, Effect.void);
                },
                cancel() {
                  cancelled.push(id);
                },
              }),
              { headers: { "content-type": stream ? "text/event-stream" : "application/json" } },
            );
          },
        });
        const session = ProviderSessionId.make("background-session");
        yield* h.gateway.lifecycle.begin(session, recoveryInput("a"), () => Effect.void);
        yield* h.gateway.lifecycle.observe(session, recoveryTurn("a"));
        const headers = { authorization: `Bearer ${h.token}.${session}` };
        const invoke = (content: string) =>
          h.invoke(
            "/v1/messages",
            {
              model: "Vendor/Exact",
              stream,
              max_tokens: 100,
              messages: [{ role: "user", content }],
            },
            headers,
          );
        const first = yield* invoke("first child").pipe(Effect.forkChild);
        yield* Deferred.await(firstReady);
        const second = yield* invoke("second child").pipe(Effect.forkChild);
        yield* Deferred.await(ready);
        yield* h.gateway.lifecycle.observe(session, recoveryTerminal("a"));
        if (nextTurn) {
          yield* h.gateway.lifecycle.begin(session, recoveryInput("b"), () => Effect.void);
          yield* h.gateway.lifecycle.observe(session, recoveryTurn("b"));
          yield* h.gateway.lifecycle.observe(session, recoveryTerminal("a"));
        }
        yield* TestClock.adjust("1 second");
        expect(cancelled).toEqual([]);
        const finish = (id: number) => {
          const response = {
            id: `response-${id}`,
            object: "response",
            status: "completed",
            model: "Vendor/Exact",
            output: [
              {
                id: `message-${id}`,
                type: "message",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: `child ${id} succeeded`, annotations: [] }],
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          };
          const item = response.output[0]!;
          const text = stream
            ? [
                {
                  type: "response.created",
                  response: { id: response.id, model: response.model, created_at: 1 },
                },
                {
                  type: "response.output_item.added",
                  output_index: 0,
                  item: { ...item, content: [] },
                },
                {
                  type: "response.content_part.added",
                  item_id: item.id,
                  output_index: 0,
                  content_index: 0,
                  part: { type: "output_text", text: "" },
                },
                {
                  type: "response.output_text.delta",
                  item_id: item.id,
                  output_index: 0,
                  content_index: 0,
                  delta: item.content[0]!.text,
                },
                { type: "response.completed", response },
              ]
                .map((event) => `data: ${JSON.stringify(event)}\n\n`)
                .join("")
            : JSON.stringify(response);
          controllers[id]!.enqueue(new TextEncoder().encode(text));
          controllers[id]!.close();
        };
        finish(0);
        expect(yield* Fiber.join(first)).toMatchObject({
          status: 200,
          text: expect.stringContaining("child 0 succeeded"),
        });
        yield* h.gateway.lifecycle.observe(session, {
          ...recoveryTerminal("a"),
          providerTurnId: ProviderTurnId.make("completed-child-turn"),
        });
        yield* TestClock.adjust("1 second");
        expect(cancelled).toEqual([]);
        finish(1);
        expect(yield* Fiber.join(second)).toMatchObject({
          status: 200,
          text: expect.stringContaining("child 1 succeeded"),
        });
        expect(h.calls).toHaveLength(2);
      }).pipe(Effect.scoped),
  );

  it.effect("cancels one child request without cancelling another child sharing the session", () =>
    Effect.gen(function* () {
      const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
      const cancelled: number[] = [];
      const h = yield* harness({
        respond: () => {
          const id = controllers.length;
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controllers.push(controller);
              },
              cancel() {
                cancelled.push(id);
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      });
      const session = ProviderSessionId.make("child-stop-session");
      yield* h.gateway.lifecycle.begin(session, recoveryInput("a"), () => Effect.void);
      yield* h.gateway.lifecycle.observe(session, recoveryTurn("a"));
      const headers = { authorization: `Bearer ${h.token}.${session}` };
      const invoke = (id: number) =>
        h.invoke(
          "/v1/chat/completions",
          {
            model: "Vendor/Exact",
            stream: true,
            messages: [{ role: "user", content: `child ${id}` }],
          },
          headers,
        );
      const first = yield* invoke(0).pipe(Effect.forkChild);
      yield* TestClock.adjust("1 second");
      const second = yield* invoke(1).pipe(Effect.forkChild);
      yield* TestClock.adjust("1 second");
      yield* h.gateway.lifecycle.observe(session, recoveryTerminal("a"));
      yield* Fiber.interrupt(first);
      yield* TestClock.adjust("1 second");
      expect(cancelled).toEqual([0]);
      controllers[1]!.enqueue(
        new TextEncoder().encode(
          chatStreamFrame({ content: "sibling survived" }, "stop") + "data: [DONE]\n\n",
        ),
      );
      controllers[1]!.close();
      const response = yield* Fiber.join(second);
      expect(response.status).toBe(200);
      expect(response.text).toContain("sibling survived");
      expect(h.calls).toHaveLength(2);
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    {
      protocol: "openai-chat",
      path: "/v1/chat/completions",
      chunk: { choices: [{ delta: { content: "before stop" } }] },
    },
    {
      protocol: "openai-responses",
      path: "/v1/responses",
      chunk: { type: "response.output_text.delta", delta: "before stop" },
    },
    {
      protocol: "anthropic-messages",
      path: "/v1/messages",
      chunk: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "before stop" },
      },
    },
    {
      protocol: "gemini",
      path: "/v1beta/models/Vendor%2FExact:streamGenerateContent",
      chunk: { candidates: [{ content: { parts: [{ text: "before stop" }] } }] },
    },
  ] as const)(
    "reports cancellation after output as a protocol error instead of an empty response (%j)",
    (scenario) =>
      Effect.gen(function* () {
        let cancelled = false;
        const h = yield* harness({
          protocol: scenario.protocol,
          respond: () =>
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(
                    new TextEncoder().encode(`data: ${JSON.stringify(scenario.chunk)}\n\n`),
                  );
                },
                cancel() {
                  cancelled = true;
                },
              }),
              { headers: { "content-type": "text/event-stream" } },
            ),
        });
        const session = ProviderSessionId.make("stream-stop-session");
        yield* h.gateway.lifecycle.begin(session, recoveryInput("a"), () => Effect.void);
        yield* h.gateway.lifecycle.observe(session, recoveryTurn("a"));
        yield* Effect.gen(function* () {
          const request = HttpServerRequest.fromWeb(
            new Request(`http://127.0.0.1/api/model-gateway${scenario.path}`, {
              method: "POST",
              headers: {
                authorization: `Bearer ${h.token}.${session}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({ model: "Vendor/Exact", stream: true }),
            }),
          );
          const response = yield* h.gateway.handle.pipe(
            Effect.provideService(HttpServerRequest.HttpServerRequest, request),
          );
          expect(response.status).toBe(200);
          if (response.body._tag !== "Stream") throw new Error("Expected streaming response");
          const reading = yield* response.body.stream.pipe(
            Stream.decodeText(),
            Stream.mkString,
            Effect.orDie,
            Effect.forkChild,
          );
          yield* TestClock.adjust("1 second");
          yield* h.gateway.lifecycle.observe(session, recoveryTerminal("a"));
          yield* h.gateway.lifecycle.cancel(session);
          yield* TestClock.adjust("1 second");
          const text = yield* Fiber.join(reading);
          expect(text).toContain("before stop");
          expect(text).toContain("The model service request was cancelled.");
          expect(text).toContain(
            scenario.protocol === "gemini"
              ? '"status":"CANCELLED"'
              : "cox_model_service_request_cancelled",
          );
        }).pipe(Effect.scoped);
        expect(cancelled).toBe(true);
        expect(h.calls).toHaveLength(1);
      }).pipe(Effect.scoped),
  );

  it.effect.each(["cancel", "close"] as const)(
    "explicitly cancels old and new background requests with a non-retryable error (%s)",
    (action) =>
      Effect.gen(function* () {
        const cancelled: number[] = [];
        let calls = 0;
        const h = yield* harness({
          recovery: { retryEnabled: true, hedgeEnabled: true },
          respond: () => {
            const id = ++calls;
            return new Response(
              new ReadableStream({
                cancel() {
                  cancelled.push(id);
                },
              }),
              {
                headers: { "content-type": "text/event-stream" },
              },
            );
          },
        });
        const session = ProviderSessionId.make("cancel-session");
        const headers = { authorization: `Bearer ${h.token}.${session}` };
        yield* h.gateway.lifecycle.begin(session, recoveryInput("a"), () => Effect.void);
        yield* h.gateway.lifecycle.observe(session, recoveryTurn("a"));
        const first = yield* h
          .invoke(
            "/v1/chat/completions",
            { model: "Vendor/Exact", stream: true, messages: ["old"] },
            headers,
          )
          .pipe(Effect.forkChild);
        yield* TestClock.adjust("1 second");
        yield* h.gateway.lifecycle.observe(session, recoveryTerminal("a"));
        yield* h.gateway.lifecycle.begin(session, recoveryInput("b"), () => Effect.void);
        const second = yield* h
          .invoke(
            "/v1/chat/completions",
            { model: "Vendor/Exact", stream: true, messages: ["new"] },
            headers,
          )
          .pipe(Effect.forkChild);
        yield* TestClock.adjust("1 second");
        yield* h.gateway.lifecycle[action](session);
        yield* TestClock.adjust("1 second");
        for (const fiber of [first, second]) {
          const response = yield* Fiber.join(fiber);
          expect(response.status).toBe(499);
          expect(response.headers["x-should-retry"]).toBe("false");
          expect(JSON.parse(response.text)).toMatchObject({
            error: { type: "request_cancelled", code: "cox_model_service_request_cancelled" },
          });
        }
        expect(cancelled.toSorted()).toEqual([1, 2]);
        expect(h.calls).toHaveLength(2);
      }).pipe(Effect.scoped),
  );

  it.effect.each(
    [400, 401, 403, 404, 422, 501].flatMap((status) =>
      [false, true].map((enabled) => ({ status, enabled })),
    ),
  )("configures retries for non-transient upstream errors (%j)", ({ status, enabled }) =>
    Effect.gen(function* () {
      let calls = 0;
      const h = yield* harness({
        recovery: { retryEnabled: true, retryNonTransientErrors: enabled },
        respond: () =>
          ++calls === 1
            ? Response.json({ error: { code: "invalid_request_error" } }, { status })
            : Response.json({ choices: [{ message: { content: "recovered" } }] }),
      });
      const fiber = yield* h
        .invoke("/v1/chat/completions", {
          model: "Vendor/Exact",
          messages: [],
        })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("2 seconds");
      const result = yield* Fiber.join(fiber);
      expect(result.status).toBe(enabled ? 200 : status);
      expect(h.calls).toHaveLength(enabled ? 2 : 1);
      if (enabled) expect(result.text).toContain("recovered");
    }).pipe(Effect.scoped),
  );

  it.effect.each([false, true])(
    "keeps upstream-tool HTTP 400 retries opt-in (%s)",
    (retryToolRequests) =>
      Effect.gen(function* () {
        let calls = 0;
        const h = yield* harness({
          protocol: "openai-responses",
          recovery: { retryEnabled: true, retryNonTransientErrors: true, retryToolRequests },
          respond: () =>
            ++calls === 1
              ? Response.json({ error: { code: "invalid_request_error" } }, { status: 400 })
              : Response.json({
                  status: "completed",
                  output: [{ type: "message", content: [{ type: "output_text", text: "found" }] }],
                }),
        });
        const fiber = yield* h
          .invoke("/v1/responses", {
            model: "Vendor/Exact",
            input: "search",
            tools: [{ type: "web_search" }],
          })
          .pipe(Effect.forkChild);
        yield* TestClock.adjust("2 seconds");
        expect((yield* Fiber.join(fiber)).status).toBe(retryToolRequests ? 200 : 400);
        expect(h.calls).toHaveLength(retryToolRequests ? 2 : 1);
      }).pipe(Effect.scoped),
  );

  it.effect("does not replay non-transient stream errors after output starts", () =>
    Effect.gen(function* () {
      const encoder = new TextEncoder();
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      const h = yield* harness({
        recovery: { retryEnabled: true, retryNonTransientErrors: true },
        respond: () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(output) {
                controller = output;
                output.enqueue(
                  encoder.encode(
                    'data: {"choices":[{"delta":{"content":"already delivered"}}]}\n\n',
                  ),
                );
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      });
      const fiber = yield* h
        .invoke("/v1/chat/completions", {
          model: "Vendor/Exact",
          messages: [],
          stream: true,
        })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("1 second");
      controller!.enqueue(
        encoder.encode('data: {"error":{"status":400,"code":"invalid_request_error"}}\n\n'),
      );
      controller!.close();
      const result = yield* Fiber.join(fiber);
      expect(result.text).toContain("already delivered");
      expect(h.calls).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect.each([false, true])("makes quota 429 retries configurable (%s)", (retryOn429) =>
    Effect.gen(function* () {
      let calls = 0;
      const h = yield* harness({
        recovery: { retryEnabled: true, retryOn429 },
        respond: () =>
          ++calls === 1
            ? Response.json(
                { error: { code: "insufficient_quota" } },
                { status: 429, headers: { "retry-after": "3600" } },
              )
            : Response.json({ choices: [{ message: { content: "quota recovered" } }] }),
      });
      const fiber = yield* h
        .invoke("/v1/chat/completions", { model: "Vendor/Exact", messages: [] })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("2 seconds");
      const result = yield* Fiber.join(fiber);
      expect(result.status).toBe(retryOn429 ? 200 : 429);
      expect(h.calls).toHaveLength(retryOn429 ? 2 : 1);
      if (retryOn429) expect(result.text).toContain("quota recovered");
    }).pipe(Effect.scoped),
  );

  it.effect.each([false, true])(
    "recognizes quota 429 errors inside successful HTTP responses (stream=%s)",
    (stream) =>
      Effect.gen(function* () {
        let calls = 0;
        const h = yield* harness({
          recovery: { retryEnabled: true, retryOn429: true },
          respond: () => {
            calls++;
            if (!stream)
              return Response.json(
                calls === 1
                  ? { error: { status: 429, code: "insufficient_quota" } }
                  : { choices: [{ message: { content: "quota recovered" } }] },
              );
            return new Response(
              calls === 1
                ? 'data: {"error":{"status":429,"code":"insufficient_quota"}}\n\n'
                : chatStreamFrame({ content: "quota recovered" }, "stop") + "data: [DONE]\n\n",
              { headers: { "content-type": "text/event-stream" } },
            );
          },
        });
        const fiber = yield* h
          .invoke("/v1/chat/completions", { model: "Vendor/Exact", messages: [], stream })
          .pipe(Effect.forkChild);
        yield* TestClock.adjust("2 seconds");
        const result = yield* Fiber.join(fiber);
        expect(result.status).toBe(200);
        expect(result.text).toContain("quota recovered");
        expect(result.text).not.toContain("insufficient_quota");
        expect(h.calls).toHaveLength(2);
      }).pipe(Effect.scoped),
  );

  it.effect.each([
    { retryToolRequests: false, retryOn429: false, status: 503, attempts: 1 },
    { retryToolRequests: true, retryOn429: false, status: 503, attempts: 2 },
    { retryToolRequests: true, retryOn429: false, status: 429, attempts: 1 },
    { retryToolRequests: false, retryOn429: true, status: 429, attempts: 1 },
    { retryToolRequests: true, retryOn429: true, status: 429, attempts: 2 },
    { retryToolRequests: true, retryOn429: true, status: 401, attempts: 1 },
  ])("configures recovery for upstream web search requests (%j)", (scenario) =>
    Effect.gen(function* () {
      let calls = 0;
      const h = yield* harness({
        protocol: "openai-responses",
        recovery: {
          retryEnabled: true,
          retryOn429: scenario.retryOn429,
          retryToolRequests: scenario.retryToolRequests,
        },
        respond: () =>
          ++calls === 1
            ? Response.json(
                {
                  error: {
                    code: scenario.status === 429 ? "insufficient_quota" : "upstream_error",
                  },
                },
                { status: scenario.status },
              )
            : Response.json({
                status: "completed",
                output: [{ type: "message", content: [{ type: "output_text", text: "found" }] }],
              }),
      });
      const fiber = yield* h
        .invoke("/v1/responses", {
          model: "Vendor/Exact",
          input: "search",
          tools: [{ type: "web_search" }],
        })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("2 seconds");
      const result = yield* Fiber.join(fiber);
      expect(result.status).toBe(scenario.attempts === 2 ? 200 : scenario.status);
      expect(h.calls).toHaveLength(scenario.attempts);
      if (scenario.attempts === 2) expect(result.text).toContain("found");
    }).pipe(Effect.scoped),
  );

  it.effect("retries failed web search streams without forwarding failed tool events", () =>
    Effect.gen(function* () {
      let calls = 0;
      const h = yield* harness({
        protocol: "openai-responses",
        recovery: { retryEnabled: true, retryToolRequests: true },
        respond: () =>
          new Response(
            ++calls === 1
              ? 'data: {"type":"response.output_item.added","item":{"type":"web_search_call","id":"failed-search"}}\n\ndata: {"type":"response.failed","response":{"error":{"code":"server_error"}}}\n\n'
              : 'data: {"type":"response.output_text.delta","delta":"found"}\n\ndata: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n',
            { headers: { "content-type": "text/event-stream" } },
          ),
      });
      const fiber = yield* h
        .invoke("/v1/responses", {
          model: "Vendor/Exact",
          stream: true,
          input: "search",
          tools: [{ type: "web_search" }],
        })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("2 seconds");
      const result = yield* Fiber.join(fiber);
      expect(result.status).toBe(200);
      expect(result.text).toContain("found");
      expect(result.text).not.toContain("failed-search");
      expect(h.calls).toHaveLength(2);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps tool requests sequential and cancels stalled requests at the budget", () =>
    Effect.gen(function* () {
      let cancelled = false;
      const h = yield* harness({
        protocol: "openai-responses",
        recovery: {
          retryEnabled: true,
          retryToolRequests: true,
          hedgeEnabled: true,
          hedgeDelayMs: 100,
          budgetMs: 2000,
        },
        respond: () =>
          new Response(
            new ReadableStream({
              cancel() {
                cancelled = true;
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      });
      const fiber = yield* h
        .invoke("/v1/responses", {
          model: "Vendor/Exact",
          stream: true,
          input: "search",
          tools: [{ type: "web_search" }],
        })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("1 second");
      expect(h.calls).toHaveLength(1);
      yield* TestClock.adjust("2 seconds");
      expect((yield* Fiber.join(fiber)).status).toBe(504);
      expect(h.calls).toHaveLength(1);
      expect(cancelled).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect.each(
    [
      { background: true },
      { previous_response_id: "prior-response" },
      { conversation: "prior-conversation" },
    ].flatMap((state) => [400, 429].map((status) => ({ state, status }))),
  )(
    "preserves stateful request limits when retry overrides are enabled (%j)",
    ({ state, status }) =>
      Effect.gen(function* () {
        const h = yield* harness({
          protocol: "openai-responses",
          recovery: {
            retryEnabled: true,
            retryOn429: true,
            retryNonTransientErrors: true,
            retryToolRequests: true,
          },
          respond: () => Response.json({ error: { code: "invalid_request_error" } }, { status }),
        });
        const result = yield* h.invoke("/v1/responses", {
          model: "Vendor/Exact",
          input: "search",
          tools: [{ type: "web_search" }],
          ...state,
        });
        expect(result.status).toBe(status);
        expect(h.calls).toHaveLength(1);
      }).pipe(Effect.scoped),
  );

  it.effect.each([400, 429, 503])(
    "gives repeated requests independent recovery budgets for HTTP %s",
    (status) =>
      Effect.gen(function* () {
        const test = yield* harness({
          recovery: {
            retryEnabled: true,
            retryNonTransientErrors: true,
            retryOn429: true,
            maxAttempts: 2,
          },
          respond: () =>
            Response.json(
              { error: { code: status === 429 ? "insufficient_quota" : "invalid_request_error" } },
              { status },
            ),
        });
        const session = ProviderSessionId.make("tracked-session");
        yield* test.gateway.lifecycle.begin(session, recoveryInput("tracked"), () => Effect.void);
        const body = { model: "Vendor/Exact", messages: [] };
        const headers = { authorization: `Bearer ${test.token}.${session}` };
        for (const attempts of [2, 4]) {
          const fiber = yield* test
            .invoke("/v1/chat/completions", body, headers)
            .pipe(Effect.forkChild);
          yield* TestClock.adjust("2 seconds");
          const response = yield* Fiber.join(fiber);
          expect(response.status).toBe(status);
          expect(JSON.parse(response.text)).toMatchObject({
            error: { attempts: 2, terminationReason: "recovery_attempts_exhausted" },
          });
          expect(test.calls).toHaveLength(attempts);
        }
      }).pipe(Effect.scoped),
  );

  it.effect(
    "recovers an identical Pi request after twenty failures with a fresh request ID",
    () => {
      const messages: Record<string, unknown>[] = [];
      const logger = Logger.make(({ message }) => {
        if (Array.isArray(message))
          for (const entry of message)
            if (typeof entry === "object" && entry !== null) messages.push(record(entry));
      });
      return Effect.gen(function* () {
        let calls = 0;
        const test = yield* harness({
          driver: "pi",
          protocol: "openai-responses",
          recovery: {
            retryEnabled: true,
            retryNonTransientErrors: true,
            retryOn429: true,
            retryToolRequests: true,
            maxAttempts: 20,
            maxConcurrent: 5,
          },
          respond: () =>
            ++calls <= 23
              ? Response.json({ error: { code: "invalid_request_error" } }, { status: 400 })
              : Response.json({
                  status: "completed",
                  output: [
                    {
                      type: "message",
                      content: [{ type: "output_text", text: "recovered identical payload" }],
                    },
                  ],
                }),
        });
        const session = ProviderSessionId.make("pi-retry-session");
        const input = recoveryInput("pi-retry");
        yield* test.gateway.lifecycle.begin(
          session,
          {
            ...input,
            providerThread: { ...input.providerThread, driver: ProviderDriverKind.make("pi") },
          },
          () => Effect.void,
        );
        const body = {
          model: "Vendor/Exact",
          input: "same synthetic request",
          tools: [{ type: "web_search" }],
        };
        const headers = { authorization: `Bearer ${test.token}.${session}` };
        const first = yield* test.invoke("/v1/responses", body, headers).pipe(Effect.forkChild);
        yield* TestClock.adjust("2 minutes");
        const failure = yield* Fiber.join(first);
        expect(failure.status).toBe(400);
        expect(JSON.parse(failure.text)).toMatchObject({
          error: { attempts: 20, terminationReason: "recovery_attempts_exhausted" },
        });
        expect(test.calls).toHaveLength(20);
        const second = yield* test.invoke("/v1/responses", body, headers).pipe(Effect.forkChild);
        yield* TestClock.adjust("10 seconds");
        expect(yield* Fiber.join(second)).toMatchObject({
          status: 200,
          text: expect.stringContaining("recovered identical payload"),
        });
        expect(test.calls).toHaveLength(24);
        const policies = messages.filter((message) => message.event === "policy");
        expect(policies).toHaveLength(2);
        const requestIds = policies.map((message) => message.requestId);
        expect(new Set(requestIds).size).toBe(2);
        for (const requestId of requestIds) {
          expect(requestId).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
          const attempts = messages.filter(
            (message) => message.event === "attempt_started" && message.requestId === requestId,
          );
          expect(attempts[0]?.attempt).toBe(1);
          expect(policies.find((message) => message.requestId === requestId)?.runId).toBe(
            input.runId,
          );
        }
        expect(JSON.stringify(messages)).not.toContain("cached_failure");
      }).pipe(Effect.scoped, Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
    },
  );

  it.effect.each([400, 422])(
    "does not cache non-retryable HTTP %s failures between requests",
    (status) =>
      Effect.gen(function* () {
        const test = yield* harness({
          recovery: { retryEnabled: true },
          respond: () => Response.json({ error: { code: "invalid_request_error" } }, { status }),
        });
        const session = ProviderSessionId.make("invalid-session");
        yield* test.gateway.lifecycle.begin(session, recoveryInput("invalid"), () => Effect.void);
        const body = { model: "Vendor/Exact", messages: [] };
        const headers = { authorization: `Bearer ${test.token}.${session}` };
        for (const attempts of [1, 2]) {
          expect((yield* test.invoke("/v1/chat/completions", body, headers)).status).toBe(status);
          expect(test.calls).toHaveLength(attempts);
        }
      }).pipe(Effect.scoped),
  );

  it.effect(
    "renews recovery budgets across native reconnects and preserves each failure cause",
    () =>
      Effect.gen(function* () {
        const test = yield* harness({
          recovery: {
            retryEnabled: true,
            hedgeEnabled: true,
            hedgeDelayMs: 100,
            budgetMs: 1000,
            responseHeadersTimeoutMs: 300,
          },
          headersDelayMs: 10000,
        });
        const session = ProviderSessionId.make("budget-session");
        yield* test.gateway.lifecycle.begin(session, recoveryInput("budget"), () => Effect.void);
        const body = { model: "Vendor/Exact", messages: [] };
        const headers = { authorization: `Bearer ${test.token}.${session}` };
        const fiber = yield* test
          .invoke("/v1/chat/completions", body, headers)
          .pipe(Effect.forkChild);
        yield* TestClock.adjust("2 seconds");
        const first = yield* Fiber.join(fiber);
        expect(first.status).toBe(504);
        expect(JSON.parse(first.text)).toMatchObject({
          error: {
            code: "recovery_budget_exhausted",
            source: "gateway",
            budgetMs: 1000,
            lastAttemptFailure: {
              code: "upstream_response_headers_timeout",
              timeoutMs: 300,
              source: "gateway",
            },
          },
        });
        const count = test.calls.length;
        const second = yield* test
          .invoke("/v1/chat/completions", body, headers)
          .pipe(Effect.forkChild);
        yield* TestClock.adjust("2 seconds");
        const repeated = yield* Fiber.join(second);
        expect(repeated.status).toBe(504);
        expect(JSON.parse(repeated.text)).toMatchObject({
          error: {
            code: "recovery_budget_exhausted",
            source: "gateway",
            budgetMs: 1000,
            lastAttemptFailure: {
              code: "upstream_response_headers_timeout",
              timeoutMs: 300,
              source: "gateway",
            },
          },
        });
        expect(repeated.headers["x-should-retry"]).toBe("false");
        expect(test.calls.length).toBeGreaterThan(count);
      }).pipe(Effect.scoped),
  );

  it.effect("allows response headers beyond the old 120 second limit when configured", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        recovery: { responseHeadersTimeoutMs: 150000, budgetMs: 180000 },
        headersDelayMs: 130000,
      });
      const fiber = yield* h
        .invoke("/v1/chat/completions", { model: "Vendor/Exact", messages: [] })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("131 seconds");
      expect((yield* Fiber.join(fiber)).status).toBe(200);
      expect(h.calls).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("uses the remaining budget when the configured headers timeout is longer", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        recovery: { responseHeadersTimeoutMs: 10000, budgetMs: 1000 },
        headersDelayMs: 5000,
      });
      const fiber = yield* h
        .invoke("/v1/chat/completions", { model: "Vendor/Exact", messages: [] })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("2 seconds");
      const result = yield* Fiber.join(fiber);
      expect(result.status).toBe(504);
      expect(JSON.parse(result.text)).toMatchObject({
        error: { code: "recovery_budget_exhausted", elapsedMs: 1000, attempts: 1 },
      });
      expect(JSON.parse(result.text).error).not.toHaveProperty("lastAttemptFailure");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "logs effective policy, header timing and terminal causes without request secrets",
    () => {
      const messages: unknown[] = [];
      const logger = Logger.make(({ message }) => {
        messages.push(message);
      });
      return Effect.gen(function* () {
        const h = yield* harness({
          protocol: "openai-responses",
          recovery: { retryEnabled: true, hedgeEnabled: true },
          respond: () =>
            Response.json(
              { error: { message: "private-upstream-key", code: "server_error" } },
              { status: 502 },
            ),
        });
        const result = yield* h.invoke("/v1/responses", {
          model: "Vendor/Exact",
          input: "private-business-document",
          previous_response_id: "private-conversation",
          tools: [{ type: "web_search" }],
        });
        expect(result.status).toBe(502);
        const logs = JSON.stringify(messages);
        expect(logs).toContain('"hedgeDisabledReason":"stateful_request"');
        expect(logs).toContain('"retryDisabledReason":"stateful_request"');
        expect(logs).toContain('"event":"response_headers"');
        expect(logs).toContain('"reason":"retry_disabled"');
        expect(logs).toContain('"source":"upstream"');
        for (const secret of [
          "private-upstream-key",
          "private-header",
          "private-business-document",
          "private-conversation",
          h.token,
        ])
          expect(logs).not.toContain(secret);
      }).pipe(Effect.scoped, Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
    },
  );

  it.effect("recovers transient HTTP failures without leaking rejected bodies", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const h = yield* harness({
        recovery: { retryEnabled: true },
        respond: () =>
          ++attempts === 1
            ? Response.json({ error: { message: "private-upstream-key" } }, { status: 503 })
            : Response.json({ choices: [{ message: { content: "recovered" } }] }),
      });
      const fiber = yield* h
        .invoke("/v1/chat/completions", { model: "Vendor/Exact", messages: [] })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("2 seconds");
      const result = yield* Fiber.join(fiber);
      expect(result.status).toBe(200);
      expect(result.text).toContain("recovered");
      expect(result.text).not.toContain("private-upstream-key");
      expect(h.calls).toHaveLength(2);
    }).pipe(Effect.scoped),
  );

  it.effect("races effective output rather than HTTP headers or SSE heartbeats", () =>
    Effect.gen(function* () {
      const encoder = new TextEncoder();
      let calls = 0;
      let cancelled = false;
      const h = yield* harness({
        recovery: { hedgeEnabled: true, hedgeDelayMs: 100 },
        respond: () => {
          calls++;
          return calls === 1
            ? new Response(
                new ReadableStream({
                  start(controller) {
                    controller.enqueue(
                      encoder.encode(
                        ': ping\n\ndata: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
                      ),
                    );
                  },
                  cancel() {
                    cancelled = true;
                  },
                }),
                { headers: { "content-type": "text/event-stream" } },
              )
            : new Response(
                chatStreamFrame(
                  {
                    tool_calls: [
                      { index: 0, id: "winner-tool", function: { name: "shell", arguments: "{}" } },
                    ],
                  },
                  "tool_calls",
                ) + "data: [DONE]\n\n",
                { headers: { "content-type": "text/event-stream" } },
              );
        },
      });
      const fiber = yield* h
        .invoke("/v1/chat/completions", { model: "Vendor/Exact", stream: true, messages: [] })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("1 second");
      const result = yield* Fiber.join(fiber);
      expect(result.status).toBe(200);
      expect(result.text.match(/winner-tool/g)).toHaveLength(1);
      expect(result.text).not.toContain("ping");
      expect(result.text).not.toContain('"role":"assistant"');
      expect(calls).toBe(2);
      expect(cancelled).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("recovers errors embedded in a 200 SSE stream before forwarding any events", () =>
    Effect.gen(function* () {
      let calls = 0;
      const h = yield* harness({
        recovery: { retryEnabled: true },
        respond: () =>
          new Response(
            ++calls === 1
              ? 'data: {"type":"error","error":{"type":"overloaded_error","message":"private-upstream-key"}}\n\n'
              : chatStreamFrame({ content: "recovered stream" }, "stop") + "data: [DONE]\n\n",
            { headers: { "content-type": "text/event-stream" } },
          ),
      });
      const fiber = yield* h
        .invoke("/v1/chat/completions", { model: "Vendor/Exact", stream: true, messages: [] })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("2 seconds");
      const result = yield* Fiber.join(fiber);
      expect(result.text).toContain("recovered stream");
      expect(result.text).not.toContain("private-upstream-key");
      expect(calls).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.effect("does not start backups once reasoning has been committed", () =>
    Effect.gen(function* () {
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      const encoder = new TextEncoder();
      const h = yield* harness({
        recovery: { hedgeEnabled: true, hedgeDelayMs: 100, budgetMs: 200 },
        respond: () =>
          new Response(
            new ReadableStream({
              start(next) {
                controller = next;
                next.enqueue(
                  encoder.encode(
                    'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n',
                  ),
                );
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      });
      const response = yield* h.gateway.handle.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request("http://127.0.0.1/api/model-gateway/v1/chat/completions", {
              method: "POST",
              headers: { authorization: `Bearer ${h.token}`, "content-type": "application/json" },
              body: JSON.stringify({ model: "Vendor/Exact", stream: true, messages: [] }),
            }),
          ),
        ),
      );
      yield* TestClock.adjust("1 second");
      expect(h.calls).toHaveLength(1);
      controller!.enqueue(
        encoder.encode(chatStreamFrame({ content: "answer" }, "stop") + "data: [DONE]\n\n"),
      );
      controller!.close();
      expect(yield* Effect.promise(() => HttpServerResponse.toWeb(response).text())).toContain(
        "answer",
      );
      expect(h.calls).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("provides scoped local credentials and filters the model list", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      expect(h.token).toBeTypeOf("string");
      expect(h.token).not.toBe("private-upstream-key");
      expect(h.config.baseUrl).toContain("/api/model-gateway/v1");
      expect(JSON.stringify(h.materialized)).not.toContain("private-upstream-key");
      expect(JSON.stringify(h.materialized)).not.toContain("private-header");
      const response = yield* h.invoke("/v1/models");
      expect(response.status).toBe(200);
      expect(JSON.parse(response.text).data.map((model: { id: string }) => model.id)).toEqual([
        "Vendor/Exact",
      ]);
      expect(h.calls).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("disables native Claude web search for materialized model-service instances", () =>
    Effect.gen(function* () {
      const h = yield* harness({ driver: "claudeAgent" });
      const instance = h.materialized[instanceId]!;
      const settings = decodeClaudeSettings(instance.config);
      const options = makeClaudeQueryOptions({
        modelSelection: { instanceId, model: "Vendor/Exact" },
        modelCatalog: resolveClaudeModelServiceCatalog(settings.customModels, "Vendor/Exact"),
        nativeThreadId: "service-no-web-search",
        resume: false,
        cwd: null,
        settings,
        environment: Object.fromEntries(
          (instance.environment ?? []).flatMap(({ name, value }) =>
            typeof value === "string" ? [[name, value]] : [],
          ),
        ),
      });
      expect(options.disallowedTools).toEqual(["WebSearch"]);
      expect(h.calls).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect.each([false, true])(
    "supplements max-only Codex catalogs and keeps explicit Ultra metadata (declared: %s)",
    (declared) =>
      Effect.gen(function* () {
        const h = yield* harness();
        const current = (yield* h.settings.getSettings).modelServices[serviceId]!;
        const declaredOptions = [
          { id: "high", label: "High" },
          { id: "max", label: "Max", ...(!declared ? { isDefault: true } : {}) },
          ...(declared ? [{ id: "ultra", label: "Ultra", isDefault: true }] : []),
        ];
        const options = declared
          ? declaredOptions
          : [
              ...declaredOptions,
              { id: "ultra", label: "Ultra", description: "Enable Codex Ultra mode" },
            ];
        yield* h.settings.updateSettings({
          modelServices: {
            [serviceId]: {
              ...current,
              models: [
                {
                  ...current.models[0]!,
                  capabilities: {
                    optionDescriptors: [
                      {
                        id: "reasoningEffort",
                        label: "Reasoning",
                        type: "select",
                        options: declaredOptions,
                      },
                    ],
                  },
                },
              ],
            },
          },
        });
        const materialized = yield* h.gateway.materialize(
          yield* h.settings.getSettings,
          h.instances,
        );
        expect(record(materialized[instanceId]!.config).customModels).toMatchObject([
          { capabilities: { optionDescriptors: [{ id: "reasoningEffort", options }] } },
        ]);
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const catalog = JSON.parse(
          yield* fs.readFileString(
            `${config.baseDir}/model-services/runtime/${instanceId}/codex-models.json`,
          ),
        );
        expect(catalog.models[0]).toMatchObject({
          slug: "Vendor/Exact",
          default_reasoning_level: declared ? "ultra" : "max",
          supported_reasoning_levels: [
            { effort: "high", description: "High" },
            { effort: "max", description: "Max" },
            { effort: "ultra", description: "Ultra" },
          ],
        });
        expect(h.calls).toEqual([]);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "rejects browser origins, wrong credentials, and models outside the binding before calling upstream",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        expect(
          (yield* h.invoke("/v1/models", undefined, { authorization: "Bearer wrong" })).status,
        ).toBe(401);
        expect(
          (yield* h.invoke("/v1/models", undefined, { origin: "http://127.0.0.1" })).status,
        ).toBe(401);
        expect((yield* h.invoke("/v1/responses", { model: "hidden", input: "hello" })).status).toBe(
          403,
        );
        expect(h.calls).toEqual([]);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "keeps ultra from Claude's bound catalog through Messages-to-Chat protocol conversion",
    () =>
      Effect.gen(function* () {
        const h = yield* harness({ driver: "claudeAgent" });
        const current = (yield* h.settings.getSettings).modelServices[serviceId]!;
        yield* h.settings.updateSettings({
          modelServices: {
            [serviceId]: {
              ...current,
              models: [
                {
                  ...current.models[0]!,
                  capabilities: {
                    optionDescriptors: [
                      {
                        id: "reasoningEffort",
                        label: "Reasoning",
                        type: "select",
                        options: [
                          { id: "high", label: "High" },
                          { id: "ultra", label: "Ultra", isDefault: true },
                        ],
                      },
                    ],
                  },
                },
              ],
            },
          },
        });
        const materialized = yield* h.gateway.materialize(
          yield* h.settings.getSettings,
          h.instances,
        );
        const settings = decodeClaudeSettings(materialized[instanceId]!.config);
        const catalog = resolveClaudeModelServiceCatalog(settings.customModels, "Vendor/Exact");
        expect(catalog.models[0]?.model.capabilities?.optionDescriptors?.[0]).toMatchObject({
          id: "effort",
          options: [{ id: "high" }, { id: "ultra", isDefault: true }],
        });
        const options = makeClaudeQueryOptions({
          modelSelection: {
            instanceId,
            model: "Vendor/Exact",
            options: [{ id: "effort", value: "ultra" }],
          },
          modelCatalog: catalog,
          nativeThreadId: "service-gateway-test",
          resume: false,
          cwd: null,
          environment: {},
        });
        expect(options.effort).toBeUndefined();
        const response = yield* h.invoke("/v1/messages", {
          model: options.model,
          max_tokens: 100,
          messages: [{ role: "user", content: "hello" }],
          thinking: { type: "adaptive" },
          ...JSON.parse(options.env!.CLAUDE_CODE_EXTRA_BODY!),
        });
        expect(response.status).toBe(200);
        expect(h.calls).toHaveLength(1);
        const body = h.calls[0]!.body;
        if (body._tag !== "Uint8Array") throw new Error("Expected JSON bytes");
        expect(JSON.parse(new TextDecoder().decode(body.body))).toMatchObject({
          model: "Vendor/Exact",
          reasoning_effort: "ultra",
        });
      }).pipe(Effect.scoped),
  );

  it.effect("fills only a missing output budget from the selected model on every retry", () =>
    withGatewayDiagnostics((messages) =>
      Effect.gen(function* () {
        let attempts = 0;
        const h = yield* harness({
          maxOutputTokens: 128000,
          recovery: { retryEnabled: true, retryNonTransientErrors: true, maxAttempts: 2 },
          respond: (request): Response => {
            const body = sentBody(request);
            expect(body).toMatchObject({
              max_tokens: 128000,
              reasoning_effort: "max",
              messages: [{ role: "user", content: "hello" }],
            });
            expect(body.max_completion_tokens).toBeUndefined();
            return ++attempts === 1
              ? Response.json({ error: { message: "temporary" } }, { status: 500 })
              : Response.json({
                  id: "chat-budget",
                  choices: [
                    {
                      index: 0,
                      message: { role: "assistant", content: "answer" },
                      finish_reason: "stop",
                    },
                  ],
                  usage: { prompt_tokens: 1, completion_tokens: 1 },
                });
          },
        });
        const fiber = yield* h
          .invoke("/v1/chat/completions", {
            model: "Vendor/Exact",
            messages: [{ role: "user", content: "hello" }],
            reasoning_effort: "max",
          })
          .pipe(Effect.forkChild);
        yield* TestClock.adjust("2 seconds");
        const response = yield* Fiber.join(fiber);
        expect(response.status).toBe(200);
        expect(h.calls).toHaveLength(2);
        expect(messages).toContainEqual(
          expect.objectContaining({
            event: "request_compatibility",
            action: "output_budget_defaulted",
            model: "Vendor/Exact",
            field: "max_tokens",
            value: 128000,
            source: "model_metadata",
          }),
        );
      }),
    ),
  );

  it.effect.each([
    { field: "max_tokens", value: 1024 },
    { field: "max_completion_tokens", value: 8192 },
    { field: "max_tokens", value: null },
  ])("keeps the agent's explicit Chat budget %j", ({ field, value }) =>
    Effect.gen(function* () {
      const h = yield* harness({ driver: "pi", maxOutputTokens: 128000 });
      const response = yield* h.invoke("/v1/chat/completions", {
        model: "Vendor/Exact",
        messages: [{ role: "user", content: "hello" }],
        [field]: value,
      });
      expect(response.status).toBe(200);
      expect(sentBody(h.calls[0]!)[field]).toBe(value);
    }).pipe(Effect.scoped),
  );

  it.effect.each([undefined, 1024, 8192, 256000])(
    "keeps the original Responses budget through Chat conversion (%s)",
    (value) =>
      Effect.gen(function* () {
        const h = yield* harness({ maxOutputTokens: 128000 });
        const response = yield* h.invoke("/v1/responses", {
          model: "Vendor/Exact",
          input: "hello",
          ...(value === undefined ? {} : { max_output_tokens: value }),
        });
        expect(response.status).toBe(200);
        expect(sentBody(h.calls[0]!).max_tokens).toBe(value ?? 128000);
        expect(sentBody(h.calls[0]!).max_completion_tokens).toBeUndefined();
      }).pipe(Effect.scoped),
  );

  it.effect.each([null, 0, -1, "8192"])(
    "does not replace invalid explicit Responses budgets during conversion (%s)",
    (value) =>
      Effect.gen(function* () {
        const h = yield* harness({ maxOutputTokens: 128000 });
        const response = yield* h.invoke("/v1/responses", {
          model: "Vendor/Exact",
          input: "hello",
          max_output_tokens: value,
        });
        expect(response.status).toBe(400);
        expect(h.calls).toHaveLength(0);
      }).pipe(Effect.scoped),
  );

  it.effect.each(["max_tokens", "max_completion_tokens"])(
    "keeps explicit Chat %s through Responses conversion",
    (field) =>
      Effect.gen(function* () {
        const h = yield* harness({
          protocol: "openai-responses",
          maxOutputTokens: 128000,
          respond: () => Response.json(responsesAnswer),
        });
        const response = yield* h.invoke("/v1/chat/completions", {
          model: "Vendor/Exact",
          messages: [{ role: "user", content: "hello" }],
          [field]: 8192,
        });
        expect(response.status).toBe(200);
        expect(sentBody(h.calls[0]!).max_output_tokens).toBe(8192);
      }).pipe(Effect.scoped),
  );

  it.effect("supports a configured six-minute wait with the metadata budget", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        protocol: "openai-responses",
        maxOutputTokens: 128000,
        recovery: { responseHeadersTimeoutMs: 420000, budgetMs: 600000 },
        headersDelayMs: 385000,
        respond: () => Response.json(responsesAnswer),
      });
      const fiber = yield* h
        .invoke("/v1/responses", { model: "Vendor/Exact", input: "hello" })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("386 seconds");
      const response = yield* Fiber.join(fiber);
      expect(response.status).toBe(200);
      expect(sentBody(h.calls[0]!).max_output_tokens).toBe(128000);
      expect(h.calls).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    {
      protocol: "openai-responses" as const,
      path: "/v1/responses",
      body: { input: "hello" },
    },
    {
      protocol: "openai-chat" as const,
      path: "/v1/chat/completions",
      body: { messages: [{ role: "user", content: "hello" }] },
    },
    {
      protocol: "anthropic-messages" as const,
      path: "/v1/messages",
      body: {
        messages: [{ role: "user", content: "hello" }],
        thinking: { type: "enabled", budget_tokens: 16000 },
      },
    },
    {
      protocol: "gemini" as const,
      path: "/v1beta/models/Vendor%2FExact:generateContent",
      body: {
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
        generationConfig: { temperature: 0.2 },
      },
    },
  ])(
    "adds the selected model budget to a native $protocol upstream request",
    ({ protocol, path, body }) =>
      Effect.gen(function* () {
        const responseBody =
          protocol === "openai-responses"
            ? responsesAnswer
            : protocol === "anthropic-messages"
              ? {
                  id: "message-budget",
                  type: "message",
                  role: "assistant",
                  content: [{ type: "text", text: "answer" }],
                  stop_reason: "end_turn",
                }
              : protocol === "gemini"
                ? { candidates: [{ content: { role: "model", parts: [{ text: "answer" }] } }] }
                : undefined;
        const h = yield* harness({
          protocol,
          maxOutputTokens: 128000,
          ...(responseBody ? { respond: () => Response.json(responseBody) } : {}),
        });
        const response = yield* h.invoke(path, { ...body, model: "Vendor/Exact" });
        expect(response.status).toBe(200);
        const sent = sentBody(h.calls[0]!);
        expect(
          protocol === "openai-responses"
            ? sent.max_output_tokens
            : protocol === "openai-chat"
              ? sent.max_tokens
              : protocol === "anthropic-messages"
                ? sent.max_tokens
                : sent.generationConfig.maxOutputTokens,
        ).toBe(128000);
        if (protocol === "anthropic-messages")
          expect(sent.thinking).toEqual({ type: "enabled", budget_tokens: 16000 });
        if (protocol === "gemini") expect(sent.generationConfig.temperature).toBe(0.2);
      }).pipe(Effect.scoped),
  );

  it.effect("does not add a model budget to token counting or unknown metadata", () =>
    Effect.gen(function* () {
      const h = yield* harness({ protocol: "anthropic-messages" });
      const response = yield* h.invoke("/v1/messages/count_tokens", {
        model: "Vendor/Exact",
        messages: [{ role: "user", content: "hello" }],
      });
      expect(sentBody(h.calls[0]!).max_tokens).toBeUndefined();
      const unknown = yield* harness({ driver: "pi", maxOutputTokens: null });
      expect(
        (yield* unknown.invoke("/v1/chat/completions", {
          model: "Vendor/Exact",
          messages: [],
        })).status,
      ).toBe(200);
      expect(sentBody(unknown.calls[0]!).max_tokens).toBeUndefined();
      expect(response.status).not.toBe(401);
    }).pipe(Effect.scoped),
  );

  it.effect("uses the actual requested model's metadata, not the binding default", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        protocol: "openai-responses",
        respond: () => Response.json(responsesAnswer),
      });
      const current = (yield* h.settings.getSettings).modelServices[serviceId]!;
      yield* h.settings.updateSettings({
        modelServices: {
          [serviceId]: {
            ...current,
            models: current.models.map((model) => ({
              ...model,
              maxOutputTokens: model.id === "Vendor/Exact" ? 16384 : 128000,
            })),
          },
        },
      });
      yield* h.gateway.materialize(yield* h.settings.getSettings, {
        [instanceId]: {
          ...h.instances[instanceId]!,
          modelService: { serviceId, modelIds: [], defaultModel: "hidden" },
        },
      });
      const response = yield* h.invoke("/v1/responses", {
        model: "Vendor/Exact",
        input: "hello",
      });
      expect(response.status).toBe(200);
      expect(sentBody(h.calls[0]!).max_output_tokens).toBe(16384);
    }).pipe(Effect.scoped),
  );

  it.effect.each(["anthropic-messages", "gemini"] as const)(
    "normalizes Responses budgets after conversion to %s without changing independent settings",
    (protocol) =>
      Effect.gen(function* () {
        const h = yield* harness({
          protocol,
          maxOutputTokens: 128000,
          respond: () =>
            Response.json(
              protocol === "gemini"
                ? {
                    candidates: [
                      {
                        content: { role: "model", parts: [{ text: "answer" }] },
                        finishReason: "STOP",
                      },
                    ],
                  }
                : {
                    id: "budget-message",
                    type: "message",
                    role: "assistant",
                    content: [{ type: "text", text: "answer" }],
                    stop_reason: "end_turn",
                    usage: { input_tokens: 1, output_tokens: 1 },
                  },
            ),
        });
        for (const value of [undefined, 1024]) {
          const response = yield* h.invoke("/v1/responses", {
            model: "Vendor/Exact",
            input: "hello",
            ...(value === undefined ? {} : { max_output_tokens: value }),
          });
          expect(response.status).toBe(200);
          const sent = sentBody(h.calls.at(-1)!);
          expect(
            protocol === "gemini" ? sent.generationConfig.maxOutputTokens : sent.max_tokens,
          ).toBe(value ?? 128000);
        }
      }).pipe(Effect.scoped),
  );

  it.effect(
    "forwards native requests without changing tools, exact IDs, or extra request fields",
    () =>
      Effect.gen(function* () {
        const h = yield* harness({ driver: "pi", maxOutputTokens: null });
        const body = {
          model: "Vendor/Exact",
          messages: [{ role: "user", content: "hello" }],
          tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
          temperature: 0.2,
        };
        const response = yield* h.invoke("/v1/chat/completions", body);
        expect(response.status).toBe(200);
        expect(h.calls[0]?.url).toBe("https://upstream.test/v1/chat/completions");
        expect(h.calls[0]?.headers.authorization).toBe("Bearer private-upstream-key");
        expect(h.calls[0]?.headers["x-extra"]).toBe("private-header");
        const sent = h.calls[0]!.body;
        expect(sent._tag).toBe("Uint8Array");
        if (sent._tag === "Uint8Array")
          expect(JSON.parse(new TextDecoder().decode(sent.body))).toEqual(body);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "preserves ultra reasoning when converting a Codex request through the real SDK bridge",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        const response = yield* h.invoke("/v1/responses", {
          model: "Vendor/Exact",
          input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
          reasoning: { effort: "ultra" },
        });
        expect(response.status).toBe(200);
        const result = JSON.parse(response.text);
        expect(result.object).toBe("response");
        expect(response.text).toContain("answer");
        expect(result.usage.input_tokens).toBe(5);
        expect(h.calls).toHaveLength(1);
        const body = h.calls[0]!.body;
        if (body._tag === "Uint8Array") {
          const text = new TextDecoder().decode(body.body);
          expect(JSON.parse(text)).toMatchObject({
            model: "Vendor/Exact",
            messages: [{ role: "user" }],
            reasoning_effort: "ultra",
          });
          expect(text).toContain("hello");
        }
      }).pipe(Effect.scoped),
  );

  it.effect(
    "converts streaming text and completion events without buffering the whole response",
    () =>
      Effect.gen(function* () {
        const encoder = new TextEncoder();
        let cancelled = false;
        const h = yield* harness({
          driver: "claudeAgent",
          respond: () =>
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(
                    encoder.encode(
                      'data: {"id":"s","model":"Vendor/Exact","choices":[{"index":0,"delta":{"content":"first"},"finish_reason":null}]}\n\n',
                    ),
                  );
                },
                cancel() {
                  cancelled = true;
                },
              }),
              { headers: { "content-type": "text/event-stream" } },
            ),
        });
        const request = HttpServerRequest.fromWeb(
          new Request("http://127.0.0.1/api/model-gateway/v1/messages", {
            method: "POST",
            headers: { "x-api-key": String(h.token), "content-type": "application/json" },
            body: JSON.stringify({
              model: "Vendor/Exact",
              stream: true,
              max_tokens: 100,
              messages: [{ role: "user", content: "hello" }],
            }),
          }),
        );
        yield* Effect.gen(function* () {
          const response = yield* h.gateway.handle.pipe(
            Effect.provideService(HttpServerRequest.HttpServerRequest, request),
          );
          expect(response.status).toBe(200);
          expect(response.body._tag).toBe("Stream");
          if (response.body._tag === "Stream") {
            const first = yield* response.body.stream.pipe(
              Stream.take(1),
              Stream.runCollect,
              Effect.orDie,
            );
            expect(new TextDecoder().decode(first[0])).toContain("message_start");
          }
        }).pipe(Effect.scoped);
        expect(cancelled).toBe(true);
      }).pipe(Effect.scoped),
  );

  it.effect("rotates upstream secrets in one place and immediately disables revoked services", () =>
    Effect.gen(function* () {
      const h = yield* harness({ driver: "pi" });
      const current = (yield* h.settings.getSettings).modelServices[serviceId]!;
      yield* h.settings.updateSettings({
        modelServices: { [serviceId]: { ...current, apiKey: "rotated-upstream-key" } },
      });
      expect(
        (yield* h.invoke("/v1/chat/completions", { model: "Vendor/Exact", messages: [] })).status,
      ).toBe(200);
      expect(h.calls[0]?.headers.authorization).toBe("Bearer rotated-upstream-key");
      const refreshed = (yield* h.settings.getSettings).modelServices[serviceId]!;
      yield* h.settings.updateSettings({
        modelServices: { [serviceId]: { ...refreshed, enabled: false } },
      });
      expect((yield* h.invoke("/v1/models")).status).toBe(503);
      expect(h.calls).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("redacts upstream errors and respects disabled request recovery", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        driver: "pi",
        respond: () => Response.json({ error: "private-upstream-key" }, { status: 429 }),
      });
      const result = yield* h.invoke("/v1/chat/completions", {
        model: "Vendor/Exact",
        messages: [],
      });
      expect(result.status).toBe(429);
      expect(result.text).not.toContain("private-upstream-key");
      expect(h.calls).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "returns safe rejected parameter metadata without echoing error text or private fields",
    () =>
      Effect.gen(function* () {
        const h = yield* harness({
          driver: "claudeAgent",
          respond: () =>
            Response.json(
              {
                error: {
                  message: "private-upstream-key request content",
                  param: "max_tokens",
                  code: "unsupported_parameter",
                },
              },
              { status: 400 },
            ),
        });
        const result = yield* h.invoke("/v1/messages", {
          model: "Vendor/Exact",
          max_tokens: 100,
          messages: [{ role: "user", content: "test" }],
        });
        expect(result.status).toBe(400);
        expect(result.text).toContain("parameter: max_tokens");
        expect(result.text).toContain("code: unsupported_parameter");
        expect(result.text).not.toContain("private-upstream-key");
        expect(result.text).not.toContain("request content");
        expect(h.calls).toHaveLength(1);
      }).pipe(Effect.scoped),
  );

  it.effect.each([
    { param: "tools[0].private-key", code: "unsupported_value", root: "tools", safeCode: true },
    {
      param: "output_config.private-key",
      code: "private-key",
      root: "output_config",
      safeCode: false,
    },
    { param: "service_tier-private-key", code: "private-key", root: undefined, safeCode: false },
    { param: "private-key", code: "invalid_parameter", root: undefined, safeCode: true },
  ])("redacts upstream rejection metadata $param", ({ param, code, root, safeCode }) =>
    Effect.gen(function* () {
      const h = yield* harness({
        driver: "pi",
        respond: () => Response.json({ error: { param, code } }, { status: 400 }),
      });
      const result = yield* h.invoke("/v1/chat/completions", {
        model: "Vendor/Exact",
        messages: [],
      });
      expect(result.status).toBe(400);
      expect(result.text).not.toContain("private-key");
      expect(result.text.includes("parameter:")).toBe(root !== undefined);
      if (root !== undefined) expect(result.text).toContain(`parameter: ${root}`);
      expect(result.text.includes("code:")).toBe(safeCode);
      if (safeCode) expect(result.text).toContain(`code: ${code}`);
      expect(h.calls).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("cancels oversized upstream error bodies without exposing their contents", () =>
    Effect.gen(function* () {
      let cancelled = false;
      const h = yield* harness({
        driver: "pi",
        respond: () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    JSON.stringify({
                      error: { param: "service_tier", code: "unsupported_parameter" },
                      content: "private-key".repeat(2000),
                    }),
                  ),
                );
              },
              cancel() {
                cancelled = true;
              },
            }),
            { status: 400 },
          ),
      });
      const result = yield* h.invoke("/v1/chat/completions", {
        model: "Vendor/Exact",
        messages: [],
      });
      expect(result.status).toBe(400);
      expect(result.text).not.toContain("private-key");
      expect(result.text).not.toContain("parameter:");
      expect(result.text).not.toContain("code:");
      expect(cancelled).toBe(true);
      expect(h.calls).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect.each(["codex", "claudeAgent"])(
    "preserves Fast routing for %s and native Codex catalog metadata",
    (driver) =>
      Effect.gen(function* () {
        const h = yield* harness({ driver });
        const current = (yield* h.settings.getSettings).modelServices[serviceId]!;
        const tiers = [
          { id: "default", label: "Standard", isDefault: true },
          { id: "priority", label: "Fast", description: "Low latency" },
        ];
        yield* h.settings.updateSettings({
          modelServices: {
            [serviceId]: {
              ...current,
              models: [
                {
                  ...current.models[0]!,
                  capabilities: {
                    optionDescriptors: [
                      {
                        id: "serviceTier",
                        label: "Service Tier",
                        type: "select",
                        currentValue: "default",
                        options: tiers,
                      },
                    ],
                  },
                },
              ],
            },
          },
        });
        const bound = yield* h.gateway.materialize(yield* h.settings.getSettings, h.instances);
        expect(record(bound[instanceId]!.config).customModels).toMatchObject([
          {
            capabilities: {
              optionDescriptors: [
                { id: "serviceTier", options: tiers },
                ...(driver === "claudeAgent" ? [{ id: "ultracode", type: "boolean" }] : []),
              ],
            },
          },
        ]);
        if (driver === "codex") {
          const fs = yield* FileSystem.FileSystem;
          const config = yield* ServerConfig.ServerConfig;
          const catalog = JSON.parse(
            yield* fs.readFileString(
              `${config.baseDir}/model-services/runtime/${instanceId}/codex-models.json`,
            ),
          );
          expect(catalog.models[0]).toMatchObject({
            default_service_tier: "default",
            service_tiers: [{ id: "priority", name: "Fast", description: "Low latency" }],
          });
        }
        const response = yield* h.invoke(driver === "codex" ? "/v1/responses" : "/v1/messages", {
          model: "Vendor/Exact",
          input: "hi",
          max_tokens: 100,
          messages: [{ role: "user", content: "hi" }],
          service_tier: "priority",
        });
        expect(response.status).toBe(200);
        const body = h.calls[0]!.body;
        if (body._tag !== "Uint8Array") throw new Error("Expected JSON bytes");
        expect(JSON.parse(new TextDecoder().decode(body.body))).toMatchObject({
          service_tier: "priority",
        });
      }).pipe(Effect.scoped),
  );

  it.effect(
    "maps Claude ultra to the GPT Chat wire maximum rejected in the recorded upstream failure",
    () =>
      Effect.gen(function* () {
        const h = yield* harness({
          driver: "claudeAgent",
          respond: (request) => {
            const raw = request.body;
            if (raw._tag !== "Uint8Array") throw new Error("Expected JSON bytes");
            const body = JSON.parse(new TextDecoder().decode(raw.body));
            return body.reasoning_effort === "ultra"
              ? Response.json(
                  {
                    error: {
                      message:
                        "Invalid value: 'ultra'. Supported values are: 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', and 'max'.",
                      type: "openai_error",
                      code: "unknown_error",
                      param: "",
                    },
                  },
                  { status: 400 },
                )
              : Response.json({
                  id: "chat-test",
                  choices: [
                    {
                      index: 0,
                      message: { role: "assistant", content: "ok" },
                      finish_reason: "stop",
                    },
                  ],
                  usage: { prompt_tokens: 1, completion_tokens: 1 },
                });
          },
        });
        const current = (yield* h.settings.getSettings).modelServices[serviceId]!;
        yield* h.settings.updateSettings({
          modelServices: {
            [serviceId]: { ...current, models: [{ ...current.models[0]!, id: "gpt-6.1-sol" }] },
          },
        });
        yield* h.gateway.materialize(yield* h.settings.getSettings, {
          [instanceId]: {
            ...h.instances[instanceId]!,
            modelService: { serviceId, modelIds: ["gpt-6.1-sol"] },
          },
        });
        const response = yield* h.invoke("/v1/messages", {
          model: "gpt-6.1-sol",
          max_tokens: 32000,
          output_config: { effort: "ultra" },
          thinking: { type: "adaptive" },
          messages: [{ role: "user", content: "hi" }],
        });
        expect(response.status).toBe(200);
        expect(h.calls).toHaveLength(1);
        const body = h.calls[0]!.body;
        if (body._tag !== "Uint8Array") throw new Error("Expected JSON bytes");
        expect(JSON.parse(new TextDecoder().decode(body.body))).toMatchObject({
          model: "gpt-6.1-sol",
          reasoning_effort: "max",
        });
      }).pipe(Effect.scoped),
  );

  it.effect.each([
    { toolCount: 13, stream: false },
    { toolCount: 90, stream: false },
    { toolCount: 13, stream: true },
    { toolCount: 90, stream: true },
  ])(
    "preserves recorded Claude tool payload sizes with ultra (tools: $toolCount, stream: $stream)",
    ({ toolCount, stream }) =>
      Effect.gen(function* () {
        const h = yield* harness({
          driver: "claudeAgent",
          respond: (request) => {
            const raw = request.body;
            if (raw._tag !== "Uint8Array") throw new Error("Expected JSON bytes");
            const body = JSON.parse(new TextDecoder().decode(raw.body));
            expect(body.reasoning_effort).toBe("max");
            expect(body.service_tier).toBe("priority");
            expect(body.max_completion_tokens).toBe(32000);
            expect(body.tools).toHaveLength(toolCount);
            expect(body.tools[0]).toEqual({
              type: "function",
              function: {
                name: "Read",
                description: "Read a test fixture",
                parameters: {
                  type: "object",
                  properties: { path: { type: "string" } },
                  required: ["path"],
                  additionalProperties: false,
                },
              },
            });
            expect(body.messages).toMatchObject([
              { role: "system" },
              { role: "user" },
              {
                role: "assistant",
                tool_calls: [{ id: "call_fixture", function: { name: "Read" } }],
              },
              { role: "tool", tool_call_id: "call_fixture", content: "fixture result" },
            ]);
            return stream
              ? new Response(
                  'data: {"id":"offline","model":"gpt-6.1-sol","choices":[{"index":0,"delta":{"role":"assistant","content":"verified"},"finish_reason":null}]}\n\n' +
                    'data: {"id":"offline","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n' +
                    "data: [DONE]\n\n",
                  { headers: { "content-type": "text/event-stream" } },
                )
              : Response.json({
                  id: "offline",
                  choices: [
                    {
                      index: 0,
                      message: { role: "assistant", content: "verified" },
                      finish_reason: "stop",
                    },
                  ],
                  usage: { prompt_tokens: 1, completion_tokens: 1 },
                });
          },
        });
        const current = (yield* h.settings.getSettings).modelServices[serviceId]!;
        yield* h.settings.updateSettings({
          modelServices: {
            [serviceId]: { ...current, models: [{ ...current.models[0]!, id: "gpt-6.1-sol" }] },
          },
        });
        yield* h.gateway.materialize(yield* h.settings.getSettings, {
          [instanceId]: {
            ...h.instances[instanceId]!,
            modelService: { serviceId, modelIds: ["gpt-6.1-sol"] },
          },
        });
        const response = yield* h.invoke("/v1/messages", {
          model: "gpt-6.1-sol",
          max_tokens: 32000,
          output_config: { effort: "ultra" },
          thinking: { type: "adaptive", display: "summarized" },
          context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
          service_tier: "priority",
          stream,
          system: [{ type: "text", text: "Fixture instructions" }],
          tools: Array.from({ length: toolCount }, (_, index) => ({
            name: index === 0 ? "Read" : `FixtureTool_${index}`,
            description: "Read a test fixture",
            input_schema: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
              additionalProperties: false,
            },
          })),
          messages: [
            { role: "user", content: "hi" },
            {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "call_fixture",
                  name: "Read",
                  input: { path: "fixture.txt" },
                },
              ],
            },
            {
              role: "user",
              content: [
                { type: "tool_result", tool_use_id: "call_fixture", content: "fixture result" },
              ],
            },
          ],
        });
        expect(response.status).toBe(200);
        expect(response.text).toContain("verified");
        expect(response.text).toContain(stream ? "message_stop" : "end_turn");
        expect(h.calls).toHaveLength(1);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "reports the recorded rejection reason when an upstream omits its parameter field",
    () =>
      Effect.gen(function* () {
        const h = yield* harness({
          driver: "pi",
          respond: () =>
            Response.json(
              {
                error: {
                  message:
                    "Invalid value: 'ultra'. Supported values are: 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', and 'max'. (request id: private-upstream-id)",
                  type: "openai_error",
                  param: "",
                  code: "unknown_error",
                },
              },
              { status: 400 },
            ),
        });
        const result = yield* h.invoke("/v1/chat/completions", {
          model: "Vendor/Exact",
          reasoning_effort: "ultra",
          messages: [],
        });
        expect(result.status).toBe(400);
        expect(result.text).toContain("parameter: reasoning_effort");
        expect(result.text).toContain("unsupported effort; allowed maximum: max");
        expect(result.text).not.toContain("private-upstream-id");
        expect(h.calls).toHaveLength(1);
      }).pipe(Effect.scoped),
  );

  it.effect.each(["codex", "pi"])(
    "normalizes GPT ultra for %s independently of protocol conversion",
    (driver) =>
      Effect.gen(function* () {
        const h = yield* harness({ driver });
        const current = (yield* h.settings.getSettings).modelServices[serviceId]!;
        const protocol = driver === "codex" ? "openai-responses" : "openai-chat";
        yield* h.settings.updateSettings({
          modelServices: {
            [serviceId]: {
              ...current,
              protocols: [protocol],
              models: [{ ...current.models[0]!, id: "gpt-6.1-sol" }],
            },
          },
        });
        yield* h.gateway.materialize(yield* h.settings.getSettings, {
          [instanceId]: {
            ...h.instances[instanceId]!,
            modelService: { serviceId, modelIds: ["gpt-6.1-sol"] },
          },
        });
        yield* h.invoke(driver === "codex" ? "/v1/responses" : "/v1/chat/completions", {
          model: "gpt-6.1-sol",
          ...(driver === "codex"
            ? { reasoning: { effort: "ultra", summary: "detailed" }, input: "hello" }
            : { reasoning_effort: "ultra", messages: [{ role: "user", content: "hello" }] }),
        });
        const raw = h.calls[0]!.body;
        if (raw._tag !== "Uint8Array") throw new Error("Expected JSON bytes");
        expect(JSON.parse(new TextDecoder().decode(raw.body))).toMatchObject(
          driver === "codex"
            ? { reasoning: { effort: "max", summary: "detailed" } }
            : { reasoning_effort: "max" },
        );
        expect(h.calls).toHaveLength(1);
      }).pipe(Effect.scoped),
  );

  it.effect.each([
    { driver: "codex", protocol: "openai-chat" as const },
    { driver: "codex", protocol: "openai-responses" as const },
    { driver: "claudeAgent", protocol: "openai-chat" as const },
    { driver: "claudeAgent", protocol: "openai-responses" as const },
  ])(
    "activates native Codex Ultra or Claude Ultracode and compiles the correct wire effort for $driver to $protocol",
    ({ driver, protocol }) =>
      Effect.gen(function* () {
        const h = yield* harness({
          driver,
          respond: () =>
            protocol === "openai-responses"
              ? Response.json({
                  id: "response-ultra",
                  object: "response",
                  model: "gpt-6.1-sol",
                  status: "completed",
                  output: [
                    {
                      id: "message-ultra",
                      type: "message",
                      role: "assistant",
                      content: [{ type: "output_text", text: "Ultra verified", annotations: [] }],
                    },
                  ],
                  usage: { input_tokens: 1, output_tokens: 1 },
                })
              : Response.json({
                  id: "chat-ultra",
                  choices: [
                    {
                      index: 0,
                      message: { role: "assistant", content: "Ultra verified" },
                      finish_reason: "stop",
                    },
                  ],
                  usage: { prompt_tokens: 1, completion_tokens: 1 },
                }),
        });
        const current = (yield* h.settings.getSettings).modelServices[serviceId]!;
        const levelId = driver === "codex" ? "reasoningEffort" : "effort";
        const mode = driver === "codex" ? "ultra" : "ultracode";
        const selection = createModelSelection(instanceId, "gpt-6.1-sol", [
          { id: levelId, value: mode },
        ]);
        yield* h.settings.updateSettings({
          modelServices: {
            [serviceId]: {
              ...current,
              protocols: [protocol],
              models: [
                {
                  ...current.models[0]!,
                  id: selection.model,
                  capabilities: {
                    optionDescriptors: [
                      {
                        id: "reasoningEffort",
                        label: "Reasoning",
                        type: "select",
                        options: [
                          { id: "xhigh", label: "Extra High" },
                          { id: "max", label: "Max" },
                        ],
                      },
                    ],
                  },
                },
              ],
            },
          },
        });
        const bound = yield* h.gateway.materialize(yield* h.settings.getSettings, {
          [instanceId]: {
            ...h.instances[instanceId]!,
            modelService: { serviceId, modelIds: [selection.model], defaultModel: selection.model },
          },
        });
        let body: Record<string, unknown>;
        if (driver === "codex") {
          const params = yield* buildCodexTurnStartParams({
            nativeThreadId: "native-ultra",
            codexInput: [{ type: "text", text: "Verify Ultra" }],
            runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: null },
            modelSelection: selection,
          });
          expect(params.effort).toBe("ultra");
          body = {
            model: params.model,
            input: "Verify Ultra",
            reasoning: { effort: params.effort },
          };
        } else {
          const settings = decodeClaudeSettings(bound[instanceId]!.config);
          const catalog = resolveClaudeModelServiceCatalog(settings.customModels, selection.model);
          const options = makeClaudeQueryOptions({
            modelSelection: selection,
            modelCatalog: catalog,
            nativeThreadId: "native-ultra",
            resume: false,
            cwd: null,
            environment: {},
          });
          expect(options.effort).toBeUndefined();
          expect(options.settings).toMatchObject({ ultracode: true, enableWorkflows: true });
          const extraBody = JSON.parse(options.env!.CLAUDE_CODE_EXTRA_BODY!);
          expect(extraBody.output_config.effort).toBe("xhigh");
          body = {
            model: options.model,
            max_tokens: 32000,
            messages: [{ role: "user", content: "Verify Ultra" }],
            thinking: { type: "adaptive" },
            ...extraBody,
          };
        }
        const response = yield* h.invoke(
          driver === "codex" ? "/v1/responses" : "/v1/messages",
          body,
        );
        expect(response.status).toBe(200);
        expect(response.text).toContain("Ultra verified");
        expect(selection.options).toEqual([{ id: levelId, value: mode }]);
        expect(h.calls).toHaveLength(1);
        const raw = h.calls[0]!.body;
        if (raw._tag !== "Uint8Array") throw new Error("Expected JSON bytes");
        expect(JSON.parse(new TextDecoder().decode(raw.body))).toMatchObject(
          protocol === "openai-chat"
            ? { reasoning_effort: driver === "codex" ? "max" : "xhigh" }
            : { reasoning: { effort: driver === "codex" ? "max" : "xhigh" } },
        );
      }).pipe(Effect.scoped),
  );

  it.effect(
    "uses a completion-token limit for Claude requests converted to a GPT reasoning model",
    () =>
      Effect.gen(function* () {
        const h = yield* harness({
          driver: "claudeAgent",
          respond: (request) => {
            const raw = request.body;
            if (raw._tag !== "Uint8Array") throw new Error("Expected JSON bytes");
            const body = JSON.parse(new TextDecoder().decode(raw.body));
            return body.max_tokens !== undefined
              ? Response.json(
                  { error: { param: "max_tokens", code: "unsupported_parameter" } },
                  { status: 400 },
                )
              : Response.json({
                  id: "test",
                  choices: [
                    {
                      index: 0,
                      message: { role: "assistant", content: "ok" },
                      finish_reason: "stop",
                    },
                  ],
                  usage: { prompt_tokens: 1, completion_tokens: 1 },
                });
          },
        });
        const current = (yield* h.settings.getSettings).modelServices[serviceId]!;
        yield* h.settings.updateSettings({
          modelServices: {
            [serviceId]: { ...current, models: [{ ...current.models[0]!, id: "gpt-6.1-sol" }] },
          },
        });
        yield* h.gateway.materialize(yield* h.settings.getSettings, {
          [instanceId]: {
            ...h.instances[instanceId]!,
            modelService: { serviceId, modelIds: ["gpt-6.1-sol"] },
          },
        });
        const response = yield* h.invoke("/v1/messages", {
          model: "gpt-6.1-sol",
          max_tokens: 32000,
          thinking: { type: "adaptive" },
          output_config: { effort: "ultra" },
          messages: [{ role: "user", content: "hi" }],
        });
        expect(response.status).toBe(200);
        const body = h.calls[0]!.body;
        if (body._tag !== "Uint8Array") throw new Error("Expected JSON bytes");
        const sent = JSON.parse(new TextDecoder().decode(body.body));
        expect(sent).toMatchObject({ max_completion_tokens: 32000, reasoning_effort: "max" });
        expect(sent.max_tokens).toBeUndefined();
        expect(h.calls).toHaveLength(1);
      }).pipe(Effect.scoped),
  );

  it.effect("revokes local credentials when the bound instance is disabled", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.gateway.materialize(yield* h.settings.getSettings, {
        [instanceId]: { ...h.instances[instanceId]!, enabled: false },
      });
      expect((yield* h.invoke("/v1/models")).status).toBe(401);
      expect(h.calls).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("explains unsupported stateful conversion without sending an upstream request", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const response = yield* h.invoke("/v1/responses", {
        model: "Vendor/Exact",
        previous_response_id: "prior",
        input: "next",
      });
      expect(response.status).toBe(422);
      expect(response.text).toContain("complete conversation input");
      expect(h.calls).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("forwards native token counting and refuses cross-protocol token estimates", () =>
    Effect.gen(function* () {
      const h = yield* harness({ driver: "claudeAgent" });
      const body = { model: "Vendor/Exact", messages: [{ role: "user", content: "hello" }] };
      expect((yield* h.invoke("/v1/messages/count_tokens", body)).status).toBe(501);
      expect(h.calls).toEqual([]);
      const current = (yield* h.settings.getSettings).modelServices[serviceId]!;
      yield* h.settings.updateSettings({
        modelServices: { [serviceId]: { ...current, protocols: ["anthropic-messages"] } },
      });
      expect((yield* h.invoke("/v1/messages/count_tokens", body)).status).toBe(200);
      expect(h.calls[0]?.url).toBe("https://upstream.test/v1/messages/count_tokens");
    }).pipe(Effect.scoped),
  );

  it.effect("generates native agent model configuration and preserves independent settings", () =>
    Effect.gen(function* () {
      const h = yield* harness({ driver: "pi" });
      const fs = yield* FileSystem.FileSystem;
      const original = h.instances[instanceId]!;
      expect(record(original.config)).toEqual({ launchArgs: "", retained: true });
      expect(h.config.provider).toBe("cox");
      const models = JSON.parse(
        yield* fs.readFileString(String(h.config.agentDir) + "/models.json"),
      );
      expect(models.providers.cox.apiKey).toBe("$COX_MODEL_SERVICE_KEY");
      expect(models.providers.cox.models[0]).toMatchObject({
        id: "Vendor/Exact",
        contextWindow: 64000,
        maxTokens: 4000,
      });
      const independent = { ...original };
      delete independent.modelService;
      const entries = yield* h.gateway.materialize(yield* h.settings.getSettings, {
        [instanceId]: independent,
      });
      expect(entries[instanceId]).toEqual(independent);
      expect((yield* h.invoke("/v1/models")).status).toBe(401);
      const openCode = yield* h.gateway.materialize(yield* h.settings.getSettings, {
        [instanceId]: { ...original, driver: ProviderDriverKind.make("opencode") },
      });
      const config = JSON.parse(
        String(
          openCode[instanceId]!.environment!.find(
            (entry) => entry.name === "OPENCODE_CONFIG_CONTENT",
          )!.value,
        ),
      );
      expect(config.model).toBe("cox/Vendor/Exact");
      expect(config.provider.cox.models["Vendor/Exact"].limit).toEqual({
        context: 64000,
        output: 4000,
      });
      expect(JSON.stringify(config)).not.toContain("private-upstream-key");
    }).pipe(Effect.scoped),
  );

  it.effect("isolates OMO native configuration and preserves role settings and exact IDs", () =>
    Effect.gen(function* () {
      const h = yield* harness({ driver: "omo", protocol: "openai-responses" });
      const fs = yield* FileSystem.FileSystem;
      const original = h.instances[instanceId]!;
      const agentModels = { oracle: "cox/Vendor/Exact", custom_role: "" };
      const categoryModels = { deep: "cox/Vendor/Exact" };
      const instances = {
        [instanceId]: {
          ...original,
          config: {
            ...record(original.config),
            agentModels,
            categoryModels,
            agentDir: "/independent/omo",
            sessionDir: "/independent/sessions",
            apiKey: "independent-secret",
          },
        },
      };
      const before = structuredClone(instances);
      const result = yield* h.gateway.materialize(yield* h.settings.getSettings, instances);
      const config = record(result[instanceId]!.config);
      expect(config).toMatchObject({
        provider: "cox",
        model: "Vendor/Exact",
        apiKey: "",
        modelServiceManaged: true,
        agentModels,
        categoryModels,
        customModels: [{ slug: "cox/Vendor/Exact" }],
      });
      expect(String(config.agentDir)).toContain("/model-services/runtime/bound-test/omo");
      expect(config.sessionDir).toBe(String(config.agentDir) + "/sessions");
      const models = JSON.parse(yield* fs.readFileString(String(config.agentDir) + "/models.json"));
      expect(models.providers.cox).toMatchObject({
        api: "openai-responses",
        apiKey: "$COX_MODEL_SERVICE_KEY",
        compat: { supportsStrictMode: true },
        models: [{ id: "Vendor/Exact", contextWindow: 64000, maxTokens: 4000 }],
      });
      expect(JSON.stringify(models)).not.toContain("private-upstream-key");
      expect(instances).toEqual(before);
      const { modelService: _binding, ...independent } = instances[instanceId]!;
      expect(
        (yield* h.gateway.materialize(yield* h.settings.getSettings, {
          [instanceId]: independent,
        }))[instanceId],
      ).toEqual(independent);
    }).pipe(Effect.scoped),
  );

  it.effect.each(["agentModels", "categoryModels"])(
    "disables missing explicit OMO %s without model fallback",
    (field) =>
      Effect.gen(function* () {
        const h = yield* harness({ driver: "omo" });
        for (const slug of ["cox/missing", "Vendor/Exact", "cox/hidden"]) {
          const result = yield* h.gateway.materialize(yield* h.settings.getSettings, {
            [instanceId]: { ...h.instances[instanceId]!, config: { [field]: { oracle: slug } } },
          });
          expect(result[instanceId]?.enabled).toBe(false);
        }
        expect(h.calls).toEqual([]);
      }).pipe(Effect.scoped),
  );

  it.effect("disables stale OMO roles and inherits an available main default", () =>
    Effect.gen(function* () {
      const h = yield* harness({ driver: "omo" });
      const current = yield* h.settings.getSettings;
      const changed = {
        ...current,
        modelServices: {
          [serviceId]: {
            ...current.modelServices[serviceId]!,
            models: [{ ...service.models[0]!, available: false }, service.models[1]!],
          },
        },
      };
      const instance = { ...h.instances[instanceId]!, modelService: { serviceId, modelIds: [] } };
      const result = yield* h.gateway.materialize(changed, {
        [instanceId]: { ...instance, config: { agentModels: { oracle: "cox/Vendor/Exact" } } },
      });
      expect(result[instanceId]?.enabled).toBe(false);
      const mainResult = yield* h.gateway.materialize(changed, h.instances);
      expect(mainResult[instanceId]?.enabled).toBe(false);
      const inherited = yield* h.gateway.materialize(changed, { [instanceId]: instance });
      expect(record(inherited[instanceId]!.config).model).toBe("hidden");
    }).pipe(Effect.scoped),
  );

  it.effect("removes Pi Responses compatibility when the service switches protocols", () =>
    Effect.gen(function* () {
      const h = yield* harness({ driver: "pi", protocol: "openai-responses" });
      const fs = yield* FileSystem.FileSystem;
      const file = String(h.config.agentDir) + "/models.json";
      expect(JSON.parse(yield* fs.readFileString(file)).providers.cox.compat).toEqual({
        supportsStrictMode: true,
      });
      const current = (yield* h.settings.getSettings).modelServices[serviceId]!;
      yield* h.settings.updateSettings({
        modelServices: { [serviceId]: { ...current, protocols: ["openai-chat"] } },
      });
      yield* h.gateway.materialize(yield* h.settings.getSettings, h.instances);
      const generated = JSON.parse(yield* fs.readFileString(file));
      expect(generated.providers.cox.api).toBe("openai-completions");
      expect(Object.hasOwn(generated.providers.cox, "compat")).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect.each(["openai-chat", "anthropic-messages", "gemini"] as const)(
    "disables forced tool choice only for rejecting Claude models over %s",
    (protocol) =>
      Effect.gen(function* () {
        const h = yield* harness({ driver: "omo", protocol });
        const fs = yield* FileSystem.FileSystem;
        const ids = [
          "claude-opus-5-5",
          "Vendor/claude-sonnet-5.5",
          "claude-fable-5-2",
          "claude-mythos-5-1",
          "claude-opus-5",
          "claude-sonnet-5-55",
          "gpt-6-luna",
        ];
        const current = (yield* h.settings.getSettings).modelServices[serviceId]!;
        yield* h.settings.updateSettings({
          modelServices: {
            [serviceId]: { ...current, models: ids.map((id) => ({ id, capabilities: null })) },
          },
        });
        yield* h.gateway.materialize(yield* h.settings.getSettings, {
          [instanceId]: {
            ...h.instances[instanceId]!,
            modelService: { serviceId, modelIds: ids, defaultModel: "gpt-6-luna" },
          },
        });
        const generated = JSON.parse(
          yield* fs.readFileString(String(h.config.agentDir) + "/models.json"),
        );
        const compat = Object.fromEntries(
          generated.providers.cox.models.map((model: Record<string, unknown>) => [
            model.id,
            model.compat,
          ]),
        );
        const rejected = protocol === "gemini" ? undefined : { supportsForcedToolChoice: false };
        expect(compat).toEqual({
          "claude-opus-5-5": rejected,
          "Vendor/claude-sonnet-5.5": rejected,
          "claude-fable-5-2": rejected,
          "claude-mythos-5-1": rejected,
          "claude-opus-5": undefined,
          "claude-sonnet-5-55": undefined,
          "gpt-6-luna": undefined,
        });
      }).pipe(Effect.scoped),
  );

  it.effect("preserves Pi Responses strict flags and optional tool arguments on the wire", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        driver: "pi",
        protocol: "openai-responses",
        maxOutputTokens: null,
        respond: () => Response.json({ id: "offline", status: "completed", output: [] }),
      });
      const parameters = {
        type: "object",
        properties: { environmentId: { type: "string" }, search: { type: "string" } },
        required: [],
        additionalProperties: false,
      };
      const body = {
        model: "Vendor/Exact",
        input: "Read the current environment without specifying optional arguments.",
        tools: [
          { type: "function", name: "cox_environment_read", parameters, strict: false },
          {
            type: "function",
            name: "strict_tool",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
              additionalProperties: false,
            },
            strict: true,
          },
        ],
      };
      expect((yield* h.invoke("/v1/responses", body)).status).toBe(200);
      expect(h.calls).toHaveLength(1);
      expect(h.calls[0]?.url).toBe("https://upstream.test/v1/responses");
      const outgoing = h.calls[0]!.body;
      if (outgoing._tag !== "Uint8Array") throw new Error("Expected JSON bytes");
      expect(JSON.parse(new TextDecoder().decode(outgoing.body))).toEqual(body);
      expect(parameters.required).toEqual([]);
    }).pipe(Effect.scoped),
  );
  it.effect.each([
    {
      protocol: "anthropic-messages",
      path: "/v1/messages",
      message: "prompt is too long: 70000 tokens > 64000 maximum",
    },
    { protocol: "openai-responses", path: "/v1/responses", message: "maximum context length" },
    { protocol: "openai-chat", path: "/v1/chat/completions", message: "maximum context length" },
    {
      protocol: "gemini",
      path: "/v1beta/models/Vendor%2FExact:generateContent",
      message: "The input token count exceeds the maximum number of tokens allowed",
    },
  ] as const)(
    "returns client-recognized context overflow for $protocol",
    ({ protocol, path, message }) =>
      Effect.gen(function* () {
        const h = yield* harness({
          protocol,
          respond: () =>
            Response.json(
              {
                error: {
                  type: "invalid_request_error",
                  message: "prompt is too long: 70000 tokens > 64000 maximum",
                },
              },
              { status: 400 },
            ),
        });
        const result = yield* h.invoke(path, {
          model: "Vendor/Exact",
          messages: [],
          input: "hello",
        });
        expect(result.status).toBe(400);
        const error = record(JSON.parse(result.text)).error;
        expect(record(error).message).toContain(message);
        if (protocol.startsWith("openai"))
          expect(record(error).code).toBe("context_length_exceeded");
        if (protocol === "anthropic-messages") expect(JSON.parse(result.text).type).toBe("error");
        if (protocol === "gemini")
          expect(record(error)).toMatchObject({ code: 400, status: "INVALID_ARGUMENT" });
        expect(h.calls).toHaveLength(1);
      }).pipe(Effect.scoped),
  );
  it.effect.each(["context_length_exceeded", "invalid_prompt", "content_policy_violation"])(
    "returns HTTP 400 for pre-output stream error %s",
    (code) =>
      Effect.gen(function* () {
        const h = yield* harness({
          protocol: "openai-responses",
          respond: () =>
            new Response(sseFrame({ type: "error", code, message: "private-upstream-key" }), {
              headers: { "content-type": "text/event-stream" },
            }),
        });
        const result = yield* h.invoke("/v1/responses", {
          model: "Vendor/Exact",
          input: "hello",
          stream: true,
        });
        expect(result.status).toBe(400);
        expect(result.text).not.toContain("private-upstream-key");
      }).pipe(Effect.scoped),
  );
  it.effect.each([
    { path: "/v1/messages", expected: { type: "authentication_error" }, top: "error" },
    {
      path: "/v1beta/models/Vendor%2FExact:generateContent",
      expected: { code: 401, status: "UNAUTHENTICATED" },
      top: undefined,
    },
  ])("uses incoming error envelope for unauthenticated $path", ({ path, expected, top }) =>
    Effect.gen(function* () {
      const h = yield* harness();
      const result = yield* h.invoke(path, {}, { authorization: "Bearer invalid" });
      expect(result.status).toBe(401);
      expect(JSON.parse(result.text)).toMatchObject({
        ...(top ? { type: top } : {}),
        error: expected,
      });
    }).pipe(Effect.scoped),
  );
  it.effect("classifies successful non-JSON upstream bodies without retrying", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        respond: () =>
          new Response("<html>private-upstream-key</html>", {
            headers: { "content-type": "text/html" },
          }),
      });
      const result = yield* h.invoke("/v1/chat/completions", {
        model: "Vendor/Exact",
        messages: [],
      });
      expect(result.status).toBe(502);
      expect(JSON.parse(result.text).error.code).toBe("upstream_invalid_response");
      expect(result.text).not.toContain("private-upstream-key");
    }).pipe(Effect.scoped),
  );
  it.effect("retries converted requests after hosted tools are removed", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const failed = yield* Deferred.make<void>();
      const h = yield* harness({
        recovery: { retryEnabled: true, maxAttempts: 2 },
        respond: () => {
          Deferred.doneUnsafe(failed, Effect.void);
          return ++attempts === 1
            ? Response.json({ error: { type: "server_error" } }, { status: 503 })
            : Response.json({
                choices: [
                  { message: { role: "assistant", content: "recovered" }, finish_reason: "stop" },
                ],
              });
        },
      });
      const fiber = yield* h
        .invoke("/v1/responses", {
          model: "Vendor/Exact",
          input: "hello",
          tools: [{ type: "web_search" }],
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(failed);
      yield* TestClock.adjust("2 seconds");
      const result = yield* Fiber.join(fiber);
      expect(result.status).toBe(200);
      expect(h.calls).toHaveLength(2);
    }).pipe(Effect.scoped),
  );
  it.effect.each(["/v1/messages", "/v1/responses"])(
    "preserves one terminal upstream error for %s",
    (path) =>
      Effect.gen(function* () {
        const ready = yield* Deferred.make<void>();
        let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
        const encoder = new TextEncoder();
        const h = yield* harness({
          protocol: "anthropic-messages",
          respond: () =>
            new Response(
              new ReadableStream<Uint8Array>({
                start(output) {
                  controller = output;
                  Deferred.doneUnsafe(ready, Effect.void);
                  output.enqueue(
                    encoder.encode(
                      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","content":[],"model":"Vendor/Exact","usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n',
                    ),
                  );
                },
              }),
              { headers: { "content-type": "text/event-stream" } },
            ),
        });
        const fiber = yield* h
          .invoke(path, { model: "Vendor/Exact", messages: [], input: "hello", stream: true })
          .pipe(Effect.forkChild);
        yield* Deferred.await(ready);
        yield* TestClock.adjust("1 second");
        if (!controller) throw new Error("Missing stream controller");
        controller.enqueue(
          encoder.encode(
            'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
          ),
        );
        yield* TestClock.adjust("1 second");
        if (path === "/v1/messages")
          controller.error(new Error("upstream disconnected after its error"));
        else controller.close();
        const result = yield* Fiber.join(fiber);
        expect(result.text.match(/event: error/g)).toHaveLength(1);
        expect(result.text).toContain("overloaded_error");
        expect(result.text).not.toContain("cox_model_service_incomplete_stream");
      }).pipe(Effect.scoped),
  );
  it.effect.each(["done", "trailing-data", "disconnect"])(
    "preserves a Chat tool-call error without replaying the request (%s)",
    (ending) =>
      Effect.gen(function* () {
        const ready = yield* Deferred.make<void>();
        let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
        const encoder = new TextEncoder();
        const h = yield* harness({
          protocol: "openai-chat",
          recovery: { retryEnabled: true, retryToolRequests: true, maxAttempts: 3 },
          respond: () =>
            new Response(
              new ReadableStream<Uint8Array>({
                start(output) {
                  controller = output;
                  Deferred.doneUnsafe(ready, Effect.void);
                  output.enqueue(
                    encoder.encode(
                      chatStreamFrame({
                        tool_calls: [
                          {
                            index: 0,
                            id: "call_eval",
                            type: "function",
                            function: { name: "eval", arguments: '{"code":"1 + 1"}' },
                          },
                        ],
                      }),
                    ),
                  );
                },
              }),
              { headers: { "content-type": "text/event-stream" } },
            ),
        });
        const fiber = yield* h
          .invoke("/v1/chat/completions", {
            model: "Vendor/Exact",
            messages: [{ role: "user", content: "Evaluate an expression" }],
            stream: true,
            tools: [
              {
                type: "function",
                function: {
                  name: "eval",
                  parameters: { type: "object", properties: { code: { type: "string" } } },
                },
              },
            ],
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(ready);
        yield* TestClock.adjust("1 second");
        if (!controller) throw new Error("Missing stream controller");
        controller.enqueue(
          encoder.encode(sseFrame({ error: { message: "malformed_function_call" } })),
        );
        yield* TestClock.adjust("1 second");
        if (ending === "disconnect") controller.error(new Error("upstream disconnected"));
        else {
          controller.enqueue(
            encoder.encode(
              ending === "done"
                ? "data: [DONE]\n\n"
                : sseFrame({ choices: [], usage: { completion_tokens: 0 } }),
            ),
          );
          controller.close();
        }
        const result = yield* Fiber.join(fiber);
        expect(result.text).toContain("call_eval");
        expect(result.text.match(/malformed_function_call/g)).toHaveLength(1);
        expect(result.text).not.toContain("cox_model_service_incomplete_stream");
        expect(h.calls).toHaveLength(1);
      }).pipe(Effect.scoped),
  );
  it.effect("unions configured and incoming Anthropic betas", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        protocol: "anthropic-messages",
        respond: (request) =>
          request.headers["anthropic-beta"] === "configured,shared,client"
            ? Response.json({
                type: "message",
                stop_reason: "end_turn",
                content: [{ type: "text", text: "ok" }],
              })
            : Response.json({}, { status: 400 }),
      });
      const current = (yield* h.settings.getSettings).modelServices[serviceId];
      if (!current) throw new Error("Missing service");
      yield* h.settings.updateSettings({
        modelServices: {
          [serviceId]: { ...current, headers: { "anthropic-beta": "configured,shared" } },
        },
      });
      const result = yield* h.invoke(
        "/v1/messages",
        { model: "Vendor/Exact", messages: [] },
        { "anthropic-beta": "shared,client" },
      );
      expect(result.status).toBe(200);
    }).pipe(Effect.scoped),
  );
  it.effect("repairs native Anthropic forced-tool thinking once", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        protocol: "anthropic-messages",
        recovery: { retryEnabled: true, maxAttempts: 2 },
        respond: (request) =>
          sentBody(request).thinking
            ? Response.json(
                {
                  error: {
                    message: "tool_choice 'specified' is incompatible with thinking enabled",
                  },
                },
                { status: 400 },
              )
            : Response.json({
                type: "message",
                stop_reason: "end_turn",
                content: [{ type: "text", text: "repaired" }],
              }),
      });
      const fiber = yield* h
        .invoke("/v1/messages", {
          model: "Vendor/Exact",
          messages: [],
          thinking: { type: "enabled", budget_tokens: 1000 },
          tool_choice: { type: "any" },
          tools: [{ name: "exec", input_schema: { type: "object" } }],
        })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("2 seconds");
      const result = yield* Fiber.join(fiber);
      expect(result.status).toBe(200);
      expect(h.calls).toHaveLength(2);
    }).pipe(Effect.scoped),
  );
  it.effect("returns 413 over real HTTP for oversized request bodies", () =>
    Effect.gen(function* () {
      const h = yield* harness({ protocol: "anthropic-messages" });
      const routes = HttpRouter.add("POST", "/api/model-gateway/v1/messages", h.gateway.handle);
      const services = yield* Layer.build(
        HttpRouter.serve(routes, { disableListenLog: true, disableLogger: true }).pipe(
          Layer.provideMerge(NodeHttpServer.layerTest),
        ),
      );
      const client = Context.get(services, HttpClient.HttpClient);
      const outgoing = yield* HttpClientRequest.bodyJson(
        HttpClientRequest.post("/api/model-gateway/v1/messages").pipe(
          HttpClientRequest.setHeader("authorization", `Bearer ${h.token}`),
        ),
        { model: "Vendor/Exact", messages: [], padding: "x".repeat(17 * 1024 * 1024) },
      );
      const response = yield* client.execute(outgoing);
      expect(response.status).toBe(413);
      expect(yield* response.json).toMatchObject({
        type: "error",
        error: { type: "request_too_large" },
      });
      expect(h.calls).toHaveLength(0);
    }).pipe(Effect.scoped),
  );
  it.effect.each([
    { status: 400, type: "invalid_request_error" },
    { status: 401, type: "authentication_error" },
    { status: 403, type: "permission_error" },
    { status: 404, type: "not_found_error" },
    { status: 413, type: "request_too_large" },
    { status: 429, type: "rate_limit_error" },
    { status: 529, type: "overloaded_error" },
    { status: 500, type: "api_error" },
  ])("preserves Anthropic HTTP error types for $status", ({ status, type }) =>
    Effect.gen(function* () {
      const h = yield* harness({
        protocol: "anthropic-messages",
        respond: () => Response.json({ error: { message: "private-upstream-key" } }, { status }),
      });
      const result = yield* h.invoke("/v1/messages", { model: "Vendor/Exact", messages: [] });
      expect(result.status).toBe(status);
      expect(JSON.parse(result.text)).toMatchObject({
        type: "error",
        error: { type, source: "upstream" },
      });
      expect(result.text).not.toContain("private-upstream-key");
    }).pipe(Effect.scoped),
  );
  it.effect("never retries context overflow when non-transient retries are enabled", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        recovery: { retryEnabled: true, retryNonTransientErrors: true, maxAttempts: 2 },
        respond: () =>
          Response.json({ error: { code: "context_length_exceeded" } }, { status: 400 }),
      });
      const fiber = yield* h
        .invoke("/v1/chat/completions", { model: "Vendor/Exact", messages: [] })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("2 seconds");
      const result = yield* Fiber.join(fiber);
      expect(result.status).toBe(400);
      expect(h.calls).toHaveLength(1);
    }).pipe(Effect.scoped),
  );
});

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ModelServiceConfig,
  ModelServiceId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfigMap,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { make } from "./ModelServiceGateway.ts";

const serviceId = ModelServiceId.make("shared-test");
const instanceId = ProviderInstanceId.make("bound-test");
const decodeService = Schema.decodeSync(ModelServiceConfig);
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

const harness = Effect.fn("ModelGateway.test.harness")(function* (
  options: {
    readonly driver?: string;
    readonly respond?: (
      request: import("effect/http/HttpClientRequest").HttpClientRequest,
    ) => Response;
  } = {},
) {
  const calls: import("effect/http/HttpClientRequest").HttpClientRequest[] = [];
  const settings = yield* ServerSettingsService;
  const previous = (yield* settings.getSettings).modelServices[serviceId];
  yield* settings.updateSettings({
    modelServices: { [serviceId]: { ...service, revision: previous?.revision ?? 0 } },
  });
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      calls.push(request);
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
  const gateway = yield* make.pipe(Effect.provideService(HttpClient.HttpClient, http));
  const driver = ProviderDriverKind.make(options.driver ?? "codex");
  const instances: ProviderInstanceConfigMap = {
    [instanceId]: {
      driver,
      enabled: true,
      modelService: { serviceId, modelIds: ["Vendor/Exact"], defaultModel: "Vendor/Exact" },
      config: { launchArgs: "", retained: true },
    },
  };
  const materialized = yield* gateway.materialize(yield* settings.getSettings, instances);
  const config = record(materialized[instanceId]!.config);
  const token =
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
    return { status: response.status, text };
  }, Effect.scoped);
  return { gateway, instances, materialized, config, token, calls, invoke, settings };
});

it.layer(layer)("model service gateway", (it) => {
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
    "forwards native requests without changing tools, exact IDs, or extra request fields",
    () =>
      Effect.gen(function* () {
        const h = yield* harness({ driver: "pi" });
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
    "converts a Codex Responses request and a Chat Completions reply through the real SDK bridge",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        const response = yield* h.invoke("/v1/responses", {
          model: "Vendor/Exact",
          input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
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

  it.effect("does not leak upstream error bodies or retry generation on failure", () =>
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
});

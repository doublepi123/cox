import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
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
import { HttpClient, HttpClientResponse, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
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

const harness = Effect.fn("ModelGateway.test.harness")(function* (
  options: {
    readonly driver?: string;
    readonly protocol?: ModelServiceConfig["protocols"][number];
    readonly recovery?: Partial<ModelServiceConfig["recovery"]>;
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
        protocols: [options.protocol ?? "openai-chat"],
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
    return { status: response.status, headers: response.headers, text };
  }, Effect.scoped);
  return { gateway, instances, materialized, config, token, calls, invoke, settings };
});

it.layer(layer)("model service gateway", (it) => {
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
          'data: {"choices":[{"delta":{"content":"sibling survived"}}]}\n\ndata: [DONE]\n\n',
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

  it.effect.each([false, true])("makes quota 429 retries configurable (%s)", (retryOn429) =>
    Effect.gen(function* () {
      let calls = 0;
      const h = yield* harness({
        recovery: { retryEnabled: true, retryOn429 },
        respond: () =>
          ++calls === 1
            ? Response.json({ error: { code: "insufficient_quota" } }, { status: 429 })
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
                : 'data: {"choices":[{"delta":{"content":"quota recovered"}}]}\n\ndata: [DONE]\n\n',
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
              : 'data: {"type":"response.output_text.delta","delta":"found"}\n\ndata: {"type":"response.completed"}\n\n',
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

  it.effect.each([
    { background: true },
    { previous_response_id: "prior-response" },
    { conversation: "prior-conversation" },
  ])("preserves stateful request limits when retry overrides are enabled (%j)", (state) =>
    Effect.gen(function* () {
      const h = yield* harness({
        protocol: "openai-responses",
        recovery: { retryEnabled: true, retryOn429: true, retryToolRequests: true },
        respond: () => Response.json({ error: { code: "insufficient_quota" } }, { status: 429 }),
      });
      const result = yield* h.invoke("/v1/responses", {
        model: "Vendor/Exact",
        input: "search",
        tools: [{ type: "web_search" }],
        ...state,
      });
      expect(result.status).toBe(429);
      expect(h.calls).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("does not spend a new upstream budget when an SDK repeats an exhausted request", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        recovery: { retryEnabled: true, maxAttempts: 2 },
        respond: () => Response.json({ error: { code: "server_error" } }, { status: 503 }),
      });
      const session = ProviderSessionId.make("tracked-session");
      yield* h.gateway.lifecycle.begin(
        session,
        {
          threadId: ThreadId.make("tracked-thread"),
          runId: RunId.make("tracked-run"),
          rootNodeId: NodeId.make("tracked-node"),
          providerThread: {
            id: ProviderThreadId.make("tracked-provider-thread"),
            driver: ProviderDriverKind.make("codex"),
          },
        },
        () => Effect.void,
      );
      const body = { model: "Vendor/Exact", messages: [] };
      const headers = { authorization: `Bearer ${h.token}.${session}` };
      const first = yield* h.invoke("/v1/chat/completions", body, headers).pipe(Effect.forkChild);
      yield* TestClock.adjust("2 seconds");
      expect((yield* Fiber.join(first)).status).toBe(503);
      expect((yield* h.invoke("/v1/chat/completions", body, headers)).status).toBe(503);
      expect(h.calls).toHaveLength(2);
    }).pipe(Effect.scoped),
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
                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"winner-tool","function":{"name":"shell","arguments":"{}"}}]}}]}\n\ndata: [DONE]\n\n',
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
              : 'data: {"choices":[{"delta":{"content":"recovered stream"}}]}\n\ndata: [DONE]\n\n',
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
        encoder.encode('data: {"choices":[{"delta":{"content":"answer"}}]}\n\ndata: [DONE]\n\n'),
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
          { capabilities: { optionDescriptors: [{ id: "serviceTier", options: tiers }] } },
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
          expect(options.effort).toBe("xhigh");
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
});

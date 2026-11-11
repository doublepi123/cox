import { describe, expect, it } from "@effect/vitest";
import {
  ModelServiceConfig,
  ModelServiceId,
  type ModelServiceProtocol,
  type ModelServiceRecommendOmoModelsInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { ServerSettingsService } from "../serverSettings.ts";
import { recommendOmoModels } from "./omoRecommendations.ts";

const serviceId = ModelServiceId.make("recommendations");
const decodeConfig = Schema.decodeSync(ModelServiceConfig);
const input: ModelServiceRecommendOmoModelsInput = {
  serviceId,
  revision: 3,
  modelId: "vendor/generator",
  binding: { serviceId, modelIds: ["vendor/generator", "fast"] },
  agents: ["sisyphus", "custom-agent"],
  categories: ["quick"],
};
const assignments = {
  agentModels: { sisyphus: "cox/vendor/generator", "custom-agent": "cox/fast" },
  categoryModels: { quick: "cox/fast" },
  explanation: "Use the reasoning model to orchestrate and the fast model for simple work.",
};
const config = (
  protocols: readonly [ModelServiceProtocol, ...ModelServiceProtocol[]] = ["openai-chat"],
) =>
  decodeConfig({
    name: "Test",
    revision: 3,
    baseUrl: "https://models.test/custom",
    apiKey: "private-key",
    headers: { "x-custom": "custom-value" },
    protocols,
    models: [
      { id: "vendor/generator", name: "Generator", supportsReasoning: true, maxOutputTokens: 4096 },
      { id: "fast", maxOutputTokens: 4096 },
      { id: "outside" },
      { id: "ignored", ignored: true },
      { id: "unavailable", available: false },
      { id: "no-tools", supportsTools: false },
      { id: "incompatible", protocols: ["gemini"] },
    ],
  });
const chatResponse = (value: unknown = assignments) => ({
  choices: [{ finish_reason: "stop", message: { content: JSON.stringify(value) } }],
});
const settingsLayer = (service = config()) =>
  ServerSettingsService.layerTest({ modelServices: { [serviceId]: service } });

describe("OMO model recommendations", () => {
  it.effect.each([
    [
      "openai-chat",
      "/custom/chat/completions",
      "authorization",
      "Bearer private-key",
      chatResponse(),
    ],
    [
      "openai-responses",
      "/custom/responses",
      "authorization",
      "Bearer private-key",
      {
        status: "completed",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: JSON.stringify(assignments) }],
          },
        ],
      },
    ],
    [
      "anthropic-messages",
      "/custom/messages",
      "x-api-key",
      "private-key",
      {
        type: "message",
        stop_reason: "end_turn",
        content: [{ type: "text", text: JSON.stringify(assignments) }],
      },
    ],
    [
      "gemini",
      "/custom/models/vendor%2Fgenerator:generateContent",
      "x-goog-api-key",
      "private-key",
      {
        candidates: [
          { finishReason: "STOP", content: { parts: [{ text: JSON.stringify(assignments) }] } },
        ],
      },
    ],
  ] as const)(
    "uses a direct no-tools nonstream request for %s",
    ([protocol, path, authHeader, authValue, response]) =>
      Effect.gen(function* () {
        const before = yield* (yield* ServerSettingsService).getSettings;
        let calls = 0;
        const http = HttpClient.make((request) =>
          Effect.sync(() => {
            calls++;
            expect(new URL(request.url).pathname).toBe(path);
            expect(request.method).toBe("POST");
            expect(request.headers[authHeader]).toBe(authValue);
            expect(request.headers["x-custom"]).toBe("custom-value");
            if (protocol === "anthropic-messages")
              expect(request.headers["anthropic-version"]).toBe("2023-06-01");
            if (request.body._tag !== "Uint8Array") throw new Error("Expected JSON bytes");
            const body = JSON.parse(new TextDecoder().decode(request.body.body));
            expect(body.tools).toBeUndefined();
            expect(body.stream ?? false).toBe(false);
            expect(
              protocol === "gemini"
                ? body.generationConfig.maxOutputTokens
                : protocol === "openai-responses"
                  ? body.max_output_tokens
                  : body.max_tokens,
            ).toBe(4096);
            if (protocol !== "gemini") expect(body.model).toBe(input.modelId);
            const prompt =
              protocol === "gemini"
                ? body.contents[0].parts[0].text
                : protocol === "openai-responses"
                  ? body.input
                  : body.messages[0].content;
            const data = JSON.parse(prompt.split("\n").at(-1));
            expect(data.catalog.map((model: { slug: string }) => model.slug)).toEqual([
              "cox/vendor/generator",
              "cox/fast",
            ]);
            expect(data.catalog[0]).toMatchObject({ name: "Generator", supportsReasoning: true });
            expect(data.standardAgentDescriptions.oracle).toContain("reasoning");
            expect(data.standardCategoryDescriptions.quick).toContain("speed");
            expect(data.requestedAgents).toEqual(input.agents);
            expect(data.requestedCategories).toEqual(input.categories);
            return HttpClientResponse.fromWeb(request, Response.json(response));
          }),
        );
        expect(
          yield* recommendOmoModels(input).pipe(Effect.provideService(HttpClient.HttpClient, http)),
        ).toEqual(assignments);
        expect(calls).toBe(1);
        expect(yield* (yield* ServerSettingsService).getSettings).toEqual(before);
      }).pipe(Effect.provide(settingsLayer(config([protocol])))),
  );

  it.effect.each([
    { ...assignments, agentModels: { ...assignments.agentModels, oracle: "cox/fast" } },
    { ...assignments, agentModels: { sisyphus: "cox/fast" } },
    { ...assignments, categoryModels: {} },
    { ...assignments, categoryModels: { quick: "cox/outside" } },
    { ...assignments, categoryModels: { quick: "cox/hallucinated" } },
    { ...assignments, categoryModels: { quick: "fast" } },
    { ...assignments, categoryModels: { quick: " cox/fast " } },
    { ...assignments, categoryModels: { quick: "cox/ignored" } },
    { ...assignments, categoryModels: { quick: "cox/unavailable" } },
    { ...assignments, categoryModels: { quick: "cox/no-tools" } },
    { ...assignments, categoryModels: { quick: "cox/incompatible" } },
    { ...assignments, categoryModels: { quick: 42 } },
    { ...assignments, explanation: " " },
    { ...assignments, unexpected: true },
    null,
  ])("rejects invalid, incomplete, outside and hallucinated assignments without retry", (value) =>
    Effect.gen(function* () {
      let calls = 0;
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          calls++;
          return HttpClientResponse.fromWeb(request, Response.json(chatResponse(value)));
        }),
      );
      const error = yield* recommendOmoModels(input).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.flip,
      );
      expect(error._tag).toBe("ModelServiceError");
      expect(calls).toBe(1);
    }).pipe(Effect.provide(settingsLayer(config(["openai-chat", "openai-responses"])))),
  );

  it.effect.each([
    { ...input, revision: 2 },
    { ...input, binding: { ...input.binding, serviceId: ModelServiceId.make("other") } },
    { ...input, modelId: "outside" },
    ...["ignored", "unavailable", "no-tools", "incompatible"].map((modelId) => ({
      ...input,
      modelId,
      binding: { serviceId, modelIds: [] },
    })),
    { ...input, agents: ["invalid.role"] },
    { ...input, agents: ["__proto__"] },
    { ...input, agents: ["constructor"] },
    { ...input, categories: ["prototype"] },
    { ...input, agents: ["1agent"] },
    { ...input, agents: [" sisyphus "] },
    { ...input, agents: ["a".repeat(65)] },
    { ...input, agents: ["sisyphus", "sisyphus"] },
    { ...input, categories: ["quick", "quick"] },
    { ...input, agents: [], categories: [] },
  ])("rejects invalid requests before HTTP", (requestInput) =>
    Effect.gen(function* () {
      let calls = 0;
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          calls++;
          return HttpClientResponse.fromWeb(request, Response.json(chatResponse()));
        }),
      );
      yield* recommendOmoModels(requestInput).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.flip,
      );
      expect(calls).toBe(0);
    }).pipe(Effect.provide(settingsLayer())),
  );

  it.effect.each([
    Response.json({ error: "private-key" }, { status: 401 }),
    new Response(null, { status: 302, headers: { location: "https://other.test" } }),
    new Response("private-key"),
    Response.json({ error: "private-key" }),
    Response.json({
      choices: [{ finish_reason: "length", message: { content: JSON.stringify(assignments) } }],
    }),
    Response.json(chatResponse("```json\n{}\n```")),
    new Response("x".repeat(1024 * 1024 + 1)),
    Response.json(chatResponse({ ...assignments, explanation: "x".repeat(1024 * 1024) })),
  ])(
    "rejects failed, malformed, truncated and oversized responses without protocol retries or secret leakage",
    (response) =>
      Effect.gen(function* () {
        let calls = 0;
        const http = HttpClient.make((request) =>
          Effect.sync(() => {
            calls++;
            return HttpClientResponse.fromWeb(request, response);
          }),
        );
        const error = yield* recommendOmoModels(input).pipe(
          Effect.provideService(HttpClient.HttpClient, http),
          Effect.flip,
        );
        expect(error.detail).not.toContain("private-key");
        expect(calls).toBe(1);
      }).pipe(Effect.provide(settingsLayer(config(["openai-chat", "openai-responses"])))),
  );

  it.effect(
    "uses empty binding modelIds as the whole eligible catalog and accepts one role group",
    () =>
      Effect.gen(function* () {
        const http = HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json(
                chatResponse({
                  ...assignments,
                  agentModels: {},
                  categoryModels: { quick: "cox/outside" },
                }),
              ),
            ),
          ),
        );
        const result = yield* recommendOmoModels({
          ...input,
          agents: [],
          binding: { serviceId, modelIds: [] },
        }).pipe(Effect.provideService(HttpClient.HttpClient, http));
        expect(result.categoryModels.quick).toBe("cox/outside");
      }).pipe(Effect.provide(settingsLayer())),
  );

  it.effect("rejects a disabled service without HTTP", () =>
    recommendOmoModels(input).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("Unexpected HTTP")),
      ),
      Effect.flip,
      Effect.tap((error) => Effect.sync(() => expect(error.detail).toContain("disabled"))),
      Effect.provide(settingsLayer({ ...config(), enabled: false })),
    ),
  );

  it.effect("rejects settings changed while generating and does not persist assignments", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettingsService;
      const http = HttpClient.make((request) =>
        settings
          .updateSettings({ modelServices: { [serviceId]: { ...config(), name: "Changed" } } })
          .pipe(
            Effect.orDie,
            Effect.as(HttpClientResponse.fromWeb(request, Response.json(chatResponse()))),
          ),
      );
      const error = yield* recommendOmoModels(input).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.flip,
      );
      expect(error.detail).toContain("changed");
    }).pipe(Effect.provide(settingsLayer())),
  );

  it.effect("times out after 120 seconds without replay", () =>
    Effect.gen(function* () {
      let calls = 0;
      const http = HttpClient.make(() =>
        Effect.sync(() => {
          calls++;
        }).pipe(Effect.andThen(Effect.never)),
      );
      const fiber = yield* recommendOmoModels(input).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.flip,
        Effect.forkChild,
      );
      yield* TestClock.adjust("120 seconds");
      const error = yield* Fiber.join(fiber);
      expect(error._tag).toBe("ModelServiceError");
      expect(calls).toBe(1);
    }).pipe(Effect.provide(settingsLayer())),
  );
});

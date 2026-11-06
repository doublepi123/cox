import { describe, expect, it } from "@effect/vitest";
import { ModelServiceConfig, ModelServiceId, type ModelServiceProtocol } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { ServerSettingsService } from "../serverSettings.ts";
import { testModelService } from "./testing.ts";

const id = ModelServiceId.make("test-models");
const decodeConfig = Schema.decodeSync(ModelServiceConfig);
const config = (
  protocols: readonly [ModelServiceProtocol, ...ModelServiceProtocol[]] = ["openai-chat"],
) =>
  decodeConfig({
    name: "Test",
    baseUrl: "https://model.test",
    apiKey: "private-key",
    protocols,
    models: [{ id: "test", capabilities: null }],
  });

describe("explicit model tests", () => {
  it.effect.each([
    ["openai-chat", "/v1/chat/completions", { choices: [{ message: { content: "OK" } }] }],
    ["openai-responses", "/v1/responses", { output: [], status: "completed" }],
    ["anthropic-messages", "/v1/messages", { type: "message", content: [{ text: "OK" }] }],
    [
      "gemini",
      "/v1beta/models/test:generateContent",
      { candidates: [{ content: { parts: [{ text: "OK" }] } }] },
    ],
  ] as const)(
    "tests %s through its protocol without creating agent sessions",
    ([protocol, path, body]) =>
      Effect.gen(function* () {
        let calls = 0;
        const http = HttpClient.make((request) =>
          Effect.sync(() => {
            calls++;
            expect(new URL(request.url).pathname).toBe(path);
            expect(request.method).toBe("POST");
            return HttpClientResponse.fromWeb(request, Response.json(body));
          }),
        );
        const result = yield* testModelService({
          serviceId: id,
          revision: 0,
          modelId: "test",
        }).pipe(Effect.provideService(HttpClient.HttpClient, http));
        expect(result).toMatchObject({
          ok: true,
          modelId: "test",
          revision: 0,
          protocol,
          message: null,
        });
        expect(calls).toBe(1);
        expect(
          (yield* (yield* ServerSettingsService).getSettings).modelServices[id]!.models,
        ).toHaveLength(1);
      }).pipe(
        Effect.provide(
          ServerSettingsService.layerTest({ modelServices: { [id]: config([protocol]) } }),
        ),
      ),
  );

  it.effect("tries the next declared protocol and does not replay a successful test", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          calls.push(request.url);
          return HttpClientResponse.fromWeb(
            request,
            request.url.endsWith("/responses")
              ? Response.json({ error: "unsupported" }, { status: 404 })
              : Response.json({ choices: [{}] }),
          );
        }),
      );
      const result = yield* testModelService({ serviceId: id, revision: 0, modelId: "test" }).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
      );
      expect(result).toMatchObject({ ok: true, protocol: "openai-chat" });
      expect(calls).toHaveLength(2);
    }).pipe(
      Effect.provide(
        ServerSettingsService.layerTest({
          modelServices: {
            [id]: config(["openai-responses", "openai-chat", "anthropic-messages"]),
          },
        }),
      ),
    ),
  );

  it.effect.each([
    Response.json({ error: "private-key" }, { status: 403 }),
    new Response("not-json"),
    Response.json({ error: { message: "private-key" } }),
  ])("does not leak upstream bodies or accept malformed success responses", (response) =>
    Effect.gen(function* () {
      const http = HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, response.clone())),
      );
      const result = yield* testModelService({ serviceId: id, revision: 0, modelId: "test" }).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
      );
      expect(result.ok).toBe(false);
      expect(result.message).not.toContain("private-key");
    }).pipe(Effect.provide(ServerSettingsService.layerTest({ modelServices: { [id]: config() } }))),
  );

  it.effect("rejects stale configurations before sending requests", () =>
    Effect.gen(function* () {
      let calls = 0;
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          calls++;
          return HttpClientResponse.fromWeb(request, Response.json({ choices: [{}] }));
        }),
      );
      const error = yield* Effect.flip(
        testModelService({ serviceId: id, revision: 4, modelId: "test" }).pipe(
          Effect.provideService(HttpClient.HttpClient, http),
        ),
      );
      expect(error.detail).toContain("changed");
      expect(calls).toBe(0);
    }).pipe(Effect.provide(ServerSettingsService.layerTest({ modelServices: { [id]: config() } }))),
  );
});

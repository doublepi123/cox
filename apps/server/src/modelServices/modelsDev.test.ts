import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import {
  enrichModelFromModelsDev,
  fetchModelsDevCatalog,
  parseModelsDevCatalog,
} from "./modelsDev.ts";

const metadata = {
  id: "gpt-test",
  name: "GPT Test",
  canonical_model_id: "openai/gpt-test",
  limit: { context: 128000, output: 16000 },
  modalities: { input: ["text", "image", "audio"], output: ["text"] },
  tool_call: true,
  reasoning: true,
  reasoning_options: [{ type: "effort", values: ["low", "high"] }],
};
const catalog = parseModelsDevCatalog({
  openai: { api: "https://api.openai.com/v1", models: { "gpt-test": metadata } },
});
const enrich = (id: string) =>
  enrichModelFromModelsDev({ id, name: id, capabilities: null }, catalog, "https://proxy.test/v1");

describe("models.dev model metadata", () => {
  it("fills names, context, output, modalities, tools and reported reasoning options", () => {
    expect(enrich("gpt-test")).toMatchObject({
      id: "gpt-test",
      name: "GPT Test",
      maxOutputTokens: 16000,
      supportsTools: true,
      supportsReasoning: true,
      inputModalities: ["text", "image", "audio"],
      outputModalities: ["text"],
      capabilities: {
        contextWindow: 128000,
        supportsImages: true,
        optionDescriptors: [
          {
            id: "reasoningEffort",
            type: "select",
            options: [
              { id: "low", label: "low" },
              { id: "high", label: "high" },
            ],
          },
        ],
      },
    });
  });
  it("matches provider-qualified IDs and Gemini resource names while preserving wire IDs", () => {
    expect(enrich("openai/gpt-test")).toMatchObject({ id: "openai/gpt-test", name: "GPT Test" });
    expect(enrich("models/gpt-test")).toMatchObject({ id: "models/gpt-test", name: "GPT Test" });
    expect(enrich("GPT-TEST").capabilities).toBeNull();
    expect(enrich("gpt-test-latest").capabilities).toBeNull();
    expect(enrich("unknown/gpt-test").capabilities).toBeNull();
  });
  it("preserves explicit upstream and manual values including false and empty option lists", () => {
    expect(
      enrichModelFromModelsDev(
        {
          id: "gpt-test",
          name: "My model",
          source: "manual",
          protocols: ["openai-chat"],
          capabilities: { contextWindow: 64000, supportsImages: false, optionDescriptors: [] },
          supportsTools: false,
          maxOutputTokens: 2000,
        },
        catalog,
        "https://proxy.test",
      ),
    ).toMatchObject({
      id: "gpt-test",
      name: "My model",
      source: "manual",
      protocols: ["openai-chat"],
      capabilities: { contextWindow: 64000, supportsImages: false, optionDescriptors: [] },
      supportsTools: false,
      maxOutputTokens: 2000,
    });
  });
  it("uses the canonical vendor over third-party copies and the actual host over the vendor", () => {
    const index = parseModelsDevCatalog({
      proxy: {
        api: "https://proxy.test/v1",
        models: { "gpt-test": { ...metadata, limit: { context: 32000 } } },
      },
      openai: { models: { "gpt-test": metadata } },
    });
    const model = { id: "gpt-test", capabilities: null };
    expect(
      enrichModelFromModelsDev(model, index, "https://other.test").capabilities?.contextWindow,
    ).toBe(128000);
    expect(
      enrichModelFromModelsDev(model, index, "https://proxy.test/v1").capabilities?.contextWindow,
    ).toBe(32000);
  });
  it("uses the declared input limit as the context window when it is below total context", () => {
    const index = parseModelsDevCatalog({
      openai: {
        models: {
          "gpt-split": { id: "gpt-split", limit: { context: 400000, input: 272000, output: 128000 } },
        },
      },
    });
    expect(
      enrichModelFromModelsDev({ id: "gpt-split", capabilities: null }, index, "https://proxy.test"),
    ).toMatchObject({ capabilities: { contextWindow: 272000 }, maxOutputTokens: 128000 });
  });
  it("ignores unused differences and prefers the first-party entry on official hosts", () => {
    const index = parseModelsDevCatalog({
      openai: {
        models: {
          "gpt-dated": { id: "gpt-dated", name: "GPT Dated", limit: { context: 400000 } },
        },
      },
      relay: {
        models: {
          "gpt-dated": {
            id: "gpt-dated",
            name: "Relay GPT",
            limit: { context: 128000 },
          },
        },
      },
      mirror: {
        models: {
          "gpt-dated": { id: "gpt-dated", name: "Relay GPT (mirror)", limit: { context: 128000 } },
        },
      },
    });
    const model = { id: "gpt-dated", capabilities: null };
    expect(
      enrichModelFromModelsDev(model, index, "https://api.openai.com/v1").capabilities
        ?.contextWindow,
    ).toBe(400000);
    const relayOnly = parseModelsDevCatalog({
      relay: { models: { same: { id: "same", name: "A", limit: { context: 128000 } } } },
      mirror: { models: { same: { id: "same", name: "B", limit: { context: 128000 } } } },
    });
    expect(
      enrichModelFromModelsDev({ id: "same", capabilities: null }, relayOnly, "https://proxy.test")
        .capabilities?.contextWindow,
    ).toBe(128000);
  });
  it("does not guess when exact IDs are ambiguous or metadata is malformed", () => {
    const index = parseModelsDevCatalog({
      a: { models: { common: { id: "common", limit: { context: 1000 } } } },
      b: { models: { common: { id: "common", limit: { context: 2000 } } } },
      c: {
        models: {
          invalid: {
            id: "invalid",
            limit: { context: -1, output: "4000" },
            modalities: { input: [null] },
            tool_call: "yes",
            reasoning: true,
          },
        },
      },
    });
    expect(
      enrichModelFromModelsDev({ id: "common", capabilities: null }, index, "https://proxy.test")
        .capabilities,
    ).toBeNull();
    const invalid = enrichModelFromModelsDev(
      { id: "invalid", capabilities: null },
      index,
      "https://proxy.test",
    );
    expect(invalid.capabilities).toBeNull();
    expect(invalid.supportsTools).toBeUndefined();
    expect(invalid.maxOutputTokens).toBeUndefined();
  });
  it.effect(
    "fetches the public catalog without credentials, refuses redirects and reuses its cache",
    () =>
      Effect.gen(function* () {
        let requests = 0;
        const http = HttpClient.make((request, _url, _signal, fiber) =>
          Effect.sync(() => {
            requests++;
            expect(request.url).toBe("https://models.dev/api.json");
            expect(request.headers.authorization).toBeUndefined();
            expect(request.headers["x-api-key"]).toBeUndefined();
            expect(
              Context.getOrUndefined(fiber.context, FetchHttpClient.RequestInit)?.redirect,
            ).toBe("manual");
            return HttpClientResponse.fromWeb(
              request,
              Response.json({ openai: { models: { "gpt-test": metadata } } }),
            );
          }),
        );
        const first = yield* fetchModelsDevCatalog.pipe(
          Effect.provideService(HttpClient.HttpClient, http),
        );
        const second = yield* fetchModelsDevCatalog.pipe(
          Effect.provideService(HttpClient.HttpClient, http),
        );
        expect(second).toBe(first);
        expect(requests).toBe(1);
      }),
  );
  it.effect("reports catalog failures without returning a partial catalog", () =>
    Effect.gen(function* () {
      const http = HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({}, { status: 302 }))),
      );
      const failure = yield* Effect.flip(
        fetchModelsDevCatalog.pipe(Effect.provideService(HttpClient.HttpClient, http)),
      );
      expect(failure.detail).toContain("models.dev");
    }),
  );
});

import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_MODEL_SERVICE_RECOVERY,
  ModelServiceRecovery,
  ModelServiceBaseUrl,
  ModelServiceConfig,
  ModelServiceId,
} from "./modelService.ts";
import { ProviderInstanceConfig } from "./providerInstance.ts";
import { ServerSettings } from "./settings.ts";

const decodeSettings = Schema.decodeSync(ServerSettings);
const decodeInstance = Schema.decodeSync(ProviderInstanceConfig);
const encodeInstance = Schema.encodeSync(ProviderInstanceConfig);
const decodeService = Schema.decodeSync(ModelServiceConfig);
const encodeService = Schema.encodeSync(ModelServiceConfig);
const decodeUnknownService = Schema.decodeUnknownSync(ModelServiceConfig);
const decodeUrl = Schema.decodeSync(ModelServiceBaseUrl);
const decodeId = Schema.decodeSync(ModelServiceId);

describe("model service contracts", () => {
  it("defaults recovery for existing services and validates bounded overrides", () => {
    const recovery = Schema.decodeUnknownSync(ModelServiceRecovery);
    expect(recovery({})).toEqual(DEFAULT_MODEL_SERVICE_RECOVERY);
    expect(DEFAULT_MODEL_SERVICE_RECOVERY).toEqual({
      retryEnabled: true,
      hedgeEnabled: true,
      respectRetryAfter: true,
      hedgeDelayMs: 15000,
      reasoningHedgeDelayMs: 45000,
      maxAttempts: 12,
      budgetMs: 180000,
      maxConcurrent: 2,
    });
    expect(
      recovery({ retryEnabled: false, hedgeEnabled: true, respectRetryAfter: false }).retryEnabled,
    ).toBe(false);
    for (const invalid of [
      { maxAttempts: 0 },
      { maxConcurrent: 5 },
      { hedgeDelayMs: -1 },
      { reasoningHedgeDelayMs: 0 },
      { budgetMs: 0 },
      { maxAttempts: 1.5 },
    ])
      expect(() => recovery(invalid)).toThrow();
    const service = decodeService({
      name: "Old service",
      baseUrl: "https://api.test",
      protocols: ["openai-chat"],
    });
    expect(service.recovery).toEqual(DEFAULT_MODEL_SERVICE_RECOVERY);
    expect(
      decodeService(
        encodeService({
          ...service,
          recovery: recovery({ respectRetryAfter: false, maxAttempts: 20 }),
        }),
      ).recovery,
    ).toMatchObject({ respectRetryAfter: false, maxAttempts: 20 });
  });
  it("retains multimodal metadata across settings serialization", () => {
    const service = decodeService({
      name: "Shared",
      baseUrl: "https://api.test",
      protocols: ["openai-chat"],
      models: [
        {
          id: "gpt-test",
          inputModalities: ["text", "image", "audio"],
          outputModalities: ["text"],
          supportsReasoning: true,
          supportsTools: false,
          capabilities: { contextWindow: 128000, supportsImages: true },
        },
      ],
    });
    expect(decodeService(encodeService(service))).toEqual(service);
    expect(service.models[0]?.inputModalities).toEqual(["text", "image", "audio"]);
  });
  it("keeps existing settings compatible and preserves exact model IDs in bindings", () => {
    expect(decodeSettings({}).modelServices).toEqual({});
    const instance = decodeInstance({
      driver: "codex",
      modelService: {
        serviceId: "shared",
        modelIds: ["Vendor/Exact"],
        defaultModel: "Vendor/Exact",
      },
    });
    expect(decodeInstance(encodeInstance(instance))).toEqual(instance);
    expect(instance.modelService?.modelIds).toEqual(["Vendor/Exact"]);
    expect(
      decodeService({
        name: "Shared",
        baseUrl: "https://api.test",
        protocols: ["openai-chat"],
      }),
    ).toMatchObject({ revision: 0, enabled: true, headers: {}, models: [] });
  });

  it("rejects unsafe URLs, empty protocol lists and path-like service IDs", () => {
    for (const url of [
      "file:///tmp/key",
      "https://user:secret@api.test",
      "https://api.test?key=secret",
      "https://api.test#fragment",
    ])
      expect(() => decodeUrl(url)).toThrow();
    expect(() => decodeId("../shared")).toThrow();
    expect(() =>
      decodeUnknownService({
        name: "Shared",
        baseUrl: "https://api.test",
        protocols: [],
      }),
    ).toThrow();
  });
});

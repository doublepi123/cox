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
const encodeSettings = Schema.encodeSync(ServerSettings);
const decodeInstance = Schema.decodeSync(ProviderInstanceConfig);
const encodeInstance = Schema.encodeSync(ProviderInstanceConfig);
const decodeService = Schema.decodeSync(ModelServiceConfig);
const encodeService = Schema.encodeSync(ModelServiceConfig);
const decodeUnknownService = Schema.decodeUnknownSync(ModelServiceConfig);
const decodeUrl = Schema.decodeSync(ModelServiceBaseUrl);
const decodeId = Schema.decodeSync(ModelServiceId);

describe("model service contracts", () => {
  it("keeps encrypted replay opt-in and round-trips service and model overrides", () => {
    const legacy = decodeService({
      name: "Old service",
      baseUrl: "https://models.test",
      protocols: ["openai-responses"],
      models: [{ id: "old" }],
    });
    expect(legacy.encryptedReasoningReplay).toBeUndefined();
    expect(legacy.models[0]?.encryptedReasoningReplay).toBeUndefined();
    for (const policy of ["preserve", "omit"] as const) {
      const service = decodeService({
        ...legacy,
        encryptedReasoningReplay: policy,
        models: [
          { id: "inherit" },
          { id: "keep", encryptedReasoningReplay: "preserve" },
          { id: "drop", encryptedReasoningReplay: "omit" },
        ],
      });
      expect(decodeService(encodeService(service))).toEqual(service);
      const id = ModelServiceId.make("shared");
      const settings = decodeSettings({ modelServices: { [id]: service } });
      expect(decodeSettings(encodeSettings(settings)).modelServices[id]).toEqual(service);
    }
    expect(() =>
      decodeUnknownService({ ...legacy, encryptedReasoningReplay: "automatic" }),
    ).toThrow();
    expect(() =>
      decodeUnknownService({ ...legacy, models: [{ id: "bad", encryptedReasoningReplay: true }] }),
    ).toThrow();
  });

  it("defaults recovery for existing services and validates bounded overrides", () => {
    const recovery = Schema.decodeUnknownSync(ModelServiceRecovery);
    expect(recovery({})).toEqual(DEFAULT_MODEL_SERVICE_RECOVERY);
    expect(DEFAULT_MODEL_SERVICE_RECOVERY).toEqual({
      retryEnabled: true,
      retryOn429: false,
      retryNonTransientErrors: false,
      retryToolRequests: false,
      hedgeEnabled: true,
      hedgeDelayMs: 30000,
      reasoningHedgeDelayMs: 60000,
      maxAttempts: 12,
      budgetMs: 600000,
      responseHeadersTimeoutMs: 300000,
      maxConcurrent: 5,
    });
    expect(recovery({ retryEnabled: false, hedgeEnabled: true }).retryEnabled).toBe(false);
    expect(recovery({ maxConcurrent: 10 }).maxConcurrent).toBe(10);
    for (const retryOn429 of [false, true]) {
      for (const respectRetryAfter of [false, true]) {
        const decoded = recovery({ retryOn429, respectRetryAfter });
        expect(decoded.retryOn429).toBe(retryOn429);
        expect(decoded).not.toHaveProperty("respectRetryAfter");
      }
    }
    for (const invalid of [
      { maxAttempts: 0 },
      { maxConcurrent: 11 },
      { hedgeDelayMs: -1 },
      { reasoningHedgeDelayMs: 0 },
      { budgetMs: 0 },
      { responseHeadersTimeoutMs: 0 },
      { responseHeadersTimeoutMs: 1800001 },
      { maxAttempts: 1.5 },
    ])
      expect(() => recovery(invalid)).toThrow();
    const service = decodeService({
      name: "Old service",
      baseUrl: "https://api.test",
      protocols: ["openai-chat"],
    });
    expect(service.recovery).toEqual(DEFAULT_MODEL_SERVICE_RECOVERY);
    expect(recovery({ hedgeDelayMs: 15000, reasoningHedgeDelayMs: 45000 })).toMatchObject({
      hedgeDelayMs: 15000,
      reasoningHedgeDelayMs: 45000,
      responseHeadersTimeoutMs: 300000,
    });
    expect(
      decodeService(
        encodeService({
          ...service,
          recovery: recovery({
            retryOn429: true,
            retryNonTransientErrors: true,
            retryToolRequests: true,
            maxAttempts: 20,
          }),
        }),
      ).recovery,
    ).toMatchObject({
      retryOn429: true,
      retryNonTransientErrors: true,
      retryToolRequests: true,
      maxAttempts: 20,
    });
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

import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { ModelServiceBaseUrl, ModelServiceConfig, ModelServiceId } from "./modelService.ts";
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

import {
  DEFAULT_SERVER_SETTINGS,
  ModelServiceConfig,
  ModelServiceId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { validateModelServiceBindings } from "./validation.ts";

const serviceId = ModelServiceId.make("omo-service");
const instanceId = ProviderInstanceId.make("omo-test");
const service = Schema.decodeSync(ModelServiceConfig)({
  name: "Models",
  baseUrl: "https://api.test/v1",
  protocols: ["openai-chat"],
  models: [
    { id: "Vendor/Exact" },
    { id: "other" },
    { id: "unavailable", available: false },
    { id: "ignored", ignored: true },
    { id: "no-tools", supportsTools: false },
    { id: "wrong-protocol", protocols: ["gemini"] },
  ],
});
function settings(config: unknown = {}): ServerSettings {
  return {
    ...DEFAULT_SERVER_SETTINGS,
    modelServices: { [serviceId]: service },
    providerInstances: {
      [instanceId]: {
        driver: ProviderDriverKind.make("omo"),
        modelService: { serviceId, modelIds: [] },
        config,
      },
    },
  };
}

describe("OMO model service validation", () => {
  it("accepts native defaults and valid custom role names in the same binding", () => {
    expect(
      validateModelServiceBindings(
        settings({
          agentModels: { oracle: "cox/Vendor/Exact", custom_role: "" },
          categoryModels: { "custom-category": "cox/other" },
        }),
      ),
    ).toBeNull();
  });
  it.each([
    "Vendor/Exact",
    "cox/missing",
    "cox/unavailable",
    "cox/ignored",
    "cox/no-tools",
    "cox/wrong-protocol",
  ])("rejects invalid bound role model %s", (slug) => {
    for (const field of ["agentModels", "categoryModels"])
      expect(validateModelServiceBindings(settings({ [field]: { oracle: slug } }))).toContain(
        "OMO role models",
      );
  });
  it("rejects a role outside the binding and blocks deletion of an explicit role reference", () => {
    const current = settings({ agentModels: { oracle: "cox/Vendor/Exact" } });
    const instance = current.providerInstances[instanceId]!;
    expect(
      validateModelServiceBindings({
        ...current,
        providerInstances: {
          [instanceId]: { ...instance, modelService: { serviceId, modelIds: ["other"] } },
        },
      }),
    ).toContain("OMO role models");
    expect(
      validateModelServiceBindings({
        ...current,
        modelServices: {
          [serviceId]: {
            ...service,
            models: service.models.filter((model) => model.id !== "Vendor/Exact"),
          },
        },
      }),
    ).toContain("OMO role models");
  });
  it("rejects invalid role names even for independent instances", () => {
    const current = settings({ agentModels: { "../oracle": "cox/Vendor/Exact" } });
    expect(
      validateModelServiceBindings({
        ...current,
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("omo"),
            config: current.providerInstances[instanceId]!.config,
          },
        },
      }),
    ).toContain("Role names");
  });
  it("rejects unavailable explicit main models without changing other providers", () => {
    const current = settings();
    const instance = current.providerInstances[instanceId]!;
    const modelService = { serviceId, modelIds: [], defaultModel: "unavailable" };
    expect(
      validateModelServiceBindings({
        ...current,
        providerInstances: { [instanceId]: { ...instance, modelService } },
      }),
    ).toContain("OMO default model");
    expect(
      validateModelServiceBindings({
        ...current,
        providerInstances: {
          [instanceId]: { ...instance, driver: ProviderDriverKind.make("pi"), modelService },
        },
      }),
    ).toBeNull();
  });
});

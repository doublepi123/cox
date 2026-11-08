import {
  ModelServiceConfig,
  ModelServiceId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelServiceBinding,
  type ModelServiceModel,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import { MODEL_SERVICE_AGENT_DRIVERS } from "@t3tools/shared/modelServices";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { modelRemovalBlockingAgents } from "./ModelServicesSettingsPanel.logic";

const serviceId = ModelServiceId.make("shared");
const instanceId = ProviderInstanceId.make("work");
const service = Schema.decodeSync(ModelServiceConfig)({
  name: "Shared",
  baseUrl: "https://models.test/v1",
  protocols: ["openai-chat"],
  models: [{ id: "remove" }, { id: "keep" }],
});
const instance = (binding: Partial<ModelServiceBinding> = {}): ProviderInstanceConfig => ({
  driver: ProviderDriverKind.make("codex"),
  displayName: "Work Agent",
  modelService: { serviceId, modelIds: [], ...binding },
});

describe("model removal binding protection", () => {
  it.each(MODEL_SERVICE_AGENT_DRIVERS)("protects explicit model selections for %s", (driver) => {
    expect(
      modelRemovalBlockingAgents(serviceId, service, "remove", {
        [instanceId]: {
          ...instance({ modelIds: ["remove", "keep"] }),
          driver: ProviderDriverKind.make(driver),
        },
      }),
    ).toEqual(["Work Agent"]);
  });

  it("protects a default model even when the agent uses all models", () => {
    expect(
      modelRemovalBlockingAgents(serviceId, service, "remove", {
        [instanceId]: instance({ defaultModel: "remove" }),
      }),
    ).toEqual(["Work Agent"]);
  });

  it("allows removing one model when an automatic binding retains a usable model", () => {
    expect(
      modelRemovalBlockingAgents(serviceId, service, "remove", {
        [instanceId]: instance({ defaultModel: "keep" }),
      }),
    ).toEqual([]);
  });

  it.each([
    { ignored: true },
    { available: false },
    { supportsTools: false },
    { protocols: ["gemini"] },
  ] satisfies ReadonlyArray<Partial<ModelServiceModel>>)(
    "does not leave an automatic binding with only unusable models: %j",
    (metadata) => {
      expect(
        modelRemovalBlockingAgents(
          serviceId,
          {
            ...service,
            models: [service.models[0]!, { id: "keep", capabilities: null, ...metadata }],
          },
          "remove",
          { [instanceId]: instance() },
        ),
      ).toEqual(["Work Agent"]);
    },
  );

  it("protects the last catalog entry of a bound service and falls back to the instance id", () => {
    expect(
      modelRemovalBlockingAgents(
        serviceId,
        { ...service, models: [{ id: "remove", ignored: true, capabilities: null }] },
        "remove",
        { [instanceId]: { ...instance(), displayName: undefined } },
      ),
    ).toEqual(["work"]);
  });

  it("ignores other services and preserves caller-owned configuration", () => {
    const instances = {
      [instanceId]: instance({ serviceId: ModelServiceId.make("other"), modelIds: ["remove"] }),
      [ProviderInstanceId.make("independent")]: { driver: ProviderDriverKind.make("claudeAgent") },
    };
    const original = structuredClone({ service, instances });
    expect(modelRemovalBlockingAgents(serviceId, service, "remove", instances)).toEqual([]);
    expect({ service, instances }).toEqual(original);
  });
});

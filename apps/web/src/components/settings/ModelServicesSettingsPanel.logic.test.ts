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
import {
  modelRemovalBlockingAgents,
  unlistedModelRemovalPlan,
} from "./ModelServicesSettingsPanel.logic";

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

describe("unlisted model cleanup", () => {
  const stale = {
    id: "stale",
    source: "discovered" as const,
    available: false,
    capabilities: null,
  };
  const anotherStale = { ...stale, id: "another-stale" };
  const active = {
    id: "active",
    source: "discovered" as const,
    available: true,
    capabilities: null,
  };

  it("only removes confirmed missing non-manual entries, including legacy and ignored entries", () => {
    const models: readonly ModelServiceModel[] = [
      active,
      stale,
      { ...stale, id: "manual", source: "manual" },
      { ...anotherStale, ignored: true },
      { id: "unknown", capabilities: null },
      { id: "legacy", available: false, capabilities: null },
    ];
    const plan = unlistedModelRemovalPlan(serviceId, { ...service, models }, {});
    expect(plan.removable.map((model) => model.id)).toEqual(["stale", "another-stale", "legacy"]);
    expect(plan.protected).toEqual([]);
    expect(models[1]).toBe(stale);
  });

  it.each(MODEL_SERVICE_AGENT_DRIVERS)(
    "keeps default and explicit selections for %s while cleaning other entries",
    (driver) => {
      const models = [active, stale, anotherStale, { ...stale, id: "free" }];
      const instances = {
        [instanceId]: {
          ...instance({ modelIds: ["stale", "active"], defaultModel: "active" }),
          driver: ProviderDriverKind.make(driver),
        },
        [ProviderInstanceId.make("default")]: instance({ defaultModel: "another-stale" }),
      };
      const original = structuredClone({ models, instances });
      const plan = unlistedModelRemovalPlan(serviceId, { ...service, models }, instances);
      expect(plan.removable.map((model) => model.id)).toEqual(["free"]);
      expect(plan.protected.map((model) => model.id)).toEqual(["stale", "another-stale"]);
      expect({ models, instances }).toEqual(original);
    },
  );

  it("protects the combined deletion from emptying an automatic agent binding", () => {
    const plan = unlistedModelRemovalPlan(
      serviceId,
      { ...service, models: [stale, anotherStale] },
      { [instanceId]: instance() },
    );
    expect(plan.removable).toEqual([]);
    expect(plan.protected).toEqual([stale, anotherStale]);
    expect(
      modelRemovalBlockingAgents(
        serviceId,
        { ...service, models: [stale, anotherStale] },
        stale.id,
        { [instanceId]: instance() },
      ),
    ).toEqual([]);
  });

  it("can empty an unbound service but never touches models from another service", () => {
    const plan = unlistedModelRemovalPlan(
      serviceId,
      { ...service, models: [stale, anotherStale] },
      { [instanceId]: instance({ serviceId: ModelServiceId.make("other"), modelIds: ["stale"] }) },
    );
    expect(plan.removable).toEqual([stale, anotherStale]);
    expect(plan.protected).toEqual([]);
  });

  it("does not offer cleanup for current or manual-only catalogs", () => {
    expect(
      unlistedModelRemovalPlan(
        serviceId,
        { ...service, models: [active, { ...stale, source: "manual" }] },
        { [instanceId]: instance() },
      ),
    ).toEqual({ removable: [], protected: [] });
  });
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

import { DEFAULT_SERVER_SETTINGS, ModelServiceConfig, ModelServiceId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { applyServerSettingsPatch } from "./serverSettings.ts";
import {
  boundModelServiceModels,
  modelServiceAgentCapabilities,
  modelServiceDisplayName,
  modelServiceProviderModels,
} from "./modelServices.ts";

const id = ModelServiceId.make("shared");
const other = ModelServiceId.make("other");
const service = Schema.decodeSync(ModelServiceConfig)({
  name: "Shared",
  baseUrl: "https://api.test",
  protocols: ["openai-chat"],
  models: [
    { id: "Vendor/Exact", capabilities: { contextWindow: 64000 } },
    { id: "embed", supportsTools: false },
    { id: "different", protocols: ["gemini"] },
  ],
});

describe("central model settings", () => {
  it("keeps ignored models out of agent bindings while preserving their configuration", () => {
    const config = {
      ...service,
      models: [...service.models, { id: "ignored", ignored: true, capabilities: null }],
    };
    expect(
      boundModelServiceModels(config, { serviceId: id, modelIds: [] }).some(
        (model) => model.id === "ignored",
      ),
    ).toBe(false);
    expect(config.models.some((model) => model.id === "ignored")).toBe(true);
  });
  it("retains OpenCode agent and variant descriptors when binding a model service", () => {
    const descriptors = [
      {
        id: "agent",
        label: "Agent",
        type: "select" as const,
        options: [{ id: "orchestrator", label: "Orchestrator", isDefault: true }],
        currentValue: "orchestrator",
      },
      {
        id: "variant",
        label: "Reasoning",
        type: "select" as const,
        options: [{ id: "high", label: "High" }],
      },
    ];
    expect(
      modelServiceAgentCapabilities("opencode", { optionDescriptors: descriptors })
        ?.optionDescriptors,
    ).toEqual(descriptors);
  });
  it("treats bound service models as an authoritative catalog, not user-added rows", () => {
    const models = modelServiceProviderModels(
      [
        { slug: "vendor/first", name: "First", capabilities: { contextWindow: 64000 } },
        "vendor/second",
      ],
      "vendor/second",
    );
    expect(models.map((model) => [model.slug, model.isCustom, model.isDefault])).toEqual([
      ["vendor/first", false, false],
      ["vendor/second", false, true],
    ]);
    expect(models[0]?.capabilities?.contextWindow).toBe(64000);
    expect(modelServiceProviderModels([])).toEqual([]);
    expect(modelServiceProviderModels(["first"], "missing")[0]?.isDefault).toBe(true);
  });

  it.each(["codex", "claudeAgent"])(
    "preserves declared service tiers beside reasoning for %s",
    (driver) => {
      const tiers = {
        id: "serviceTier",
        label: "Service Tier",
        type: "select" as const,
        currentValue: "default",
        options: [
          { id: "default", label: "Standard", isDefault: true },
          { id: "priority", label: "Fast" },
        ],
      };
      const fast = { id: "fastMode", label: "Fast Mode", type: "boolean" as const };
      expect(
        modelServiceAgentCapabilities(driver, {
          optionDescriptors: [
            {
              id: "reasoningEffort",
              label: "Reasoning",
              type: "select",
              options: [{ id: "ultra", label: "Ultra" }],
            },
            tiers,
            fast,
          ],
        })?.optionDescriptors,
      ).toEqual([
        {
          id: driver === "codex" ? "reasoningEffort" : "effort",
          label: "Reasoning",
          type: "select",
          options: [{ id: "ultra", label: "Ultra" }],
        },
        tiers,
        ...(driver === "claudeAgent" ? [fast] : []),
      ]);
      expect(
        modelServiceAgentCapabilities(driver, { optionDescriptors: [tiers] })?.optionDescriptors,
      ).toEqual([tiers]);
    },
  );
  it("formats familiar model names without changing unknown IDs or custom display names", () => {
    expect(modelServiceDisplayName("gpt-5.2-codex")).toBe("GPT-5.2 Codex");
    expect(modelServiceDisplayName("gemini-2.5-pro")).toBe("Gemini 2.5 Pro");
    expect(modelServiceDisplayName("anthropic/claude-sonnet-4.5")).toBe("Claude Sonnet 4.5");
    expect(modelServiceDisplayName("deepseek-v3")).toBe("DeepSeek V3");
    expect(modelServiceDisplayName("Vendor/Exact")).toBe("Vendor/Exact");
    expect(
      boundModelServiceModels(
        { ...service, models: [{ id: "gpt-5", name: "My name", capabilities: null }] },
        { serviceId: id, modelIds: [] },
      )[0]?.name,
    ).toBe("My name");
  });
  it("updates and deletes connections independently while advancing their revisions", () => {
    const initial = {
      ...DEFAULT_SERVER_SETTINGS,
      modelServices: { [id]: service, [other]: service },
    };
    const changed = applyServerSettingsPatch(initial, {
      modelServices: { [id]: { ...service, name: "Changed" } },
    });
    expect(changed.modelServices[id]).toMatchObject({ name: "Changed", revision: 1 });
    expect(changed.modelServices[other]).toBe(service);
    const removed = applyServerSettingsPatch(changed, { modelServices: { [id]: null } });
    expect(removed.modelServices[id]).toBeUndefined();
    expect(removed.modelServices[other]).toBe(service);
  });

  it("filters explicit incompatibilities while retaining models with unknown capabilities", () => {
    expect(
      boundModelServiceModels(service, { serviceId: id, modelIds: [] }).map((model) => model.id),
    ).toEqual(["Vendor/Exact"]);
    expect(boundModelServiceModels(service, { serviceId: id, modelIds: ["different"] })).toEqual(
      [],
    );
  });

  it("maps reported reasoning controls and adds Codex Ultra when max is supported", () => {
    const capabilities = {
      contextWindow: 64000,
      optionDescriptors: [
        {
          id: "reasoningEffort",
          label: "Reasoning",
          type: "select" as const,
          options: ["none", "high", "max", "unknown"].map((value) => ({ id: value, label: value })),
        },
      ],
    };
    expect(
      modelServiceAgentCapabilities("codex", capabilities)?.optionDescriptors?.[0],
    ).toMatchObject({
      id: "reasoningEffort",
      options: [{ id: "none" }, { id: "high" }, { id: "max" }, { id: "ultra" }, { id: "unknown" }],
    });
    expect(
      modelServiceAgentCapabilities("claudeAgent", capabilities)?.optionDescriptors?.[0],
    ).toMatchObject({ id: "effort", options: capabilities.optionDescriptors[0]!.options });
    expect(modelServiceAgentCapabilities("pi", capabilities)?.optionDescriptors?.[0]).toMatchObject(
      { id: "thinking", options: [{ id: "off" }, { id: "high" }, { id: "max" }] },
    );
    expect(modelServiceAgentCapabilities("codex", null)).toBeUndefined();
    expect(modelServiceAgentCapabilities("pi", { contextWindow: 64000 })).toEqual({
      contextWindow: 64000,
    });
  });

  it("preserves reported Codex Ultra metadata without adding duplicates", () => {
    const options = [
      { id: "max", label: "Maximum", description: "Maximum effort" },
      { id: "ultra", label: "Ultra", isDefault: true },
      { id: "vendor-effort", label: "Vendor effort" },
    ];
    expect(
      modelServiceAgentCapabilities("codex", {
        optionDescriptors: [{ id: "effort", label: "Effort", type: "select", options }],
      })?.optionDescriptors,
    ).toEqual([{ id: "reasoningEffort", label: "Reasoning", type: "select", options }]);
    expect(
      modelServiceAgentCapabilities("codex", {
        optionDescriptors: [
          { id: "reasoningEffort", label: "Reasoning", type: "select", options: [] },
        ],
      })?.optionDescriptors,
    ).toEqual([]);
  });

  it("exposes an independent Claude Ultracode workflow toggle for service models with xhigh", () => {
    const capabilities = {
      optionDescriptors: [
        {
          id: "reasoningEffort",
          label: "Reasoning",
          type: "select" as const,
          currentValue: "ultra",
          options: [
            { id: "high", label: "High" },
            { id: "xhigh", label: "Extra High" },
            { id: "max", label: "Maximum" },
            { id: "ultra", label: "Old Ultra", isDefault: true },
          ],
        },
      ],
    };
    const mapped = modelServiceAgentCapabilities("claudeAgent", capabilities);
    expect(mapped?.optionDescriptors?.[0]).toMatchObject({
      id: "effort",
      currentValue: "xhigh",
      options: [{ id: "high" }, { id: "xhigh", isDefault: true }, { id: "max" }],
    });
    expect(mapped?.optionDescriptors?.[1]).toEqual({
      id: "ultracode",
      label: "Ultracode",
      type: "boolean",
      currentValue: true,
    });
    expect(modelServiceAgentCapabilities("claudeAgent", mapped!)?.optionDescriptors).toEqual(
      mapped?.optionDescriptors,
    );
    expect(capabilities.optionDescriptors[0]?.currentValue).toBe("ultra");
    expect(capabilities.optionDescriptors[0]?.options.at(-1)?.id).toBe("ultra");
  });

  it("preserves Claude service reasoning choices, defaults and current values", () => {
    const options = [
      { id: "max", label: "Maximum", description: "Maximum effort" },
      { id: "ultra", label: "Ultra", isDefault: true },
      { id: "vendor-effort", label: "Vendor effort" },
    ];
    expect(
      modelServiceAgentCapabilities("claudeAgent", {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            currentValue: "ultra",
            options,
          },
        ],
      })?.optionDescriptors,
    ).toEqual([
      { id: "effort", label: "Reasoning", type: "select", currentValue: "ultra", options },
    ]);
    expect(
      modelServiceAgentCapabilities("claudeAgent", { optionDescriptors: [] })?.optionDescriptors,
    ).toEqual([]);
  });
});

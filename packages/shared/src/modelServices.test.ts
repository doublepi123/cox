import { DEFAULT_SERVER_SETTINGS, ModelServiceConfig, ModelServiceId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { applyServerSettingsPatch } from "./serverSettings.ts";
import {
  boundModelServiceModels,
  modelServiceAgentCapabilities,
  modelServiceDisplayName,
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

  it("maps only reported reasoning levels into each agent's supported controls", () => {
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
    ).toMatchObject({ id: "reasoningEffort", options: capabilities.optionDescriptors[0]!.options });
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

  it("preserves reported Codex reasoning levels without adding unreported levels", () => {
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

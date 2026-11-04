import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId, type ModelCapabilities } from "@t3tools/contracts";

import {
  applyClaudePromptEffortPrefix,
  buildExplicitProviderOptionSelectionsFromDescriptors,
  buildProviderOptionSelectionsFromDescriptors,
  createModelCapabilities,
  createModelSelection,
  getProviderOptionCurrentLabel,
  getProviderOptionDescriptors,
  mergeModelCapabilities,
  readCustomModelEntries,
  toCustomModelSetting,
  modelSelectionsEqual,
  withCodexUltraCapabilities,
} from "./model.ts";

const codexCaps: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "xhigh", label: "Extra High" },
        { id: "high", label: "High", isDefault: true },
      ],
      currentValue: "high",
    },
    {
      id: "fastMode",
      label: "Fast Mode",
      type: "boolean",
    },
  ],
});

describe("descriptor helpers", () => {
  it("restores legacy Claude Ultra selections as Ultracode instead of dropping them to a default", () => {
    const descriptors = getProviderOptionDescriptors({
      caps: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Reasoning",
            type: "select",
            options: [
              { id: "high", label: "High", isDefault: true },
              { id: "ultracode", label: "Ultracode" },
            ],
          },
        ],
      },
      selections: [{ id: "effort", value: "ultra" }],
    });
    expect(descriptors[0]?.currentValue).toBe("ultracode");
    expect(
      buildExplicitProviderOptionSelectionsFromDescriptors(descriptors, [
        { id: "effort", value: "ultra" },
      ]),
    ).toEqual([{ id: "effort", value: "ultracode" }]);
  });

  it("adds Codex Ultra after max without changing defaults, current values or unrelated controls", () => {
    const input: ModelCapabilities = {
      contextWindow: 64000,
      optionDescriptors: [
        {
          id: "reasoningEffort",
          label: "Reasoning",
          type: "select",
          currentValue: "max",
          options: [
            { id: "low", label: "Low" },
            { id: "max", label: "Maximum", isDefault: true, description: "Kept" },
            { id: "vendor", label: "Vendor" },
          ],
        },
        { id: "fastMode", label: "Fast", type: "boolean", currentValue: false },
      ],
    };
    const output = withCodexUltraCapabilities(input);
    const effort = output.optionDescriptors?.[0];
    expect(effort).toMatchObject({ id: "reasoningEffort", currentValue: "max" });
    expect(effort?.type === "select" ? effort.options : []).toEqual([
      { id: "low", label: "Low" },
      { id: "max", label: "Maximum", isDefault: true, description: "Kept" },
      { id: "ultra", label: "Ultra", description: "Enable Codex Ultra mode" },
      { id: "vendor", label: "Vendor" },
    ]);
    expect(output.optionDescriptors?.[1]).toBe(input.optionDescriptors?.[1]);
    expect(input.optionDescriptors?.[0]).not.toEqual(effort);
    expect(withCodexUltraCapabilities(output)).toBe(output);
  });

  it("does not add Ultra to an undeclared maximum or duplicate an explicitly configured Ultra", () => {
    for (const options of [
      [],
      [{ id: "high", label: "High" }],
      [{ id: "ultra", label: "Custom Ultra", isDefault: true }],
    ]) {
      const input: ModelCapabilities = {
        optionDescriptors: [{ id: "reasoningEffort", label: "Reasoning", type: "select", options }],
      };
      expect(withCodexUltraCapabilities(input)).toBe(input);
    }
    const input: ModelCapabilities = {
      optionDescriptors: [
        { id: "effort", label: "Effort", type: "select", options: [{ id: "max", label: "Max" }] },
      ],
    };
    expect(withCodexUltraCapabilities(input)).toBe(input);
    expect(withCodexUltraCapabilities(null)).toBeNull();
  });

  it("builds dispatch options only from explicit selections", () => {
    const descriptors = getProviderOptionDescriptors({
      caps: codexCaps,
      selections: [{ id: "fastMode", value: true }],
    });

    expect(buildExplicitProviderOptionSelectionsFromDescriptors(descriptors, undefined)).toBe(
      undefined,
    );
    expect(
      buildExplicitProviderOptionSelectionsFromDescriptors(descriptors, [
        { id: "fastMode", value: true },
      ]),
    ).toEqual([{ id: "fastMode", value: true }]);
  });

  it("compares complete model selections independent of option ordering", () => {
    const left = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: true },
    ]);
    const reordered = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
      { id: "fastMode", value: true },
      { id: "reasoningEffort", value: "high" },
    ]);

    expect(modelSelectionsEqual(left, reordered)).toBe(true);
    expect(
      modelSelectionsEqual(left, {
        ...reordered,
        options: [
          { id: "fastMode", value: true },
          { id: "reasoningEffort", value: "medium" },
        ],
      }),
    ).toBe(false);
    expect(modelSelectionsEqual(left, { ...reordered, model: "gpt-5.5" })).toBe(false);
  });
});

describe("applyClaudePromptEffortPrefix", () => {
  it("keeps slash commands intact when ultrathink is selected", () => {
    expect(applyClaudePromptEffortPrefix("/compact", "ultrathink")).toBe("/compact");
    expect(applyClaudePromptEffortPrefix(" /compact keep recent errors ", "ultrathink")).toBe(
      "/compact keep recent errors",
    );
    expect(applyClaudePromptEffortPrefix(" /review src/model.ts ", "ultrathink")).toBe(
      "/review src/model.ts",
    );
    expect(applyClaudePromptEffortPrefix("/security-review", "ultrathink")).toBe(
      "/security-review",
    );
    expect(applyClaudePromptEffortPrefix("/plugin:skill run", "ultrathink")).toBe(
      "/plugin:skill run",
    );
    expect(applyClaudePromptEffortPrefix("/deploy.prod to staging", "ultrathink")).toBe(
      "/deploy.prod to staging",
    );
  });

  it("still adds the ultrathink prefix to ordinary prompts", () => {
    expect(applyClaudePromptEffortPrefix("Investigate this failure", "ultrathink")).toBe(
      "Ultrathink:\nInvestigate this failure",
    );
    expect(applyClaudePromptEffortPrefix("/home/theo/app.ts crashed on load", "ultrathink")).toBe(
      "Ultrathink:\n/home/theo/app.ts crashed on load",
    );
  });
});

describe("readCustomModelEntries", () => {
  it("preserves context-only and explicit false multimodal capabilities through serialization", () => {
    const saved = { slug: "custom", capabilities: { contextWindow: 32000, supportsImages: false } };
    const entry = readCustomModelEntries([saved])[0]!;
    expect(toCustomModelSetting(entry)).toEqual(saved);
  });
  const capabilities: ModelCapabilities = {
    optionDescriptors: [
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [{ id: "high", label: "High", isDefault: true }],
        currentValue: "high",
      },
    ],
  };

  it("resolves bare slugs and entries, trimming and deduplicating on slug", () => {
    expect(
      readCustomModelEntries([
        " bare ",
        { slug: "named", name: " Named ", capabilities },
        "bare",
        { slug: "named", name: "Second" },
        "",
        { name: "no slug" },
        42,
      ]),
    ).toEqual([
      { slug: "bare", name: "bare", capabilities: null },
      { slug: "named", name: "Named", capabilities },
    ]);
  });

  it("drops unparseable capabilities but keeps the entry", () => {
    expect(
      readCustomModelEntries([{ slug: "x", capabilities: { optionDescriptors: "nope" } }]),
    ).toEqual([{ slug: "x", name: "x", capabilities: null }]);
    expect(readCustomModelEntries("not a list")).toEqual([]);
  });

  it("treats a saved empty option list as unset and drops it on the next save", () => {
    const [legacy, contextOnly] = readCustomModelEntries([
      { slug: "legacy", capabilities: { optionDescriptors: [] } },
      { slug: "context", capabilities: { contextWindow: 64000, optionDescriptors: [] } },
    ]);
    expect(legacy).toEqual({ slug: "legacy", name: "legacy", capabilities: null });
    expect(contextOnly).toEqual({
      slug: "context",
      name: "context",
      capabilities: { contextWindow: 64000 },
    });
    expect(toCustomModelSetting(legacy!)).toBe("legacy");
  });
});

describe("mergeModelCapabilities", () => {
  it("replaces only the fields saved capabilities set", () => {
    expect(mergeModelCapabilities(codexCaps, null)).toBe(codexCaps);
    expect(mergeModelCapabilities(codexCaps, { optionDescriptors: [] })).toBe(codexCaps);
    expect(mergeModelCapabilities(codexCaps, { contextWindow: 400000 })).toEqual({
      ...codexCaps,
      contextWindow: 400000,
    });
    const fastMode = { id: "fastMode", label: "Fast Mode", type: "boolean" as const };
    expect(mergeModelCapabilities(codexCaps, { optionDescriptors: [fastMode] })).toEqual({
      optionDescriptors: [fastMode],
    });
    expect(mergeModelCapabilities(null, { optionDescriptors: [] })).toBeNull();
  });
});

describe("provider-reported option display", () => {
  const selection = createModelSelection(ProviderInstanceId.make("opencode"), "ling");
  const reported = { ...selection, options: [{ id: "variant", value: "default" }] };
  const descriptor = {
    id: "variant",
    label: "Reasoning",
    type: "select" as const,
    options: [
      { id: "none", label: "None" },
      { id: "thinking", label: "Thinking" },
    ],
  };

  it("shows explicit reports without adding a choice or a dispatch option", () => {
    expect(getProviderOptionCurrentLabel(descriptor, selection, reported)).toBe("Default");
    expect(
      getProviderOptionCurrentLabel(descriptor, selection, {
        ...reported,
        options: [{ id: "variant", value: "thinking" }],
      }),
    ).toBe("Thinking");
    expect(
      getProviderOptionCurrentLabel(
        { ...descriptor, currentValue: "none" },
        { ...selection, options: [{ id: "variant", value: "none" }] },
        reported,
      ),
    ).toBe("None");
    expect(descriptor.options.map((option) => option.id)).toEqual(["none", "thinking"]);
    expect(buildProviderOptionSelectionsFromDescriptors([descriptor])).toBeUndefined();
    expect(getProviderOptionCurrentLabel(descriptor, selection)).toBe("Unknown");
    const effortDescriptor = { ...descriptor, id: "effort", currentValue: "default" };
    expect(getProviderOptionCurrentLabel(effortDescriptor, selection)).toBeUndefined();
    expect(
      getProviderOptionCurrentLabel(effortDescriptor, selection, {
        ...reported,
        model: "other",
        options: [{ id: "effort", value: "default" }],
      }),
    ).toBeUndefined();
    expect(
      getProviderOptionCurrentLabel(effortDescriptor, selection, {
        ...reported,
        options: [{ id: "effort", value: "default" }],
      }),
    ).toBe("Default");
    expect(
      getProviderOptionCurrentLabel({ ...descriptor, currentValue: "thinking" }, selection),
    ).toBe("Unknown");
  });

  it.each([
    { ...selection, model: "other" },
    { ...selection, instanceId: ProviderInstanceId.make("other") },
    { ...selection, options: [{ id: "variant", value: "none" }] },
  ])("ignores reports after changing the model, instance, or option: %j", (selected) => {
    expect(getProviderOptionCurrentLabel(descriptor, selected, reported)).toBe("Unknown");
  });
});

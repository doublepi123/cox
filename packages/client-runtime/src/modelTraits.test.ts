import { ProviderDriverKind, type ProviderOptionDescriptor } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildTraitsTriggerDisplay,
  getDescriptorStringValue,
  getTraitSelectChange,
} from "./modelTraits.ts";

describe("buildTraitsTriggerDisplay", () => {
  it.each([
    { currentValue: undefined, defaultValue: undefined, value: null, label: "Thinking" },
    { currentValue: undefined, defaultValue: "high", value: "high", label: "High" },
    { currentValue: "low", defaultValue: undefined, value: "low", label: "Low" },
    { currentValue: "max", defaultValue: "high", value: "max", label: "Max" },
    { id: "effort", currentValue: undefined, defaultValue: undefined, value: null, label: "" },
  ])("labels Pi thinking without inventing a selection: $label ($value)", (input) => {
    const descriptor: Extract<ProviderOptionDescriptor, { type: "select" }> = {
      id: input.id ?? "thinking",
      label: "Thinking",
      type: "select",
      options: ["low", "high", "max"].map((id) => ({
        id,
        label: id[0]!.toUpperCase() + id.slice(1),
        ...(id === input.defaultValue ? { isDefault: true } : {}),
      })),
      ...(input.currentValue ? { currentValue: input.currentValue } : {}),
    };

    expect(
      buildTraitsTriggerDisplay({
        provider: ProviderDriverKind.make("pi"),
        descriptors: [descriptor],
        primarySelectDescriptorId: descriptor.id,
        ultrathinkPromptControlled: false,
      }).label,
    ).toBe(input.label);
    expect(getDescriptorStringValue(descriptor)).toBe(input.value);
  });
});

const speed: Extract<ProviderOptionDescriptor, { type: "select" }> = {
  id: "serviceTier",
  label: "Service Tier",
  type: "select",
  currentValue: "priority",
  options: [
    { id: "default", label: "Standard", isDefault: true },
    { id: "priority", label: "Fast" },
    { id: "ultrafast", label: "Ultrafast" },
  ],
};
const reasoning: Extract<ProviderOptionDescriptor, { type: "select" }> = {
  id: "effort",
  label: "Reasoning",
  type: "select",
  currentValue: "ultra",
  options: [{ id: "ultra", label: "Ultra" }],
};

describe("model traits speed controls", () => {
  it.each(["codex", "claudeAgent"])("displays service speed beside reasoning for %s", (kind) => {
    const input = {
      provider: ProviderDriverKind.make(kind),
      primarySelectDescriptorId: "effort",
      ultrathinkPromptControlled: false,
    };
    expect(buildTraitsTriggerDisplay({ ...input, descriptors: [reasoning, speed] })).toEqual({
      label: "Ultra Fast",
      speedLabel: "Fast",
      otherLabels: [],
      ultracode: false,
    });
    expect(
      buildTraitsTriggerDisplay({
        ...input,
        descriptors: [reasoning, { ...speed, currentValue: "default" }],
      }),
    ).toEqual({ label: "Ultra", speedLabel: null, otherLabels: [], ultracode: false });
    expect(
      buildTraitsTriggerDisplay({
        ...input,
        descriptors: [reasoning, { ...speed, currentValue: "ultrafast" }],
      }),
    ).toEqual({
      label: "Ultra Ultrafast",
      speedLabel: "Ultrafast",
      otherLabels: [],
      ultracode: false,
    });
  });

  it("keeps effort when changing the service tier", () => {
    expect(
      getTraitSelectChange(
        {
          descriptors: [reasoning, speed],
          primarySelectDescriptor: reasoning,
          ultrathinkPromptControlled: false,
          ultrathinkInBodyText: false,
        },
        speed,
        "Keep my prompt",
        "default",
      ),
    ).toEqual({
      prompt: "Keep my prompt",
      modelOptions: [
        { id: "effort", value: "ultra" },
        { id: "serviceTier", value: "default" },
      ],
    });
  });
});

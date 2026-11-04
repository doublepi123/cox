import { ProviderDriverKind, type ProviderOptionDescriptor } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildTraitsTriggerDisplay, getTraitSelectChange } from "./modelTraits.ts";

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
    });
    expect(
      buildTraitsTriggerDisplay({
        ...input,
        descriptors: [reasoning, { ...speed, currentValue: "default" }],
      }),
    ).toEqual({ label: "Ultra", speedLabel: null, otherLabels: [] });
    expect(
      buildTraitsTriggerDisplay({
        ...input,
        descriptors: [reasoning, { ...speed, currentValue: "ultrafast" }],
      }),
    ).toEqual({ label: "Ultra Ultrafast", speedLabel: "Ultrafast", otherLabels: [] });
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

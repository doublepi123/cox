import { describe, expect, it } from "vite-plus/test";
import { omoModelReasoningLevels } from "./omoRecommendations.ts";

describe("OMO reasoning choices", () => {
  it("normalizes off, removes unsupported values and retains catalog order", () => {
    expect(
      omoModelReasoningLevels({
        capabilities: {
          optionDescriptors: [
            {
              id: "reasoningEffort",
              label: "Reasoning",
              type: "select",
              options: ["none", "high", "ultra", "max", "high"].map((id) => ({ id, label: id })),
            },
          ],
        },
      }),
    ).toEqual(["off", "high", "max"]);
  });

  it("keeps unknown or explicitly unsupported reasoning on the model default", () => {
    expect(omoModelReasoningLevels({ capabilities: null })).toEqual([]);
    expect(
      omoModelReasoningLevels({
        supportsReasoning: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "thinking",
              label: "Thinking",
              type: "select",
              options: [{ id: "high", label: "High" }],
            },
          ],
        },
      }),
    ).toEqual([]);
  });
});

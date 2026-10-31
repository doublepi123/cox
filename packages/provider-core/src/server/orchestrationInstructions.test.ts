import { assert, describe, it } from "@effect/vitest";
import {
  T3_CODE_ORCHESTRATION_INSTRUCTIONS,
  t3AcpPromptWithInstructions,
  t3OrchestrationPrompt,
  t3OrchestrationSystemPrompt,
} from "./orchestrationInstructions.ts";

describe("local agent instructions", () => {
  it("advertises only the available local tool surface", () => {
    assert.equal(t3OrchestrationSystemPrompt(true), T3_CODE_ORCHESTRATION_INSTRUCTIONS);
    assert.isUndefined(t3OrchestrationSystemPrompt(false));
    assert.notInclude(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "t3_environment_link");
    assert.notInclude(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "device_open");
    const first = t3OrchestrationPrompt({
      prompt: "Inspect this project.",
      hasT3Mcp: true,
      orchestrationDelivered: false,
    });
    assert.include(first, "Inspect this project.");
    assert.include(first, T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim());
    assert.equal(
      t3OrchestrationPrompt({ prompt: "Continue.", hasT3Mcp: true, orchestrationDelivered: true }),
      "Continue.",
    );
    assert.equal(
      t3OrchestrationPrompt({
        prompt: "Continue.",
        hasT3Mcp: false,
        orchestrationDelivered: false,
      }),
      "Continue.",
    );
  });

  it("refreshes ACP context when local tool availability or interaction mode changes", () => {
    const state = { interactionMode: "default", hasT3Mcp: true } as const;
    const first = t3AcpPromptWithInstructions({ prompt: "Inspect the project.", state });
    assert.include(first, T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim());
    assert.notInclude(first, "ELECTRON_RUN_AS_NODE");
    assert.equal(
      t3AcpPromptWithInstructions({ prompt: "Again.", state, previousState: state }),
      "Again.",
    );
    const plan = t3AcpPromptWithInstructions({
      prompt: "Plan the change.",
      state: { ...state, interactionMode: "plan" },
      previousState: state,
    });
    assert.include(plan, "interaction mode: Plan");
    const noTools = t3AcpPromptWithInstructions({
      prompt: "Inspect locally.",
      state: { ...state, hasT3Mcp: false },
      previousState: state,
    });
    assert.notInclude(noTools, T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim());
    assert.equal(t3AcpPromptWithInstructions({ prompt: "/compact", state }), "/compact");
  });
});

import { assert, describe, it } from "@effect/vitest";
import {
  T3_CODE_ORCHESTRATION_INSTRUCTIONS,
  T3_CODE_ORCHESTRATION_SECTIONS,
  OMO_CODE_ORCHESTRATION_INSTRUCTIONS,
  t3AcpPromptWithInstructions,
  t3OrchestrationPrompt,
  t3OrchestrationSystemPrompt,
} from "./orchestrationInstructions.ts";

describe("local agent instructions", () => {
  it("prefers each provider's native subagents without turning background work or a different child model into cross-provider delegation", () => {
    assert.include(
      T3_CODE_ORCHESTRATION_INSTRUCTIONS,
      "prefer your own available native subagent tools",
    );
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "Pi without a subagent extension");
    assert.include(
      T3_CODE_ORCHESTRATION_INSTRUCTIONS,
      "a different child model or native background task alone does not require Cox delegation",
    );
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "never silently switch to Cox delegation");
    assert.notInclude(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "it finishes in this turn");
    for (const section of T3_CODE_ORCHESTRATION_SECTIONS)
      assert.isBelow(Buffer.byteLength(section), 4000);
    const prompt = t3AcpPromptWithInstructions({
      prompt: "Use subagents in parallel",
      state: { interactionMode: "default", hasT3Mcp: true },
    });
    assert.include(prompt, "prefer your own available native subagent tools");
  });

  it("gives OMO its configured native task roles and never a hidden Cox fallback", () => {
    assert.include(OMO_CODE_ORCHESTRATION_INSTRUCTIONS, "OMO's native `task`");
    for (const role of ["atlas", "explore", "oracle"])
      assert.include(OMO_CODE_ORCHESTRATION_INSTRUCTIONS, role);
    assert.include(OMO_CODE_ORCHESTRATION_INSTRUCTIONS, "including native background work");
    assert.include(OMO_CODE_ORCHESTRATION_INSTRUCTIONS, "report its original error");
    assert.include(
      OMO_CODE_ORCHESTRATION_INSTRUCTIONS,
      "Never silently retry it as a Cox delegate",
    );
  });
  it("advertises only the available local tool surface", () => {
    assert.equal(t3OrchestrationSystemPrompt(true), T3_CODE_ORCHESTRATION_INSTRUCTIONS);
    assert.isUndefined(t3OrchestrationSystemPrompt(false));
    assert.notInclude(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "cox_environment_link");
    assert.notInclude(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "device_open");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "cox_thread_move");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "preserves its ID and history");
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

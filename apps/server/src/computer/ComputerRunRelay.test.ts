import { describe, expect, it } from "vite-plus/test";
import { OrchestrationV2RunStatus } from "@t3tools/contracts";
import { runStatusComputerState } from "./ComputerRunRelay.ts";

describe("computer run relay", () => {
  it.each([
    ["completed", "completed"],
    ["failed", "failed"],
    ["interrupted", "stopped"],
    ["cancelled", "stopped"],
    ["rolled_back", "stopped"],
    ["running", undefined],
    ["waiting", undefined],
  ] as const)("maps run status %s to %s", (status, state) => {
    expect(runStatusComputerState(status)).toBe(state);
  });

  it("maps every run status", () => {
    for (const status of OrchestrationV2RunStatus.literals) runStatusComputerState(status);
  });
});

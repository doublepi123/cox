import { expect, it } from "@effect/vitest";
import { TRIAGE_PLAYBOOK, buildTriageAppPrompt, buildTriageSeedPrompt } from "./triagePrompt.ts";
it("keeps diagnostics local and protects the live installation", () => {
  expect(TRIAGE_PLAYBOOK).toContain("Do not clone upstream source");
  expect(TRIAGE_PLAYBOOK).toContain("~/.t3");
  expect(buildTriageAppPrompt("/tmp/context.md")).toContain("context.md");
  expect(
    buildTriageSeedPrompt({
      contextFilePath: "/tmp/context.md",
      entry: { kind: "app", client: "browser" },
    }),
  ).toContain("/tmp/context.md");
});

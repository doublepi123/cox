import { expect, it } from "vite-plus/test";
import { buildPrContentPrompt } from "@t3tools/provider-core/server/textGenerationPrompts";

import { conventionalCommitsTextGenerationPolicy } from "./TextGenerationPresets.ts";

it("asks for a Conventional Commit title when the listed commits use that style", () => {
  const { prompt } = buildPrContentPrompt({
    baseBranch: "main",
    headBranch: "recorder",
    commitSummary: "feat(web): add a recorder",
    diffSummary: "Add the recorder UI",
    diffPatch: "",
    policy: conventionalCommitsTextGenerationPolicy,
  });

  expect(prompt).toContain("When the listed commits use Conventional Commits, write the title as a Conventional Commit subject too");
});

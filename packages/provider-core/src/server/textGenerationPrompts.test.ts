import { describe, expect, it } from "vite-plus/test";

import { normalizeCliError } from "./textGenerationUtils.ts";
import { buildThreadTitlePrompt } from "./textGenerationPrompts.ts";

describe("buildThreadTitlePrompt", () => {
  it("names the project to omit when generating or revising a title", () => {
    for (const previousTitle of [undefined, "Login failure"]) {
      const { prompt } = buildThreadTitlePrompt({
        message: "Fix login",
        projectTitle: "Sandbox",
        previousTitle,
      });
      expect(prompt).toContain('Omit the project name ("Sandbox")');
    }
  });

  it("prioritizes custom title instructions over generic length and format rules", () => {
    for (const previousTitle of [undefined, "Login failure"]) {
      const { prompt } = buildThreadTitlePrompt({
        message: "Fix the login failure",
        previousTitle,
        instructions: "Use Chinese and prefix every title with the team name.",
      });
      expect(prompt).toContain("Title instructions from the user:\nUse Chinese");
      expect(prompt).toContain("including on length and format, they win");
      expect(prompt).not.toContain("fewer than 40 characters");
    }
  });

  it("keeps the default limits for missing or blank title instructions", () => {
    for (const previousTitle of [undefined, "Login failure"]) {
      for (const instructions of [undefined, " "]) {
        const { prompt } = buildThreadTitlePrompt({
          message: "Fix login",
          previousTitle,
          instructions,
        });
        expect(prompt).toContain("3-8 words, fewer than 40 characters.");
        expect(prompt).not.toContain("Title instructions from the user:");
      }
    }
  });
});

describe("normalizeCliError", () => {
  it("does not expose CLI failure details in the public error message", () => {
    const result = normalizeCliError(
      "codex",
      "generateCommitMessage",
      new Error("request failed with access_token=secret-token"),
      "Failed to generate a commit message",
    );

    expect(result.detail).toBe("Failed to generate a commit message");
    expect(result.message).not.toContain("secret-token");
  });
});

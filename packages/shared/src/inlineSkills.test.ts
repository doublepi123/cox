import { describe, expect, it } from "vite-plus/test";

import { formatProviderSkillDisplayName } from "./inlineSkills.ts";

describe("formatProviderSkillDisplayName", () => {
  it.each(["code-review", "t3:foo"])("preserves %s without a display name", (name) => {
    expect(formatProviderSkillDisplayName({ name })).toBe(name);
  });

  it("prefers the trimmed provider display name", () => {
    expect(
      formatProviderSkillDisplayName({ name: "code-review", displayName: " Review changes " }),
    ).toBe("Review changes");
  });
});

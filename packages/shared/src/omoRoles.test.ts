import { describe, expect, it } from "vite-plus/test";

import {
  OMO_MAIN_AGENT_CHAIN,
  OMO_NATIVE_AGENT_ROLES,
  OMO_NATIVE_CATEGORY_ROLES,
  omoRoleInfo,
  officialOmoAssignment,
  type OmoCatalogModel,
  type OmoRoleInfo,
} from "./omoRoles.ts";

function roleNamed(kind: "agent" | "category", name: string): OmoRoleInfo {
  const role = omoRoleInfo(kind, name);
  if (!role) throw new Error(`missing ${kind} role ${name}`);
  return role;
}

describe("officialOmoAssignment", () => {
  const catalog: ReadonlyArray<OmoCatalogModel> = [
    { slug: "cox/gpt-6.1-sol", reasoningLevels: ["off", "low", "medium", "high"] },
    { slug: "cox/deepseek-v4.1-flash", reasoningLevels: ["off", "high"] },
    { slug: "cox/gpt-6-luna", reasoningLevels: ["low"] },
  ];

  it("matches a catalog slug exactly and keeps the rung reasoning when supported", () => {
    expect(officialOmoAssignment(roleNamed("category", "deep-low"), catalog)).toEqual({
      model: "cox/gpt-6.1-sol",
      reasoning: "medium",
    });
  });

  it("normalizes dots to dashes in both the rung id and the catalog slug", () => {
    expect(
      officialOmoAssignment(
        [{ model: "gpt-6.1-sol", reasoning: "low" }],
        [{ slug: "cox/gpt-6-1-sol", reasoningLevels: ["low"] }],
      ),
    ).toEqual({ model: "cox/gpt-6-1-sol", reasoning: "low" });
  });

  it("falls back to the id without -fast when the exact id is missing", () => {
    expect(
      officialOmoAssignment([{ model: "gpt-6.1-sol-fast", reasoning: "medium" }], catalog),
    ).toEqual({ model: "cox/gpt-6.1-sol", reasoning: "medium" });
  });

  it("matches deepseek-flash through the deepseek-v4.1-flash alias", () => {
    expect(officialOmoAssignment([{ model: "deepseek-flash", reasoning: "off" }], catalog)).toEqual(
      { model: "cox/deepseek-v4.1-flash", reasoning: "off" },
    );
  });

  it("snaps unsupported reasoning to the nearest supported level, ties going higher", () => {
    expect(
      officialOmoAssignment(
        [{ model: "gpt-6-luna", reasoning: "max" }],
        [{ slug: "cox/gpt-6-luna", reasoningLevels: ["low", "high"] }],
      ),
    ).toEqual({ model: "cox/gpt-6-luna", reasoning: "high" });
    expect(
      officialOmoAssignment(
        [{ model: "gpt-6-luna", reasoning: "medium" }],
        [{ slug: "cox/gpt-6-luna", reasoningLevels: ["low", "high"] }],
      ),
    ).toEqual({ model: "cox/gpt-6-luna", reasoning: "high" });
  });

  it("returns an empty reasoning when the model lists no reasoning levels", () => {
    expect(
      officialOmoAssignment(
        [{ model: "gpt-6-luna", reasoning: "low" }],
        [{ slug: "cox/gpt-6-luna" }],
      ),
    ).toEqual({ model: "cox/gpt-6-luna", reasoning: "" });
  });

  it("returns undefined when no rung matches the catalog", () => {
    expect(
      officialOmoAssignment(roleNamed("agent", "explore"), [{ slug: "cox/glm-5.3" }]),
    ).toBeUndefined();
  });

  it("resolves the deep category name to the deep-low info", () => {
    expect(omoRoleInfo("category", "deep")).toBe(omoRoleInfo("category", "deep-low"));
    expect(omoRoleInfo("category", "deep")?.name).toBe("deep-low");
  });
});

describe("OMO Native role catalog", () => {
  it("keeps the official main-agent and role chains non-empty", () => {
    expect(OMO_MAIN_AGENT_CHAIN.length).toBeGreaterThan(0);
    expect(OMO_NATIVE_AGENT_ROLES.every((role) => role.officialChain.length > 0)).toBe(true);
    expect(OMO_NATIVE_CATEGORY_ROLES.every((role) => role.officialChain.length > 0)).toBe(true);
  });
});

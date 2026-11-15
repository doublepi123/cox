import { describe, expect, it } from "vite-plus/test";
import { parseOmpDiscoveredCommands, withOmpBuiltinSlashCommands } from "./commands.ts";

describe("parseOmpDiscoveredCommands", () => {
  it("splits native commands into slash commands and skills", () => {
    const discovered = parseOmpDiscoveredCommands({
      commands: [
        { name: "review", description: "Review the diff", source: "extension" },
        {
          name: "skill:ship",
          description: "Ship it",
          source: "skill",
          location: "project",
          path: "/repo/.omp/skills/ship.md",
        },
        { name: "skill:global-guide", source: "skill", location: "user" },
        { name: "skill:", source: "skill" },
        { name: 7, source: "skill" },
      ],
    });
    expect(discovered.slashCommands).toEqual([{ name: "review", description: "Review the diff" }]);
    expect(discovered.skills).toEqual([
      {
        name: "ship",
        path: "/repo/.omp/skills/ship.md",
        enabled: true,
        description: "Ship it",
        scope: "project",
      },
      { name: "global-guide", path: "omp:skill:global-guide", enabled: true, scope: "user" },
    ]);
  });

  it("normalizes legacy scopes onto Cox scopes", () => {
    const discovered = parseOmpDiscoveredCommands({
      commands: [{ name: "skill:legacy", source: "skill", location: "workspace" }],
    });
    expect(discovered.skills[0]?.scope).toBe("project");
  });

  it("returns empty catalogs for malformed payloads", () => {
    expect(parseOmpDiscoveredCommands(undefined)).toEqual({ slashCommands: [], skills: [] });
    expect(parseOmpDiscoveredCommands({ commands: "nope" })).toEqual({
      slashCommands: [],
      skills: [],
    });
  });

  it("advertises the native /compact builtin exactly once", () => {
    expect(withOmpBuiltinSlashCommands([])).toEqual([
      {
        name: "compact",
        description: "Summarize the conversation and reduce context usage",
        input: { hint: "Optional instructions" },
      },
    ]);
    expect(withOmpBuiltinSlashCommands([{ name: "compact", description: "Overridden" }])).toEqual([
      {
        name: "compact",
        description: "Summarize the conversation and reduce context usage",
        input: { hint: "Optional instructions" },
      },
    ]);
  });
});

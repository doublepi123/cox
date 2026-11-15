import { type ServerProviderSkill, type ServerProviderSlashCommand } from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";

const OMP_COMPACT_SLASH_COMMAND: ServerProviderSlashCommand = {
  name: "compact",
  description: "Summarize the conversation and reduce context usage",
  input: { hint: "Optional instructions" },
};

export interface OmpDiscoveredCommands {
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
}

function recordField(input: unknown, key: string): unknown {
  return Predicate.isObject(input) ? input[key] : undefined;
}

function recordString(input: unknown, key: string): string | undefined {
  const value = recordField(input, key);
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function withOmpBuiltinSlashCommands(
  commands: ReadonlyArray<ServerProviderSlashCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  return [OMP_COMPACT_SLASH_COMMAND, ...commands.filter((command) => command.name !== "compact")];
}

function normalizeOmpSkillScope(scope: string | undefined): string | undefined {
  if (scope === undefined) return undefined;
  const normalized = scope.trim().toLowerCase();
  if (normalized === "global" || normalized === "personal") return "user";
  if (normalized === "workspace" || normalized === "local") return "project";
  return scope;
}

export function parseOmpDiscoveredCommands(data: unknown): OmpDiscoveredCommands {
  const commands = recordField(data, "commands");
  if (!Array.isArray(commands)) return { slashCommands: [], skills: [] };
  const slashCommands: Array<ServerProviderSlashCommand> = [];
  const skills: Array<ServerProviderSkill> = [];
  for (const command of commands) {
    const commandName = recordString(command, "name");
    if (commandName === undefined) continue;
    const description = recordString(command, "description");
    if (recordString(command, "source") === "skill") {
      const name = commandName.startsWith("skill:")
        ? commandName.slice("skill:".length)
        : commandName;
      if (name.length === 0) continue;
      const path = recordString(command, "path") ?? `omp:skill:${name}`;
      const scope = normalizeOmpSkillScope(recordString(command, "location"));
      skills.push({
        name,
        path,
        enabled: true,
        ...(description === undefined ? {} : { description }),
        ...(scope === undefined ? {} : { scope }),
      });
      continue;
    }
    slashCommands.push({
      name: commandName,
      ...(description === undefined ? {} : { description }),
    });
  }
  return { slashCommands, skills };
}

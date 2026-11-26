import type { ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { parse as parseYamlDocument } from "yaml";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const MAX_SKILL_BYTES = 1_000_000;

interface SkillRoot {
  readonly directory: string;
  readonly scope: "project" | "user";
}

function frontmatterFlag(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized === "true" ? true : normalized === "false" ? false : undefined;
}

export function parseDshSkill(
  contents: string,
  path: string,
  scope: SkillRoot["scope"],
): ServerProviderSkill | undefined {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) return undefined;
  let parsed: unknown;
  try {
    parsed = parseYamlDocument(match[1] ?? "");
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const description = typeof record.description === "string" ? record.description.trim() : "";
  if (!name || !description || /\s/u.test(name)) return undefined;
  const userInvocable = frontmatterFlag(record["user-invocable"]);
  return {
    name,
    description,
    path,
    scope,
    enabled: true,
    ...(frontmatterFlag(record["disable-model-invocation"]) === true
      ? { userInvocationOnly: true }
      : {}),
    ...(userInvocable === false ? { userInvocable: false } : {}),
  };
}

const projectRoot = Effect.fn("dshProjectRoot")(function* (cwd: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (let directory = path.resolve(cwd); ; directory = path.dirname(directory)) {
    if (
      yield* fileSystem.exists(path.join(directory, ".git")).pipe(Effect.orElseSucceed(() => false))
    )
      return directory;
    if (path.dirname(directory) === directory) return path.resolve(cwd);
  }
});

export const dshSkillRoots = Effect.fn("dshSkillRoots")(function* (
  cwd: string,
  environment: NodeJS.ProcessEnv,
  homeDirectory: string,
) {
  const path = yield* Path.Path;
  const project = yield* projectRoot(cwd);
  const home = (value: string | undefined, fallback: string) =>
    expandHomePath(value?.trim() || path.join(homeDirectory, fallback), homeDirectory);
  return [
    { directory: path.join(project, ".dsh", "skills"), scope: "project" },
    { directory: path.join(project, ".agents", "skills"), scope: "project" },
    { directory: path.join(home(environment.DSH_HOME, ".dsh"), "skills"), scope: "user" },
    { directory: path.join(home(environment.DSH_AGENTS_HOME, ".agents"), "skills"), scope: "user" },
  ] satisfies ReadonlyArray<SkillRoot>;
});

const readSkill = Effect.fn("readDshSkill")(function* (file: string, scope: SkillRoot["scope"]) {
  const fileSystem = yield* FileSystem.FileSystem;
  const info = yield* fileSystem.stat(file);
  if (info.type !== "File" || Number(info.size) > MAX_SKILL_BYTES) return undefined;
  return parseDshSkill(yield* fileSystem.readFileString(file), file, scope);
});

export const discoverDshSkills = Effect.fn("discoverDshSkills")(function* (
  cwd: string,
  environment: NodeJS.ProcessEnv,
  homeDirectory: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skills = new Map<string, ServerProviderSkill>();
  for (const root of yield* dshSkillRoots(cwd, environment, homeDirectory)) {
    const entries = yield* fileSystem
      .readDirectory(root.directory)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    for (const entry of [...entries].sort()) {
      if (entry.startsWith(".")) continue;
      const candidate = path.join(root.directory, entry);
      const file = entry.endsWith(".md") ? candidate : path.join(candidate, "SKILL.md");
      const skill = yield* readSkill(file, root.scope).pipe(Effect.orElseSucceed(() => undefined));
      if (skill !== undefined && !skills.has(skill.name)) skills.set(skill.name, skill);
    }
  }
  return [...skills.values()].sort((left, right) => left.name.localeCompare(right.name));
});

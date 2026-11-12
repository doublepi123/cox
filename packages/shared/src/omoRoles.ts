import { OMO_REASONING_LEVELS, type OmoReasoningLevel } from "@t3tools/contracts";

export type OmoRoleKind = "agent" | "category";

export interface OmoRoleRung {
  readonly model: string;
  readonly reasoning?: OmoReasoningLevel;
}

export interface OmoRoleInfo {
  readonly name: string;
  readonly kind: OmoRoleKind;
  readonly title: string;
  readonly summary: string;
  readonly modelGuidance: string;
  readonly usage: "frequent" | "occasional" | "rare";
  readonly officialChain: ReadonlyArray<OmoRoleRung>;
}

export interface OmoCatalogModel {
  readonly slug: string;
  readonly reasoningLevels?: ReadonlyArray<OmoReasoningLevel>;
}

export interface OmoOfficialAssignment {
  readonly model: string;
  readonly reasoning: OmoReasoningLevel | "";
}

const OMO_MODEL_ALIASES: Readonly<Partial<Record<string, ReadonlyArray<string>>>> = {
  "deepseek-flash": ["deepseek-v4-1-flash", "deepseek-v4-flash"],
};

export const OMO_NATIVE_AGENT_ROLES: ReadonlyArray<OmoRoleInfo> = [
  {
    name: "explore",
    kind: "agent",
    title: "Codebase search",
    summary: "Finds where things live in a codebase and which file holds a given behavior.",
    modelGuidance:
      "Needs speed more than intelligence; a small fast model fits, and large flagship models waste cost.",
    usage: "frequent",
    officialChain: [
      { model: "kimi-for-coding-highspeed", reasoning: "off" },
      { model: "gpt-6-luna-fast", reasoning: "low" },
      { model: "claude-haiku-5-5", reasoning: "medium" },
      { model: "deepseek-flash", reasoning: "max" },
      { model: "qwen3.7-plus" },
      { model: "minimax-m2.7" },
    ],
  },
  {
    name: "librarian",
    kind: "agent",
    title: "External research",
    summary:
      "Researches multiple repositories, remote codebases, official documentation and implementation examples.",
    modelGuidance:
      "Needs speed more than intelligence; a small fast model fits, and large flagship models waste cost.",
    usage: "occasional",
    officialChain: [
      { model: "kimi-for-coding-highspeed", reasoning: "off" },
      { model: "gpt-6-luna-fast", reasoning: "low" },
      { model: "claude-haiku-5-5", reasoning: "medium" },
      { model: "deepseek-flash", reasoning: "max" },
      { model: "qwen3.7-plus" },
      { model: "minimax-m2.7" },
    ],
  },
  {
    name: "plan-consultant",
    kind: "agent",
    title: "Pre-planning consultant",
    summary:
      "Identifies hidden intentions, ambiguities and likely AI failure points before planning; runs once per plan.",
    modelGuidance:
      "Needs strong reasoning; use a top-tier reasoning model, since weak reasoning misses hidden requirements.",
    usage: "rare",
    officialChain: [
      { model: "claude-fable-5-2", reasoning: "max" },
      { model: "claude-fable-5-1", reasoning: "max" },
      { model: "claude-opus-5-5", reasoning: "max" },
      { model: "kimi-k3.1-pro", reasoning: "max" },
      { model: "kimi-k3", reasoning: "max" },
    ],
  },
  {
    name: "plan-reviewer",
    kind: "agent",
    title: "Plan review",
    summary:
      "Reviews work plans for clarity, verifiability and completeness; runs once per review round.",
    modelGuidance:
      "Must not be a small model; use a strong reasoning model that can spot gaps and unverifiable steps.",
    usage: "occasional",
    officialChain: [
      { model: "gpt-6-astra", reasoning: "xhigh" },
      { model: "claude-opus-5-5", reasoning: "max" },
      { model: "gemini-4-argon", reasoning: "high" },
      { model: "gemini-3.1-pro", reasoning: "high" },
      { model: "glm-5.2" },
    ],
  },
];

export const OMO_NATIVE_CATEGORY_ROLES: ReadonlyArray<OmoRoleInfo> = [
  {
    name: "visual-engineering",
    kind: "category",
    title: "Visual engineering",
    summary:
      "Handles visual design, UI and UX, frontend work, styling, animation and design systems.",
    modelGuidance:
      "Needs strong frontend and design judgment; must not be a utility or search model.",
    usage: "occasional",
    officialChain: [
      { model: "gemini-4-argon", reasoning: "low" },
      { model: "claude-fable-5-2", reasoning: "max" },
      { model: "claude-fable-5-1", reasoning: "max" },
      { model: "claude-opus-5-5", reasoning: "max" },
      { model: "kimi-k3.1-pro", reasoning: "max" },
    ],
  },
  {
    name: "architect",
    kind: "category",
    title: "Architecture",
    summary:
      "Handles big-picture system design and broad debugging across many sources; implements when needed.",
    modelGuidance:
      "Needs top-tier reasoning across many sources; use the strongest available model.",
    usage: "rare",
    officialChain: [
      { model: "claude-fable-5-2", reasoning: "max" },
      { model: "claude-fable-5-1", reasoning: "max" },
    ],
  },
  {
    name: "ultrabrain",
    kind: "category",
    title: "Hard logic tasks",
    summary: "Used only for genuinely hard, logic-heavy tasks with clear goals.",
    modelGuidance:
      "Use the strongest reasoning model; this lane is built for GPT-style autonomous work.",
    usage: "rare",
    officialChain: [
      { model: "gpt-6-astra", reasoning: "max" },
      { model: "gpt-5.6-sol", reasoning: "max" },
    ],
  },
  {
    name: "deep-low",
    kind: "category",
    title: "Deep work",
    summary:
      "The default deep lane for one goal and one deliverable, with decisions settled from evidence; covers backend, algorithms and browser or computer use.",
    modelGuidance:
      "Built for GPT-style autonomous work; use a capable coding model with sustained reasoning.",
    usage: "frequent",
    officialChain: [
      { model: "gpt-6.1-sol", reasoning: "medium" },
      { model: "gpt-6.1-sol-fast", reasoning: "medium" },
      { model: "gpt-5.6-sol", reasoning: "medium" },
      { model: "gpt-5.6-sol-fast", reasoning: "medium" },
    ],
  },
  {
    name: "deep-high",
    kind: "category",
    title: "Deep escalation",
    summary: "The escalation deep lane for a central decision that evidence alone cannot settle.",
    modelGuidance: "Use the strongest GPT-style autonomous model for a difficult central decision.",
    usage: "rare",
    officialChain: [{ model: "gpt-6-astra", reasoning: "high" }],
  },
  {
    name: "artistry",
    kind: "category",
    title: "Creative problem solving",
    summary: "Handles unconventional, creative problem solving and design.",
    modelGuidance:
      "Use a model with flexible thinking that can still implement the result practically.",
    usage: "rare",
    officialChain: [
      { model: "claude-fable-5-2", reasoning: "max" },
      { model: "claude-fable-5-1", reasoning: "max" },
      { model: "claude-opus-5-5", reasoning: "max" },
      { model: "kimi-k3.1-pro", reasoning: "max" },
    ],
  },
  {
    name: "quick",
    kind: "category",
    title: "Quick edits",
    summary: "Handles trivial tasks such as single-file changes and typo fixes.",
    modelGuidance: "Use a small, fast model; avoid heavyweight reasoning models for simple edits.",
    usage: "frequent",
    officialChain: [
      { model: "gpt-6-luna-fast", reasoning: "low" },
      { model: "claude-haiku-5-5", reasoning: "medium" },
      { model: "deepseek-flash", reasoning: "off" },
      { model: "qwen3.6-flash", reasoning: "low" },
      { model: "minimax-m3" },
      { model: "minimax-m2.7" },
      { model: "grok-4.20-0309-non-reasoning" },
      { model: "glm-5.3-flash", reasoning: "low" },
      { model: "mimo-v2.6-flash", reasoning: "low" },
    ],
  },
  {
    name: "unspecified-low",
    kind: "category",
    title: "General low effort",
    summary: "Handles general low-complexity work that fits no other category.",
    modelGuidance:
      "Use an efficient model with adequate instruction following and coding ability; keep heavyweight reasoning for harder tasks.",
    usage: "frequent",
    officialChain: [
      { model: "claude-sonnet-5-5", reasoning: "medium" },
      { model: "mimo-v2.6-pro", reasoning: "high" },
      { model: "grok-4.7", reasoning: "xhigh" },
      { model: "glm-5.3", reasoning: "high" },
      { model: "gpt-6.1-sol", reasoning: "medium" },
      { model: "gpt-5.6-sol", reasoning: "medium" },
      { model: "claude-sonnet-5", reasoning: "low" },
      { model: "qwen3.8-max-preview", reasoning: "high" },
      { model: "deepseek-v4-pro", reasoning: "max" },
      { model: "mimo-v2.5-pro", reasoning: "high" },
    ],
  },
  {
    name: "unspecified-high",
    kind: "category",
    title: "General high effort",
    summary: "Handles general high-complexity work that fits no other category.",
    modelGuidance:
      "Use a strong reasoning and coding model that executes reliably on unfamiliar tasks.",
    usage: "occasional",
    officialChain: [
      { model: "claude-opus-5-5", reasoning: "medium" },
      { model: "glm-5.3", reasoning: "max" },
      { model: "kimi-k3.1-pro", reasoning: "max" },
    ],
  },
  {
    name: "writing",
    kind: "category",
    title: "Writing",
    summary: "Handles documentation, technical writing and prose editing.",
    modelGuidance:
      "Use a model with strong clarity and structure; coding strength alone is not enough.",
    usage: "occasional",
    officialChain: [
      { model: "gemini-4-argon", reasoning: "low" },
      { model: "claude-opus-5-5", reasoning: "low" },
      { model: "claude-opus-4-6", reasoning: "max" },
    ],
  },
];

export const OMO_MAIN_AGENT_CHAIN: ReadonlyArray<OmoRoleRung> = [
  { model: "claude-opus-5-5", reasoning: "medium" },
  { model: "kimi-k3.1-pro", reasoning: "max" },
  { model: "glm-5.3", reasoning: "max" },
];

export const OMO_LEGACY_AGENT_NAMES: ReadonlyArray<string> = [
  "sisyphus",
  "hephaestus",
  "oracle",
  "prometheus",
  "metis",
  "momus",
  "atlas",
  "multimodal-looker",
];

export function omoRoleInfo(kind: OmoRoleKind, name: string): OmoRoleInfo | undefined {
  if (kind === "agent") return OMO_NATIVE_AGENT_ROLES.find((role) => role.name === name);
  const canonicalName = name === "deep" ? "deep-low" : name;
  return OMO_NATIVE_CATEGORY_ROLES.find((role) => role.name === canonicalName);
}

function normalizeOmoModelId(id: string): string {
  return id
    .slice(id.lastIndexOf("/") + 1)
    .toLowerCase()
    .replaceAll(".", "-");
}

function indexCatalog(
  models: ReadonlyArray<OmoCatalogModel>,
): ReadonlyMap<string, OmoCatalogModel> {
  const byId = new Map<string, OmoCatalogModel>();
  for (const model of models) {
    const key = normalizeOmoModelId(model.slug);
    if (!byId.has(key)) byId.set(key, model);
  }
  return byId;
}

function firstCatalogMatch(
  ids: ReadonlyArray<string>,
  byId: ReadonlyMap<string, OmoCatalogModel>,
): OmoCatalogModel | undefined {
  for (const id of ids) {
    const model = byId.get(id);
    if (model) return model;
  }
  return undefined;
}

function candidateIds(id: string): ReadonlyArray<string> {
  return [id, ...(OMO_MODEL_ALIASES[id] ?? [])];
}

function findRungModel(
  rungModel: string,
  byId: ReadonlyMap<string, OmoCatalogModel>,
): OmoCatalogModel | undefined {
  const id = normalizeOmoModelId(rungModel);
  const exact = firstCatalogMatch(candidateIds(id), byId);
  if (exact || !id.endsWith("-fast")) return exact;
  return firstCatalogMatch(candidateIds(id.slice(0, -"-fast".length)), byId);
}

function reasoningIndex(level: OmoReasoningLevel): number {
  return OMO_REASONING_LEVELS.indexOf(level);
}

function nearestSupportedReasoning(
  target: OmoReasoningLevel,
  supported: ReadonlyArray<OmoReasoningLevel>,
): OmoReasoningLevel {
  const targetIndex = reasoningIndex(target);
  return supported.reduce((best, level) => {
    const distance = Math.abs(reasoningIndex(level) - targetIndex);
    const bestDistance = Math.abs(reasoningIndex(best) - targetIndex);
    if (distance < bestDistance) return level;
    if (distance === bestDistance && reasoningIndex(level) > reasoningIndex(best)) return level;
    return best;
  });
}

function assignedReasoning(rung: OmoRoleRung, model: OmoCatalogModel): OmoReasoningLevel | "" {
  const supported = model.reasoningLevels ?? [];
  if (!rung.reasoning || supported.length === 0) return "";
  if (supported.includes(rung.reasoning)) return rung.reasoning;
  return nearestSupportedReasoning(rung.reasoning, supported);
}

export function officialOmoAssignment(
  role: OmoRoleInfo | ReadonlyArray<OmoRoleRung>,
  models: ReadonlyArray<OmoCatalogModel>,
): OmoOfficialAssignment | undefined {
  const chain = "officialChain" in role ? role.officialChain : role;
  const byId = indexCatalog(models);
  for (const rung of chain) {
    const model = findRungModel(rung.model, byId);
    if (model) return { model: model.slug, reasoning: assignedReasoning(rung, model) };
  }
  return undefined;
}

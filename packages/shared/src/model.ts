import {
  type CustomModelSetting,
  MODEL_SLUG_ALIASES_BY_PROVIDER,
  ModelCapabilities,
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { copySorted } from "./Array.ts";

const DEFAULT_PROVIDER_DRIVER_KIND = ProviderDriverKind.make("codex");

export function modelSelectionCommandType(
  currentInstanceId: ProviderInstanceId,
  selection: ModelSelection,
) {
  return currentInstanceId === selection.instanceId
    ? ("thread.model-selection.set" as const)
    : ("provider.switch" as const);
}

export interface SelectableModelOption {
  slug: string;
  name: string;
  aliases?: ReadonlyArray<string> | undefined;
}

export function createModelCapabilities(input: ModelCapabilities): ModelCapabilities {
  return {
    ...input,
    ...(input.optionDescriptors
      ? { optionDescriptors: input.optionDescriptors.map(cloneDescriptor) }
      : {}),
  };
}

export function withCodexUltraCapabilities(capabilities: ModelCapabilities): ModelCapabilities;
export function withCodexUltraCapabilities(
  capabilities: ModelCapabilities | null,
): ModelCapabilities | null;
export function withCodexUltraCapabilities(
  capabilities: ModelCapabilities | null,
): ModelCapabilities | null {
  const descriptors = capabilities?.optionDescriptors;
  if (!descriptors) return capabilities;
  const effort = descriptors.find(
    (descriptor) => descriptor.id === "reasoningEffort" && descriptor.type === "select",
  );
  if (effort?.type !== "select" || effort.options.some((option) => option.id === "ultra")) {
    return capabilities;
  }
  const maxIndex = effort.options.findIndex((option) => option.id === "max");
  if (maxIndex === -1) return capabilities;
  return {
    ...capabilities,
    optionDescriptors: descriptors.map((descriptor) =>
      descriptor === effort
        ? {
            ...effort,
            options: [
              ...effort.options.slice(0, maxIndex + 1),
              { id: "ultra", label: "Ultra", description: "Enable Codex Ultra mode" },
              ...effort.options.slice(maxIndex + 1),
            ],
          }
        : descriptor,
    ),
  };
}

export function withClaudeUltracodeCapabilities(
  capabilities: ModelCapabilities | null,
): ModelCapabilities | null {
  const descriptors = capabilities?.optionDescriptors ?? [];
  const effortIndex = descriptors.findIndex(
    (descriptor) =>
      descriptor.id === "effort" &&
      descriptor.type === "select" &&
      descriptor.options.some((option) => option.id === "ultracode"),
  );
  const effort = descriptors[effortIndex];
  if (effort?.type !== "select") {
    if (
      descriptors.some(
        (descriptor) => descriptor.id === "ultracode" && descriptor.type === "boolean",
      )
    )
      return capabilities;
    return {
      ...capabilities,
      optionDescriptors: [...descriptors, { id: "ultracode", label: "Ultracode", type: "boolean" }],
    };
  }
  const ultracodeByDefault =
    (effort.currentValue ?? effort.options.find((option) => option.isDefault)?.id) === "ultracode";
  const hasXhigh = effort.options.some((option) => option.id === "xhigh");
  const options = effort.options.flatMap(({ isDefault, ...option }) => {
    if (option.id === "ultracode") {
      return hasXhigh
        ? []
        : [{ id: "xhigh", label: "Extra High", ...(isDefault ? { isDefault } : {}) }];
    }
    if (ultracodeByDefault && option.id === "xhigh") return [{ ...option, isDefault: true }];
    return [isDefault && !ultracodeByDefault ? { ...option, isDefault } : option];
  });
  return {
    ...capabilities,
    optionDescriptors: descriptors.toSpliced(
      effortIndex,
      1,
      {
        ...effort,
        ...(effort.currentValue === "ultracode" ? { currentValue: "xhigh" } : {}),
        options,
      },
      ...(descriptors.some(
        (descriptor) => descriptor.id === "ultracode" && descriptor.type === "boolean",
      )
        ? []
        : [
            {
              id: "ultracode",
              label: "Ultracode",
              type: "boolean" as const,
              ...(ultracodeByDefault ? { currentValue: true } : {}),
            },
          ]),
    ),
  };
}

function getRawSelectionValueById(
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
  id: string,
): string | boolean | undefined {
  const selection = selections?.find((candidate) => candidate.id === id);
  return selection?.value;
}

function getProviderOptionSelectionValue(
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
  id: string,
): string | boolean | undefined {
  return getRawSelectionValueById(selections, id);
}

function getProviderOptionStringSelectionValue(
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
  id: string,
): string | undefined {
  const value = getProviderOptionSelectionValue(selections, id);
  return typeof value === "string" ? value : undefined;
}

function getProviderOptionBooleanSelectionValue(
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
  id: string,
): boolean | undefined {
  const value = getProviderOptionSelectionValue(selections, id);
  return typeof value === "boolean" ? value : undefined;
}

export function getModelSelectionStringOptionValue(
  modelSelection: ModelSelection | null | undefined,
  id: string,
): string | undefined {
  return getProviderOptionStringSelectionValue(modelSelection?.options, id);
}

export function getModelSelectionBooleanOptionValue(
  modelSelection: ModelSelection | null | undefined,
  id: string,
): boolean | undefined {
  return getProviderOptionBooleanSelectionValue(modelSelection?.options, id);
}

function canonicalModelSelectionOptions(
  modelSelection: ModelSelection,
): ReadonlyArray<readonly [id: string, value: string | boolean]> {
  return copySorted(
    (modelSelection.options ?? []).map(
      (selection): readonly [id: string, value: string | boolean] => [
        selection.id,
        selection.value,
      ],
    ),
    (
      [leftId, leftValue]: readonly [id: string, value: string | boolean],
      [rightId, rightValue]: readonly [id: string, value: string | boolean],
    ) => {
      const idOrder = leftId.localeCompare(rightId);
      return idOrder !== 0 ? idOrder : String(leftValue).localeCompare(String(rightValue));
    },
  );
}

export function modelSelectionsEqual(left: ModelSelection, right: ModelSelection): boolean {
  if (left.instanceId !== right.instanceId || left.model !== right.model) {
    return false;
  }
  const leftOptions = canonicalModelSelectionOptions(left);
  const rightOptions = canonicalModelSelectionOptions(right);
  return (
    leftOptions.length === rightOptions.length &&
    leftOptions.every(
      ([id, value], index) => id === rightOptions[index]?.[0] && value === rightOptions[index]?.[1],
    )
  );
}

/**
 * Whether a composer's draft model pick is what the thread already runs. Web sends
 * `fastMode: false` for models with a fast toggle while mobile omits it, so off counts as unset.
 */
export function draftModelPickMatchesThread(pick: ModelSelection, thread: ModelSelection): boolean {
  const withoutFastModeOff = (selection: ModelSelection) =>
    createModelSelection(
      selection.instanceId,
      selection.model,
      selection.options?.filter((option) => option.id !== "fastMode" || option.value !== false),
    );
  return modelSelectionsEqual(withoutFastModeOff(pick), withoutFastModeOff(thread));
}

function resolveDescriptorChoiceValue(
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>,
  raw: string | null | undefined,
): string | undefined {
  const trimmed = trimOrNull(raw);
  if (!trimmed) {
    return descriptor.currentValue ?? descriptor.options.find((option) => option.isDefault)?.id;
  }
  if (descriptor.options.length === 0) {
    return trimmed;
  }
  if (
    descriptor.promptInjectedValues?.includes(trimmed) &&
    descriptor.options.some((option) => option.id === trimmed)
  ) {
    return descriptor.options.find((option) => option.isDefault)?.id;
  }
  if (descriptor.options.some((option) => option.id === trimmed)) {
    return trimmed;
  }
  if (
    descriptor.id === "effort" &&
    trimmed === "ultra" &&
    descriptor.options.some((option) => option.id === "ultracode")
  ) {
    return "ultracode";
  }
  return descriptor.currentValue ?? descriptor.options.find((option) => option.isDefault)?.id;
}

function cloneDescriptor(descriptor: ProviderOptionDescriptor): ProviderOptionDescriptor {
  return descriptor.type === "select"
    ? {
        ...descriptor,
        options: [...descriptor.options],
        ...(descriptor.promptInjectedValues
          ? { promptInjectedValues: [...descriptor.promptInjectedValues] }
          : {}),
      }
    : { ...descriptor };
}

function cloneSelection(selection: ProviderOptionSelection): ProviderOptionSelection {
  return { ...selection };
}

function withDescriptorCurrentValue(
  descriptor: ProviderOptionDescriptor,
  rawCurrentValue: string | boolean | undefined,
): ProviderOptionDescriptor {
  if (descriptor.type === "boolean") {
    if (typeof rawCurrentValue === "boolean") {
      return {
        ...descriptor,
        currentValue: rawCurrentValue,
      };
    }
    return descriptor;
  }
  const currentValue =
    typeof rawCurrentValue === "string"
      ? resolveDescriptorChoiceValue(descriptor, rawCurrentValue)
      : resolveDescriptorChoiceValue(descriptor, descriptor.currentValue);
  if (!currentValue) {
    const { currentValue: _unusedCurrentValue, ...rest } = descriptor;
    return rest;
  }
  return {
    ...descriptor,
    currentValue,
  };
}

export function withLegacyUltracodeEffort<
  Selections extends ReadonlyArray<ProviderOptionSelection> | null | undefined,
>(
  descriptors: ReadonlyArray<ProviderOptionDescriptor> | null | undefined,
  selections: Selections,
): Selections | Array<ProviderOptionSelection> {
  const effort = descriptors?.find(
    (descriptor) => descriptor.id === "effort" && descriptor.type === "select",
  );
  if (
    getRawSelectionValueById(selections, "effort") === "ultra" &&
    effort?.type === "select" &&
    effort.options.some((option) => option.id === "ultra")
  )
    return selections;
  if (
    !["ultracode", "ultra"].includes(String(getRawSelectionValueById(selections, "effort"))) ||
    !descriptors?.some(
      (descriptor) => descriptor.id === "ultracode" && descriptor.type === "boolean",
    )
  ) {
    return selections;
  }
  return [
    ...(selections ?? []).map((selection) =>
      selection.id === "effort" && ["ultracode", "ultra"].includes(String(selection.value))
        ? { id: "effort", value: "xhigh" }
        : selection,
    ),
    ...(getRawSelectionValueById(selections, "ultracode") === undefined
      ? [{ id: "ultracode", value: true }]
      : []),
  ];
}

export function getProviderOptionDescriptors(input: {
  caps: ModelCapabilities;
  selections?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
}): ReadonlyArray<ProviderOptionDescriptor> {
  const { caps } = input;
  const baseDescriptors = (caps.optionDescriptors ?? []).map(cloneDescriptor);
  const selections = withLegacyUltracodeEffort(baseDescriptors, input.selections);

  return baseDescriptors.map((descriptor) =>
    withDescriptorCurrentValue(
      descriptor,
      getRawSelectionValueById(selections, descriptor.id) ?? descriptor.currentValue,
    ),
  );
}

function getReportedOptionValue(
  id: string,
  selection?: ModelSelection | null,
  reportedSelection?: ModelSelection | null,
) {
  if (
    !selection ||
    !reportedSelection ||
    selection.instanceId !== reportedSelection.instanceId ||
    selection.model !== reportedSelection.model ||
    selection.options?.some((option) => option.id === id)
  )
    return undefined;
  return getRawSelectionValueById(reportedSelection.options, id);
}

export function getProviderOptionStatedValue(
  id: string,
  selection?: ModelSelection | null,
  reportedSelection?: ModelSelection | null,
) {
  return (
    getRawSelectionValueById(selection?.options, id) ??
    getReportedOptionValue(id, selection, reportedSelection)
  );
}

export function getProviderOptionCurrentValue(
  descriptor: ProviderOptionDescriptor | null | undefined,
  selection?: ModelSelection | null,
  reportedSelection?: ModelSelection | null,
): string | boolean | undefined {
  if (!descriptor) {
    return undefined;
  }
  const hasExplicitOption = selection?.options?.some((option) => option.id === descriptor.id);
  // Reported values are display-only; callers that build dispatch options omit this context.
  const reportedValue = getReportedOptionValue(descriptor.id, selection, reportedSelection);
  if (reportedValue !== undefined) return reportedValue;
  if (descriptor.id === "variant" && selection && !hasExplicitOption) return undefined;
  if (descriptor.type === "boolean") {
    return descriptor.currentValue;
  }
  if (descriptor.currentValue) {
    return descriptor.currentValue;
  }
  return descriptor.options.find((option) => option.isDefault)?.id;
}

export function getProviderOptionCurrentLabel(
  descriptor: ProviderOptionDescriptor | null | undefined,
  selection?: ModelSelection | null,
  reportedSelection?: ModelSelection | null,
): string | undefined {
  if (!descriptor) {
    return undefined;
  }
  if (descriptor.type === "boolean") {
    return typeof descriptor.currentValue === "boolean"
      ? descriptor.currentValue
        ? "On"
        : "Off"
      : undefined;
  }
  const currentValue = getProviderOptionCurrentValue(descriptor, selection, reportedSelection);
  return (
    descriptor.options.find((option) => option.id === currentValue)?.label ??
    (getReportedOptionValue(descriptor.id, selection, reportedSelection) === "default"
      ? "Default"
      : descriptor.id === "variant"
        ? "Unknown"
        : undefined)
  );
}

export function buildProviderOptionSelectionsFromDescriptors(
  descriptors: ReadonlyArray<ProviderOptionDescriptor> | null | undefined,
): Array<ProviderOptionSelection> | undefined {
  if (!descriptors || descriptors.length === 0) {
    return undefined;
  }

  const nextSelections: Array<ProviderOptionSelection> = [];

  for (const descriptor of descriptors) {
    const value = getProviderOptionCurrentValue(descriptor);
    if (typeof value === "string" || typeof value === "boolean") {
      nextSelections.push({ id: descriptor.id, value });
    }
  }

  return nextSelections.length > 0 ? nextSelections : undefined;
}

export function buildExplicitProviderOptionSelectionsFromDescriptors(
  descriptors: ReadonlyArray<ProviderOptionDescriptor> | null | undefined,
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): Array<ProviderOptionSelection> | undefined {
  if (!selections || selections.length === 0) {
    return undefined;
  }
  const explicitIds = new Set(
    withLegacyUltracodeEffort(descriptors, selections).map(({ id }) => id),
  );
  const normalized = buildProviderOptionSelectionsFromDescriptors(descriptors)?.filter(
    (selection) => explicitIds.has(selection.id),
  );
  return normalized && normalized.length > 0 ? normalized : undefined;
}

export function isClaudeUltrathinkPrompt(text: string | null | undefined): boolean {
  return typeof text === "string" && /\bultrathink\b/i.test(text);
}

export function codexModelFamily(slug: string): string {
  return slug.startsWith("openai.gpt-") ? slug.slice("openai.".length) : slug;
}

export function formatCodexModelName(name: string): string {
  return name.replace(/^gpt/i, "GPT").replace(/-([a-z])/g, (_, c) => "-" + c.toUpperCase());
}

export function formatModelSlugName(slug: string): string {
  const separator = slug.lastIndexOf("/") + 1;
  const prefix = slug.slice(0, separator);
  const name = slug.slice(separator);
  if (/^gpt-\d/i.test(name)) return prefix + formatCodexModelName(name);
  if (!/^(claude-(opus|sonnet|haiku|fable)|gemini|grok|composer)-\d/i.test(name)) return slug;
  return (
    prefix +
    name
      .replace(/^(claude-[a-z]+-\d+)-(\d{1,2})(?=-|\[|$)/i, "$1.$2")
      .split("-")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ")
  );
}

export function normalizeModelSlug(
  model: string | null | undefined,
  provider: ProviderDriverKind = DEFAULT_PROVIDER_DRIVER_KIND,
): string | null {
  const trimmed = normalizeCustomModelSlug(model);
  if (!trimmed) {
    return null;
  }

  const aliases = MODEL_SLUG_ALIASES_BY_PROVIDER[provider] ?? {};
  const aliased = Object.prototype.hasOwnProperty.call(aliases, trimmed)
    ? aliases[trimmed]
    : undefined;
  return typeof aliased === "string" ? aliased : trimmed;
}

/** Custom model identifiers are provider-owned, so only trim them; never expand aliases. */
export function normalizeCustomModelSlug(model: string | null | undefined): string | null {
  if (typeof model !== "string") {
    return null;
  }

  return model.trim() || null;
}

export interface CustomModelDefinition {
  readonly slug: string;
  readonly name: string;
  readonly capabilities: ModelCapabilities | null;
}

const decodeCustomModelCapabilities = Schema.decodeUnknownOption(ModelCapabilities);

/** Older settings stored `optionDescriptors: []` as a placeholder, so an empty list sets nothing. */
function savedModelCapabilities(capabilities: ModelCapabilities): ModelCapabilities | null {
  const saved: ModelCapabilities = {
    ...(capabilities.contextWindow === undefined
      ? {}
      : { contextWindow: capabilities.contextWindow }),
    ...(capabilities.supportsImages === undefined
      ? {}
      : { supportsImages: capabilities.supportsImages }),
    ...(capabilities.optionDescriptors?.length
      ? { optionDescriptors: capabilities.optionDescriptors }
      : {}),
  };
  return Object.keys(saved).length > 0 ? createModelCapabilities(saved) : null;
}

export function mergeModelCapabilities(
  base: ModelCapabilities | null,
  saved: ModelCapabilities | null,
): ModelCapabilities | null {
  const overrides = saved ? savedModelCapabilities(saved) : null;
  if (!overrides) return base;
  return base ? createModelCapabilities({ ...base, ...overrides }) : overrides;
}

export function readCustomModelEntries(value: unknown): CustomModelDefinition[] {
  if (!Array.isArray(value)) return [];
  const entries: CustomModelDefinition[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const record =
      typeof raw === "string"
        ? { slug: raw }
        : raw !== null && typeof raw === "object"
          ? (raw as { slug?: unknown; name?: unknown; capabilities?: unknown })
          : null;
    if (!record) continue;
    const slug = normalizeCustomModelSlug(typeof record.slug === "string" ? record.slug : null);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    const name =
      (typeof record.name === "string" ? normalizeCustomModelSlug(record.name) : null) ?? slug;
    const capabilities =
      record.capabilities === undefined || record.capabilities === null
        ? null
        : Option.getOrNull(decodeCustomModelCapabilities(record.capabilities));
    entries.push({
      slug,
      name,
      capabilities: capabilities ? savedModelCapabilities(capabilities) : null,
    });
  }
  return entries;
}

export function toCustomModelSetting(entry: CustomModelDefinition): CustomModelSetting {
  const descriptors = entry.capabilities?.optionDescriptors ?? [];
  const name = entry.name !== entry.slug ? entry.name : undefined;
  if (!name && descriptors.length === 0 && !entry.capabilities) return entry.slug;
  return {
    slug: entry.slug,
    ...(name ? { name } : {}),
    ...(entry.capabilities ? { capabilities: createModelCapabilities(entry.capabilities) } : {}),
  };
}

export function resolveSelectableModel(
  provider: ProviderDriverKind,
  value: string | null | undefined,
  options: ReadonlyArray<SelectableModelOption>,
): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const direct = options.find((option) => option.slug === trimmed);
  if (direct) {
    return direct.slug;
  }

  const byName = options.find((option) => option.name.toLowerCase() === trimmed.toLowerCase());
  if (byName) {
    return byName.slug;
  }

  const byAlias = options.find((option) =>
    option.aliases?.some((alias) => alias.toLowerCase() === trimmed.toLowerCase()),
  );
  if (byAlias) {
    return byAlias.slug;
  }

  const normalized = normalizeModelSlug(trimmed, provider);
  if (!normalized) {
    return null;
  }

  const resolved = options.find((option) => option.slug === normalized);
  return resolved ? resolved.slug : null;
}

function trimOrNull<T extends string>(value: T | null | undefined): T | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim() as T;
  return trimmed || null;
}

function cloneSelections(
  selections: ReadonlyArray<ProviderOptionSelection>,
): Array<ProviderOptionSelection> {
  return selections.map(cloneSelection);
}

export function createModelSelection(
  instanceId: ProviderInstanceId,
  model: string,
  options?: ReadonlyArray<ProviderOptionSelection> | null,
): ModelSelection {
  const selections = options ? cloneSelections(options) : [];
  const base: ModelSelection = {
    instanceId,
    model,
  };
  return selections.length > 0 ? { ...base, options: selections } : base;
}

export function resolvePromptInjectedEffort(
  caps: ModelCapabilities,
  rawEffort: string | null | undefined,
): string | null {
  const trimmed = trimOrNull(rawEffort);
  if (!trimmed) return null;
  const descriptors = getProviderOptionDescriptors({ caps });
  for (const descriptor of descriptors) {
    if (descriptor.type === "select" && descriptor.promptInjectedValues?.includes(trimmed)) {
      return trimmed;
    }
  }
  return null;
}

export function applyClaudePromptEffortPrefix(
  text: string,
  effort: string | null | undefined,
): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return trimmed;
  }
  // Prefixing slash commands prevents Claude invocation; command names allow any token without a second slash.
  if (effort !== "ultrathink" || /^\/[^\s/]+(?:\s|$)/u.test(trimmed)) {
    return trimmed;
  }
  if (trimmed.startsWith("Ultrathink:")) {
    return trimmed;
  }
  return `Ultrathink:\n${trimmed}`;
}

import type {
  ModelServiceBinding,
  ModelCapabilities,
  ModelServiceConfig,
  ModelServiceModel,
  ModelServiceProtocol,
  ServerProviderModel,
  ProviderInstanceConfig,
} from "@t3tools/contracts";
import {
  readCustomModelEntries,
  withCodexUltraCapabilities,
  withClaudeUltracodeCapabilities,
} from "./model.ts";

export const MODEL_SERVICE_AGENT_DRIVERS = [
  "codex",
  "claudeAgent",
  "pi",
  "omo",
  "opencode",
] as const;

export function modelServiceDisplayName(id: string): string {
  const match =
    /^(?:(?:openai|anthropic|google|models)\/)?(gpt|claude|gemini|grok|deepseek|qwen)(?:-|$)(.*)$/i.exec(
      id,
    );
  if (!match) return id;
  const brand: Readonly<Record<string, string>> = {
    gpt: "GPT",
    claude: "Claude",
    gemini: "Gemini",
    grok: "Grok",
    deepseek: "DeepSeek",
    qwen: "Qwen",
  };
  const words = match[2]!.split("-").map((word) => {
    if (/^\d{8}$/.test(word)) return word;
    if (/^\d+[bB]$/.test(word)) return word.toUpperCase();
    return word ? word[0]!.toUpperCase() + word.slice(1) : word;
  });
  const prefix = brand[match[1]!.toLowerCase()];
  if (prefix === "GPT" && /^\d/.test(words[0] ?? "")) {
    return [`${prefix}-${words[0]}`, ...words.slice(1)].filter(Boolean).join(" ");
  }
  return [prefix, ...words].filter(Boolean).join(" ");
}

const MODEL_SERVICE_PROTOCOL_PREFERENCE = {
  gpt: ["openai-responses", "openai-chat", "anthropic-messages", "gemini"],
  kimi: ["openai-chat", "anthropic-messages", "openai-responses", "gemini"],
  gemini: ["anthropic-messages", "gemini", "openai-chat", "openai-responses"],
  default: ["anthropic-messages", "openai-chat", "openai-responses", "gemini"],
} as const satisfies Record<string, ReadonlyArray<ModelServiceProtocol>>;

const CONVERTIBLE_MODEL_SERVICE_PROTOCOLS: ReadonlySet<ModelServiceProtocol> = new Set([
  "openai-responses",
  "openai-chat",
  "anthropic-messages",
  "gemini",
]);

export function preferredModelServiceProtocols(
  modelId: string,
): ReadonlyArray<ModelServiceProtocol> {
  const slug = modelId.split("/").at(-1) ?? "";
  return /^gpt(?:-|$)/i.test(slug)
    ? MODEL_SERVICE_PROTOCOL_PREFERENCE.gpt
    : /^kimi(?:-|$)/i.test(slug)
      ? MODEL_SERVICE_PROTOCOL_PREFERENCE.kimi
      : /^gemini(?:-|$)/i.test(slug)
        ? MODEL_SERVICE_PROTOCOL_PREFERENCE.gemini
        : MODEL_SERVICE_PROTOCOL_PREFERENCE.default;
}

export function modelServiceCandidateProtocols(
  service: ModelServiceConfig,
  model: ModelServiceModel,
  incoming?: ModelServiceProtocol,
): ReadonlyArray<ModelServiceProtocol> {
  const serviceProtocols = new Set(service.protocols);
  const allowed = new Set(
    (model.protocols ?? service.protocols).filter(
      (protocol) =>
        serviceProtocols.has(protocol) &&
        (incoming === undefined ||
          protocol === incoming ||
          (CONVERTIBLE_MODEL_SERVICE_PROTOCOLS.has(incoming) &&
            CONVERTIBLE_MODEL_SERVICE_PROTOCOLS.has(protocol))),
    ),
  );
  if (allowed.size === 0) return [];
  return preferredModelServiceProtocols(model.id).filter((protocol) => allowed.has(protocol));
}

export function modelServiceUpstreamProtocol(
  service: ModelServiceConfig,
  model: ModelServiceModel,
  incoming?: ModelServiceProtocol,
): ModelServiceProtocol | undefined {
  return modelServiceCandidateProtocols(service, model, incoming)[0];
}

export function isBoundModelServiceModelAllowed(
  binding: ModelServiceBinding,
  model: ModelServiceModel,
): boolean {
  return (
    model.ignored !== true &&
    (binding.modelIds.length === 0 || binding.modelIds.includes(model.id)) &&
    model.supportsTools !== false
  );
}

export function modelServiceAgentProtocol(
  driver: string,
  service: ModelServiceConfig,
): ModelServiceProtocol {
  if (driver === "codex") return "openai-responses";
  if (driver === "claudeAgent") return "anthropic-messages";
  return service.protocols[0];
}

export function boundModelServiceModels(
  service: ModelServiceConfig,
  binding: ModelServiceBinding,
): ReadonlyArray<ModelServiceModel> {
  return service.models
    .filter(
      (model) =>
        isBoundModelServiceModelAllowed(binding, model) &&
        modelServiceUpstreamProtocol(service, model) !== undefined,
    )
    .map((model) => ({
      ...model,
      name: !model.name || model.name === model.id ? modelServiceDisplayName(model.id) : model.name,
    }));
}

export function modelServiceModelSlug(driver: string, id: string): string {
  return driver === "pi" || driver === "omo" || driver === "opencode" ? `cox/${id}` : id;
}

export function modelServiceRoleReferences(
  instance: ProviderInstanceConfig,
): ReadonlyArray<string> {
  if (instance.driver !== "omo" || instance.config === null || typeof instance.config !== "object")
    return [];
  const config = instance.config as Record<string, unknown>;
  return [config.agentModels, config.categoryModels].flatMap((roles) =>
    roles !== null && typeof roles === "object" && !Array.isArray(roles)
      ? Object.values(roles).filter(
          (slug): slug is string => typeof slug === "string" && slug !== "",
        )
      : [],
  );
}

export function modelServiceProviderModels(
  customModels: unknown,
  defaultModel?: string,
): ReadonlyArray<ServerProviderModel> {
  const entries = readCustomModelEntries(customModels);
  const selected = entries.find((entry) => entry.slug === defaultModel)?.slug ?? entries[0]?.slug;
  return entries.map((entry) => ({
    ...entry,
    isCustom: false,
    isDefault: entry.slug === selected,
  }));
}

export function modelServiceAgentCapabilities(
  driver: string,
  capabilities: ModelCapabilities | null,
): ModelCapabilities | undefined {
  if (!capabilities)
    return driver === "claudeAgent"
      ? (withClaudeUltracodeCapabilities(null) ?? undefined)
      : undefined;
  const descriptor = capabilities.optionDescriptors?.find(
    (option) =>
      ["reasoningEffort", "effort", "thinking"].includes(option.id) && option.type === "select",
  );
  const allowed =
    driver === "pi" || driver === "omo"
      ? ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
      : [];
  const options =
    descriptor?.type === "select"
      ? descriptor.options.flatMap((option) => {
          const id =
            (driver === "pi" || driver === "omo") && option.id === "none" ? "off" : option.id;
          return driver === "codex" || driver === "claudeAgent" || allowed.includes(id)
            ? [{ ...option, id }]
            : [];
        })
      : [];
  const currentValue = descriptor?.currentValue;
  const mapped: ModelCapabilities = {
    ...capabilities,
    ...(capabilities.optionDescriptors === undefined
      ? {}
      : {
          optionDescriptors: [
            ...(options.length
              ? [
                  {
                    id:
                      driver === "pi" || driver === "omo"
                        ? "thinking"
                        : driver === "claudeAgent"
                          ? "effort"
                          : "reasoningEffort",
                    label: "Reasoning",
                    type: "select" as const,
                    options,
                    ...(typeof currentValue === "string" &&
                    options.some((option) => option.id === currentValue)
                      ? { currentValue }
                      : {}),
                  },
                ]
              : []),
            ...(capabilities.optionDescriptors ?? []).filter(
              (option) =>
                option !== descriptor &&
                ((driver === "opencode" &&
                  (option.id === "agent" || option.id === "variant") &&
                  option.type === "select") ||
                  ((driver === "codex" || driver === "claudeAgent") &&
                    option.id === "serviceTier" &&
                    option.type === "select") ||
                  (driver === "claudeAgent" &&
                    ["fastMode", "ultracode"].includes(option.id) &&
                    option.type === "boolean")),
            ),
          ],
        }),
  };
  return driver === "codex"
    ? withCodexUltraCapabilities(mapped)
    : driver === "claudeAgent"
      ? (withClaudeUltracodeCapabilities(mapped) ?? undefined)
      : mapped;
}

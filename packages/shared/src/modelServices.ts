import type {
  ModelServiceBinding,
  ModelCapabilities,
  ModelServiceConfig,
  ModelServiceModel,
  ModelServiceProtocol,
  ServerProviderModel,
} from "@t3tools/contracts";
import { readCustomModelEntries } from "./model.ts";

export const MODEL_SERVICE_AGENT_DRIVERS = ["codex", "claudeAgent", "pi", "opencode"] as const;

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
        (binding.modelIds.length === 0 || binding.modelIds.includes(model.id)) &&
        model.supportsTools !== false &&
        (model.protocols === undefined ||
          model.protocols.some((protocol) => service.protocols.includes(protocol))),
    )
    .map((model) => ({
      ...model,
      name: !model.name || model.name === model.id ? modelServiceDisplayName(model.id) : model.name,
    }));
}

export function modelServiceModelSlug(driver: string, id: string): string {
  return driver === "pi" || driver === "opencode" ? `cox/${id}` : id;
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
  if (!capabilities) return undefined;
  const descriptor = capabilities.optionDescriptors?.find(
    (option) =>
      ["reasoningEffort", "effort", "thinking"].includes(option.id) && option.type === "select",
  );
  const allowed =
    driver === "pi" ? ["off", "minimal", "low", "medium", "high", "xhigh", "max"] : [];
  const options =
    descriptor?.type === "select"
      ? descriptor.options.flatMap((option) => {
          const id = driver === "pi" && option.id === "none" ? "off" : option.id;
          return driver === "codex" || driver === "claudeAgent" || allowed.includes(id)
            ? [{ ...option, id }]
            : [];
        })
      : [];
  return {
    ...capabilities,
    ...(capabilities.optionDescriptors === undefined
      ? {}
      : {
          optionDescriptors: [
            ...(options.length
              ? [
                  {
                    id:
                      driver === "pi"
                        ? "thinking"
                        : driver === "claudeAgent"
                          ? "effort"
                          : "reasoningEffort",
                    label: "Reasoning",
                    type: "select" as const,
                    options,
                    ...(descriptor?.type === "select" &&
                    descriptor.currentValue !== undefined &&
                    options.some((option) => option.id === descriptor.currentValue)
                      ? { currentValue: descriptor.currentValue }
                      : {}),
                  },
                ]
              : []),
            ...(capabilities.optionDescriptors ?? []).filter(
              (option) =>
                option !== descriptor &&
                (((driver === "codex" || driver === "claudeAgent") &&
                  option.id === "serviceTier" &&
                  option.type === "select") ||
                  (driver === "claudeAgent" &&
                    option.id === "fastMode" &&
                    option.type === "boolean")),
            ),
          ],
        }),
  };
}

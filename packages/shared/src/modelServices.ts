import { ModelServiceId } from "@t3tools/contracts";
import { sha256 } from "@noble/hashes/sha2";
import * as Hex from "effect/encoding/Hex";
import type {
  ModelServiceBinding,
  ModelCapabilities,
  ModelServiceConfig,
  ModelServiceModel,
  ModelServiceModelRef,
  ModelServiceProtocol,
  ModelServiceSource,
  ServerProviderModel,
  ProviderInstanceConfig,
  ServerSettings,
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
  "omp",
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
  if (service.protocol !== undefined) {
    const protocol = service.protocol;
    return (!model.protocols || model.protocols.includes(protocol)) &&
      (incoming === undefined ||
        incoming === protocol ||
        (CONVERTIBLE_MODEL_SERVICE_PROTOCOLS.has(incoming) &&
          CONVERTIBLE_MODEL_SERVICE_PROTOCOLS.has(protocol)))
      ? [protocol]
      : [];
  }
  const configured = modelServiceProtocols(service);
  const serviceProtocols = new Set(configured);
  const allowed = new Set(
    (model.protocols ?? configured).filter(
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

export function modelServiceProtocols(
  service: ModelServiceConfig,
): ReadonlyArray<ModelServiceProtocol> {
  return service.protocol === undefined ? service.protocols! : [service.protocol];
}

export function isBoundModelServiceModelAllowed(
  binding: Pick<ModelServiceSource, "modelIds">,
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
  return modelServiceProtocols(service)[0]!;
}

export function boundModelServiceModels(
  service: ModelServiceConfig,
  binding: ModelServiceSource,
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

export function modelServiceSources(
  binding: ModelServiceBinding,
): ReadonlyArray<ModelServiceSource> {
  return (
    binding.sources ??
    (binding.serviceId ? [{ serviceId: binding.serviceId, modelIds: binding.modelIds }] : [])
  );
}

export function modelServiceDefaultRef(
  binding: ModelServiceBinding,
): ModelServiceModelRef | undefined {
  return (
    binding.defaultModelRef ??
    (binding.serviceId && binding.defaultModel
      ? { serviceId: binding.serviceId, modelId: binding.defaultModel }
      : undefined)
  );
}

export function sameModelServiceRef(
  left: ModelServiceModelRef,
  right: ModelServiceModelRef,
): boolean {
  return left.serviceId === right.serviceId && left.modelId === right.modelId;
}

const modelServiceRefKey = (model: ModelServiceModelRef) =>
  JSON.stringify([model.serviceId, model.modelId]);
const managedModelId = (key: string) =>
  `cox-ms-${Hex.encode(sha256(new TextEncoder().encode(key)).subarray(0, 24))}`;

export function modelServiceQualifiedId(model: ModelServiceModelRef): string {
  return managedModelId(modelServiceRefKey(model));
}

export function modelServiceRuntimeId(
  binding: ModelServiceBinding,
  model: ModelServiceModelRef,
): string {
  if (!binding.sources) return model.modelId;
  const legacy = binding.legacyAliases?.find((entry) => sameModelServiceRef(entry.model, model));
  if (legacy) return legacy.id;
  return modelServiceQualifiedId(model);
}

export function modelServiceDefaultRuntimeId(binding: ModelServiceBinding): string | undefined {
  const model = modelServiceDefaultRef(binding);
  return model ? modelServiceRuntimeId(binding, model) : undefined;
}

export function isModelServiceSelection(
  binding: ModelServiceBinding,
  driver: string,
  slug: string,
): boolean {
  return (
    binding.sources !== undefined &&
    (slug.startsWith(modelServiceModelSlug(driver, "cox-ms-")) ||
      binding.legacyAliases?.some((entry) => modelServiceModelSlug(driver, entry.id) === slug) ===
        true)
  );
}

export interface ModelServiceTarget {
  readonly ref: ModelServiceModelRef;
  readonly id: string;
  readonly model: ModelServiceModel;
  readonly service: ModelServiceConfig;
}

export function modelServiceTargets(
  services: ServerSettings["modelServices"],
  binding: ModelServiceBinding,
): ReadonlyArray<ModelServiceTarget> {
  const aliases = new Map(
    binding.legacyAliases?.map((entry) => [modelServiceRefKey(entry.model), entry.id] as const),
  );
  return modelServiceSources(binding).flatMap((source) => {
    if (!Object.hasOwn(services, source.serviceId)) return [];
    const service = services[source.serviceId];
    if (!service) return [];
    return service.models.flatMap((model) => {
      if (source.modelIds.length && !source.modelIds.includes(model.id)) return [];
      const ref = { serviceId: source.serviceId, modelId: model.id };
      const key = modelServiceRefKey(ref);
      const id = binding.sources ? (aliases.get(key) ?? managedModelId(key)) : model.id;
      return [{ ref, id, model, service }];
    });
  });
}

export function isModelServiceTargetAvailable(target: ModelServiceTarget): boolean {
  return target.model.available !== false && isModelServiceTargetCompatible(target);
}

export function isModelServiceTargetCompatible(target: ModelServiceTarget): boolean {
  return (
    target.service.enabled &&
    target.model.ignored !== true &&
    target.model.supportsTools !== false &&
    modelServiceUpstreamProtocol(target.service, target.model) !== undefined
  );
}

export function modelServiceSourceLabels(services: ServerSettings["modelServices"]) {
  const entries = Object.entries(services);
  const nameCounts = new Map<string, number>();
  for (const [, service] of entries) {
    nameCounts.set(service.name, (nameCounts.get(service.name) ?? 0) + 1);
  }
  const labels = entries.map(([id, service]) => {
    const host =
      nameCounts.get(service.name)! > 1 && URL.canParse(service.baseUrl)
        ? new URL(service.baseUrl).host
        : "";
    return [ModelServiceId.make(id), host ? `${service.name} · ${host}` : service.name] as const;
  });
  const labelCounts = new Map<string, number>();
  for (const [, label] of labels) {
    labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
  }
  return new Map(
    labels.map(([id, label]) => [id, labelCounts.get(label)! > 1 ? `${label} (${id})` : label]),
  );
}

export function modelServiceTargetName(target: ModelServiceTarget, showSource: boolean): string {
  const { model, service } = target;
  const name =
    model.name && model.name !== model.id ? model.name : modelServiceDisplayName(model.id);
  return showSource ? `${name} · ${service.name}` : name;
}

export function multiSourceModelServiceBinding(
  binding: ModelServiceBinding,
  services: ServerSettings["modelServices"],
): ModelServiceBinding {
  if (binding.sources) return binding;
  const [source] = modelServiceSources(binding);
  if (!source) return binding;
  const defaultModelRef = modelServiceDefaultRef(binding);
  return {
    modelIds: [],
    sources: [source],
    ...(defaultModelRef ? { defaultModelRef } : {}),
    legacyAliases: modelServiceTargets(services, binding).map((target) => ({
      id: target.id,
      model: target.ref,
    })),
  };
}

export function modelServiceSplitPlan(
  services: ServerSettings["modelServices"],
  serviceId: ModelServiceId,
) {
  if (!Object.hasOwn(services, serviceId)) return [];
  const service = services[serviceId];
  if (!service) return [];
  const protocols = [...new Set(modelServiceProtocols(service))];
  if (protocols.length < 2) return [];
  const ids = new Set(Object.keys(services));
  const models = service.models.map((model) => {
    const candidates = modelServiceCandidateProtocols(service, model);
    return { model, protocol: candidates[0] ?? protocols[0]!, alternatives: candidates.slice(1) };
  });
  return protocols.map((protocol, index) => {
    let id = serviceId;
    if (index > 0) {
      const base = `${serviceId.slice(0, 40)}-${protocol}`;
      let candidate = base;
      for (let suffix = 2; ids.has(candidate); suffix += 1) candidate = `${base}-${suffix}`;
      ids.add(candidate);
      id = ModelServiceId.make(candidate);
    }
    return {
      serviceId: id,
      protocol,
      models: models.filter((entry) => entry.protocol === protocol),
    };
  });
}

export function modelServiceModelSlug(driver: string, id: string): string {
  return driver === "pi" || driver === "omo" || driver === "omp" || driver === "opencode"
    ? `cox/${id}`
    : id;
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
  const nativeThinkingDriver = driver === "pi" || driver === "omo" || driver === "omp";
  if (!capabilities)
    return driver === "claudeAgent"
      ? (withClaudeUltracodeCapabilities(null) ?? undefined)
      : undefined;
  const descriptor = capabilities.optionDescriptors?.find(
    (option) =>
      ["reasoningEffort", "effort", "thinking"].includes(option.id) && option.type === "select",
  );
  const allowed = nativeThinkingDriver
    ? ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
    : [];
  const options =
    descriptor?.type === "select"
      ? descriptor.options.flatMap((option) => {
          const id = nativeThinkingDriver && option.id === "none" ? "off" : option.id;
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
                    id: nativeThinkingDriver
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

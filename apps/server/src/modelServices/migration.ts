import {
  ModelServiceError,
  type ModelServiceId,
  type ModelServiceModelRef,
  type ModelServiceSource,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import {
  isModelServiceTargetAvailable,
  modelServiceDefaultRef,
  modelServiceProtocols,
  modelServiceSources,
  modelServiceSplitPlan,
  modelServiceTargets,
  multiSourceModelServiceBinding,
} from "@t3tools/shared/modelServices";
import * as Effect from "effect/Effect";

export function migrateSingleModelServices(settings: ServerSettings): ServerSettings {
  let changed = false;
  const modelServices = { ...settings.modelServices };
  for (const [id, service] of Object.entries(settings.modelServices)) {
    if (!service.protocols || new Set(service.protocols).size !== 1) continue;
    const { protocols, ...connection } = service;
    modelServices[id as ModelServiceId] = { ...connection, protocol: protocols[0] };
    changed = true;
  }
  const providerInstances = { ...settings.providerInstances };
  for (const id of Object.keys(providerInstances) as Array<keyof typeof providerInstances>) {
    const instance = providerInstances[id];
    const binding = instance?.modelService;
    if (!instance || !binding?.serviceId || !modelServices[binding.serviceId]?.protocol) continue;
    providerInstances[id] = {
      ...instance,
      modelService: multiSourceModelServiceBinding(binding, modelServices),
    };
    changed = true;
  }
  return changed ? { ...settings, modelServices, providerInstances } : settings;
}

export function migrateIgnoredModelServiceModels(
  settings: ServerSettings,
  legacyServices: Readonly<
    Record<string, { readonly models?: readonly { readonly ignored?: boolean }[] }>
  >,
): ServerSettings {
  const modelServices = { ...settings.modelServices };
  const removed = new Map<string, Set<string>>();
  let changed = false;
  for (const id of Object.keys(modelServices) as ModelServiceId[]) {
    const service = modelServices[id];
    const legacyModels = legacyServices[id]?.models;
    if (!service || !legacyModels?.some((model) => model.ignored !== undefined)) continue;
    changed = true;
    const removedIds = new Set<string>();
    const models = service.models.filter((model, index) => {
      if (legacyModels[index]?.ignored !== true) return true;
      removedIds.add(model.id);
      return false;
    });
    if (removedIds.size) {
      removed.set(id, removedIds);
      modelServices[id] = { ...service, models, revision: service.revision + 1 };
    }
  }
  if (!changed) return settings;

  const providerInstances = { ...settings.providerInstances };
  for (const id of Object.keys(providerInstances) as Array<keyof typeof providerInstances>) {
    const instance = providerInstances[id];
    const binding = instance?.modelService;
    if (!instance || !binding) continue;
    const removedTargets = modelServiceTargets(settings.modelServices, binding).filter(({ ref }) =>
      removed.get(ref.serviceId)?.has(ref.modelId),
    );
    if (!removedTargets.length) continue;
    const normalized = multiSourceModelServiceBinding(binding, settings.modelServices);
    const [first, ...rest] = modelServiceSources(normalized).flatMap((source) => {
      const removedIds = removed.get(source.serviceId);
      if (!removedIds) return [source];
      const modelIds = source.modelIds.filter((modelId) => !removedIds.has(modelId));
      if (source.modelIds.length && !modelIds.length) return [];
      return [{ ...source, modelIds }];
    });
    const { modelService: _binding, ...unbound } = instance;
    const { defaultModelRef, ...remainingBinding } = normalized;
    const nextBinding = first && {
      ...remainingBinding,
      sources: [first, ...rest] as const,
      ...(defaultModelRef && !removed.get(defaultModelRef.serviceId)?.has(defaultModelRef.modelId)
        ? { defaultModelRef }
        : {}),
    };
    let config = instance.config;
    if (
      instance.driver === "omo" &&
      config &&
      typeof config === "object" &&
      !Array.isArray(config)
    ) {
      const retiredSlugs = new Set(removedTargets.map(({ id }) => "cox/" + id));
      const nextConfig: Record<string, unknown> = { ...config };
      for (const field of ["agentModels", "categoryModels"]) {
        const roles = nextConfig[field];
        if (roles && typeof roles === "object" && !Array.isArray(roles)) {
          nextConfig[field] = Object.fromEntries(
            Object.entries(roles).filter(
              ([, slug]) => typeof slug !== "string" || !retiredSlugs.has(slug),
            ),
          );
        }
      }
      config = nextConfig;
    }
    const updated = { ...unbound, ...(config !== undefined ? { config } : {}) };
    providerInstances[id] =
      nextBinding && modelServiceTargets(modelServices, nextBinding).length
        ? { ...updated, modelService: nextBinding }
        : { ...updated, enabled: false };
  }
  return { ...settings, modelServices, providerInstances };
}

export const splitModelService = Effect.fn("splitModelService")(function* (
  settings: ServerSettings,
  input: NonNullable<ServerSettingsPatch["splitModelService"]>,
) {
  const { serviceId, revision } = input;
  const service = settings.modelServices[serviceId];
  if (service?.revision !== revision || modelServiceProtocols(service).length < 2)
    return yield* new ModelServiceError({
      detail: "The model service changed. Reload its current settings before splitting it.",
    });
  const plan = modelServiceSplitPlan(settings.modelServices, serviceId);
  const routes = new Map(
    plan.flatMap((part) => part.models.map(({ model }) => [model.id, part.serviceId] as const)),
  );
  const { protocols: _protocols, ...connection } = service;
  const modelServices = { ...settings.modelServices };
  for (const part of plan) {
    modelServices[part.serviceId] = {
      ...connection,
      name: `${service.name} · ${part.protocol}`,
      revision: part.serviceId === serviceId ? revision + 1 : 1,
      protocol: part.protocol,
      models: part.models.map(({ model }) => model),
    };
  }

  const providerInstances = { ...settings.providerInstances };
  for (const id of Object.keys(providerInstances) as Array<keyof typeof providerInstances>) {
    const instance = providerInstances[id];
    const binding = instance?.modelService;
    if (!instance || !binding) continue;
    const sources = modelServiceSources(binding);
    const source = sources.find((entry) => entry.serviceId === serviceId);
    if (!source) continue;
    const targets = modelServiceTargets(settings.modelServices, binding).filter(
      (target) => target.ref.serviceId === serviceId,
    );
    const replacementTargets = [...targets.filter(isModelServiceTargetAvailable), ...targets];
    const partIds = new Set(replacementTargets.map((target) => routes.get(target.ref.modelId)!));
    const replaced: ReadonlyArray<ModelServiceSource> = [...partIds].map((partId) => ({
      serviceId: partId,
      modelIds: source.modelIds.length
        ? targets
            .filter((target) => routes.get(target.ref.modelId) === partId)
            .map((target) => target.ref.modelId)
        : [],
    }));
    const [first, ...rest] = sources.flatMap((entry) => (entry === source ? replaced : [entry]));
    if (!first)
      return yield* new ModelServiceError({
        detail: "The agent binding needs at least one compatible model.",
      });
    const remap = (model: ModelServiceModelRef): ModelServiceModelRef =>
      model.serviceId === serviceId
        ? { ...model, serviceId: routes.get(model.modelId) ?? serviceId }
        : model;
    const defaultModel = modelServiceDefaultRef(binding);
    providerInstances[id] = {
      ...instance,
      modelService: {
        modelIds: [],
        sources: [first, ...rest],
        ...(defaultModel ? { defaultModelRef: remap(defaultModel) } : {}),
        legacyAliases: [
          ...(binding.legacyAliases ?? [])
            .filter((alias) => !targets.some((target) => target.id === alias.id))
            .map((alias) => ({ ...alias, model: remap(alias.model) })),
          ...targets.map((target) => ({ id: target.id, model: remap(target.ref) })),
        ],
      },
    };
  }
  return {
    ...settings,
    modelServices,
    providerInstances,
    modelServiceOrder: [
      ...new Set([
        ...settings.modelServiceOrder.flatMap((id) =>
          id === serviceId ? plan.map((part) => part.serviceId) : [id],
        ),
        ...plan.map((part) => part.serviceId),
      ]),
    ],
  };
});

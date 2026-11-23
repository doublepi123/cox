import type {
  ModelServiceConfig,
  ModelServiceId,
  ModelServiceModel,
  ProviderInstanceConfigMap,
  ServerSettings,
} from "@t3tools/contracts";
import {
  isModelServiceTargetAvailable,
  modelServiceDefaultRef,
  modelServiceRoleReferences,
  modelServiceSources,
  modelServiceTargets,
} from "@t3tools/shared/modelServices";

export function modelRemovalBlockingAgents(
  serviceId: ModelServiceId,
  service: ModelServiceConfig,
  modelId: string,
  instances: ProviderInstanceConfigMap,
  services: ServerSettings["modelServices"] = { [serviceId]: service },
): readonly string[] {
  return modelsRemovalBlockingAgents(serviceId, service, new Set([modelId]), instances, services);
}

export function modelsRemovalBlockingAgents(
  serviceId: ModelServiceId,
  service: ModelServiceConfig,
  modelIds: ReadonlySet<string>,
  instances: ProviderInstanceConfigMap,
  services: ServerSettings["modelServices"] = { [serviceId]: service },
): readonly string[] {
  if (modelIds.size === 0) return [];
  const remaining = {
    ...service,
    models: service.models.filter((model) => !modelIds.has(model.id)),
  };
  return Object.entries(instances).flatMap(([id, instance]) => {
    const binding = instance.modelService;
    if (!binding) return [];
    const source = modelServiceSources(binding).find((entry) => entry.serviceId === serviceId);
    if (!source) return [];
    const defaultModel = modelServiceDefaultRef(binding);
    const roles = modelServiceRoleReferences(instance);
    const removed = modelServiceTargets(services, binding).filter(
      (target) => target.ref.serviceId === serviceId && modelIds.has(target.ref.modelId),
    );
    const remainingTargets = modelServiceTargets({ ...services, [serviceId]: remaining }, binding);
    if (
      source.modelIds.some((modelId) => modelIds.has(modelId)) ||
      (defaultModel?.serviceId === serviceId && modelIds.has(defaultModel.modelId)) ||
      removed.some((target) => roles.includes(`cox/${target.id}`)) ||
      remainingTargets.length === 0 ||
      (removed.some(isModelServiceTargetAvailable) &&
        !remainingTargets.some(isModelServiceTargetAvailable))
    ) {
      return [instance.displayName || id];
    }
    return [];
  });
}

export function unlistedModelRemovalPlan(
  serviceId: ModelServiceId,
  service: ModelServiceConfig,
  instances: ProviderInstanceConfigMap,
  services: ServerSettings["modelServices"] = { [serviceId]: service },
) {
  const unlisted = service.models.filter(
    (model) => model.available === false && model.source !== "manual",
  );
  return modelRemovalPlan(serviceId, service, unlisted, instances, services);
}

export function modelRemovalPlan(
  serviceId: ModelServiceId,
  service: ModelServiceConfig,
  candidates: readonly ModelServiceModel[],
  instances: ProviderInstanceConfigMap,
  services: ServerSettings["modelServices"] = { [serviceId]: service },
): {
  readonly removable: readonly ModelServiceModel[];
  readonly protected: readonly ModelServiceModel[];
} {
  if (!candidates.length) return { removable: [], protected: [] };
  const selectedIds = new Set(
    Object.values(instances).flatMap((instance) => {
      const binding = instance.modelService;
      if (!binding) return [];
      const source = modelServiceSources(binding).find((entry) => entry.serviceId === serviceId);
      if (!source) return [];
      const defaultModel = modelServiceDefaultRef(binding);
      const roles = modelServiceRoleReferences(instance);
      return [
        ...source.modelIds,
        ...(defaultModel?.serviceId === serviceId ? [defaultModel.modelId] : []),
        ...modelServiceTargets(services, binding).flatMap((target) =>
          target.ref.serviceId === serviceId && roles.includes(`cox/${target.id}`)
            ? [target.ref.modelId]
            : [],
        ),
      ];
    }),
  );
  const removable = candidates.filter((model) => !selectedIds.has(model.id));
  const removedIds = new Set(removable.map((model) => model.id));
  if (modelsRemovalBlockingAgents(serviceId, service, removedIds, instances, services).length > 0)
    return { removable: [], protected: candidates };
  return {
    removable,
    protected: candidates.filter((model) => !removedIds.has(model.id)),
  };
}

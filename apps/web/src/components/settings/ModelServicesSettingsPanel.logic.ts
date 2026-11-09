import type {
  ModelServiceConfig,
  ModelServiceId,
  ModelServiceModel,
  ProviderInstanceConfigMap,
} from "@t3tools/contracts";
import { boundModelServiceModels } from "@t3tools/shared/modelServices";

export function modelRemovalBlockingAgents(
  serviceId: ModelServiceId,
  service: ModelServiceConfig,
  modelId: string,
  instances: ProviderInstanceConfigMap,
): readonly string[] {
  return modelsRemovalBlockingAgents(serviceId, service, new Set([modelId]), instances);
}

function modelsRemovalBlockingAgents(
  serviceId: ModelServiceId,
  service: ModelServiceConfig,
  modelIds: ReadonlySet<string>,
  instances: ProviderInstanceConfigMap,
): readonly string[] {
  if (modelIds.size === 0) return [];
  const remaining = {
    ...service,
    models: service.models.filter((model) => !modelIds.has(model.id)),
  };
  return Object.entries(instances).flatMap(([id, instance]) => {
    const binding = instance.modelService;
    if (!binding || binding.serviceId !== serviceId) return [];
    const removesAvailableModel = boundModelServiceModels(service, binding).some(
      (model) => modelIds.has(model.id) && model.available !== false,
    );
    if (
      binding.modelIds.some((modelId) => modelIds.has(modelId)) ||
      (binding.defaultModel !== undefined && modelIds.has(binding.defaultModel)) ||
      remaining.models.length === 0 ||
      (removesAvailableModel &&
        !boundModelServiceModels(remaining, binding).some((model) => model.available !== false))
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
): {
  readonly removable: readonly ModelServiceModel[];
  readonly protected: readonly ModelServiceModel[];
} {
  const unlisted = service.models.filter(
    (model) => model.available === false && model.source !== "manual",
  );
  const selectedIds = new Set(
    Object.values(instances).flatMap((instance) => {
      const binding = instance.modelService;
      return binding?.serviceId === serviceId
        ? [...binding.modelIds, ...(binding.defaultModel ? [binding.defaultModel] : [])]
        : [];
    }),
  );
  const removable = unlisted.filter((model) => !selectedIds.has(model.id));
  const removedIds = new Set(removable.map((model) => model.id));
  if (modelsRemovalBlockingAgents(serviceId, service, removedIds, instances).length > 0)
    return { removable: [], protected: unlisted };
  return {
    removable,
    protected: unlisted.filter((model) => !removedIds.has(model.id)),
  };
}

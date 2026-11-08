import type {
  ModelServiceConfig,
  ModelServiceId,
  ProviderInstanceConfigMap,
} from "@t3tools/contracts";
import { boundModelServiceModels } from "@t3tools/shared/modelServices";

export function modelRemovalBlockingAgents(
  serviceId: ModelServiceId,
  service: ModelServiceConfig,
  modelId: string,
  instances: ProviderInstanceConfigMap,
): readonly string[] {
  const remaining = {
    ...service,
    models: service.models.filter((model) => model.id !== modelId),
  };
  return Object.entries(instances).flatMap(([id, instance]) => {
    const binding = instance.modelService;
    if (!binding || binding.serviceId !== serviceId) return [];
    const removesAvailableModel = boundModelServiceModels(service, binding).some(
      (model) => model.id === modelId && model.available !== false,
    );
    if (
      binding.modelIds.includes(modelId) ||
      binding.defaultModel === modelId ||
      remaining.models.length === 0 ||
      (removesAvailableModel &&
        !boundModelServiceModels(remaining, binding).some((model) => model.available !== false))
    ) {
      return [instance.displayName || id];
    }
    return [];
  });
}

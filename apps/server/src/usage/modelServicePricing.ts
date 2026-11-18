import {
  ModelServiceId,
  type ModelServiceConfig,
  type ModelServiceModel,
  type ServerSettings,
} from "@t3tools/contracts";
import {
  modelServiceDisplayName,
  modelServiceQualifiedId,
  modelServiceTargets,
} from "@t3tools/shared/modelServices";
import type { UsageRecord } from "@t3tools/provider-core/server/usage";
import { modelTokenRates, type ModelServiceUsageRate } from "./usagePricing.ts";

export interface ModelServiceUsagePrice {
  readonly name: string;
  readonly rateModel: string;
  readonly pricing: ModelServiceUsageRate | undefined;
}

export function createModelServiceUsagePricing(
  settings: Pick<ServerSettings, "modelServices" | "providerInstances">,
  instanceForSource: (sourcePath: string) => string | undefined,
): (record: UsageRecord, sourcePath?: string) => ModelServiceUsagePrice | undefined {
  const qualified = new Map<string, ModelServiceUsagePrice>();
  const legacyByInstance = new Map<string, Map<string, ModelServiceUsagePrice>>();
  const entry = (service: ModelServiceConfig, model: ModelServiceModel, name: string) => {
    const price = model.price ?? model.modelsDevPrice;
    return {
      name: `${name} · ${service.name}`,
      rateModel: model.id,
      pricing: price
        ? { rate: modelTokenRates(price), manual: model.price !== undefined }
        : undefined,
    };
  };
  for (const [id, service] of Object.entries(settings.modelServices)) {
    const serviceId = ModelServiceId.make(id);
    for (const model of service.models) {
      const name = model.name ?? modelServiceDisplayName(model.id);
      qualified.set(
        modelServiceQualifiedId({ serviceId, modelId: model.id }),
        entry(service, model, name),
      );
    }
  }
  for (const [instanceId, instance] of Object.entries(settings.providerInstances)) {
    if (!instance.modelService) continue;
    const legacy = new Map<string, ModelServiceUsagePrice>();
    for (const target of modelServiceTargets(settings.modelServices, instance.modelService)) {
      if (target.id.startsWith("cox-ms-")) continue;
      const name = target.model.name ?? modelServiceDisplayName(target.model.id);
      const pricing = entry(target.service, target.model, name);
      if (pricing.pricing) legacy.set(target.id, pricing);
    }
    if (legacy.size) legacyByInstance.set(instanceId, legacy);
  }
  return (record, sourcePath) => {
    const isCox = record.model.startsWith("cox/");
    const id = isCox ? record.model.slice(4) : record.model;
    const managed = qualified.get(id);
    if (managed || !isCox || !sourcePath) return managed;
    const instanceId = instanceForSource(sourcePath);
    return instanceId ? legacyByInstance.get(instanceId)?.get(id) : undefined;
  };
}

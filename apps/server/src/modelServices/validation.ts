import {
  ModelServiceError,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import {
  MODEL_SERVICE_AGENT_DRIVERS,
  modelServiceRoleReferences,
} from "@t3tools/shared/modelServices";
import { OmoSettings } from "@t3tools/provider-omo/settings";
import * as Schema from "effect/Schema";

const decodeOmoSettings = Schema.decodeUnknownExit(OmoSettings);

export function validateModelServiceBindings(settings: ServerSettings): string | null {
  for (const service of Object.values(settings.modelServices)) {
    if (new Set(service.models.map((model) => model.id)).size !== service.models.length)
      return "Model IDs must be unique within a model service.";
    for (const [name, value] of Object.entries(service.headers)) {
      if (
        !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
        /[\r\n]/.test(value) ||
        ["host", "connection", "content-length", "transfer-encoding"].includes(name.toLowerCase())
      )
        return "The model service contains an invalid request header.";
    }
  }
  for (const instance of Object.values(settings.providerInstances)) {
    if (instance.driver === "omo" && decodeOmoSettings(instance.config ?? {})._tag === "Failure")
      return "OMO settings are invalid. Role names must start with a letter and contain only letters, digits, underscores or hyphens (up to 64 characters).";
    const binding = instance.modelService;
    if (!binding) continue;
    if (!(MODEL_SERVICE_AGENT_DRIVERS as ReadonlyArray<string>).includes(instance.driver))
      return "This agent does not support a centrally managed model service.";
    const service = settings.modelServices[binding.serviceId];
    if (!service) return "Unbind agents before removing their model service.";
    const models = service.models.filter(
      (model) => binding.modelIds.length === 0 || binding.modelIds.includes(model.id),
    );
    if (!models.length) return "The agent binding needs at least one compatible model.";
    if (binding.modelIds.some((id) => !models.some((model) => model.id === id)))
      return "The agent binding contains a missing or incompatible model.";
    if (binding.defaultModel && !models.some((model) => model.id === binding.defaultModel))
      return "The default model must be included in the agent binding.";
    if (instance.driver === "omo") {
      if (
        modelServiceRoleReferences(instance).some(
          (slug) => !models.some((model) => `cox/${model.id}` === slug),
        )
      )
        return "OMO role models must exist in the bound model service. Clear or reassign roles before removing their models.";
    }
  }
  return null;
}

export function ensureModelServiceRevisions(
  settings: ServerSettings,
  patch: ServerSettingsPatch,
): Effect.Effect<void, ModelServiceError> {
  for (const [id, entry] of Object.entries(patch.modelServices ?? {})) {
    if (
      entry &&
      entry.revision !==
        (settings.modelServices[id as keyof typeof settings.modelServices]?.revision ?? 0)
    )
      return Effect.fail(
        new ModelServiceError({
          detail: "The model service changed. Reload its current settings before saving.",
        }),
      );
  }
  return Effect.void;
}

import {
  ModelServiceError,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import {
  MODEL_SERVICE_AGENT_DRIVERS,
  modelServiceDefaultRef,
  modelServiceRoleReferences,
  modelServiceSources,
  modelServiceTargets,
  sameModelServiceRef,
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
    const sources = modelServiceSources(binding);
    if (new Set(sources.map((source) => source.serviceId)).size !== sources.length)
      return "Each model service can be bound to an agent only once.";
    for (const source of sources) {
      if (!Object.hasOwn(settings.modelServices, source.serviceId))
        return "Unbind agents before removing their model service.";
      const service = settings.modelServices[source.serviceId];
      if (!service) return "Unbind agents before removing their model service.";
      const ids = new Set(service.models.map((model) => model.id));
      if (source.modelIds.some((id) => !ids.has(id)))
        return "The agent binding contains a missing or incompatible model.";
    }
    const models = modelServiceTargets(settings.modelServices, binding);
    if (!models.length) return "The agent binding needs at least one compatible model.";
    const aliases = binding.legacyAliases ?? [];
    if (
      new Set(aliases.map((entry) => entry.id)).size !== aliases.length ||
      new Set(aliases.map((entry) => JSON.stringify(entry.model))).size !== aliases.length ||
      new Set(models.map((model) => model.id)).size !== models.length ||
      models.some((model) =>
        aliases.some(
          (alias) => alias.id === model.id && !sameModelServiceRef(alias.model, model.ref),
        ),
      )
    )
      return "The agent binding contains conflicting model identifiers.";
    const defaultModel = modelServiceDefaultRef(binding);
    if (defaultModel && !models.some((model) => sameModelServiceRef(model.ref, defaultModel)))
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
    const prior = settings.modelServices[id as keyof typeof settings.modelServices];
    if (entry && entry.revision !== (prior?.revision ?? 0))
      return Effect.fail(
        new ModelServiceError({
          detail: "The model service changed. Reload its current settings before saving.",
        }),
      );
    if (entry && JSON.stringify(entry.protocols) !== JSON.stringify(prior?.protocols)) {
      if (new Set(prior?.protocols).size > 1)
        return Effect.fail(
          new ModelServiceError({
            detail: "Preview and split this service before changing its protocols.",
          }),
        );
      if (new Set(entry.protocols).size > 1)
        return Effect.fail(
          new ModelServiceError({ detail: "Choose one API protocol per model service." }),
        );
    }
  }
  return Effect.void;
}

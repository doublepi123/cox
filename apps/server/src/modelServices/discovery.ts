import {
  ModelServiceError,
  type ModelServiceConfig,
  type ModelServiceDiscoveryInput,
  type ModelServiceDiscoveryResult,
  type ModelServiceModel,
  type ModelServiceProtocol,
  ProviderDriverKind,
} from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import { parseGatewayModel } from "../provider/GatewayModels.ts";
import * as Settings from "../serverSettings.ts";
import {
  modelServiceDisplayName,
  modelServiceProtocols,
  preferredModelServiceProtocols,
} from "@t3tools/shared/modelServices";
import { enrichModelFromModelsDev, fetchModelsDevCatalog } from "./modelsDev.ts";
import { modelServiceFingerprint } from "./validation.ts";
const isModelServiceError = Schema.is(ModelServiceError);

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export function modelServiceEndpoint(
  service: Pick<ModelServiceConfig, "baseUrl">,
  protocol: ModelServiceProtocol,
  endpoint: string,
): URL {
  const url = new URL(service.baseUrl);
  const base = url.href.replace(/\/+$/, "");
  const version =
    url.pathname === "/"
      ? protocol === "gemini"
        ? "/v1beta"
        : "/v1"
      : protocol === "anthropic-messages" && !/\/v\d+[a-z0-9]*\/*$/i.test(url.pathname)
        ? "/v1"
        : "";
  return new URL(`${base}${version}/${endpoint.replace(/^\/+/, "")}`);
}

export function modelServiceHeaders(
  service: ModelServiceConfig,
  protocol: ModelServiceProtocol,
): Record<string, string> {
  return {
    ...(protocol === "anthropic-messages" ? { "anthropic-version": "2023-06-01" } : {}),
    ...service.headers,
    ...(service.apiKey
      ? protocol === "anthropic-messages"
        ? { "x-api-key": service.apiKey }
        : protocol === "gemini"
          ? { "x-goog-api-key": service.apiKey }
          : { authorization: `Bearer ${service.apiKey}` }
      : {}),
  };
}

export function parseModelServiceModel(
  value: unknown,
  defaults: ReadonlyArray<ModelServiceProtocol>,
): ModelServiceModel | null {
  const raw = record(value);
  const id = typeof raw.id === "string" ? raw.id : typeof raw.name === "string" ? raw.name : "";
  if (!id.trim()) return null;
  if (
    Array.isArray(raw.supportedGenerationMethods) &&
    !raw.supportedGenerationMethods.includes("generateContent")
  )
    return null;
  const inputModalities =
    raw.input_modalities ??
    record(raw.modalities).input ??
    record(raw.architecture).input_modalities;
  const outputModalities =
    raw.output_modalities ??
    record(raw.modalities).output ??
    record(raw.architecture).output_modalities;
  const modalities = (value: unknown): ReadonlyArray<string> | undefined =>
    Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.trim())
      ? value
      : undefined;
  const model = parseGatewayModel(
    {
      ...raw,
      id,
      display_name: raw.display_name ?? raw.displayName,
      context_length: raw.context_length ?? raw.inputTokenLimit ?? record(raw.limit).context,
      input_modalities: modalities(inputModalities),
    },
    ProviderDriverKind.make("codex"),
  );
  if (!model) return null;
  const protocols =
    new Set(defaults).size > 1
      ? preferredModelServiceProtocols(model.slug).filter((protocol) => defaults.includes(protocol))
      : undefined;
  const parameters = Array.isArray(raw.supported_parameters) ? raw.supported_parameters : undefined;
  const tools =
    raw.supports_tools ??
    record(raw.capabilities).tools ??
    raw.tool_call ??
    parameters?.includes("tools");
  const output =
    raw.max_output_tokens ??
    raw.outputTokenLimit ??
    record(raw.limit).output ??
    record(raw.top_provider).max_completion_tokens;
  const reasoning =
    raw.supports_reasoning ??
    raw.reasoning ??
    raw.thinking ??
    (parameters?.includes("reasoning") ? true : undefined);
  return {
    id: model.slug,
    name: model.name === model.slug ? modelServiceDisplayName(model.slug) : model.name,
    capabilities: model.capabilities,
    ...(protocols ? { protocols } : {}),
    source: "discovered",
    available: true,
    ...(modalities(inputModalities) ? { inputModalities: modalities(inputModalities)! } : {}),
    ...(modalities(outputModalities) ? { outputModalities: modalities(outputModalities)! } : {}),
    ...(typeof reasoning === "boolean" ? { supportsReasoning: reasoning } : {}),
    ...(typeof tools === "boolean" ? { supportsTools: tools } : {}),
    ...(typeof output === "number" && Number.isSafeInteger(output) && output > 0
      ? { maxOutputTokens: output }
      : {}),
  };
}

export const fetchModelServiceModels = Effect.fn("fetchModelServiceModels")(
  function* (service: ModelServiceConfig) {
    const http = yield* HttpClient.HttpClient;
    const protocols = modelServiceProtocols(service);
    const protocol = protocols[0]!;
    const url = service.modelsPath
      ? new URL(service.modelsPath, service.baseUrl.replace(/\/+$/, "") + "/")
      : modelServiceEndpoint(service, protocol, "models");
    if (
      url.origin !== new URL(service.baseUrl).origin ||
      url.username ||
      url.password ||
      !["http:", "https:"].includes(url.protocol)
    )
      return yield* new ModelServiceError({
        detail: "The model-list URL must use the model service's origin.",
      });
    const found = new Map<string, ModelServiceModel>();
    const cursors = new Set<string>();
    for (let page = 0; page < 100; page++) {
      const response = yield* http.execute(
        HttpClientRequest.get(url.href).pipe(
          HttpClientRequest.setHeaders(modelServiceHeaders(service, protocol)),
        ),
      );
      if (response.status !== 200)
        return yield* new ModelServiceError({
          detail: `Model discovery failed (HTTP ${response.status}).`,
        });
      const body = record(
        yield* response.json.pipe(
          Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(8 * 1024 * 1024)),
        ),
      );
      const entries = body.data ?? body.models;
      if (!Array.isArray(entries))
        return yield* new ModelServiceError({ detail: "The service did not return a model list." });
      for (const value of entries) {
        const model = parseModelServiceModel(value, protocols);
        if (model) found.set(model.id, model);
      }
      const cursor =
        typeof body.nextPageToken === "string"
          ? body.nextPageToken
          : body.has_more === true && typeof body.last_id === "string"
            ? body.last_id
            : undefined;
      if (!cursor) {
        if (body.has_more === true)
          return yield* new ModelServiceError({
            detail: "The service returned incomplete model pagination.",
          });
        return [...found.values()];
      }
      if (cursors.has(cursor))
        return yield* new ModelServiceError({ detail: "The service repeated a model-list page." });
      cursors.add(cursor);
      url.searchParams.set(
        typeof body.nextPageToken === "string"
          ? "pageToken"
          : protocol === "anthropic-messages"
            ? "after_id"
            : "after",
        cursor,
      );
    }
    return yield* new ModelServiceError({
      detail: "The model list exceeded the pagination limit.",
    });
  },
  Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
  Effect.timeout("30 seconds"),
  Effect.mapError((error) =>
    isModelServiceError(error)
      ? error
      : new ModelServiceError({
          detail: "Could not fetch models. Check the URL, API key and model-list path.",
        }),
  ),
);

export const discoverModelService = Effect.fn("discoverModelService")(
  function* (input: ModelServiceDiscoveryInput) {
    const settings = yield* Settings.ServerSettingsService;
    const service = (yield* settings.getSettings).modelServices[input.serviceId];
    if (!service?.enabled)
      return yield* new ModelServiceError({ detail: "This model service is missing or disabled." });
    const discovered = input.metadataOnly
      ? service.models
      : yield* fetchModelServiceModels(service);
    const models = new Map(discovered.map((model) => [model.id, model]));
    for (const model of service.models) {
      const advertised = models.has(model.id);
      if (model.source === "manual") {
        if (!input.preview || advertised) models.set(model.id, model);
      } else if (!advertised) {
        if (!input.preview) models.set(model.id, { ...model, available: false });
      } else
        models.set(model.id, {
          ...models.get(model.id)!,
          ...(model.price ? { price: model.price } : {}),
          ...(model.modelsDevPrice ? { modelsDevPrice: model.modelsDevPrice } : {}),
          ...(model.encryptedReasoningReplay !== undefined
            ? { encryptedReasoningReplay: model.encryptedReasoningReplay }
            : {}),
        });
    }
    const catalog = input.preview
      ? null
      : yield* input.metadataOnly
          ? fetchModelsDevCatalog
          : fetchModelsDevCatalog.pipe(Effect.orElseSucceed(() => null));
    const current = (yield* settings.getSettings).modelServices[input.serviceId];
    if (!Equal.equals(current, service))
      return yield* new ModelServiceError({
        detail: "The model service changed during discovery. Retry with its current settings.",
      });
    const metadataIds = input.metadataModelIds && new Set(input.metadataModelIds);
    const result: ModelServiceDiscoveryResult = {
      models: [...models.values()].map((model) =>
        catalog && (!metadataIds || metadataIds.has(model.id))
          ? enrichModelFromModelsDev(model, catalog, service.baseUrl)
          : model,
      ),
      discoveredAt: DateTime.formatIso(yield* DateTime.now),
      revision: service.revision,
      fingerprint: yield* modelServiceFingerprint(service),
    };
    if (!input.preview)
      yield* settings.updateSettings({
        modelServices: {
          [input.serviceId]: {
            ...service,
            models: result.models,
            discoveredAt: result.discoveredAt,
          },
        },
      });
    return result;
  },
  Effect.mapError((error) =>
    isModelServiceError(error)
      ? error
      : new ModelServiceError({
          detail: "Could not save the model catalog. The previous catalog has been retained.",
        }),
  ),
);

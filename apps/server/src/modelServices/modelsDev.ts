import { ModelServiceError, type ModelServiceModel } from "@t3tools/contracts";
import { modelServiceDisplayName } from "@t3tools/shared/modelServices";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const positive = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
const strings = (value: unknown): ReadonlyArray<string> | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim())
    ? value
    : undefined;

interface CatalogEntry {
  readonly provider: string;
  readonly apiHost: string | undefined;
  readonly canonicalId: string | undefined;
  readonly model: ModelServiceModel;
}
export type ModelsDevCatalog = ReadonlyMap<string, ReadonlyArray<CatalogEntry>>;

export function parseModelsDevCatalog(value: unknown): ModelsDevCatalog {
  const index = new Map<string, CatalogEntry[]>();
  for (const [provider, rawProvider] of Object.entries(record(value))) {
    const info = record(rawProvider);
    let apiHost: string | undefined;
    try {
      apiHost = typeof info.api === "string" ? new URL(info.api).hostname : undefined;
    } catch {}
    for (const [key, value] of Object.entries(record(info.models))) {
      const raw = record(value);
      const id = typeof raw.id === "string" && raw.id.trim() ? raw.id : key;
      const name = typeof raw.name === "string" && raw.name.trim() ? raw.name : undefined;
      const limit = record(raw.limit);
      const modalities = record(raw.modalities);
      const input = strings(modalities.input);
      const output = strings(modalities.output);
      const context = positive(limit.context);
      const maxOutput = positive(limit.output);
      const efforts = Array.isArray(raw.reasoning_options)
        ? raw.reasoning_options.flatMap((option: unknown) => {
            const entry = record(option);
            return entry.type === "effort" ? (strings(entry.values) ?? []) : [];
          })
        : [];
      const entry: CatalogEntry = {
        provider,
        apiHost,
        canonicalId:
          typeof raw.canonical_model_id === "string" ? raw.canonical_model_id : undefined,
        model: {
          id,
          ...(name ? { name } : {}),
          capabilities: {
            ...(context ? { contextWindow: context } : {}),
            ...(input ? { supportsImages: input.includes("image") } : {}),
            ...(efforts.length
              ? {
                  optionDescriptors: [
                    {
                      id: "reasoningEffort",
                      label: "Reasoning",
                      type: "select",
                      options: [...new Set(efforts)].map((id) => ({ id, label: id })),
                    },
                  ],
                }
              : {}),
          },
          ...(maxOutput ? { maxOutputTokens: maxOutput } : {}),
          ...(input ? { inputModalities: input } : {}),
          ...(output ? { outputModalities: output } : {}),
          ...(typeof raw.tool_call === "boolean" ? { supportsTools: raw.tool_call } : {}),
          ...(typeof raw.reasoning === "boolean" ? { supportsReasoning: raw.reasoning } : {}),
        },
      };
      for (const alias of new Set([id, `${provider}/${id}`])) {
        const entries = index.get(alias) ?? [];
        entries.push(entry);
        index.set(alias, entries);
      }
    }
  }
  return index;
}

export function enrichModelFromModelsDev(
  model: ModelServiceModel,
  catalog: ModelsDevCatalog,
  baseUrl: string,
): ModelServiceModel {
  const candidates = catalog.get(model.id) ?? catalog.get(model.id.replace(/^models\//, "")) ?? [];
  const host = new URL(baseUrl).hostname;
  const hosted = candidates.filter((entry) => entry.apiHost === host);
  const canonical = candidates.filter(
    (entry) => entry.canonicalId === `${entry.provider}/${entry.model.id}`,
  );
  const pool = hosted.length ? hosted : canonical.length === 1 ? canonical : candidates;
  const match = pool[0]?.model;
  if (
    !match ||
    (pool.length > 1 && pool.some((entry) => JSON.stringify(entry.model) !== JSON.stringify(match)))
  )
    return model;
  const capabilities = {
    ...match.capabilities,
    ...Object.fromEntries(
      Object.entries(model.capabilities ?? {}).filter(([, value]) => value !== undefined),
    ),
  };
  return {
    ...match,
    ...model,
    name:
      model.source !== "manual" ||
      !model.name ||
      model.name === model.id ||
      model.name === modelServiceDisplayName(model.id)
        ? (match.name ?? model.name ?? modelServiceDisplayName(model.id))
        : model.name,
    capabilities: Object.keys(capabilities).length ? capabilities : null,
  };
}

const catalogs = new WeakMap<
  HttpClient.HttpClient,
  { readonly at: number; readonly catalog: ModelsDevCatalog }
>();

export const fetchModelsDevCatalog = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;
  const cached = catalogs.get(http);
  const now = yield* Clock.currentTimeMillis;
  if (cached && now - cached.at < 60 * 60 * 1000) return cached.catalog;
  const response = yield* http.execute(HttpClientRequest.get("https://models.dev/api.json"));
  if (response.status !== 200)
    return yield* new ModelServiceError({ detail: "Catalog unavailable" });
  const catalog = parseModelsDevCatalog(
    yield* response.json.pipe(
      Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(20 * 1024 * 1024)),
    ),
  );
  if (!catalog.size) return yield* new ModelServiceError({ detail: "Empty catalog" });
  catalogs.set(http, { at: now, catalog });
  return catalog;
}).pipe(
  Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
  Effect.timeout("8 seconds"),
  Effect.mapError(
    () =>
      new ModelServiceError({
        detail: "Could not fetch model metadata from models.dev. Try again later.",
      }),
  ),
);

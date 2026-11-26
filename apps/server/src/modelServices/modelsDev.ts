import {
  ModelServiceError,
  type ModelServiceModel,
  type ModelTokenPrice,
} from "@t3tools/contracts";
import { modelServiceDisplayName } from "@t3tools/shared/modelServices";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Equal from "effect/Equal";
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
  readonly price: ModelTokenPrice | undefined;
  readonly model: ModelServiceModel;
}
export interface ModelsDevCatalog {
  readonly models: ReadonlyMap<string, ReadonlyArray<CatalogEntry>>;
  readonly canonical: ReadonlyMap<string, ReadonlyArray<CatalogEntry>>;
}

function parsePrice(value: unknown): ModelTokenPrice | undefined {
  const cost = record(value);
  const rate = (raw: unknown) =>
    typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : undefined;
  const input = rate(cost.input);
  const output = rate(cost.output);
  if (input === undefined || output === undefined) return undefined;
  const cacheRead = rate(cost.cache_read);
  const cacheWrite = rate(cost.cache_write);
  return {
    inputCostPerMillionTokens: input,
    outputCostPerMillionTokens: output,
    ...(cacheRead === undefined ? {} : { cacheReadCostPerMillionTokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWriteCostPerMillionTokens: cacheWrite }),
  };
}

const add = (index: Map<string, CatalogEntry[]>, key: string, entry: CatalogEntry) => {
  const entries = index.get(key) ?? [];
  entries.push(entry);
  index.set(key, entries);
};

export function parseModelsDevCatalog(value: unknown): ModelsDevCatalog {
  const models = new Map<string, CatalogEntry[]>();
  const canonical = new Map<string, CatalogEntry[]>();
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
      const context = positive(limit.input) ?? positive(limit.context);
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
        price: parsePrice(raw.cost),
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
      for (const alias of new Set([id, `${provider}/${id}`])) add(models, alias, entry);
      if (entry.canonicalId) add(canonical, entry.canonicalId, entry);
    }
  }
  return { models, canonical };
}

const officialProviders: Readonly<Record<string, string>> = {
  "api.openai.com": "openai",
  "api.anthropic.com": "anthropic",
  "generativelanguage.googleapis.com": "google",
  "api.deepseek.com": "deepseek",
};

const ownedByVendor = (entry: CatalogEntry) =>
  entry.canonicalId?.startsWith(`${entry.provider}/`) === true;
const usedMetadata = (entry: ModelServiceModel) =>
  JSON.stringify([
    entry.capabilities,
    entry.maxOutputTokens,
    entry.supportsTools,
    entry.supportsReasoning,
  ]);
const consistent = (entries: ReadonlyArray<CatalogEntry>) =>
  entries.every((entry) => usedMetadata(entry.model) === usedMetadata(entries[0]!.model));

function modelsDevCandidates(
  model: ModelServiceModel,
  catalog: ModelsDevCatalog,
  baseUrl: string,
): {
  readonly direct: ReadonlyArray<CatalogEntry>;
  readonly entries: ReadonlyArray<CatalogEntry>;
  readonly sameId: boolean;
} {
  const candidates =
    catalog.models.get(model.id) ?? catalog.models.get(model.id.replace(/^models\//, "")) ?? [];
  const host = new URL(baseUrl).hostname;
  const hosted = candidates.filter((entry) => entry.apiHost === host);
  const firstParty = candidates.filter((entry) => entry.provider === officialProviders[host]);
  const canonical = candidates.filter(
    (entry) => entry.canonicalId === `${entry.provider}/${entry.model.id}`,
  );
  const direct = hosted.length
    ? hosted
    : firstParty.length
      ? firstParty
      : canonical.length === 1
        ? canonical
        : candidates;
  if (direct !== candidates || consistent(candidates))
    return { direct, entries: direct, sameId: true };
  const vendor = candidates.filter(ownedByVendor);
  if (vendor.length && consistent(vendor)) return { direct, entries: vendor, sameId: true };
  const vendorCopies = [
    ...new Set(
      candidates.flatMap((entry) =>
        entry.canonicalId ? (catalog.canonical.get(entry.canonicalId) ?? []) : [],
      ),
    ),
  ].filter(ownedByVendor);
  return vendorCopies.length && consistent(vendorCopies)
    ? { direct, entries: vendorCopies, sameId: false }
    : { direct, entries: candidates, sameId: true };
}

const agreedPrice = (entries: ReadonlyArray<CatalogEntry>) => {
  const first = entries[0]?.price;
  return first && entries.every((entry) => Equal.equals(first, entry.price)) ? first : undefined;
};

export function syncModelPriceFromModelsDev(
  model: ModelServiceModel,
  catalog: ModelsDevCatalog,
  baseUrl: string,
): ModelServiceModel {
  const { direct, entries } = modelsDevCandidates(model, catalog, baseUrl);
  const price = agreedPrice(direct) ?? agreedPrice(entries);
  if (Equal.equals(price, model.modelsDevPrice)) return model;
  const { modelsDevPrice: _previous, ...rest } = model;
  return price ? { ...rest, modelsDevPrice: price } : rest;
}

export function enrichModelFromModelsDev(
  model: ModelServiceModel,
  catalog: ModelsDevCatalog,
  baseUrl: string,
): ModelServiceModel {
  const { entries: pool, sameId } = modelsDevCandidates(model, catalog, baseUrl);
  model = syncModelPriceFromModelsDev(model, catalog, baseUrl);
  const match = pool[0]?.model;
  if (
    !match ||
    (pool.length > 1 && pool.some((entry) => usedMetadata(entry.model) !== usedMetadata(match)))
  )
    return model;
  const capabilities = {
    ...match.capabilities,
    ...Object.fromEntries(
      Object.entries(model.capabilities ?? {}).filter(([, value]) => value !== undefined),
    ),
  };
  const fallbackName = model.name ?? modelServiceDisplayName(model.id);
  return {
    ...match,
    ...model,
    name: !sameId
      ? fallbackName
      : model.source !== "manual" ||
          !model.name ||
          model.name === model.id ||
          model.name === modelServiceDisplayName(model.id)
        ? (match.name ?? fallbackName)
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
  if (!catalog.models.size) return yield* new ModelServiceError({ detail: "Empty catalog" });
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

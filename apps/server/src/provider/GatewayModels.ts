import type {
  CustomModelSetting,
  ModelCapabilities,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderModel,
} from "@t3tools/contracts";
import { providerModelsFromSettings } from "@t3tools/provider-core/server/snapshotProbe";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as ByteSize from "effect/ByteSize";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import { HttpClient, HttpClientRequest } from "effect/http";
import { ProviderDriverError } from "./Errors.ts";
import { gatewayBaseUrl } from "./gatewayConfiguration.ts";
import { withCodexUltraCapabilities } from "@t3tools/shared/model";

class GatewayModelDiscoveryError extends Schema.TaggedError<GatewayModelDiscoveryError>()(
  "GatewayModelDiscoveryError",
  { message: Schema.String },
) {}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function parseGatewayModel(
  value: unknown,
  driver: ProviderDriverKind,
): ServerProviderModel | null {
  const model = record(value);
  const slug = typeof model.id === "string" ? model.id.trim() : "";
  if (!slug) return null;
  const capabilities = record(model.capabilities);
  const architecture = record(model.architecture);
  const limits = record(model.limits);
  const context = [
    model.context_length,
    model.context_window,
    model.max_input_tokens,
    limits.context,
    capabilities.context_window,
  ].find(
    (candidate): candidate is number =>
      typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate > 0,
  );
  const modalities =
    model.input_modalities ?? architecture.input_modalities ?? capabilities.input_modalities;
  const imageFlag = [
    model.supports_images,
    model.supports_vision,
    capabilities.supports_images,
    capabilities.vision,
  ].find((candidate): candidate is boolean => typeof candidate === "boolean");
  const images =
    imageFlag ?? (Array.isArray(modalities) ? modalities.includes("image") : undefined);
  const rawEfforts =
    model.supported_reasoning_efforts ??
    model.supported_reasoning_levels ??
    model.reasoning_efforts ??
    capabilities.reasoning_efforts;
  const efforts = Array.isArray(rawEfforts)
    ? [
        ...new Set(
          rawEfforts.flatMap((value: unknown) => {
            const entry = record(value);
            const effort =
              typeof value === "string"
                ? value
                : (entry.effort ?? entry.reasoningEffort ?? entry.id);
            return typeof effort === "string" && effort.trim() ? [effort.trim()] : [];
          }),
        ),
      ]
    : [];
  const rawTiers =
    model.service_tiers ?? model.supported_service_tiers ?? capabilities.service_tiers;
  const tiers = Array.isArray(rawTiers)
    ? rawTiers.flatMap((value: unknown) => {
        const entry = record(value);
        const id = typeof value === "string" ? value : entry.id;
        if (typeof id !== "string" || !id.trim()) return [];
        const name = entry.name ?? entry.label;
        return [
          {
            id: id.trim(),
            label:
              typeof name === "string" && name.trim()
                ? name.trim()
                : id === "priority" || id === "fast"
                  ? "Fast"
                  : id === "default"
                    ? "Standard"
                    : id,
          },
        ];
      })
    : [];
  const tierDescriptor = tiers.length
    ? [
        {
          id: "serviceTier",
          label: "Service Tier",
          type: "select" as const,
          options: tiers.map((tier) => ({
            ...tier,
            ...(tier.id === model.default_service_tier ? { isDefault: true } : {}),
          })),
          ...(typeof model.default_service_tier === "string" &&
          tiers.some((tier) => tier.id === model.default_service_tier)
            ? { currentValue: model.default_service_tier }
            : {}),
        },
      ]
    : [];
  const metadata: ModelCapabilities = {
    ...(context !== undefined ? { contextWindow: context } : {}),
    ...(images !== undefined ? { supportsImages: images } : {}),
    ...(Array.isArray(rawEfforts) || tierDescriptor.length
      ? {
          optionDescriptors: [
            ...(efforts.length
              ? [
                  {
                    id: driver === "codex" ? "reasoningEffort" : "effort",
                    label: "Reasoning",
                    type: "select" as const,
                    options: efforts.map((effort) => ({ id: effort, label: effort })),
                  },
                ]
              : []),
            ...tierDescriptor,
          ],
        }
      : {}),
  };
  const name = model.display_name ?? model.name;
  return {
    slug,
    name: typeof name === "string" && name.trim() ? name.trim() : slug,
    isCustom: false,
    capabilities: Object.keys(metadata).length ? metadata : null,
  };
}

export const makeGatewayModels = Effect.fn("makeGatewayModels")(function* (input: {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly baseUrl?: string | undefined;
  readonly apiKey?: string | undefined;
  readonly customModels: ReadonlyArray<CustomModelSetting>;
}) {
  const http = yield* HttpClient.HttpClient;
  const models = yield* Ref.make<ReadonlyArray<ServerProviderModel> | null>(null);
  const attempted = yield* Ref.make(false);
  const refresh = Effect.gen(function* () {
    const base = yield* Effect.try(() =>
      gatewayBaseUrl(
        input.baseUrl,
        input.driver === "codex" ? "https://api.openai.com/v1" : "https://api.anthropic.com",
      ),
    );
    const endpoint = `${base}${input.driver === "claudeAgent" && !base.endsWith("/v1") ? "/v1" : ""}/models`;
    const found = new Map<string, ServerProviderModel>();
    let after: string | undefined;
    const cursors = new Set<string>();
    for (let page = 0; page < 20; page++) {
      const url = new URL(endpoint);
      if (after) url.searchParams.set(input.driver === "claudeAgent" ? "after_id" : "after", after);
      let request = HttpClientRequest.get(url.href);
      if (input.apiKey) request = request.pipe(HttpClientRequest.bearerToken(input.apiKey));
      if (input.driver === "claudeAgent") {
        request = request.pipe(HttpClientRequest.setHeader("anthropic-version", "2023-06-01"));
        if (input.apiKey)
          request = request.pipe(HttpClientRequest.setHeader("x-api-key", input.apiKey));
      }
      const response = yield* http.execute(request);
      if (response.status !== 200)
        return yield* new GatewayModelDiscoveryError({
          message: `Gateway model discovery failed (HTTP ${response.status}).`,
        });
      const body = record(
        yield* response.json.pipe(
          Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(4 * 1024 * 1024)),
        ),
      );
      if (!Array.isArray(body.data))
        return yield* new GatewayModelDiscoveryError({
          message: "Gateway did not return a models data array.",
        });
      for (const value of body.data) {
        const model = parseGatewayModel(value, input.driver);
        if (model) found.set(model.slug, model);
      }
      if (body.has_more !== true) {
        yield* Ref.set(models, [...found.values()]);
        return;
      }
      const cursor = body.last_id;
      if (typeof cursor !== "string" || !cursor || cursors.has(cursor)) break;
      cursors.add(cursor);
      after = cursor;
    }
    return yield* new GatewayModelDiscoveryError({
      message: "Gateway model pagination could not be completed.",
    });
  }).pipe(
    Effect.timeout("20 seconds"),
    Effect.mapError(
      () =>
        new ProviderDriverError({
          driver: input.driver,
          instanceId: input.instanceId,
          detail:
            "Could not refresh gateway models. Check the API URL, API key, and gateway model-list support.",
        }),
    ),
    Effect.provideService(HttpClient.HttpClient, http),
  );
  return {
    refresh,
    apply: Effect.fn("GatewayModels.apply")(function* (snapshot: ServerProvider) {
      if (!snapshot.enabled) return snapshot;
      if (!(yield* Ref.getAndSet(attempted, true))) yield* refresh.pipe(Effect.ignore);
      return {
        ...snapshot,
        models: providerModelsFromSettings(
          (yield* Ref.get(models)) ?? [],
          input.customModels,
          null,
        ).map((model) =>
          input.driver === "codex"
            ? { ...model, capabilities: withCodexUltraCapabilities(model.capabilities) }
            : model,
        ),
      };
    }),
  };
});

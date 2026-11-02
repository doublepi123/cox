import type { ServerProviderModel } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";
import { mapCodexModelCapabilities } from "./CodexProvider.ts";

export class ChatGptCatalogError extends Schema.TaggedError<ChatGptCatalogError>()(
  "ChatGptCatalogError",
  { status: Schema.Int },
) {}

const Catalog = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      slug: Schema.NonEmptyString,
      display_name: Schema.NonEmptyString,
      visibility: Schema.String,
      additional_speed_tiers: Schema.optionalKey(
        Schema.NullOr(Schema.Array(Schema.NonEmptyString)),
      ),
      default_service_tier: Schema.optionalKey(Schema.NullOr(Schema.NonEmptyString)),
      service_tiers: Schema.optionalKey(
        Schema.NullOr(
          Schema.Array(
            Schema.Struct({
              id: Schema.NonEmptyString,
              name: Schema.NonEmptyString,
              description: Schema.optionalKey(Schema.NullOr(Schema.String)),
            }),
          ),
        ),
      ),
      default_reasoning_level: Schema.optionalKey(Schema.NullOr(Schema.NonEmptyString)),
      supported_reasoning_levels: Schema.optionalKey(
        Schema.NullOr(
          Schema.Array(
            Schema.Struct({
              effort: Schema.NonEmptyString,
              description: Schema.optionalKey(Schema.NullOr(Schema.String)),
            }),
          ),
        ),
      ),
    }),
  ),
});

export const chatGptModels = Effect.fn("chatGptModels")(function* (
  accessToken: string,
  nativeModels: ReadonlyArray<ServerProviderModel>,
) {
  const http = yield* HttpClient.HttpClient;
  const response = yield* http.execute(
    HttpClientRequest.get("https://api.openai.com/v1/models").pipe(
      HttpClientRequest.bearerToken(accessToken),
    ),
  );
  if (response.status !== 200) return yield* new ChatGptCatalogError({ status: response.status });
  const catalog = yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Catalog)));
  return catalog.models
    .filter((model) => model.visibility === "list")
    .map((model): ServerProviderModel => {
      const native = nativeModels.find((candidate) => candidate.slug === model.slug);
      // A pinned Codex CLI can predate a model the account already has; the catalog still lists its efforts.
      const catalogCapabilities =
        model.supported_reasoning_levels?.length ||
        model.additional_speed_tiers?.length ||
        model.service_tiers?.length
          ? mapCodexModelCapabilities({
              id: model.slug,
              model: model.slug,
              displayName: model.display_name,
              description: "",
              hidden: false,
              isDefault: false,
              defaultReasoningEffort: model.default_reasoning_level ?? "medium",
              supportedReasoningEfforts: (model.supported_reasoning_levels ?? []).map((level) => ({
                reasoningEffort: level.effort,
                description: level.description ?? "",
              })),
              additionalSpeedTiers: model.additional_speed_tiers ?? [],
              defaultServiceTier: model.default_service_tier ?? null,
              serviceTiers:
                model.service_tiers?.map((tier) => ({
                  id: tier.id,
                  name: tier.name,
                  description: tier.description ?? "",
                })) ?? [],
            })
          : null;
      const nativeCapabilities = native?.capabilities;
      const capabilities = nativeCapabilities
        ? {
            ...nativeCapabilities,
            optionDescriptors: [
              ...(nativeCapabilities.optionDescriptors ?? []),
              ...(catalogCapabilities?.optionDescriptors?.filter(
                (descriptor) =>
                  !nativeCapabilities.optionDescriptors?.some(
                    (existing) => existing.id === descriptor.id,
                  ),
              ) ?? []),
            ],
          }
        : catalogCapabilities;
      return {
        ...native,
        capabilities,
        slug: model.slug,
        name: model.display_name,
        isCustom: false,
      };
    });
}, Effect.timeout("15 seconds"));

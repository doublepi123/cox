import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import { ModelCapabilities } from "./model.ts";

import { ModelServiceId } from "./modelServiceBinding.ts";
export { ModelServiceId, ModelServiceBinding } from "./modelServiceBinding.ts";

export const ModelServiceProtocol = Schema.Literals([
  "openai-responses",
  "openai-chat",
  "anthropic-messages",
  "gemini",
]);
export type ModelServiceProtocol = typeof ModelServiceProtocol.Type;

export const ModelServiceBaseUrl = TrimmedNonEmptyString.check(
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);
      return (
        (["https:", "http:"].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash) ||
        "Use an HTTP(S) base URL without credentials, query or fragment."
      );
    } catch {
      return "Use an HTTP(S) base URL without credentials, query or fragment.";
    }
  }),
);

export const ModelServiceModel = Schema.Struct({
  id: TrimmedNonEmptyString,
  available: Schema.optionalKey(Schema.Boolean),
  name: Schema.optionalKey(TrimmedNonEmptyString),
  protocols: Schema.optionalKey(Schema.Array(ModelServiceProtocol)),
  capabilities: Schema.NullOr(ModelCapabilities).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  supportsTools: Schema.optionalKey(Schema.Boolean),
  maxOutputTokens: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  inputModalities: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  outputModalities: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  supportsReasoning: Schema.optionalKey(Schema.Boolean),
  source: Schema.optionalKey(Schema.Literals(["discovered", "manual"])),
});
export type ModelServiceModel = typeof ModelServiceModel.Type;

export const ModelServiceConfig = Schema.Struct({
  name: TrimmedNonEmptyString,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
    Schema.withDecodingDefault(Effect.succeed(0)),
  ),
  baseUrl: ModelServiceBaseUrl,
  apiKey: Schema.optionalKey(TrimmedString).pipe(Schema.annotateKey({ settingsSecret: true })),
  headers: Schema.Record(Schema.String, Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
    Schema.annotateKey({ settingsSecret: true }),
  ),
  protocols: Schema.NonEmptyArray(ModelServiceProtocol),
  modelsPath: Schema.optionalKey(TrimmedString),
  models: Schema.Array(ModelServiceModel).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  discoveredAt: Schema.optionalKey(Schema.String),
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
export type ModelServiceConfig = typeof ModelServiceConfig.Type;

export const ModelServiceDiscoveryInput = Schema.Struct({
  serviceId: ModelServiceId,
  metadataOnly: Schema.optionalKey(Schema.Boolean),
});
export const ModelServiceDiscoveryResult = Schema.Struct({
  models: Schema.Array(ModelServiceModel),
  discoveredAt: Schema.String,
});
export type ModelServiceDiscoveryResult = typeof ModelServiceDiscoveryResult.Type;
export class ModelServiceError extends Schema.TaggedError<ModelServiceError>()(
  "ModelServiceError",
  {
    detail: Schema.String,
    status: Schema.optionalKey(Schema.Literals([400, 422, 501, 502, 503])),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

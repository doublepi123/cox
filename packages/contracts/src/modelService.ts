import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import { ModelCapabilities } from "./model.ts";

import { ModelServiceId, ModelServiceBinding } from "./modelServiceBinding.ts";
export { ModelServiceId, ModelServiceBinding } from "./modelServiceBinding.ts";

export const ModelServiceProtocol = Schema.Literals([
  "openai-responses",
  "openai-chat",
  "anthropic-messages",
  "gemini",
]);
export type ModelServiceProtocol = typeof ModelServiceProtocol.Type;

export const ModelServiceEncryptedReasoningReplay = Schema.Literals(["preserve", "omit"]);
export type ModelServiceEncryptedReasoningReplay = typeof ModelServiceEncryptedReasoningReplay.Type;

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
  ignored: Schema.optionalKey(Schema.Boolean),
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
  encryptedReasoningReplay: Schema.optionalKey(ModelServiceEncryptedReasoningReplay),
  source: Schema.optionalKey(Schema.Literals(["discovered", "manual"])),
});
export type ModelServiceModel = typeof ModelServiceModel.Type;

const boundedInteger = (minimum: number, maximum: number, fallback: number) =>
  Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(minimum),
    Schema.isLessThanOrEqualTo(maximum),
  ).pipe(Schema.withDecodingDefault(Effect.succeed(fallback)));

export const ModelServiceRecovery = Schema.Struct({
  retryEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  retryOn429: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  retryNonTransientErrors: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  retryToolRequests: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  hedgeEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  hedgeDelayMs: boundedInteger(100, 600_000, 30_000),
  reasoningHedgeDelayMs: boundedInteger(100, 600_000, 60_000),
  maxAttempts: boundedInteger(1, 100, 12),
  budgetMs: boundedInteger(100, 1_800_000, 600_000),
  responseHeadersTimeoutMs: boundedInteger(100, 1_800_000, 300_000),
  maxConcurrent: boundedInteger(1, 10, 5),
});
export type ModelServiceRecovery = typeof ModelServiceRecovery.Type;
export const DEFAULT_MODEL_SERVICE_RECOVERY = Schema.decodeSync(ModelServiceRecovery)({});

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
  encryptedReasoningReplay: Schema.optionalKey(ModelServiceEncryptedReasoningReplay),
  recovery: ModelServiceRecovery.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_MODEL_SERVICE_RECOVERY)),
  ),
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

export const ModelServiceTestInput = Schema.Struct({
  serviceId: ModelServiceId,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  modelId: TrimmedNonEmptyString,
});
export type ModelServiceTestInput = typeof ModelServiceTestInput.Type;
export const ModelServiceTestResult = Schema.Struct({
  modelId: TrimmedNonEmptyString,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  ok: Schema.Boolean,
  protocol: Schema.NullOr(ModelServiceProtocol),
  durationMs: Schema.Number,
  message: Schema.NullOr(Schema.String),
});
export type ModelServiceTestResult = typeof ModelServiceTestResult.Type;

export const OmoRoleName = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),
  Schema.makeFilter((name) => !["__proto__", "prototype", "constructor"].includes(name)),
);
export const MAX_OMO_RECOMMENDATION_PROMPT_LENGTH = 32_000;
export const OmoRecommendationPrompt = Schema.String.check(
  Schema.isMaxLength(MAX_OMO_RECOMMENDATION_PROMPT_LENGTH),
);
const isOmoRoleName = Schema.is(OmoRoleName);
export const OMO_REASONING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export const OmoReasoningLevel = Schema.Literals(OMO_REASONING_LEVELS);
export type OmoReasoningLevel = typeof OmoReasoningLevel.Type;
export const OmoRoleReasoning = Schema.Record(
  Schema.String,
  Schema.Union([Schema.Literal(""), OmoReasoningLevel]),
).check(Schema.makeFilter((roles) => Object.keys(roles).every(isOmoRoleName)));
const OmoRecommendedRoleModels = Schema.Record(Schema.String, TrimmedNonEmptyString).check(
  Schema.makeFilter((roles) => Object.keys(roles).every(isOmoRoleName)),
);
export const ModelServiceRecommendOmoModelsInput = Schema.Struct({
  serviceId: ModelServiceId,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  modelId: TrimmedNonEmptyString,
  binding: ModelServiceBinding,
  agents: Schema.Array(OmoRoleName),
  categories: Schema.Array(OmoRoleName),
  prompt: Schema.optionalKey(OmoRecommendationPrompt),
});
export type ModelServiceRecommendOmoModelsInput = typeof ModelServiceRecommendOmoModelsInput.Type;
export const ModelServiceRecommendOmoModelsResult = Schema.Struct({
  agentModels: OmoRecommendedRoleModels,
  categoryModels: OmoRecommendedRoleModels,
  agentReasoning: OmoRoleReasoning,
  categoryReasoning: OmoRoleReasoning,
  explanation: TrimmedNonEmptyString,
});
export type ModelServiceRecommendOmoModelsResult = typeof ModelServiceRecommendOmoModelsResult.Type;
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

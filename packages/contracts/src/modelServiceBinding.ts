import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ModelServiceId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-zA-Z][a-zA-Z0-9_-]*$/),
).pipe(Schema.brand("ModelServiceId"));
export type ModelServiceId = typeof ModelServiceId.Type;
export const ModelServiceModelRef = Schema.Struct({
  serviceId: ModelServiceId,
  modelId: TrimmedNonEmptyString,
});
export type ModelServiceModelRef = typeof ModelServiceModelRef.Type;

export const ModelServiceSource = Schema.Struct({
  serviceId: ModelServiceId,
  modelIds: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type ModelServiceSource = typeof ModelServiceSource.Type;

export const ModelServiceBinding = Schema.Struct({
  serviceId: Schema.optionalKey(ModelServiceId),
  modelIds: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  defaultModel: Schema.optionalKey(TrimmedNonEmptyString),
  sources: Schema.optionalKey(Schema.NonEmptyArray(ModelServiceSource)),
  defaultModelRef: Schema.optionalKey(ModelServiceModelRef),
  legacyAliases: Schema.optionalKey(
    Schema.Array(Schema.Struct({ id: TrimmedNonEmptyString, model: ModelServiceModelRef })),
  ),
}).check(
  Schema.makeFilter((binding) =>
    binding.sources
      ? binding.serviceId === undefined &&
        binding.defaultModel === undefined &&
        binding.modelIds.length === 0
      : binding.serviceId !== undefined &&
        binding.defaultModelRef === undefined &&
        binding.legacyAliases === undefined,
  ),
);
export type ModelServiceBinding = typeof ModelServiceBinding.Type;

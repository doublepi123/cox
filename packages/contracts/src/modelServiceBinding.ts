import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ModelServiceId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-zA-Z][a-zA-Z0-9_-]*$/),
).pipe(Schema.brand("ModelServiceId"));
export type ModelServiceId = typeof ModelServiceId.Type;
export const ModelServiceBinding = Schema.Struct({
  serviceId: ModelServiceId,
  modelIds: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  defaultModel: Schema.optionalKey(TrimmedNonEmptyString),
});
export type ModelServiceBinding = typeof ModelServiceBinding.Type;

import * as Schema from "effect/Schema";

const TokenPrice = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0));

export const ModelTokenPrice = Schema.Struct({
  inputCostPerMillionTokens: TokenPrice,
  outputCostPerMillionTokens: TokenPrice,
  cacheReadCostPerMillionTokens: Schema.optionalKey(TokenPrice),
  cacheWriteCostPerMillionTokens: Schema.optionalKey(TokenPrice),
});
export type ModelTokenPrice = typeof ModelTokenPrice.Type;

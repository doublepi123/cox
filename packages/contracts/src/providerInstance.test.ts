import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ProviderInstanceEnvironmentVariable } from "./providerInstance.ts";

const decodeEnvironmentVariable = Schema.decodeUnknownSync(ProviderInstanceEnvironmentVariable);
const encodeEnvironmentVariable = Schema.encodeSync(ProviderInstanceEnvironmentVariable);

describe("ProviderInstanceEnvironmentVariable", () => {
  it("treats a stored reference as sensitive even when the flag is missing or false", () => {
    const secret = { provider: "onepassword", reference: "op://Private/item/field" };
    expect(decodeEnvironmentVariable({ name: "API_KEY", secret })).toMatchObject({
      value: secret,
      sensitive: true,
    });
    expect(decodeEnvironmentVariable({ name: "API_KEY", sensitive: false, secret }).sensitive).toBe(
      true,
    );
  });

  it("preserves sensitivity and the reference when encoded again", () => {
    const secret = { provider: "onepassword", reference: "op://Private/item/field" };
    const decoded = decodeEnvironmentVariable({ name: "API_KEY", secret, sensitive: false });
    expect(encodeEnvironmentVariable(decoded)).toEqual({
      name: "API_KEY",
      value: "",
      secret,
      sensitive: true,
    });
    expect(decodeEnvironmentVariable({ name: "BASE_URL", value: "https://example.test" })).toEqual({
      name: "BASE_URL",
      value: "https://example.test",
      sensitive: false,
    });
  });
});

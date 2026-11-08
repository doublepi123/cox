import { secretReferencesInSettings, withSettingsSecrets } from "@t3tools/contracts";
import type * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";

export const resolveSettingsSecrets = Effect.fn("SettingsSecrets.resolve")(function* <
  Settings extends Readonly<Record<string, unknown>>,
>(resolver: SecretResolver.SecretResolver["Service"], schema: Schema.Top, settings: Settings) {
  const pending = secretReferencesInSettings(schema, settings);
  if (pending.length === 0) return settings;
  const values = yield* resolver.read(pending.map(({ reference }) => reference));
  return withSettingsSecrets(
    settings,
    pending.flatMap((slot, index) => {
      const value = values[index];
      return value === undefined || value.trim() === "" ? [] : [{ ...slot, value }];
    }),
  );
});

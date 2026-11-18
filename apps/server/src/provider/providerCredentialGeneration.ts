import type {
  ProviderInstanceConfig,
  ResolvedProviderInstanceEnvironment,
  SettingsSecretSlot,
} from "@t3tools/contracts";
import { modelServiceSources } from "@t3tools/shared/modelServices";

export interface ProviderCredentialSecrets {
  readonly environment: ResolvedProviderInstanceEnvironment;
  readonly config: ReadonlyArray<SettingsSecretSlot & { readonly value: string }>;
}

export interface ProviderCredentialFingerprint {
  readonly driver: ProviderInstanceConfig["driver"];
  readonly enabled: boolean;
  readonly modelServiceIds: ReadonlyArray<string>;
  readonly environment: ReadonlyArray<readonly [string, string]>;
  readonly configSecrets: ReadonlyArray<readonly [string, string | undefined, string]>;
}

export function makeProviderCredentialFingerprint(
  entry: ProviderInstanceConfig,
  enabled: boolean,
  secrets: ProviderCredentialSecrets,
): ProviderCredentialFingerprint {
  return {
    driver: entry.driver,
    enabled,
    modelServiceIds: entry.modelService
      ? modelServiceSources(entry.modelService)
          .map((source) => source.serviceId)
          .toSorted()
      : [],
    environment: secrets.environment.map((item) => [item.name, item.value] as const),
    configSecrets: secrets.config.map((slot) => [slot.field, slot.key, slot.value] as const),
  };
}

export function sameProviderCredentialFingerprint(
  left: ProviderCredentialFingerprint,
  right: ProviderCredentialFingerprint,
): boolean {
  return (
    left.driver === right.driver &&
    left.enabled === right.enabled &&
    left.modelServiceIds.length === right.modelServiceIds.length &&
    left.modelServiceIds.every((id, index) => right.modelServiceIds[index] === id) &&
    left.environment.length === right.environment.length &&
    left.environment.every(
      ([name, value], index) =>
        right.environment[index]?.[0] === name && right.environment[index]?.[1] === value,
    ) &&
    left.configSecrets.length === right.configSecrets.length &&
    left.configSecrets.every(
      ([field, key, value], index) =>
        right.configSecrets[index]?.[0] === field &&
        right.configSecrets[index]?.[1] === key &&
        right.configSecrets[index]?.[2] === value,
    )
  );
}

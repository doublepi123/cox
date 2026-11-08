import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  SecretProviderId,
  SecretProviderKind,
  type ServerSettings,
} from "@t3tools/contracts";
import {
  mapSettingsSecretValues,
  withoutRemovedSecretProviderReferences,
} from "./settingsSecrets.ts";

const removed = SecretProviderId.make("removed");
const kept = SecretProviderId.make("kept");
const instanceId = ProviderInstanceId.make("pi_secrets");
const reference = { provider: removed, reference: "op://Private/item/field" };
const retained = { provider: kept, reference: "op://Work/item/field" };
const provider = {
  kind: SecretProviderKind.make("one_password"),
  label: "Vault",
  config: { account: "test" },
};
const settings: ServerSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  secretProviders: { [removed]: provider, [kept]: provider },
  sourceControlHosts: {
    gitcafe: { token: reference },
    bitbucket: { accessToken: retained, email: "me@example.test" },
  },
  providerInstances: {
    [instanceId]: {
      driver: ProviderDriverKind.make("pi"),
      config: { apiKey: reference, agentDir: "/configured" },
      environment: [
        { name: "TOKEN", value: reference, sensitive: true },
        { name: "RETAINED", value: retained, sensitive: true },
        { name: "BASE_URL", value: "https://example.test", sensitive: false },
      ],
    },
  },
};

describe("removed secret provider references", () => {
  it("clears only credentials referencing a removed provider, without mutating saved settings", () => {
    const next = { ...settings, secretProviders: { [kept]: provider } };
    const cleaned = withoutRemovedSecretProviderReferences(settings, next);
    expect(cleaned.sourceControlHosts.gitcafe?.token).toBe("");
    expect(cleaned.sourceControlHosts.bitbucket).toEqual(settings.sourceControlHosts.bitbucket);
    expect(cleaned.providerInstances[instanceId]?.config).toEqual({
      apiKey: "",
      agentDir: "/configured",
    });
    expect(cleaned.providerInstances[instanceId]?.environment).toEqual(
      settings.providerInstances[instanceId]?.environment?.slice(1),
    );
    expect(settings.sourceControlHosts.gitcafe?.token).toEqual(reference);
    expect(settings.providerInstances[instanceId]?.environment).toHaveLength(3);
  });

  it("leaves unchanged settings and provider variables alone during field mapping", () => {
    expect(withoutRemovedSecretProviderReferences(settings, settings)).toBe(settings);
    const slots: string[] = [];
    const mapped = mapSettingsSecretValues(settings, (value, name) => {
      slots.push(name);
      return typeof value === "string" ? value : "replaced";
    });
    expect(mapped.sourceControlHosts.gitcafe?.token).toBe("replaced");
    expect(mapped.providerInstances[instanceId]?.environment).toEqual(
      settings.providerInstances[instanceId]?.environment,
    );
    expect(new Set(slots).size).toBe(slots.length);
  });
});

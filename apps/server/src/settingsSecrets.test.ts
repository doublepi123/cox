import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  SecretProviderId,
  SecretProviderKind,
  type ServerSettings,
  NotificationWebhookChannel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { SecretResolver } from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import * as ServerConfig from "./config.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as Settings from "./serverSettings.ts";
import { resolveWebhookChannelSecret } from "./notifications/WebhookNotificationService.ts";
import {
  mapSettingsSecretValues,
  SECRET_REDACTED,
  withoutRemovedSecretProviderReferences,
} from "./settingsSecrets.ts";

const removed = SecretProviderId.make("removed");
const kept = SecretProviderId.make("kept");
const instanceId = ProviderInstanceId.make("pi_secrets");
const reference = { provider: removed, reference: "op://Private/item/field" };
const retained = { provider: kept, reference: "op://Work/item/field" };
const decodeWebhookChannel = Schema.decodeSync(NotificationWebhookChannel);
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
  it.each(["omo", "omp"])(
    "handles %s API keys through the same secret mapping and removal flow",
    (driver) => {
      const current = {
        ...settings,
        providerInstances: {
          [instanceId]: {
            ...settings.providerInstances[instanceId]!,
            driver: ProviderDriverKind.make(driver),
          },
        },
      };
      const mapped = mapSettingsSecretValues(current, (value) =>
        typeof value === "string" ? value : "replaced",
      );
      expect(mapped.providerInstances[instanceId]?.config).toEqual({
        apiKey: "replaced",
        agentDir: "/configured",
      });
      const cleaned = withoutRemovedSecretProviderReferences(current, {
        ...current,
        secretProviders: { [kept]: provider },
      });
      expect(cleaned.providerInstances[instanceId]?.config).toEqual({
        apiKey: "",
        agentDir: "/configured",
      });
    },
  );
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

describe("webhook secret persistence", () => {
  it("stores, redacts, preserves, clears and removes channel credentials through settings patches", async () => {
    const channel = decodeWebhookChannel({
      id: "private/channel",
      label: "Private channel",
      provider: "json",
      url: "https://example.test/hook",
      secret: "webhook-private-key",
      events: ["human_attention"],
    });
    const layer = Settings.layer.pipe(
      Layer.provideMerge(ServerSecretStore.layer),
      Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "cox-webhook-secrets-" })),
      Layer.provideMerge(NodeServices.layer),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* Settings.ServerSettingsService;
        const store = yield* ServerSecretStore.ServerSecretStore;
        const fs = yield* FileSystem.FileSystem;
        const config = yield* ServerConfig.ServerConfig;
        const name = `notifications.webhook.${Buffer.from(channel.id).toString("base64url")}.secret`;
        const saved = yield* service.updateSettings({ notifications: { webhooks: [channel] } });
        const redacted = Settings.redactServerSettingsForClient(saved).notifications.webhooks[0];
        expect(redacted?.secret).toBe(SECRET_REDACTED);
        expect(yield* store.get(name)).toEqual(
          Option.some(new TextEncoder().encode("webhook-private-key")),
        );
        expect(yield* fs.readFileString(config.settingsPath)).not.toContain("webhook-private-key");
        const sentinel = { ...channel, secret: SECRET_REDACTED };
        yield* service.updateSettings({ notifications: { webhooks: [sentinel] } });
        expect((yield* service.getSettings).notifications.webhooks[0]?.secret).toBe(
          "webhook-private-key",
        );
        expect(
          yield* resolveWebhookChannelSecret(sentinel).pipe(
            Effect.provideService(ServerSecretStore.ServerSecretStore, store),
            Effect.provideService(SecretResolver, {
              read: () => Effect.succeed([]),
              invalidate: () => Effect.void,
              label: () => Effect.succeed(""),
            }),
          ),
        ).toBe("webhook-private-key");
        yield* service.updateSettings({
          notifications: { webhooks: [{ ...channel, secret: "" }] },
        });
        expect(yield* store.get(name)).toEqual(Option.none());
        expect((yield* service.getSettings).notifications.webhooks[0]?.secret).toBe("");
        yield* service.updateSettings({ notifications: { webhooks: [channel] } });
        yield* service.updateSettings({ notifications: { webhooks: [] } });
        expect(yield* store.get(name)).toEqual(Option.none());
      }).pipe(Effect.provide(layer), Effect.scoped),
    );
  });

  it("removes webhook references when their secret provider is removed", () => {
    const channel = decodeWebhookChannel({
      id: "reference",
      label: "Reference",
      provider: "json",
      url: "https://example.test/hook",
      secret: reference,
      events: [],
    });
    const current = {
      ...settings,
      notifications: { ...settings.notifications, webhooks: [channel] },
    };
    const cleaned = withoutRemovedSecretProviderReferences(current, {
      ...current,
      secretProviders: { [kept]: provider },
    });
    expect(cleaned.notifications.webhooks[0]?.secret).toBe("");
  });
});

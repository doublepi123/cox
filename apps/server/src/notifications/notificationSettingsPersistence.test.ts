import * as NodeServices from "@effect/platform-node/NodeServices";
import { NotificationWebhookChannel, ServerSettings } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as Secrets from "../auth/ServerSecretStore.ts";
import * as Config from "../config.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Settings from "../serverSettings.ts";

const decodeSettings = Schema.decodeUnknownSync(Schema.fromJsonString(ServerSettings));
const channel = Schema.decodeSync(NotificationWebhookChannel)({
  id: "phone",
  label: "Phone",
  provider: "json",
  url: "https://hooks.example.com",
  secret: "private-token",
  events: ["human_attention"],
});
const dependencies = Settings.layer.pipe(
  Layer.provideMerge(Secrets.layer),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "notification-settings-" })),
  Layer.provideMerge(NodeServices.layer),
);

it("persists and reloads the public origin while retaining channels and their vaulted secrets", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const settings = yield* Settings.ServerSettingsService;
        const config = yield* Config.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        yield* settings.updateSettings({
          notifications: { webPushEnabled: false, webhooks: [channel] },
        });
        yield* settings.updateSettings({
          notifications: { publicBaseUrl: "https://cox.example.com" },
        });
        const persistedText = yield* fs.readFileString(config.settingsPath);
        const persisted = decodeSettings(persistedText);
        expect(persisted.notifications).toMatchObject({
          publicBaseUrl: "https://cox.example.com",
          webPushEnabled: false,
          webhooks: [{ id: "phone", label: "Phone" }],
        });
        expect(persistedText).not.toContain("private-token");
        const reloaded = yield* Effect.flatMap(
          Settings.ServerSettingsService,
          (service) => service.getSettings,
        ).pipe(Effect.provide(Layer.fresh(Settings.layer).pipe(Layer.provide(Secrets.layer))));
        expect(reloaded.notifications).toEqual((yield* settings.getSettings).notifications);
        yield* settings.updateSettings({ notifications: { publicBaseUrl: null } });
        expect(decodeSettings(yield* fs.readFileString(config.settingsPath)).notifications).toEqual(
          {
            ...persisted.notifications,
            publicBaseUrl: null,
          },
        );
      }).pipe(Effect.provide(dependencies)),
    ),
  );
});

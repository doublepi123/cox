import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  MAX_NOTIFICATION_WEBHOOKS,
  MobileNotificationSettings,
  NotificationPublicBaseUrl,
  NotificationWebhookChannel,
} from "./notifications.ts";
import { DEFAULT_SERVER_SETTINGS, ServerSettings, ServerSettingsPatch } from "./settings.ts";

const decodeNotificationSettings = Schema.decodeUnknownSync(MobileNotificationSettings);
const decodeChannel = Schema.decodeUnknownSync(NotificationWebhookChannel);
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const encodeServerSettings = Schema.encodeSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const decodeOrigin = Schema.decodeUnknownSync(NotificationPublicBaseUrl);
const webhookChannel = (id = "bark-phone") => ({
  id,
  label: "Bark on my phone",
  provider: "bark",
  url: "https://api.day.app/abcdef/",
  events: ["turn_failed", "human_attention"],
});

describe("notification public server origin", () => {
  it.each(["https://cox.example.com", "http://192.0.2.10:4773", "https://[2001:db8::1]/"])(
    "accepts the HTTP(S) origin %s",
    (origin) => expect(decodeOrigin(origin)).toBe(origin),
  );
  it.each([
    "/environment/thread",
    "https://cox.example.com/foo",
    "https://user:secret@cox.example.com",
    "https://user@cox.example.com",
    "https://cox.example.com?q=1",
    "https://cox.example.com#thread",
    "javascript:alert(1)",
    "ftp://cox.example.com",
    "not a url",
    `https://${"a".repeat(2040)}.com`,
  ])("rejects a non-origin notification base URL %s", (origin) => {
    expect(() => decodeOrigin(origin)).toThrow();
  });
});

describe("mobile notification settings", () => {
  it("defaults web push on with an empty webhook list and no public origin", () => {
    expect(decodeNotificationSettings({})).toEqual({
      publicBaseUrl: null,
      webPushEnabled: true,
      webhooks: [],
    });
  });
  it(`allows at most ${MAX_NOTIFICATION_WEBHOOKS} webhooks`, () => {
    const channels = Array.from({ length: MAX_NOTIFICATION_WEBHOOKS }, (_, index) =>
      webhookChannel(`channel-${index}`),
    );
    expect(decodeNotificationSettings({ webhooks: channels }).webhooks).toHaveLength(
      MAX_NOTIFICATION_WEBHOOKS,
    );
    expect(() =>
      decodeNotificationSettings({ webhooks: [...channels, webhookChannel("one-too-many")] }),
    ).toThrow();
  });
});

describe("server settings integration", () => {
  it("defaults notifications in ServerSettings and DEFAULT_SERVER_SETTINGS", () => {
    const defaults = { publicBaseUrl: null, webPushEnabled: true, webhooks: [] };
    expect(decodeServerSettings({}).notifications).toEqual(defaults);
    expect(DEFAULT_SERVER_SETTINGS.notifications).toEqual(defaults);
  });
  it("round-trips a webhook and public origin through the server settings envelope", () => {
    const decoded = decodeServerSettings({
      notifications: {
        publicBaseUrl: "https://cox.example.com",
        webPushEnabled: false,
        webhooks: [webhookChannel()],
      },
    });
    expect(decoded.notifications).toEqual({
      publicBaseUrl: "https://cox.example.com",
      webPushEnabled: false,
      webhooks: [decodeChannel(webhookChannel())],
    });
    expect(decodeServerSettings(encodeServerSettings(decoded)).notifications).toEqual(
      decoded.notifications,
    );
  });
  it("decodes notification patches without filling unrelated keys", () => {
    expect(decodeServerSettingsPatch({ notifications: { webPushEnabled: false } })).toEqual({
      notifications: { webPushEnabled: false },
    });
    expect(
      decodeServerSettingsPatch({ notifications: { webhooks: [webhookChannel()] } }).notifications
        ?.webhooks,
    ).toEqual([decodeChannel(webhookChannel())]);
    for (const publicBaseUrl of [null, "https://cox.example.com"]) {
      expect(decodeServerSettingsPatch({ notifications: { publicBaseUrl } })).toEqual({
        notifications: { publicBaseUrl },
      });
    }
  });
});

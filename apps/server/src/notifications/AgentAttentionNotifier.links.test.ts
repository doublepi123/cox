import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { AuthSessionId, NotificationWebhookChannel } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { AgentAttentionNotifier } from "./AgentAttentionNotifier.ts";
import { NotificationSubscriptionRepository } from "../persistence/NotificationSubscriptions.ts";
import {
  commit,
  layers,
  now,
  request,
  run,
  secret,
  thread,
} from "./AgentAttentionNotifier.testkit.ts";
import { keys, receiver } from "./notificationReceiver.testkit.ts";
import { providerReceiver } from "./providerReceiver.testkit.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(DateTime.toEpochMillis(now));
});
afterEach(() => vi.useRealTimers());

it.each([
  ["https://cox-alpha.example.com", "env-alpha"],
  ["https://cox-beta.example.com", "env-beta"],
])(
  "F4-IS4-1: links all real agent alerts to %s through four providers and encrypted push",
  async (origin, environmentId) => {
    await using push = await receiver(true);
    await using json = await receiver(false);
    await using bark = await providerReceiver();
    await using telegram = await providerReceiver();
    await using ntfy = await providerReceiver();
    const decodeChannel = Schema.decodeUnknownSync(NotificationWebhookChannel);
    const webhooks = [
      ["json", json.endpoint],
      ["bark", bark.endpoint],
      ["telegram", telegram.endpoint],
      ["ntfy", `${ntfy.endpoint}/topic`],
    ].map(([provider, url]) =>
      decodeChannel({
        id: provider === "json" ? "hook" : provider,
        label: provider,
        provider,
        url,
        chatId: "123",
        secret: "vault-secret",
        allowPrivateNetwork: true,
        events: ["human_attention", "turn_completed", "turn_failed"],
      }),
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at, revoked_at)
          VALUES ('session', 'owner', '[]', 'browser-session-cookie', '2026-11-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z', NULL)`;
          yield* (yield* NotificationSubscriptionRepository).upsertSubscription({
            sessionId: AuthSessionId.make("session"),
            endpoint: `${push.endpoint}/push`,
            endpointOrigin: push.endpoint,
            keys,
            label: "Phone",
            userAgent: null,
            createdAt: DateTime.formatIso(now),
          });
          yield* (yield* ServerSecretStore).set(
            "notifications.webhook.aG9vaw.secret",
            new TextEncoder().encode("vault-secret"),
          );
          yield* commit({ type: "thread.created", payload: thread });
          yield* commit({ type: "run.created", payload: run("run-1") });
          yield* (yield* AgentAttentionNotifier).start;
          const expectedKinds = [
            "human_attention",
            "human_attention",
            "human_attention",
            "turn_completed",
            "turn_failed",
          ];
          for (const event of [
            { type: "runtime-request.updated" as const, payload: request("ask_user_question") },
            {
              type: "runtime-request.updated" as const,
              payload: request("approval-dialog", "command"),
            },
            { type: "turn-item.updated" as const, payload: secret("request_secret") },
            { type: "run.updated" as const, payload: run("run-1", "completed") },
            { type: "run.created" as const, payload: run("run-2") },
            { type: "run.updated" as const, payload: run("run-2", "failed") },
          ]) {
            yield* commit(event);
            if (event.type === "run.created") continue;
            const [encrypted, generic, barkPayload, telegramPayload, ntfyPayload] =
              yield* Effect.promise(() =>
                Promise.all([push.next(), json.next(), bark.next(), telegram.next(), ntfy.next()]),
              );
            const threadPath = `/${environmentId}/attention-thread`;
            const deepLinkUrl = `${origin}${threadPath}`;
            expect(new URL(generic.deepLinkUrl).origin).toBe(origin);
            expect(generic).toMatchObject({
              kind: expectedKinds.shift(),
              threadPath,
              deepLinkUrl,
            });
            expect(encrypted).toEqual(generic);
            expect(barkPayload.url).toBe(deepLinkUrl);
            expect(telegramPayload.reply_markup?.inline_keyboard[0]?.[0]?.url).toBe(deepLinkUrl);
            expect(ntfyPayload.click).toBe(deepLinkUrl);
          }
          for (const target of [push, json, bark, telegram, ntfy]) {
            expect(target.messages).toHaveLength(5);
          }
        }).pipe(
          Effect.provide(layers(json.endpoint, { publicBaseUrl: origin, environmentId, webhooks })),
        ),
      ),
    );
  },
);

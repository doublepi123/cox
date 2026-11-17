// allow: SIZE_OK -- Static IP subnet tables accompany the single outbound delivery boundary.
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect Crypto has no HMAC operation.
import { createHmac } from "node:crypto";
import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Paused Node reads enforce the response byte limit.
import { Agent as HttpAgent, request as httpRequest } from "node:http";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- HTTPS needs the same paused reads with native SNI.
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import type {
  IsoDateTime,
  NotificationEventKind,
  NotificationWebhookChannel,
  ThreadId,
} from "@t3tools/contracts";
import { isSecretReference } from "@t3tools/contracts";
import { SecretResolver } from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { SECRET_REDACTED } from "../settingsSecrets.ts";

export interface WebhookNotificationMessage {
  readonly event: string;
  readonly kind: NotificationEventKind;
  readonly threadId: ThreadId;
  readonly threadPath: string;
  readonly deepLinkUrl?: string;
  readonly title: string;
  readonly body: string;
  readonly timestamp: IsoDateTime;
}

type Failure =
  | "invalid_url"
  | "blocked_address"
  | "missing_secret"
  | "missing_chat_id"
  | "dns_failed"
  | "timeout"
  | "transport_failed"
  | "http_status";

export class WebhookNotificationError extends Error {
  override readonly name = "WebhookNotificationError";
  readonly reason: Failure;
  readonly status: number | undefined;
  constructor(reason: Failure, status?: number) {
    super(`Webhook delivery failed: ${reason}${status === undefined ? "" : ` (${status})`}.`);
    this.reason = reason;
    this.status = status;
  }
}

export const resolveWebhookChannelSecret = Effect.fn("Webhook.resolveSecret")(function* (
  channel: NotificationWebhookChannel,
) {
  if (isSecretReference(channel.secret)) {
    const resolver = yield* SecretResolver;
    const values = yield* resolver.read([channel.secret]);
    const value = values[0];
    if (!value) return yield* Effect.fail(new WebhookNotificationError("missing_secret"));
    return value;
  }
  if (channel.secret !== SECRET_REDACTED) return channel.secret;
  const store = yield* ServerSecretStore;
  const value = yield* store.get(
    `notifications.webhook.${Buffer.from(channel.id, "utf8").toString("base64url")}.secret`,
  );
  if (Option.isNone(value))
    return yield* Effect.fail(new WebhookNotificationError("missing_secret"));
  return new TextDecoder().decode(value.value);
});

const blockList = (subnets: ReadonlyArray<readonly [string, number]>) => {
  const list = new BlockList();
  for (const [address, prefix] of subnets) {
    list.addSubnet(address, prefix, isIP(address) === 6 ? "ipv6" : "ipv4");
  }
  return list;
};
const forbidden = blockList([
  ["0.0.0.0", 32],
  ["169.254.0.0", 16],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
  ["100.100.100.200", 32],
  ["::", 128],
  ["fe80::", 10],
  ["ff00::", 8],
]);
const privateNetwork = blockList([
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["::", 96],
  ["::1", 128],
  ["fc00::", 7],
  ["fec0::", 10],
]);
const loopback = blockList([
  ["127.0.0.0", 8],
  ["::1", 128],
]);

interface WebhookDispatcherOptions {
  readonly ownServerPort: number;
  readonly lookup?: (
    hostname: string,
    options: { readonly all: true },
  ) => Promise<readonly LookupAddress[]>;
}

export class WebhookNotificationService {
  private readonly options: WebhookDispatcherOptions;
  constructor(options: WebhookDispatcherOptions) {
    this.options = options;
  }

  async deliver(
    channel: NotificationWebhookChannel,
    notification: WebhookNotificationMessage,
    secret = typeof channel.secret === "string" ? channel.secret : SECRET_REDACTED,
  ) {
    const signal = AbortSignal.timeout(5000);
    try {
      if (secret === SECRET_REDACTED) throw new WebhookNotificationError("missing_secret");
      const url = new URL(channel.url);
      if (
        url.username ||
        url.password ||
        (url.protocol !== "https:" && !(channel.allowPrivateNetwork && url.protocol === "http:"))
      ) {
        throw new WebhookNotificationError("invalid_url");
      }
      const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
      const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
      if (
        hostname === "localhost" &&
        (!channel.allowPrivateNetwork || port === this.options.ownServerPort)
      ) {
        throw new WebhookNotificationError("blocked_address");
      }
      const addresses = isIP(hostname)
        ? [{ address: hostname, family: isIP(hostname) }]
        : await Promise.race([
            (this.options.lookup ?? lookup)(hostname, { all: true }),
            new Promise<never>((_resolve, reject) => {
              signal.addEventListener(
                "abort",
                () => reject(new WebhookNotificationError("timeout")),
                {
                  once: true,
                },
              );
            }),
          ]);
      for (const { address } of addresses) {
        const family = isIP(address);
        const type = family === 6 ? "ipv6" : "ipv4";
        if (
          !family ||
          forbidden.check(address, type) ||
          (!channel.allowPrivateNetwork && privateNetwork.check(address, type)) ||
          (loopback.check(address, type) && port === this.options.ownServerPort)
        ) {
          throw new WebhookNotificationError("blocked_address");
        }
      }
      signal.throwIfAborted();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      let body: string;
      switch (channel.provider) {
        case "bark":
          if (secret) headers.Authorization = `Bearer ${secret}`;
          body = JSON.stringify({
            title: notification.title,
            body: notification.body,
            group: "Cox",
            url: notification.deepLinkUrl,
            level: "timeSensitive",
          });
          break;
        case "telegram":
          if (!channel.chatId) throw new WebhookNotificationError("missing_chat_id");
          if (url.origin === "https://api.telegram.org" && url.pathname === "/" && secret) {
            url.pathname = `/bot${secret}/sendMessage`;
          } else if (secret) headers["X-Telegram-Bot-Token"] = secret;
          body = JSON.stringify({
            chat_id: channel.chatId,
            text:
              `${notification.title}\n${notification.body}` +
              (notification.deepLinkUrl && !notification.deepLinkUrl.startsWith("https://")
                ? `\n${notification.deepLinkUrl}`
                : ""),
            disable_web_page_preview: true,
            ...(notification.deepLinkUrl?.startsWith("https://")
              ? {
                  reply_markup: {
                    inline_keyboard: [[{ text: "Open in Cox", url: notification.deepLinkUrl }]],
                  },
                }
              : {}),
          });
          break;
        case "ntfy": {
          if (secret) headers.Authorization = `Bearer ${secret}`;
          const topic = decodeURIComponent(url.pathname.replace(/^\//, ""));
          if (!topic || topic.includes("/")) throw new WebhookNotificationError("invalid_url");
          url.pathname = "/";
          body = JSON.stringify({
            topic,
            title: notification.title,
            message: notification.body,
            priority: 4,
            click: notification.deepLinkUrl,
          });
          break;
        }
        case "json":
          body = JSON.stringify({
            event: notification.event,
            kind: notification.kind,
            threadId: notification.threadId,
            threadPath: notification.threadPath,
            deepLinkUrl: notification.deepLinkUrl,
            title: notification.title,
            body: notification.body,
            timestamp: notification.timestamp,
          });
          if (secret) {
            headers["X-Cox-Signature-256"] =
              `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
          }
          break;
        default: {
          const exhaustive: never = channel.provider;
          return exhaustive;
        }
      }
      const address = addresses[0];
      if (!address) throw new WebhookNotificationError("dns_failed");
      const agentOptions = {
        highWaterMark: 4096,
        autoSelectFamily: false,
        lookup: ((_hostname, _options, callback) =>
          callback(null, address.address, address.family)) satisfies NonNullable<
          ConstructorParameters<typeof HttpAgent>[0]
        >["lookup"],
      };
      const agent =
        url.protocol === "https:" ? new HttpsAgent(agentOptions) : new HttpAgent(agentOptions);
      const request = url.protocol === "https:" ? httpsRequest : httpRequest;
      try {
        return await new Promise<{ status: number; responseBytes: number }>((resolve, reject) => {
          const req = request(url, { method: "POST", headers, agent, signal }, (response) => {
            const status = response.statusCode ?? 0;
            if (status >= 300 && status < 400) {
              reject(new WebhookNotificationError("transport_failed"));
              response.destroy();
              req.destroy();
              return;
            }
            let responseBytes = 0;
            const finish = () => {
              if (status < 200 || status >= 300) {
                reject(new WebhookNotificationError("http_status", status));
              } else {
                resolve({ status, responseBytes });
              }
            };
            response.on("readable", () => {
              while (responseBytes < 4096) {
                const chunk: Buffer | null = response.read(4096 - responseBytes);
                if (chunk === null) break;
                responseBytes += chunk.byteLength;
              }
              if (responseBytes === 4096) {
                finish();
                response.destroy();
                req.destroy();
              }
            });
            response.once("end", finish);
            response.once("error", reject);
          });
          req.once("error", reject);
          req.end(body);
        });
      } finally {
        agent.destroy();
      }
    } catch (error) {
      if (error instanceof WebhookNotificationError) throw error;
      throw new WebhookNotificationError(signal.aborted ? "timeout" : "transport_failed");
    }
  }
}

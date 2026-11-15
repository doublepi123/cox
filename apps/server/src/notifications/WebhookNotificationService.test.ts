// allow: SIZE_OK -- Inline provider payloads and IP policy tables keep the wire-level security suite together.
// @effect-diagnostics nodeBuiltinImport:off -- These integration tests exercise Node HTTP and HMAC.
import { createHmac } from "node:crypto";
import { createServer, IncomingMessage, type Server } from "node:http";
import { once } from "node:events";
import { NotificationWebhookChannel, IsoDateTime, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import {
  WebhookNotificationError,
  WebhookNotificationService,
  type WebhookNotificationMessage,
} from "./WebhookNotificationService.ts";

const message: WebhookNotificationMessage = {
  event: "thread.attention",
  kind: "human_attention",
  threadId: ThreadId.make("thread-webhook"),
  threadPath: "/projects/project/threads/thread-webhook",
  deepLinkUrl: "https://cox.example/thread",
  title: "智能体等待确认",
  body: "Please review",
  timestamp: IsoDateTime.make("2026-11-15T12:00:00.000Z"),
};
const decode = Schema.decodeSync(NotificationWebhookChannel);
const channel = (fields: Partial<NotificationWebhookChannel>) =>
  decode({
    id: "test",
    label: "Test",
    provider: "json",
    url: baseUrl,
    allowPrivateNetwork: true,
    events: [],
    ...fields,
  });
const dispatcher = new WebhookNotificationService({ ownServerPort: 65535 });
let server: Server;
let baseUrl: string;
const received: {
  readonly path: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}[] = [];

beforeAll(async () => {
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received.push({
      path: request.url ?? "",
      headers: request.headers,
      body: Buffer.concat(chunks).toString("utf8"),
    });
    if (request.url === "/redirect") {
      response.writeHead(302, { Location: `${baseUrl}/redirect-target` }).end();
    } else if (request.url === "/large") {
      response.end(Buffer.alloc(1024 * 1024, "x"));
    } else if (request.url === "/failure") {
      response.writeHead(500).end("private response should never appear in errors");
    } else {
      response.end("ok");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test listener");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

describe("native webhook providers", () => {
  it.each(["bark", "telegram", "ntfy", "json"] as const)(
    "delivers %s payload and credentials over HTTP",
    async (provider) => {
      const path = `/${provider}`;
      const target = channel({
        provider,
        url: baseUrl + path,
        secret: "private-token",
        chatId: "1234",
      });
      await dispatcher.deliver(target, message);
      const request = received.at(-1);
      expect(request?.headers["content-type"]).toBe("application/json");
      const payload: unknown = JSON.parse(request?.body ?? "");
      switch (provider) {
        case "bark":
          expect(request?.path).toBe("/bark");
          expect(request?.headers.authorization).toBe("Bearer private-token");
          expect(payload).toEqual({
            title: message.title,
            body: "Please review",
            group: "Cox",
            url: message.deepLinkUrl,
            level: "timeSensitive",
          });
          break;
        case "telegram":
          expect(request?.path).toBe("/telegram");
          expect(request?.headers["x-telegram-bot-token"]).toBe("private-token");
          expect(payload).toEqual({
            chat_id: "1234",
            text: `${message.title}\nPlease review`,
            disable_web_page_preview: true,
            reply_markup: {
              inline_keyboard: [[{ text: "Open in Cox", url: message.deepLinkUrl }]],
            },
          });
          break;
        case "ntfy":
          expect(request?.path).toBe("/");
          expect(request?.headers.authorization).toBe("Bearer private-token");
          expect(payload).toEqual({
            topic: "ntfy",
            title: "智能体等待确认",
            message: "Please review",
            priority: 4,
            click: message.deepLinkUrl,
          });
          break;
        case "json":
          expect(payload).toEqual(message);
          expect(request?.headers["x-cox-signature-256"]).toBe(
            `sha256=${createHmac("sha256", "private-token")
              .update(request?.body ?? "")
              .digest("hex")}`,
          );
          break;
        default: {
          const exhaustive: never = provider;
          throw exhaustive;
        }
      }
    },
  );

  it("includes custom-scheme deep links in Telegram text", async () => {
    await dispatcher.deliver(
      channel({
        provider: "telegram",
        url: baseUrl + "/telegram",
        chatId: "4321",
      }),
      { ...message, deepLinkUrl: "cox://thread/123" },
    );
    expect(JSON.parse(received.at(-1)?.body ?? "")).toEqual({
      chat_id: "4321",
      text: `${message.title}\nPlease review\ncox://thread/123`,
      disable_web_page_preview: true,
    });
  });
});

describe("SSRF boundaries", () => {
  it.each([
    ["169.254.169.254", true],
    ["100.100.100.200", true],
    ["[fe80::1]", true],
    ["0.0.0.0", true],
    ["[::]", true],
    ["224.0.0.1", true],
    ["[ff02::1]", true],
    ["255.255.255.255", true],
    ["127.0.0.1:8443", true],
    ["[::1]:8443", true],
    ["localhost:8443", true],
    ["127.2.3.4:8443", true],
    ["[::ffff:127.0.0.1]:8443", true],
    ["[::ffff:169.254.169.254]", true],
    ["[::ffff:0.0.0.0]", true],
    ["10.0.0.1", false],
    ["172.16.0.1", false],
    ["192.168.1.1", false],
    ["127.0.0.1", false],
    ["[::1]", false],
    ["[fc00::1]", false],
  ])("blocks %s with private opt-in %s before a connection", async (host, allowPrivateNetwork) => {
    const service = new WebhookNotificationService({ ownServerPort: 8443 });
    await expect(
      service.deliver(
        channel({
          url: `https://${host}`,
          allowPrivateNetwork,
        }),
        message,
      ),
    ).rejects.toMatchObject({ reason: "blocked_address" });
  });

  it("rejects plain HTTP without explicit private access", async () => {
    const target = { ...channel({}), allowPrivateNetwork: false };
    await expect(dispatcher.deliver(target, message)).rejects.toMatchObject({
      reason: "invalid_url",
    });
  });

  it.each(["127.0.0.1", "192.168.1.1", "::1"])(
    "checks every DNS address including %s",
    async (address) => {
      const dns = vi.fn(async () => [
        { address: "8.8.8.8", family: 4 },
        { address, family: address.includes(":") ? 6 : 4 },
      ]);
      const service = new WebhookNotificationService({ ownServerPort: 8443, lookup: dns });
      await expect(
        service.deliver(
          channel({
            url: "https://public.example",
            allowPrivateNetwork: false,
          }),
          message,
        ),
      ).rejects.toMatchObject({ reason: "blocked_address" });
      expect(dns).toHaveBeenCalledWith("public.example", { all: true });
    },
  );

  it("pins the verified DNS address during connection instead of resolving again", async () => {
    const url = new URL(baseUrl);
    url.hostname = "public.example";
    const dns = vi.fn(async () => [{ address: "127.0.0.1", family: 4 }]);
    const service = new WebhookNotificationService({ ownServerPort: 8443, lookup: dns });
    const result = await service.deliver(channel({ url: url.href }), message);
    expect(result?.status).toBe(200);
    expect(dns).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["redirect", new WebhookNotificationError("transport_failed")],
    ["failure", new WebhookNotificationError("http_status", 500)],
  ] as const)("enforces bounded response handling for %s", async (path, expected) => {
    const outcome = await dispatcher
      .deliver(channel({ url: `${baseUrl}/${path}` }), message)
      .catch((error: unknown) => error);
    expect(outcome).toEqual(expected);
    expect(received.some((request) => request.path === "/redirect-target")).toBe(false);
  });

  it("reads at most 4096 application bytes from a 1 MiB response", async () => {
    const read = IncomingMessage.prototype.read;
    let actualReadBytes = 0;
    const consumer = vi.spyOn(IncomingMessage.prototype, "read").mockImplementation(function (
      this: IncomingMessage,
      size?: number,
    ) {
      const chunk: unknown = read.call(this, size);
      if (typeof this.statusCode === "number" && Buffer.isBuffer(chunk)) {
        actualReadBytes += chunk.byteLength;
      }
      return chunk;
    });
    try {
      const result = await dispatcher.deliver(channel({ url: `${baseUrl}/large` }), message);
      expect(result).toEqual({ status: 200, responseBytes: 4096 });
      expect(actualReadBytes).toBe(4096);
    } finally {
      consumer.mockRestore();
    }
  });

  it("scrubs Telegram tokens from URL, DNS error and error causes", async () => {
    const service = new WebhookNotificationService({
      ownServerPort: 8443,
      lookup: async () => {
        throw new Error("https://api.telegram.org/bot123456:secret/sendMessage");
      },
    });
    const error = await service
      .deliver(
        channel({
          provider: "telegram",
          url: "https://api.telegram.org/bot123456:secret/sendMessage",
          secret: "123456:secret",
          chatId: "123",
        }),
        message,
      )
      .catch((cause: unknown) => cause);
    expect(error).toEqual(new WebhookNotificationError("transport_failed"));
    expect(String(error)).not.toContain("123456:secret");
    expect(error).not.toHaveProperty("cause");
  });

  it("times out while DNS is unresolved and never sends afterward", async () => {
    const controller = new AbortController();
    const abort = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    try {
      const service = new WebhookNotificationService({
        ownServerPort: 8443,
        lookup: () => new Promise(() => {}),
      });
      const outcome = expect(
        service.deliver(channel({ url: "https://public.example" }), message),
      ).rejects.toMatchObject({ reason: "timeout" });
      expect(abort).toHaveBeenCalledWith(5000);
      controller.abort();
      await outcome;
    } finally {
      abort.mockRestore();
    }
  });
});

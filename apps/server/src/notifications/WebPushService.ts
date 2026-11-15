import { lookup } from "node:dns/promises";
import { addAbortListener } from "node:events";
import { BlockList, isIP } from "node:net";

import type { MobilePushSubscriptionInput } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import {
  createVapidAuthorization,
  encryptWebPushPayload,
  getVapidKeyPair,
  WebPushCryptoError,
} from "./webPushCrypto.ts";

const { request: httpRequest } = process.getBuiltinModule("node:http");
const { request: httpsRequest } = process.getBuiltinModule("node:https");

export class WebPushError extends Data.TaggedError("WebPushError")<{
  readonly reason:
    | "endpoint"
    | "dns"
    | "timeout"
    | "transport"
    | "http"
    | WebPushCryptoError["reason"];
  readonly statusCode?: number;
}> {}

export type WebPushDeliveryResult =
  | { readonly status: "delivered" }
  | { readonly status: "gone"; readonly statusCode: 404 | 410 }
  | { readonly status: "failed"; readonly error: WebPushError };

export type WebPushConfig = {
  readonly subject?: string;
  readonly allowLoopbackHttpForTest?: boolean;
};

export class WebPushService extends Context.Service<
  WebPushService,
  {
    readonly getVapidPublicKey: Effect.Effect<string, WebPushError>;
    readonly send: (
      subscription: Pick<MobilePushSubscriptionInput, "endpoint" | "keys">,
      payload: Uint8Array,
    ) => Effect.Effect<WebPushDeliveryResult>;
  }
>()("cox/notifications/WebPushService") {}

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const)
  blocked.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const)
  blocked.addSubnet(address, prefix, "ipv6");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const loopback = new BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addAddress("::1", "ipv6");

const post = async (
  endpoint: URL,
  message: { readonly body: Buffer; readonly authorization: string },
  policy: { readonly allowLoopback: boolean; readonly signal: AbortSignal },
): Promise<number> => {
  const host = endpoint.hostname.replace(/^\[|\]$/g, "");
  const signal = AbortSignal.any([policy.signal, AbortSignal.timeout(5_000)]);
  let abortSubscription: ReturnType<typeof addAbortListener> | undefined;
  try {
    return await new Promise<number>((resolve, reject) => {
      abortSubscription = addAbortListener(signal, () =>
        reject(new WebPushError({ reason: "timeout" })),
      );
      const addresses = isIP(host)
        ? Promise.resolve([{ address: host, family: isIP(host) }])
        : lookup(host, { all: true, verbatim: true });
      void addresses
        .then(
          (resolved) => {
            if (signal.aborted) return;
            const first = resolved[0];
            if (
              !first ||
              resolved.some(({ address, family }) => {
                const type = family === 6 ? "ipv6" : "ipv4";
                if (
                  policy.allowLoopback &&
                  (family === 4 || address === "::1") &&
                  loopback.check(address, type)
                )
                  return false;
                return (
                  blocked.check(address, type) || (family === 6 && !globalV6.check(address, "ipv6"))
                );
              })
            ) {
              reject(new WebPushError({ reason: "endpoint" }));
              return;
            }
            const request = (endpoint.protocol === "https:" ? httpsRequest : httpRequest)(
              endpoint,
              {
                method: "POST",
                agent: false,
                signal,
                lookup: (_hostname, options, callback) =>
                  options.all
                    ? callback(null, resolved)
                    : callback(null, first.address, first.family),
                headers: {
                  "Content-Type": "application/octet-stream",
                  "Content-Encoding": "aes128gcm",
                  "Content-Length": message.body.length,
                  TTL: "86400",
                  Urgency: "high",
                  Authorization: message.authorization,
                },
              },
              (response) => {
                resolve(response.statusCode ?? 0);
                response.destroy();
              },
            );
            request.once("error", () =>
              reject(new WebPushError({ reason: signal.aborted ? "timeout" : "transport" })),
            );
            request.end(message.body);
          },
          () => reject(new WebPushError({ reason: "dns" })),
        )
        .catch(() => reject(new WebPushError({ reason: "transport" })));
    });
  } finally {
    abortSubscription?.[Symbol.dispose]();
  }
};

export const make = Effect.fn("WebPushService.make")(function* (config: WebPushConfig = {}) {
  const store = yield* ServerSecretStore;
  const keys = getVapidKeyPair.pipe(
    Effect.provideService(ServerSecretStore, store),
    Effect.mapError((error) => new WebPushError({ reason: error.reason })),
  );
  return WebPushService.of({
    getVapidPublicKey: keys.pipe(Effect.map((key) => key.publicKey)),
    send: Effect.fn("WebPushService.send")(
      function* (subscription, payload) {
        const endpoint = URL.parse(subscription.endpoint);
        if (
          !endpoint ||
          endpoint.username ||
          endpoint.password ||
          endpoint.hash ||
          (endpoint.protocol !== "https:" &&
            !(
              config.allowLoopbackHttpForTest === true &&
              endpoint.protocol === "http:" &&
              ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)
            ))
        )
          return yield* new WebPushError({ reason: "endpoint" });
        const key = yield* keys;
        const now = yield* Clock.currentTimeMillis;
        const statusCode = yield* Effect.tryPromise({
          try: async (signal) => {
            const authorization = await createVapidAuthorization(key, {
              endpoint,
              subject: config.subject ?? "mailto:cox@localhost",
              nowEpochSeconds: Math.floor(now / 1000),
            });
            return post(
              endpoint,
              {
                authorization,
                body: encryptWebPushPayload(subscription.keys, payload),
              },
              { allowLoopback: config.allowLoopbackHttpForTest === true, signal },
            );
          },
          catch: (error) =>
            error instanceof WebPushError
              ? error
              : new WebPushError({
                  reason: error instanceof WebPushCryptoError ? error.reason : "encryption",
                }),
        });
        if (statusCode >= 200 && statusCode < 300) return { status: "delivered" } as const;
        if (statusCode === 404 || statusCode === 410)
          return { status: "gone", statusCode } as const;
        return yield* new WebPushError({ reason: "http", statusCode });
      },
      Effect.catch((error) => Effect.succeed({ status: "failed", error } as const)),
    ),
  });
});

export const layer = Layer.effect(WebPushService, make());

import dns from "node:dns";
import { once } from "node:events";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { importJWK, jwtVerify } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as SecretStore from "../auth/ServerSecretStore.ts";
import { make, type WebPushConfig, type WebPushService } from "./WebPushService.ts";

const { createDecipheriv, createECDH, hkdfSync } = process.getBuiltinModule("node:crypto");
const http = process.getBuiltinModule("node:http");
const lookup = vi.hoisted(() =>
  vi.fn<(host: string, options: dns.LookupAllOptions) => Promise<dns.LookupAddress[]>>(),
);
vi.mock("node:dns/promises", () => ({ lookup }));
beforeEach(() => lookup.mockImplementation((host, options) => dns.promises.lookup(host, options)));
const epoch = 1_730_000_000;
const subscriber = createECDH("prime256v1");
subscriber.setPrivateKey(Buffer.from("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94", "base64url"));
const auth = Buffer.from("BTBZMqHH6r4Tts7J_aSIgg", "base64url");
const keys = {
  p256dh: subscriber.getPublicKey().toString("base64url"),
  auth: auth.toString("base64url"),
};
const payload = Buffer.from(
  JSON.stringify({ title: "Cox", body: "\uD83D\uDE80 done", url: "/thread/42" }),
);
const withService = <A>(
  use: (service: WebPushService["Service"]) => Effect.Effect<A>,
  config: WebPushConfig = { allowLoopbackHttpForTest: true },
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const clock = yield* Clock.Clock;
        const service = yield* make(config);
        return yield* use(service).pipe(
          Effect.provideService(Clock.Clock, {
            currentTimeMillis: Effect.succeed(epoch * 1000),
            currentTimeMillisUnsafe: () => epoch * 1000,
            currentTimeNanos: Effect.succeed(BigInt(epoch) * 1_000_000_000n),
            currentTimeNanosUnsafe: () => BigInt(epoch) * 1_000_000_000n,
            monotonicTimeNanos: clock.monotonicTimeNanos,
            monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
            sleep: (duration) => clock.sleep(duration),
          }),
        );
      }).pipe(
        Effect.provide(
          SecretStore.layer.pipe(
            Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "web-push-service-" })),
            Layer.provide(NodeServices.layer),
          ),
        ),
      ),
    ),
  );

const receiver = async (statusCode = 201) => {
  const received = Promise.withResolvers<{
    readonly headers: InstanceType<typeof http.IncomingMessage>["headers"];
    readonly body: Buffer;
  }>();
  const requests: string[] = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url ?? "");
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.resolve({ headers: request.headers, body: Buffer.concat(chunks) });
      if (statusCode === 0) return;
      response.writeHead(statusCode, { Location: "/redirect-target" }).end();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new TypeError("Expected a TCP listener");
  return {
    endpoint: `http://127.0.0.1:${address.port}/push`,
    received: received.promise,
    requests,
    async [Symbol.asyncDispose]() {
      server.closeAllConnections();
      await server[Symbol.asyncDispose]();
    },
  };
};

afterEach(() => {
  lookup.mockReset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("WebPushService delivery", () => {
  it("delivers decryptable UTF-8 JSON with valid ES256 VAPID over live HTTP", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(epoch * 1000);
    await using push = await receiver();
    const result = await withService((service) =>
      service.send({ endpoint: push.endpoint, keys }, payload),
    );
    const { body, headers } = await push.received;
    const match = /^vapid t=([^,]+), k=(.+)$/.exec(headers.authorization ?? "");
    const vapid = Buffer.from(match?.[2] ?? "", "base64url");
    const publicKey = await importJWK(
      {
        kty: "EC",
        crv: "P-256",
        x: vapid.subarray(1, 33).toString("base64url"),
        y: vapid.subarray(33).toString("base64url"),
      },
      "ES256",
    );
    const verified = await jwtVerify(match?.[1] ?? "", publicKey, {
      audience: new URL(push.endpoint).origin,
      algorithms: ["ES256"],
    });
    const ephemeral = body.subarray(21, 86);
    const ikm = Buffer.from(
      hkdfSync(
        "sha256",
        subscriber.computeSecret(ephemeral),
        auth,
        Buffer.concat([Buffer.from("WebPush: info\0"), subscriber.getPublicKey(), ephemeral]),
        32,
      ),
    );
    const salt = body.subarray(0, 16);
    const cek = Buffer.from(hkdfSync("sha256", ikm, salt, "Content-Encoding: aes128gcm\0", 16));
    const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, "Content-Encoding: nonce\0", 12));
    const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
    decipher.setAuthTag(body.subarray(-16));

    expect(result).toEqual({ status: "delivered" });
    expect(Buffer.concat([decipher.update(body.subarray(86, -16)), decipher.final()])).toEqual(
      Buffer.concat([payload, Buffer.from([2])]),
    );
    expect(verified.payload).toMatchObject({ sub: "mailto:cox@localhost", exp: epoch + 43200 });
    expect(headers).toMatchObject({
      "content-type": "application/octet-stream",
      "content-encoding": "aes128gcm",
      ttl: "86400",
      urgency: "high",
      "content-length": String(payload.length + 103),
    });
  });

  it.each([404, 410])("classifies HTTP %i as an expired subscription", async (statusCode) => {
    await using push = await receiver(statusCode);
    expect(
      await withService((service) => service.send({ endpoint: push.endpoint, keys }, payload)),
    ).toEqual({ status: "gone", statusCode });
  });

  it.each([401, 403, 429, 500, 503, 302])(
    "returns typed HTTP %i failures without following redirects",
    async (statusCode) => {
      await using push = await receiver(statusCode);
      expect(
        await withService((service) => service.send({ endpoint: push.endpoint, keys }, payload)),
      ).toMatchObject({ status: "failed", error: { reason: "http", statusCode } });
      expect(push.requests).toEqual(["/push"]);
    },
  );

  it("aborts a stalled HTTP receiver at the production deadline", async () => {
    await using push = await receiver(0);
    expect(
      await withService((service) => service.send({ endpoint: push.endpoint, keys }, payload)),
    ).toMatchObject({ status: "failed", error: { reason: "timeout" } });
  });

  it("uses the validated DNS answer even if a second lookup would rebind", async () => {
    await using push = await receiver();
    lookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    vi.spyOn(dns, "lookup").mockImplementation(() => {
      throw new TypeError("DNS rebound");
    });
    expect(
      await withService((service) =>
        service.send({ endpoint: push.endpoint.replace("127.0.0.1", "localhost"), keys }, payload),
      ),
    ).toEqual({ status: "delivered" });
  });
});

describe("WebPushService endpoint policy", () => {
  it.each([
    "http://169.254.169.254/push",
    "https://169.254.169.254/push",
    "http://push.example/push",
    "https://0.0.0.0/push",
    "https://10.0.0.1/push",
    "https://100.64.0.1/push",
    "https://172.16.0.1/push",
    "https://192.168.0.1/push",
    "https://224.0.0.1/push",
    "https://255.255.255.255/push",
    "https://[::]/push",
    "https://[::ffff:127.0.0.1]/push",
    "https://[64:ff9b::a9fe:a9fe]/push",
    "https://[2002:a9fe:a9fe::1]/push",
    "https://[fc00::1]/push",
    "https://[fe80::1]/push",
    "https://[ff02::1]/push",
    "https://[2001:db8::1]/push",
    "https://user:password@push.example/push",
    "file:///tmp/push",
  ])("rejects unsafe endpoint %s", async (endpoint) => {
    expect(await withService((service) => service.send({ endpoint, keys }, payload))).toMatchObject(
      { status: "failed", error: { reason: "endpoint" } },
    );
  });

  it.each([
    "http://127.0.0.1/push",
    "http://localhost/push",
    "http://[::1]/push",
    "https://127.0.0.1/push",
  ])("requires explicit opt-in for %s", async (endpoint) => {
    expect(
      await withService((service) => service.send({ endpoint, keys }, payload), {}),
    ).toMatchObject({ status: "failed", error: { reason: "endpoint" } });
  });

  it("rejects mixed public and private DNS answers", async () => {
    lookup.mockResolvedValue([
      { address: "93.184.215.14", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ]);
    expect(
      await withService((service) =>
        service.send({ endpoint: "https://push.example/push", keys }, payload),
      ),
    ).toMatchObject({ status: "failed", error: { reason: "endpoint" } });
  });

  it("returns a typed DNS failure", async () => {
    lookup.mockRejectedValue(new TypeError("lookup failed"));
    expect(
      await withService((service) =>
        service.send({ endpoint: "https://push.example/push", keys }, payload),
      ),
    ).toMatchObject({ status: "failed", error: { reason: "dns" } });
  });
});

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { VapidPublicKeyResponse } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { importJWK, jwtVerify } from "jose";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as SecretStore from "../auth/ServerSecretStore.ts";
import {
  createVapidAuthorization,
  encryptWebPushPayload,
  getVapidKeyPair,
} from "./webPushCrypto.ts";

const { createDecipheriv, createECDH, createHmac } = process.getBuiltinModule("node:crypto");
const decode = (value: string) => Buffer.from(value, "base64url");
const uaPrivate = decode("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94");
const subscription = {
  p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
};
const entropy = {
  salt: decode("DGv6ra1nlYgDCS1FRnbzlw"),
  privateKey: decode("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"),
};
const plaintext = Buffer.from("When I grow up, I want to be a watermelon");
const secretLayer = () =>
  SecretStore.layer.pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "web-push-crypto-" })),
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
const hmac = (key: Uint8Array, value: Uint8Array) =>
  createHmac("sha256", key).update(value).digest();
const isPublicKeyResponse = Schema.is(VapidPublicKeyResponse);

afterEach(() => vi.useRealTimers());

describe("RFC 8291 encryption", () => {
  it("matches the official Appendix A header and ciphertext byte for byte", () => {
    const body = encryptWebPushPayload(subscription, plaintext, entropy);

    expect(body).toEqual(
      decode(
        "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_" +
          "yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
      ),
    );
  });

  it.each([0, 3800])("decrypts a %i-byte payload with the subscriber private key", (size) => {
    const payload = Buffer.alloc(size, 0x61);
    const body = encryptWebPushPayload(subscription, payload);
    const ua = createECDH("prime256v1");
    ua.setPrivateKey(uaPrivate);
    const asPublic = body.subarray(21, 86);
    const prk = hmac(decode(subscription.auth), ua.computeSecret(asPublic));
    const ikm = hmac(
      prk,
      Buffer.concat([
        Buffer.from("WebPush: info\0"),
        ua.getPublicKey(),
        asPublic,
        Buffer.from([1]),
      ]),
    );
    const contentPrk = hmac(body.subarray(0, 16), ikm);
    const cek = hmac(contentPrk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
    const nonce = hmac(contentPrk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
    const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
    decipher.setAuthTag(body.subarray(-16));

    expect(Buffer.concat([decipher.update(body.subarray(86, -16)), decipher.final()])).toEqual(
      Buffer.concat([payload, Buffer.from([2])]),
    );
    expect(body.length).toBe(size + 103);
    expect(body.readUInt32BE(16)).toBe(4096);
    expect(body[20]).toBe(65);
  });

  it("rejects payloads beyond the byte limit", () => {
    expect(() => encryptWebPushPayload(subscription, Buffer.alloc(3801))).toThrow(
      expect.objectContaining({ reason: "payload" }),
    );
  });

  it("rejects invalid subscription key material before encryption", () => {
    expect(() => encryptWebPushPayload({ ...subscription, p256dh: "bad" }, plaintext)).toThrow(
      expect.objectContaining({ reason: "subscription" }),
    );
  });
});

describe("VAPID identity", () => {
  it("persists one key across racing creators and a fresh store instance", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const stores = yield* Effect.all(
            Array.from({ length: 8 }, () => SecretStore.make),
            { concurrency: "unbounded" },
          );
          const keys = yield* Effect.forEach(
            stores,
            (store) =>
              getVapidKeyPair.pipe(Effect.provideService(SecretStore.ServerSecretStore, store)),
            { concurrency: "unbounded" },
          );
          const reloaded = yield* getVapidKeyPair.pipe(Effect.provide(SecretStore.layer));

          expect(new Set(keys.map((key) => key.publicKey))).toEqual(new Set([reloaded.publicKey]));
          expect(reloaded.publicKey).toHaveLength(87);
          expect(isPublicKeyResponse({ publicKey: reloaded.publicKey, enabled: true })).toBe(true);
        }).pipe(
          Effect.provide(
            ServerConfig.layerTest(process.cwd(), { prefix: "web-push-concurrent-" }).pipe(
              Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
            ),
          ),
        ),
      ),
    );
  });

  it("signs an ES256 JWT for the endpoint origin with a 12-hour expiry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_730_000_000_000);
    const key = await Effect.runPromise(
      getVapidKeyPair.pipe(Effect.provide(secretLayer()), Effect.scoped),
    );
    const header = await createVapidAuthorization(key, {
      endpoint: new URL("https://push.example:8443/subscription/secret?token=1"),
      subject: "mailto:push@example.com",
      nowEpochSeconds: 1_730_000_000,
    });
    const match = /^vapid t=([^,]+), k=(.+)$/.exec(header);
    expect(match).not.toBeNull();
    const publicKey = decode(match?.[2] ?? "");
    const verificationKey = await importJWK(
      {
        kty: "EC",
        crv: "P-256",
        x: publicKey.subarray(1, 33).toString("base64url"),
        y: publicKey.subarray(33).toString("base64url"),
      },
      "ES256",
    );
    const verified = await jwtVerify(match?.[1] ?? "", verificationKey, {
      audience: "https://push.example:8443",
      algorithms: ["ES256"],
    });

    expect(verified.protectedHeader).toEqual({ typ: "JWT", alg: "ES256" });
    expect(verified.payload).toEqual({
      aud: "https://push.example:8443",
      exp: 1_730_043_200,
      sub: "mailto:push@example.com",
    });
  });

  it.each(["ftp://example.com", "mailto:invalid", "https://user:pass@example.com"])(
    "rejects invalid VAPID subject %s",
    async (subject) => {
      const key = await Effect.runPromise(
        getVapidKeyPair.pipe(Effect.provide(secretLayer()), Effect.scoped),
      );
      await expect(
        createVapidAuthorization(key, {
          endpoint: new URL("https://push.example"),
          subject,
          nowEpochSeconds: 1_730_000_000,
        }),
      ).rejects.toMatchObject({ reason: "subject" });
    },
  );

  it("fails closed on a corrupt persisted key", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* SecretStore.ServerSecretStore;
          yield* store.set("web-push-vapid-p256", Buffer.alloc(32));
          const result = yield* getVapidKeyPair.pipe(Effect.flip);
          expect(result).toMatchObject({ reason: "keypair" });
        }).pipe(Effect.provide(secretLayer())),
      ),
    );
  });
});

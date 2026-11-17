import { PushSubscriptionKeys } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { SignJWT } from "jose";

import { isSecretAlreadyExistsError, ServerSecretStore } from "../auth/ServerSecretStore.ts";

const { createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes } =
  process.getBuiltinModule("node:crypto");

export class WebPushCryptoError extends Data.TaggedError("WebPushCryptoError")<{
  readonly reason: "keypair" | "subscription" | "payload" | "encryption" | "subject";
}> {}

export type VapidKeyPair = {
  readonly publicKey: string;
  readonly privateKey: ReturnType<typeof createPrivateKey>;
};

const secretName = "web-push-vapid-p256";
const decodeSubscriptionKeys = Schema.decodeUnknownResult(PushSubscriptionKeys);

export const getVapidKeyPair = Effect.gen(function* () {
  const store = yield* ServerSecretStore;
  const existing = yield* store.get(secretName);
  const bytes = yield* Option.match(existing, {
    onSome: Effect.succeed,
    onNone: () =>
      Effect.try({
        try: () => {
          const key = createECDH("prime256v1");
          key.generateKeys();
          return Buffer.from(key.getPrivateKey().toString("hex").padStart(64, "0"), "hex");
        },
        catch: () => new WebPushCryptoError({ reason: "keypair" }),
      }).pipe(
        Effect.flatMap((generated) =>
          store.create(secretName, generated).pipe(
            Effect.as(generated),
            Effect.catchIf(isSecretAlreadyExistsError, () =>
              store.get(secretName).pipe(
                Effect.flatMap(
                  Option.match({
                    onSome: Effect.succeed,
                    onNone: () => Effect.fail(new WebPushCryptoError({ reason: "keypair" })),
                  }),
                ),
              ),
            ),
          ),
        ),
      ),
  });
  return yield* Effect.try({
    try: (): VapidKeyPair => {
      const key = createECDH("prime256v1");
      if (bytes.length !== 32) throw new WebPushCryptoError({ reason: "keypair" });
      key.setPrivateKey(bytes);
      const publicKey = key.getPublicKey();
      return {
        publicKey: publicKey.toString("base64url"),
        privateKey: createPrivateKey({
          format: "jwk",
          key: {
            kty: "EC",
            crv: "P-256",
            x: publicKey.subarray(1, 33).toString("base64url"),
            y: publicKey.subarray(33).toString("base64url"),
            d: Buffer.from(bytes).toString("base64url"),
          },
        }),
      };
    },
    catch: () => new WebPushCryptoError({ reason: "keypair" }),
  });
}).pipe(Effect.mapError(() => new WebPushCryptoError({ reason: "keypair" })));

export const createVapidAuthorization = async (
  keys: VapidKeyPair,
  claims: {
    readonly endpoint: URL;
    readonly subject: string;
    readonly nowEpochSeconds: number;
  },
): Promise<string> => {
  const subject = URL.parse(claims.subject);
  if (
    !subject ||
    subject.username ||
    subject.password ||
    (subject.protocol !== "https:" &&
      !(subject.protocol === "mailto:" && /^[^@\s]+@[^@\s]+$/.test(subject.pathname)))
  ) {
    throw new WebPushCryptoError({ reason: "subject" });
  }
  const jwt = await new SignJWT({})
    .setProtectedHeader({ typ: "JWT", alg: "ES256" })
    .setAudience(claims.endpoint.origin)
    .setExpirationTime(claims.nowEpochSeconds + 12 * 3600)
    .setSubject(claims.subject)
    .sign(keys.privateKey);
  return `vapid t=${jwt}, k=${keys.publicKey}`;
};

export const encryptWebPushPayload = (
  keys: PushSubscriptionKeys,
  payload: Uint8Array,
  entropy?: { readonly salt: Uint8Array; readonly privateKey: Uint8Array },
): Buffer => {
  if (payload.byteLength > 3800) throw new WebPushCryptoError({ reason: "payload" });
  const parsed = decodeSubscriptionKeys(keys);
  if (Result.isFailure(parsed)) throw new WebPushCryptoError({ reason: "subscription" });
  const uaPublic = Buffer.from(parsed.success.p256dh, "base64url");
  const auth = Buffer.from(parsed.success.auth, "base64url");
  const ephemeral = createECDH("prime256v1");
  if (entropy) ephemeral.setPrivateKey(entropy.privateKey);
  else ephemeral.generateKeys();
  const asPublic = ephemeral.getPublicKey();
  const salt = Buffer.from(entropy?.salt ?? randomBytes(16));
  if (salt.length !== 16) throw new WebPushCryptoError({ reason: "encryption" });
  const ikm = Buffer.from(
    hkdfSync(
      "sha256",
      ephemeral.computeSecret(uaPublic),
      auth,
      Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]),
      32,
    ),
  );
  const cek = hkdfSync("sha256", ikm, salt, "Content-Encoding: aes128gcm\0", 16);
  const nonce = hkdfSync("sha256", ikm, salt, "Content-Encoding: nonce\0", 12);
  const cipher = createCipheriv("aes-128-gcm", Buffer.from(cek), Buffer.from(nonce));
  const header = Buffer.alloc(86);
  salt.copy(header);
  header.writeUInt32BE(4096, 16);
  header[20] = 65;
  asPublic.copy(header, 21);
  return Buffer.concat([
    header,
    cipher.update(Buffer.concat([payload, Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
};

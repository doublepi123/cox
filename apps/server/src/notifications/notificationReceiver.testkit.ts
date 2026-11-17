import { once } from "node:events";
import { importJWK, jwtVerify } from "jose";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { expect } from "vite-plus/test";

const { createServer } = process.getBuiltinModule("node:http");
const { createDecipheriv, createECDH, createHmac, hkdfSync } =
  process.getBuiltinModule("node:crypto");
const subscriber = createECDH("prime256v1");
subscriber.setPrivateKey(Buffer.from("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94", "base64url"));
const auth = Buffer.from("BTBZMqHH6r4Tts7J_aSIgg", "base64url");
export const keys = {
  p256dh: subscriber.getPublicKey().toString("base64url"),
  auth: auth.toString("base64url"),
};
const Message = Schema.Struct({
  kind: Schema.String,
  threadId: Schema.String,
  threadPath: Schema.String,
  deepLinkUrl: Schema.String,
  event: Schema.String,
});
type Received = typeof Message.Type;
const decodeMessage = Schema.decodeSync(Schema.fromJsonString(Message));

export const receiver = async (push: boolean) => {
  const messages: Received[] = [];
  const waiters: Array<ReturnType<typeof Promise.withResolvers<Received>>> = [];
  const failures: unknown[] = [];
  let consumed = 0;
  let delay = false;
  let accepted = Promise.withResolvers<void>();
  const timers: Array<Fiber.Fiber<void>> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      void (async () => {
        if (req.url === "/gone") {
          res.writeHead(410).end();
          return;
        }
        let body = Buffer.concat(chunks);
        if (push) {
          const match = /^vapid t=([^,]+), k=(.+)$/.exec(req.headers.authorization ?? "");
          const key = Buffer.from(match?.[2] ?? "", "base64url");
          const publicKey = await importJWK(
            {
              kty: "EC",
              crv: "P-256",
              x: key.subarray(1, 33).toString("base64url"),
              y: key.subarray(33).toString("base64url"),
            },
            "ES256",
          );
          await jwtVerify(match?.[1] ?? "", publicKey, {
            audience: endpoint,
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
          const decipher = createDecipheriv(
            "aes-128-gcm",
            Buffer.from(hkdfSync("sha256", ikm, salt, "Content-Encoding: aes128gcm\0", 16)),
            Buffer.from(hkdfSync("sha256", ikm, salt, "Content-Encoding: nonce\0", 12)),
          );
          decipher.setAuthTag(body.subarray(-16));
          body = Buffer.concat([decipher.update(body.subarray(86, -16)), decipher.final()]);
          expect(body.at(-1)).toBe(2);
          body = body.subarray(0, -1);
        } else {
          expect(req.headers["x-cox-signature-256"]).toBe(
            `sha256=${createHmac("sha256", "vault-secret").update(body).digest("hex")}`,
          );
        }
        const message = decodeMessage(body.toString());
        messages.push(message);
        waiters.shift()?.resolve(message);
        accepted.resolve();
        if (!delay) res.writeHead(201).end();
        else {
          timers.push(
            Effect.runFork(
              Effect.sleep("4 seconds").pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    res.writeHead(201).end();
                  }),
                ),
              ),
            ),
          );
        }
      })().catch((error: unknown) => {
        failures.push(error);
        for (const waiter of waiters.splice(0)) waiter.reject(error);
        res.destroy(error instanceof Error ? error : undefined);
      });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new TypeError("Expected TCP receiver");
  const endpoint = `http://127.0.0.1:${address.port}`;
  return {
    endpoint,
    messages,
    next: () => {
      if (failures.length > 0) return Promise.reject(failures[0]);
      const available = messages[consumed++];
      if (available !== undefined) return Promise.resolve(available);
      const waiter = Promise.withResolvers<Received>();
      waiters.push(waiter);
      return waiter.promise;
    },
    delayNext: () => {
      delay = true;
      accepted = Promise.withResolvers<void>();
      return accepted.promise;
    },
    async [Symbol.asyncDispose]() {
      await Effect.runPromise(Effect.forEach(timers, Fiber.interrupt, { discard: true }));
      server.closeAllConnections();
      await server[Symbol.asyncDispose]();
      const { connect } = process.getBuiltinModule("node:net");
      const error = await new Promise<Error>((resolve, reject) => {
        const socket = connect(address.port, "127.0.0.1");
        socket.once("error", resolve);
        socket.once("connect", () => {
          socket.destroy();
          reject(new TypeError("Receiver still open"));
        });
      });
      expect(error).toMatchObject({ code: "ECONNREFUSED" });
    },
  };
};

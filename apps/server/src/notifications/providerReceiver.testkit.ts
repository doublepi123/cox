import { once } from "node:events";
import * as Schema from "effect/Schema";

const { createServer } = process.getBuiltinModule("node:http");
const ProviderPayload = Schema.Struct({
  url: Schema.optionalKey(Schema.String),
  click: Schema.optionalKey(Schema.String),
  reply_markup: Schema.optionalKey(
    Schema.Struct({
      inline_keyboard: Schema.Array(Schema.Array(Schema.Struct({ url: Schema.String }))),
    }),
  ),
});
type ProviderPayload = typeof ProviderPayload.Type;
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(ProviderPayload));

export const providerReceiver = async () => {
  const messages: ProviderPayload[] = [];
  const waiters: Array<ReturnType<typeof Promise.withResolvers<ProviderPayload>>> = [];
  let consumed = 0;
  let failure: unknown;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      try {
        const message = decode(Buffer.concat(chunks).toString());
        messages.push(message);
        waiters.shift()?.resolve(message);
        response.writeHead(200).end("{}");
      } catch (error) {
        failure = error;
        for (const waiter of waiters.splice(0)) waiter.reject(error);
        response.destroy(error instanceof Error ? error : undefined);
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new TypeError("Expected TCP receiver");
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    messages,
    next: () => {
      if (failure !== undefined) return Promise.reject(failure);
      const available = messages[consumed++];
      if (available !== undefined) return Promise.resolve(available);
      const waiter = Promise.withResolvers<ProviderPayload>();
      waiters.push(waiter);
      return waiter.promise;
    },
    async [Symbol.asyncDispose]() {
      server.closeAllConnections();
      await server[Symbol.asyncDispose]();
    },
  };
};

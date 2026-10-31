import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as RpcHttp from "../rpc/http.ts";
import * as Resolver from "./resolver.ts";
import { target, entry, descriptor } from "./localTestFixtures.ts";
const dependencies = Layer.mergeAll(
  RpcHttp.layerRemoteHttpClient(async () => Response.json(descriptor)),
  Layer.succeed(ClientCapabilities.ClientPresentation, {
    metadata: { label: "Browser", deviceType: "desktop", surface: "web" },
  }),
);
describe("local connection resolver", () => {
  it.effect("uses local cookies without bearer credentials", () =>
    Effect.gen(function* () {
      const resolver = yield* Resolver.make;
      const connection = yield* resolver.prepare(entry);
      expect(connection.httpAuthorization).toBeNull();
      const socket = new URL(connection.socketUrl);
      expect(socket.origin).toBe(target.wsBaseUrl);
      expect(socket.pathname).toBe("/ws");
      expect(socket.searchParams.has("token")).toBe(false);
      expect(socket.searchParams.has("wsTicket")).toBe(false);
    }).pipe(Effect.provide(dependencies)),
  );
});

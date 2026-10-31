import { AuthStandardClientScopes } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Queue from "effect/Queue";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PairingGrantStore from "./PairingGrantStore.ts";

const layerServerConfig = (overrides?: Partial<ServerConfig.ServerConfig["Service"]>) =>
  Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return {
        ...config,
        ...overrides,
      } satisfies ServerConfig.ServerConfig["Service"];
    }),
  ).pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-bootstrap-test-" })),
  );

const layerPairingGrantStore = (overrides?: Partial<ServerConfig.ServerConfig["Service"]>) =>
  PairingGrantStore.layer.pipe(
    Layer.provide(SqlitePersistence.layerMemory),
    Layer.provide(layerServerConfig(overrides)),
  );

it.layer(NodeServices.layer)("PairingGrantStore.layer", (it) => {
  it.effect("accepts lowercase one-time tokens exactly once", () =>
    Effect.gen(function* () {
      const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore;
      const issued = yield* bootstrapCredentials.issueOneTimeToken({ label: "Julius iPhone" });
      const first = yield* bootstrapCredentials.consume(issued.credential.toLowerCase());
      const second = yield* Effect.flip(bootstrapCredentials.consume(issued.credential));

      expect(first.method).toBe("one-time-token");
      expect(first.scopes).toEqual(AuthStandardClientScopes);
      expect(first.subject).toBe("one-time-token");
      expect(first.label).toBe("Julius iPhone");
      expect(issued.label).toBe("Julius iPhone");
      expect(second._tag).toBe("UnknownBootstrapCredentialError");
      expect(second.message).toContain("Unknown bootstrap credential");
    }).pipe(
      Effect.provide(layerPairingGrantStore()),
      Effect.provideServiceEffect(
        Crypto.Crypto,
        Effect.map(Crypto.Crypto, (crypto) => ({
          ...crypto,
          randomBytes: (size) => Effect.succeed(new Uint8Array(size).fill(8)),
        })),
      ),
    ),
  );

  it.effect("atomically consumes a one-time token when multiple requests race", () =>
    Effect.gen(function* () {
      const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore;
      const token = yield* bootstrapCredentials.issueOneTimeToken();
      const results = yield* Effect.all(
        Array.from({ length: 8 }, () =>
          Effect.result(
            bootstrapCredentials.consume(token.credential, {
              requestedScopes: ["orchestration:read"],
            }),
          ),
        ),
        {
          concurrency: "unbounded",
        },
      );

      const successes = results.filter((result) => result._tag === "Success");
      const failures = results.filter((result) => result._tag === "Failure");

      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(7);
      for (const failure of failures) {
        expect(failure.failure._tag).toBe("UnknownBootstrapCredentialError");
        expect(failure.failure.message).toContain("Unknown bootstrap credential");
      }
    }).pipe(Effect.provide(layerPairingGrantStore())),
  );

  it.effect("requires the bound proof key thumbprint when present", () =>
    Effect.gen(function* () {
      const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore;
      const token = yield* bootstrapCredentials.issueOneTimeToken({
        proofKeyThumbprint: "client-proof-key-thumbprint",
        scopes: ["orchestration:read"],
      });

      const missing = yield* Effect.flip(bootstrapCredentials.consume(token.credential));
      const wrong = yield* Effect.flip(
        bootstrapCredentials.consume(token.credential, {
          proofKeyThumbprint: "other-proof-key-thumbprint",
          requestedScopes: ["access:write"],
        }),
      );
      const forbiddenScope = yield* Effect.flip(
        bootstrapCredentials.consume(token.credential, {
          proofKeyThumbprint: "client-proof-key-thumbprint",
          requestedScopes: ["access:write"],
        }),
      );
      const consumed = yield* bootstrapCredentials.consume(token.credential, {
        proofKeyThumbprint: "client-proof-key-thumbprint",
        requestedScopes: ["orchestration:read"],
      });

      expect(missing.message).toContain("proof key mismatch");
      expect(wrong.message).toContain("proof key mismatch");
      expect(forbiddenScope._tag).toBe("BootstrapCredentialScopeNotGrantedError");
      expect(consumed.proofKeyThumbprint).toBe("client-proof-key-thumbprint");
    }).pipe(Effect.provide(layerPairingGrantStore())),
  );

  it.effect("keeps credentials out of pairing lists and change events", () =>
    Effect.gen(function* () {
      const grants = yield* PairingGrantStore.PairingGrantStore;
      const changes = yield* Queue.unbounded<PairingGrantStore.BootstrapCredentialChange>();
      yield* grants.streamChanges.pipe(
        Stream.runForEach((change) => Queue.offer(changes, change)),
        Effect.forkScoped({ startImmediately: true }),
      );
      for (const input of [{}, { label: "Synthetic phone" }]) {
        const issued = yield* grants.issueOneTimeToken(input);
        const change = yield* Queue.take(changes);
        expect(change?.type).toBe("pairingLinkUpserted");
        if (change?.type !== "pairingLinkUpserted")
          throw new Error("Expected a pairing link update");
        expect(change.pairingLink.id).toBe(issued.id);
        expect(change.pairingLink).not.toHaveProperty("credential");
        const listed = (yield* grants.listActive()).find((link) => link.id === issued.id);
        expect(listed).toEqual(change.pairingLink);
        const consumed = yield* grants.consume(issued.credential);
        expect(consumed.scopes).toEqual(change.pairingLink.scopes);
        expect(yield* Queue.take(changes)).toEqual({ type: "pairingLinkRemoved", id: issued.id });
      }
    }).pipe(Effect.scoped, Effect.provide(layerPairingGrantStore())),
  );
});

import { expect, it } from "@effect/vitest";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import { layer } from "./runtime";
it.effect("provides cryptographic local command identifiers", () =>
  Effect.gen(function* () {
    const crypto = yield* SecureRandom.SecureRandom;
    const digester = yield* Digest.Digest;
    const uuid = yield* crypto.uuidV4();
    expect(uuid).toMatch(/^[a-f0-9-]{36}$/);
    const digest = yield* digester.digest(Digest.sha256, new Uint8Array([1, 2, 3]));
    expect(digest.byteLength).toBe(32);
  }).pipe(Effect.provide(layer)),
);

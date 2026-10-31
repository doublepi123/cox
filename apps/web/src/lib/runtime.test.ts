import { expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import { layer } from "./runtime";
it.effect("provides cryptographic local command identifiers", () =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const uuid = yield* crypto.randomUUIDv4();
    expect(uuid).toMatch(/^[a-f0-9-]{36}$/);
    const digest = yield* crypto.digest("SHA-256", new Uint8Array([1, 2, 3]));
    expect(digest.byteLength).toBe(32);
  }).pipe(Effect.provide(layer)),
);

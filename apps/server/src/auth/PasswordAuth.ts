// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no timingSafeEqual.
import * as NodeCrypto from "node:crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";

import type { ServerConfig } from "../config.ts";

const MAX_FAILED_ATTEMPTS = 10;
const FAILURE_WINDOW_MS = 5 * 60 * 1000;

export type PasswordAuthResult =
  | { readonly _tag: "Matched" }
  | { readonly _tag: "Rejected" }
  | { readonly _tag: "Throttled"; readonly retryAfterSeconds: number };

export interface PasswordAuth {
  /** Throttled attempts are neither compared nor recorded, so the lockout ends at a fixed time. */
  readonly verify: (credential: string | undefined) => Effect.Effect<PasswordAuthResult>;
}

export const resolvePasswordAuth = Effect.fn("PasswordAuth.resolve")(function* (
  config: Pick<ServerConfig["Service"], "authPassword">,
) {
  const password = config.authPassword;
  if (password === undefined) {
    return undefined;
  }
  const value = Redacted.value(password);
  if (value.length === 0) {
    return undefined;
  }
  const hash = NodeCrypto.createHash("sha256").update(value).digest();
  const failures = yield* Ref.make<ReadonlyArray<number>>([]);

  return {
    verify: Effect.fn("PasswordAuth.verify")(function* (credential: string | undefined) {
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const recent = (yield* Ref.get(failures)).filter((at) => now - at < FAILURE_WINDOW_MS);
      if (recent.length >= MAX_FAILED_ATTEMPTS) {
        const unlocksAt = recent[recent.length - MAX_FAILED_ATTEMPTS]! + FAILURE_WINDOW_MS;
        return {
          _tag: "Throttled",
          retryAfterSeconds: Math.max(1, Math.ceil((unlocksAt - now) / 1000)),
        } as const;
      }
      if (
        credential !== undefined &&
        NodeCrypto.timingSafeEqual(
          hash,
          NodeCrypto.createHash("sha256").update(credential).digest(),
        )
      ) {
        yield* Ref.set(failures, []);
        return { _tag: "Matched" } as const;
      }
      yield* Ref.set(failures, [...recent.slice(-(MAX_FAILED_ATTEMPTS - 1)), now]);
      return { _tag: "Rejected" } as const;
    }),
  } satisfies PasswordAuth;
});

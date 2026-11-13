import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type * as SubscriptionRef from "effect/SubscriptionRef";

import type { PlatformConnectionRegistration } from "../connection/catalog.ts";
import type { ConnectionAttemptError } from "../connection/model.ts";

export interface PlatformConnectionDiscoveryResult {
  readonly registrations: ReadonlyArray<PlatformConnectionRegistration>;
  readonly error: ConnectionAttemptError | null;
}

export class PlatformConnectionSource extends Context.Service<
  PlatformConnectionSource,
  {
    readonly registrations: Stream.Stream<PlatformConnectionDiscoveryResult>;
    readonly discoveryError: SubscriptionRef.SubscriptionRef<ConnectionAttemptError | null>;
    readonly retry: Effect.Effect<void>;
  }
>()("@t3tools/client-runtime/platform/source/PlatformConnectionSource") {}

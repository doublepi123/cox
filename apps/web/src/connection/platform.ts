import {
  ClientCapabilities,
  PlatformConnectionSource,
  Persistence,
} from "@t3tools/client-runtime/platform";
import {
  Connectivity,
  Wakeups,
  type ConnectionAttemptError,
  PrimaryConnectionRegistration,
  PrimaryConnectionTarget,
  mapRemoteEnvironmentError,
} from "@t3tools/client-runtime/connection";
import { fetchRemoteEnvironmentDescriptor } from "@t3tools/client-runtime/environment";
import { EnvironmentRpcRequestObserver } from "@t3tools/client-runtime/rpc";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { APP_VERSION } from "../branding";
import * as PrimaryEnvironmentHttpLayer from "../environments/primary/httpLayer";
import {
  readPrimaryEnvironmentTarget,
  type PrimaryEnvironmentTarget,
} from "../environments/primary/target";
import { clearComposerDraftsEnvironment } from "../composerDraftStore";
import { acknowledgeRpcRequest, trackRpcRequestSent } from "../rpc/requestLatencyState";
import * as ConnectionStorage from "./storage";
import { clientPresentationMetadata } from "./clientMetadata";

let nextObservedRpcRequestId = 0;

function currentNetworkStatus(): "unknown" | "offline" | "online" {
  if (typeof navigator === "undefined") {
    return "unknown";
  }
  return navigator.onLine ? "online" : "offline";
}

const layerConnectivity = Connectivity.layer({
  status: Effect.sync(currentNetworkStatus),
  changes: Stream.callback((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const online = () => Queue.offerUnsafe(queue, "online");
        const offline = () => Queue.offerUnsafe(queue, "offline");
        window.addEventListener("online", online);
        window.addEventListener("offline", offline);
        return { online, offline };
      }),
      ({ online, offline }) =>
        Effect.sync(() => {
          window.removeEventListener("online", online);
          window.removeEventListener("offline", offline);
        }),
    ).pipe(Effect.asVoid),
  ),
});

export function subscribeToApplicationWakeups(
  onWakeup: (reason: Wakeups.ConnectionWakeup) => void,
): () => void {
  let hiddenAt = document.visibilityState === "hidden" ? Date.now() : undefined;
  let lastWakeupAt = -Infinity;
  let lastWakeupWasLong = false;
  let lastNetworkWakeupAt = -Infinity;
  let networkChangedWhileHidden = false;
  const listener = (event: Event) => {
    if (
      document.visibilityState !== "visible" ||
      event.type === "pagehide" ||
      event.type === "freeze"
    ) {
      hiddenAt ??= Date.now();
      return;
    }
    const now = Date.now();
    const longResume =
      (hiddenAt !== undefined && now - hiddenAt >= 30_000) ||
      (event.type === "pageshow" && "persisted" in event && event.persisted === true) ||
      event.type === "resume";
    hiddenAt = undefined;
    if (
      now - lastWakeupAt < 500 &&
      !networkChangedWhileHidden &&
      (!longResume || lastWakeupWasLong)
    )
      return;
    lastWakeupAt = now;
    lastWakeupWasLong = longResume;
    const reason = longResume
      ? "application-active-long"
      : networkChangedWhileHidden
        ? "network-changed"
        : "application-active";
    networkChangedWhileHidden = false;
    onWakeup(reason);
  };
  const networkChanged = () => {
    if (document.visibilityState !== "visible") {
      networkChangedWhileHidden = true;
      return;
    }
    const now = Date.now();
    if (now - lastNetworkWakeupAt < 500) return;
    lastNetworkWakeupAt = now;
    networkChangedWhileHidden = false;
    onWakeup("network-changed");
  };
  const connection =
    "connection" in navigator && navigator.connection instanceof EventTarget
      ? navigator.connection
      : undefined;
  document.addEventListener("visibilitychange", listener);
  document.addEventListener("freeze", listener);
  document.addEventListener("resume", listener);
  window.addEventListener("focus", listener);
  window.addEventListener("pageshow", listener);
  window.addEventListener("pagehide", listener);
  window.addEventListener("online", networkChanged);
  connection?.addEventListener("change", networkChanged);
  return () => {
    document.removeEventListener("visibilitychange", listener);
    document.removeEventListener("freeze", listener);
    document.removeEventListener("resume", listener);
    window.removeEventListener("focus", listener);
    window.removeEventListener("pageshow", listener);
    window.removeEventListener("pagehide", listener);
    window.removeEventListener("online", networkChanged);
    connection?.removeEventListener("change", networkChanged);
  };
}

const layerWakeups = Wakeups.layer({
  changes: Stream.callback<Wakeups.ConnectionWakeup>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() =>
        subscribeToApplicationWakeups((reason) => Queue.offerUnsafe(queue, reason)),
      ),
      (unsubscribe) => Effect.sync(unsubscribe),
    ).pipe(Effect.asVoid),
  ),
});

export function currentClientMetadata() {
  return clientPresentationMetadata({
    appVersion: APP_VERSION,
    identity: {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      maxTouchPoints: navigator.maxTouchPoints,
    },
  });
}

const layerCapabilities = Layer.succeed(
  ClientCapabilities.ClientPresentation,
  ClientCapabilities.ClientPresentation.of({ metadata: currentClientMetadata() }),
);

const loadPrimaryConnectionRegistration = Effect.fn(
  "web.connectionPlatform.loadPrimaryConnectionRegistration",
)(function* (resolved: PrimaryEnvironmentTarget) {
  const descriptor = yield* fetchRemoteEnvironmentDescriptor({
    httpBaseUrl: resolved.target.httpBaseUrl,
  }).pipe(
    Effect.provide(PrimaryEnvironmentHttpLayer.layer),
    Effect.mapError(mapRemoteEnvironmentError),
  );
  return new PrimaryConnectionRegistration({
    target: new PrimaryConnectionTarget({
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      httpBaseUrl: resolved.target.httpBaseUrl,
      wsBaseUrl: resolved.target.wsBaseUrl,
    }),
  });
});

export const layerPlatformConnectionSource = Layer.effect(
  PlatformConnectionSource.PlatformConnectionSource,
  Effect.gen(function* () {
    const retries = yield* Queue.unbounded<void>();
    const discoveryError = yield* SubscriptionRef.make<ConnectionAttemptError | null>(null);
    return PlatformConnectionSource.PlatformConnectionSource.of({
      discoveryError,
      retry: Queue.offer(retries, undefined).pipe(Effect.asVoid),
      registrations: Stream.tick("2 seconds").pipe(
        Stream.merge(Stream.fromQueue(retries)),
        Stream.mapEffect(() =>
          loadPrimaryConnectionRegistration(readPrimaryEnvironmentTarget()).pipe(
            Effect.map((registration) => ({
              registrations: [registration] as ReadonlyArray<PrimaryConnectionRegistration>,
              error: null,
            })),
            Effect.catch((error) =>
              Effect.logWarning("Could not discover the local server.", { error }).pipe(
                Effect.as({
                  registrations: [] as ReadonlyArray<PrimaryConnectionRegistration>,
                  error,
                }),
              ),
            ),
          ),
        ),
      ),
    });
  }),
);

const layerEnvironmentOwnedDataCleanup = Layer.succeed(
  Persistence.EnvironmentOwnedDataCleanup,
  Persistence.EnvironmentOwnedDataCleanup.of({
    clear: Effect.fn("Persistence.EnvironmentOwnedDataCleanup.clear")(function (environmentId) {
      return Effect.sync(() => {
        clearComposerDraftsEnvironment(environmentId);
      });
    }),
  }),
);

const layerRpcRequestObserver = Layer.succeed(
  EnvironmentRpcRequestObserver,
  EnvironmentRpcRequestObserver.of({
    // Every RPC passes through this observer; the request owns its span.
    observe: Effect.fnUntraced(function* ({ environmentId, environmentLabel, method }) {
      return yield* Effect.sync(() => {
        nextObservedRpcRequestId += 1;
        const requestId = `${environmentId}:${nextObservedRpcRequestId}`;
        trackRpcRequestSent(requestId, method, `${method} · ${environmentLabel}`);
        return Effect.sync(() => {
          acknowledgeRpcRequest(requestId);
        });
      });
    }),
  }),
);

export const layer = Layer.mergeAll(
  ConnectionStorage.layer,
  layerConnectivity,
  layerWakeups,
  layerCapabilities,
  layerPlatformConnectionSource,
  layerEnvironmentOwnedDataCleanup,
  layerRpcRequestObserver,
);

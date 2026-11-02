import {
  ClientCapabilities,
  PlatformConnectionSource,
  Persistence,
} from "@t3tools/client-runtime/platform";
import {
  Connectivity,
  Wakeups,
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

export function subscribeToApplicationWakeups(onWakeup: () => void): () => void {
  const listener = () => {
    if (document.visibilityState === "visible") onWakeup();
  };
  document.addEventListener("visibilitychange", listener);
  window.addEventListener("focus", listener);
  window.addEventListener("pageshow", listener);
  return () => {
    document.removeEventListener("visibilitychange", listener);
    window.removeEventListener("focus", listener);
    window.removeEventListener("pageshow", listener);
  };
}

const layerWakeups = Wakeups.layer({
  changes: Stream.callback<"application-active">((queue) =>
    Effect.acquireRelease(
      Effect.sync(() =>
        subscribeToApplicationWakeups(() => Queue.offerUnsafe(queue, "application-active")),
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

const layerPlatformConnectionSource = Layer.succeed(
  PlatformConnectionSource.PlatformConnectionSource,
  PlatformConnectionSource.PlatformConnectionSource.of({
    registrations: Stream.tick("2 seconds").pipe(
      Stream.mapEffect(() =>
        loadPrimaryConnectionRegistration(readPrimaryEnvironmentTarget()).pipe(
          Effect.map((registration) => [registration]),
          Effect.catch((error) =>
            Effect.logWarning("Could not discover the local server.", { error }).pipe(
              Effect.as([] as ReadonlyArray<PrimaryConnectionRegistration>),
            ),
          ),
        ),
      ),
    ),
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

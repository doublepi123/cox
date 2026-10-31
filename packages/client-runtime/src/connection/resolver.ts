import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import { appendClientConnectionParams } from "./clientMetadata.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import type { ConnectionCatalogEntry } from "./catalog.ts";
import type { PreparedConnection } from "./model.ts";
import { ConnectionBlockedError, type ConnectionAttemptError } from "./model.ts";
import { environmentMismatchError, mapRemoteEnvironmentError } from "./errors.ts";
import {
  appendOrchestrationProtocol,
  orchestrationProtocolCompatibilityError,
} from "./compatibility.ts";
import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";

export class ConnectionResolver extends Context.Service<
  ConnectionResolver,
  {
    readonly prepare: (
      entry: ConnectionCatalogEntry,
    ) => Effect.Effect<PreparedConnection, ConnectionAttemptError>;
  }
>()("@t3tools/client-runtime/connection/resolver/ConnectionResolver") {}

export const make = Effect.gen(function* () {
  const presentation = yield* ClientCapabilities.ClientPresentation;
  const httpClient = yield* HttpClient.HttpClient;
  const authorize = Effect.fn("clientRuntime.connection.local.authorize")(function* (
    entry: ConnectionCatalogEntry,
  ) {
    const target = entry.target;
    if (target._tag !== "PrimaryConnectionTarget") {
      return yield* new ConnectionBlockedError({
        reason: "unsupported",
        detail: "Cox connects only to its local server.",
      });
    }
    const socket = new URL(target.wsBaseUrl);
    socket.pathname = "/ws";
    appendClientConnectionParams(socket, presentation.metadata, "direct");
    const prepared: PreparedConnection = {
      environmentId: target.environmentId,
      label: target.label,
      httpBaseUrl: target.httpBaseUrl,
      socketUrl: socket.toString(),
      httpAuthorization: null,
      target,
    };
    const descriptor = yield* fetchRemoteEnvironmentDescriptor({
      httpBaseUrl: target.httpBaseUrl,
    }).pipe(
      Effect.mapError(mapRemoteEnvironmentError),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );
    if (descriptor.environmentId !== target.environmentId) {
      return yield* environmentMismatchError({
        expected: target.environmentId,
        actual: descriptor.environmentId,
      });
    }
    return { prepared, descriptor };
  });

  const prepare = Effect.fn("clientRuntime.connection.broker.prepare")(function* (
    entry: ConnectionCatalogEntry,
  ) {
    const { prepared, descriptor } = yield* authorize(entry);
    const compatibilityError = orchestrationProtocolCompatibilityError(descriptor);
    if (compatibilityError !== null) {
      return yield* compatibilityError;
    }
    return {
      ...prepared,
      socketUrl: appendOrchestrationProtocol(prepared.socketUrl),
    };
  });

  return ConnectionResolver.of({ prepare });
});

export const layer = Layer.effect(ConnectionResolver, make);

import {
  AuthEnvironmentMaintainScope,
  EnvironmentHttpApi,
  EnvironmentInternalError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import {
  annotateEnvironmentRequest,
  currentEnvironmentTraceId,
  failEnvironmentAuthInvalid,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { LocalServiceUpdate, LocalServiceUpdateError } from "./LocalServiceUpdate.ts";

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "localServiceUpdates",
  Effect.fnUntraced(function* (handlers) {
    const updates = yield* LocalServiceUpdate;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const handle =
      <A>(name: string, action: Effect.Effect<A, LocalServiceUpdateError>) =>
      () =>
        Effect.gen(function* () {
          yield* annotateEnvironmentRequest(name);
          const request = yield* HttpServerRequest.HttpServerRequest;
          yield* auth
            .assertBrowserSessionRequest(request)
            .pipe(
              Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
                failEnvironmentAuthInvalid(
                  EnvironmentAuth.serverAuthCredentialReason(error),
                  EnvironmentAuth.serverAuthDpopFailureReason(error),
                ),
              ),
            );
          yield* requireEnvironmentScope(AuthEnvironmentMaintainScope);
          return yield* action;
        }).pipe(
          Effect.withSpan(`environment.localServiceUpdates.${name}`),
          Effect.catchIf(
            (error): error is LocalServiceUpdateError => error instanceof LocalServiceUpdateError,
            (error) =>
              Effect.map(
                currentEnvironmentTraceId,
                (traceId) =>
                  new EnvironmentInternalError({
                    code: "internal_error",
                    reason: "internal_error",
                    traceId,
                  }),
              ).pipe(
                Effect.tap(() => Effect.logError(error.message)),
                Effect.flatMap(Effect.fail),
              ),
          ),
        );
    return handlers
      .handle("state", handle("state", updates.state))
      .handle("check", handle("check", updates.check))
      .handle("download", handle("download", updates.download))
      .handle("apply", handle("apply", updates.apply));
  }),
);

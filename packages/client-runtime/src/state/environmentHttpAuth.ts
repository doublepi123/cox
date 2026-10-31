import * as Effect from "effect/Effect";
import {
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
} from "@t3tools/contracts";
import { FetchHttpClient, type HttpMethod } from "effect/http";
import type { PreparedConnection } from "../connection/model.ts";
import {
  executeEnvironmentHttpRequest,
  makeEnvironmentHttpApiGroupClient,
  makeEnvironmentHttpApiUrlBuilder,
  RemoteEnvironmentAuthFetchError,
} from "../rpc/http.ts";

export interface EnvironmentHttpAuthHeaders {
  readonly authorization?: string;
}

export function withOrchestrationProtocolHeader(headers: EnvironmentHttpAuthHeaders) {
  return {
    ...headers,
    [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT as "2",
  };
}

export const executeAuthenticatedEnvironmentHttpRequest = Effect.fnUntraced(function* <
  Group extends Parameters<typeof makeEnvironmentHttpApiGroupClient>[1],
  Response,
  Failure,
  Services,
>(input: {
  readonly prepared: PreparedConnection;
  readonly method: HttpMethod.HttpMethod;
  readonly url: (urls: ReturnType<typeof makeEnvironmentHttpApiUrlBuilder>[Group]) => string;
  readonly timeoutMs: number;
  readonly group: Group;
  readonly request: (input: {
    readonly client: Effect.Success<ReturnType<typeof makeEnvironmentHttpApiGroupClient<Group>>>;
    readonly headers: EnvironmentHttpAuthHeaders;
  }) => Effect.Effect<Response, Failure, Services>;
  readonly isUnauthorizedResponse?: (response: NoInfer<Response>) => boolean;
}) {
  if (
    input.prepared.target._tag !== "PrimaryConnectionTarget" ||
    input.prepared.httpAuthorization !== null
  ) {
    return yield* new RemoteEnvironmentAuthFetchError({
      message: "Cox permits only the local server connection.",
      cause: input.prepared.target._tag,
    });
  }
  const urls = makeEnvironmentHttpApiUrlBuilder(input.prepared.httpBaseUrl);
  const requestUrl = input.url(urls[input.group]);
  const client = yield* makeEnvironmentHttpApiGroupClient(input.prepared.httpBaseUrl, input.group);
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    input.timeoutMs,
    input.request({ client, headers: {} }),
  ).pipe(Effect.provideService(FetchHttpClient.RequestInit, { credentials: "same-origin" }));
});

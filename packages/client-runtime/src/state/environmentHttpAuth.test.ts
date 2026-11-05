import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
} from "@t3tools/contracts";
import { withOrchestrationProtocolHeader } from "./environmentHttpAuth.ts";
import { prepared } from "../connection/localTestFixtures.ts";
import { layerRemoteHttpClient } from "../rpc/http.ts";
import { fetchEnvironmentSessionState } from "./session.ts";
it.effect("uses same-origin cookie authentication for local HTTP", () =>
  Effect.gen(function* () {
    const requests: RequestInit[] = [];
    const session = yield* fetchEnvironmentSessionState({ prepared }).pipe(
      Effect.provide(
        layerRemoteHttpClient(async (_request, init) => {
          requests.push(init ?? {});
          return Response.json({
            authenticated: false,
            auth: {
              policy: "loopback-browser",
              loginMode: "local",
              sessionMethods: ["browser-session-cookie"],
              sessionCookieName: "cox_session",
            },
          });
        }),
      ),
    );
    expect(session.authenticated).toBe(false);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.credentials).toBe("same-origin");
    const headers = new Headers(requests[0]?.headers);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("dpop")).toBeNull();
    expect(
      new Headers(withOrchestrationProtocolHeader({})).get(ORCHESTRATION_PROTOCOL_HEADER),
    ).toBe(ORCHESTRATION_PROTOCOL_VERSION_TEXT);
  }),
);

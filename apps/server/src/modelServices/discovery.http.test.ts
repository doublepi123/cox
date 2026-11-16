import { describe, expect, it } from "@effect/vitest";
import { ModelServiceConfig } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as NetAddress from "effect/net/NetAddress";
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { fetchModelServiceModels } from "./discovery.ts";

const decode = Schema.decodeSync(ModelServiceConfig);

interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
}

type ScriptedResponse =
  | { readonly kind: "redirect"; readonly status: number; readonly location: string }
  | { readonly kind: "json"; readonly body: unknown };

const flattenHeaders = (
  headers: Readonly<Record<string, readonly string[] | string | undefined>>,
): Record<string, string | undefined> => {
  const flat: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    flat[name] = typeof value === "string" ? value : value?.join(", ");
  }
  return flat;
};

const withServer = (script: (request: RecordedRequest, requestCount: number) => ScriptedResponse) =>
  Effect.gen(function* () {
    const requests: RecordedRequest[] = [];
    const context = yield* Layer.build(Layer.fresh(NodeHttpServer.layerTest));
    const server = Context.get(context, HttpServer.HttpServer);
    yield* server.serve(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const recorded: RecordedRequest = {
          method: request.method,
          url: request.url,
          headers: flattenHeaders(request.headers),
        };
        requests.push(recorded);
        const scripted = script(recorded, requests.length);
        switch (scripted.kind) {
          case "redirect":
            return HttpServerResponse.redirect(scripted.location, { status: scripted.status });
          case "json":
            return yield* HttpServerResponse.json(scripted.body);
        }
      }),
    );
    const address = server.address;
    if (!NetAddress.isInetAddress(address)) {
      return yield* Effect.die(new Error("Expected a TCP server address."));
    }
    return { origin: `http://127.0.0.1:${address.port}`, requests };
  });

interface CredentialFixture {
  readonly apiKey: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly expectedAtOrigin: Readonly<Record<string, string>>;
  readonly secrets: ReadonlyArray<string>;
}

const credentials: Readonly<Record<"openai-chat" | "anthropic-messages", CredentialFixture>> = {
  "openai-chat": {
    apiKey: "dummy-openai-secret-key",
    headers: { "x-api-key": "dummy-openai-x-api-key", "x-extra": "dummy-extra-token" },
    expectedAtOrigin: {
      authorization: "Bearer dummy-openai-secret-key",
      "x-api-key": "dummy-openai-x-api-key",
      "x-extra": "dummy-extra-token",
    },
    secrets: ["dummy-openai-secret-key", "dummy-openai-x-api-key", "dummy-extra-token"],
  },
  "anthropic-messages": {
    apiKey: "dummy-anthropic-secret-key",
    headers: { authorization: "Bearer dummy-anthropic-auth", "x-extra": "dummy-extra-token" },
    expectedAtOrigin: {
      authorization: "Bearer dummy-anthropic-auth",
      "x-api-key": "dummy-anthropic-secret-key",
      "x-extra": "dummy-extra-token",
      "anthropic-version": "2023-06-01",
    },
    secrets: ["dummy-anthropic-secret-key", "dummy-anthropic-auth", "dummy-extra-token"],
  },
};

const protocols = ["openai-chat", "anthropic-messages"] as const;

const redirectRows = protocols.flatMap((protocol) =>
  [302, 303, 307, 308].flatMap((code) =>
    (["same-origin", "cross-port"] as const).map((targetKind) => ({
      protocol,
      code,
      targetKind,
    })),
  ),
);

const leakCatalog = { data: [{ id: "redirect-leaked-model" }] };

describe("model service discovery redirect credential isolation over real HTTP", () => {
  it.effect.each(redirectRows)(
    "rejects HTTP $code $targetKind redirects without contacting the redirect target ($protocol)",
    ({ protocol, code, targetKind }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const creds = credentials[protocol];
          const sink = yield* withServer(() => ({ kind: "json", body: leakCatalog }));
          const redirectTo =
            targetKind === "cross-port" ? `${sink.origin}/collect` : "/attacker-models";
          const origin = yield* withServer((_request, requestCount) =>
            requestCount === 1
              ? { kind: "redirect", status: code, location: redirectTo }
              : { kind: "json", body: leakCatalog },
          );
          const failure = yield* Effect.flip(
            fetchModelServiceModels(
              decode({
                name: "Redirect fixture",
                baseUrl: `${origin.origin}/v1`,
                apiKey: creds.apiKey,
                headers: creds.headers,
                protocols: [protocol],
              }),
            ).pipe(Effect.provide(FetchHttpClient.layer)),
          );
          expect(failure.detail).toContain(`HTTP ${code}`);
          for (const secret of creds.secrets) {
            expect(failure.detail).not.toContain(secret);
          }
          expect(origin.requests.length).toBe(1);
          const seen = origin.requests[0];
          expect(seen?.method).toBe("GET");
          expect(seen?.url).toBe("/v1/models");
          for (const [name, value] of Object.entries(creds.expectedAtOrigin)) {
            expect(seen?.headers[name]).toBe(value);
          }
          expect(sink.requests.length).toBe(0);
        }),
      ),
  );

  it.effect.each(protocols)("completes two-page discovery over real HTTP ($protocol)", (protocol) =>
    Effect.scoped(
      Effect.gen(function* () {
        const creds = credentials[protocol];
        const origin = yield* withServer((_request, requestCount) =>
          requestCount === 1
            ? { kind: "json", body: { data: [{ id: "alpha" }], has_more: true, last_id: "alpha" } }
            : { kind: "json", body: { data: [{ id: "beta" }] } },
        );
        const models = yield* fetchModelServiceModels(
          decode({
            name: "Paging fixture",
            baseUrl: `${origin.origin}/v1`,
            apiKey: creds.apiKey,
            headers: creds.headers,
            protocols: [protocol],
          }),
        ).pipe(Effect.provide(FetchHttpClient.layer));
        expect(models.map((model) => model.id)).toEqual(["alpha", "beta"]);
        expect(origin.requests.length).toBe(2);
        expect(origin.requests[1]?.url).toBe(
          protocol === "anthropic-messages"
            ? "/v1/models?after_id=alpha"
            : "/v1/models?after=alpha",
        );
        for (const request of origin.requests) {
          expect(request.headers["x-extra"]).toBe("dummy-extra-token");
        }
      }),
    ),
  );
});

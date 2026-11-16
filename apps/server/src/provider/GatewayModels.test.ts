import { describe, expect, it } from "@effect/vitest";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Real HTTP servers verify fetch redirect credential isolation.
import { createServer, type Server } from "node:http";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { HttpClient, HttpClientResponse } from "effect/http";
import { makeGatewayModels, parseGatewayModel } from "./GatewayModels.ts";

const codex = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("gateway-test");
const snapshot: ServerProvider = {
  instanceId,
  driver: codex,
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-02T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

describe("gateway models", () => {
  it("does not forward gateway credentials to redirect targets with the real fetch client", async () => {
    const listen = (server: Server) =>
      new Promise<string>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (!address || typeof address === "string") {
            reject(new Error("Expected a TCP address"));
            return;
          }
          resolve(`http://127.0.0.1:${address.port}`);
        });
      });
    let targetRequests = 0;
    const gatewayRequests: Array<{
      url: string | undefined;
      authorization: string | undefined;
      apiKey: string | string[] | undefined;
    }> = [];
    let redirectStatus = 302;
    const target = createServer((_request, response) => {
      targetRequests++;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "redirected-model" }] }));
    });
    let targetUrl = "";
    const source = createServer((request, response) => {
      gatewayRequests.push({
        url: request.url,
        authorization: request.headers.authorization,
        apiKey: request.headers["x-api-key"],
      });
      response.writeHead(redirectStatus, { location: `${targetUrl}/models` });
      response.end();
    });
    try {
      targetUrl = await listen(target);
      const baseUrl = await listen(source);
      for (const status of [301, 302, 303, 307, 308]) {
        redirectStatus = status;
        const error = await Effect.runPromise(
          Effect.gen(function* () {
            const gateway = yield* makeGatewayModels({
              instanceId,
              driver: ProviderDriverKind.make("claudeAgent"),
              baseUrl,
              apiKey: "private-test-key",
              customModels: [],
            });
            return yield* Effect.flip(gateway.refresh);
          }).pipe(Effect.provide(FetchHttpClient.layer)),
        );
        expect(error.detail).not.toContain("private-test-key");
        expect(targetRequests).toBe(0);
      }
      expect(gatewayRequests).toEqual(
        Array.from({ length: 5 }, () => ({
          url: "/v1/models",
          authorization: "Bearer private-test-key",
          apiKey: "private-test-key",
        })),
      );
    } finally {
      await Promise.all(
        [source, target].map(
          (server) =>
            new Promise<void>((resolve) => {
              server.closeAllConnections();
              server.close(() => resolve());
            }),
        ),
      );
    }
  });

  it.effect("supplements Codex Ultra after manual max-only gateway capabilities are merged", () =>
    Effect.gen(function* () {
      const http = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(request, Response.json({ data: [{ id: "vendor/exact" }] })),
        ),
      );
      const gateway = yield* makeGatewayModels({
        instanceId,
        driver: codex,
        baseUrl: "https://gateway.test/v1",
        customModels: [
          {
            slug: "vendor/exact",
            capabilities: {
              optionDescriptors: [
                {
                  id: "reasoningEffort",
                  label: "Reasoning",
                  type: "select",
                  currentValue: "max",
                  options: [{ id: "max", label: "Maximum", isDefault: true }],
                },
              ],
            },
          },
        ],
      }).pipe(Effect.provideService(HttpClient.HttpClient, http));
      const result = yield* gateway.apply(snapshot);
      expect(result.models[0]?.capabilities?.optionDescriptors?.[0]).toMatchObject({
        currentValue: "max",
        options: [{ id: "max", isDefault: true }, { id: "ultra" }],
      });
    }),
  );

  it("imports only explicitly advertised service tiers and their defaults", () => {
    expect(
      parseGatewayModel(
        {
          id: "speed-model",
          service_tiers: ["default", { id: "priority", name: "Fast", description: "Low latency" }],
          default_service_tier: "default",
        },
        codex,
      )?.capabilities?.optionDescriptors,
    ).toEqual([
      {
        id: "serviceTier",
        label: "Service Tier",
        type: "select",
        options: [
          { id: "default", label: "Standard", isDefault: true },
          { id: "priority", label: "Fast" },
        ],
        currentValue: "default",
      },
    ]);
    expect(parseGatewayModel({ id: "gpt-6.1-sol" }, codex)?.capabilities).toBeNull();
  });
  it("only fills capabilities reported by the gateway", () => {
    expect(parseGatewayModel({ id: "unknown" }, codex)?.capabilities).toBeNull();
    expect(
      parseGatewayModel(
        {
          id: "known",
          context_length: 128000,
          architecture: { input_modalities: ["text", "image"] },
          supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
        },
        codex,
      ),
    ).toMatchObject({
      slug: "known",
      capabilities: {
        contextWindow: 128000,
        supportsImages: true,
        optionDescriptors: [{ id: "reasoningEffort", options: [{ id: "low" }, { id: "high" }] }],
      },
    });
    expect(
      parseGatewayModel({ id: "text", input_modalities: ["text"], reasoning_efforts: [] }, codex)
        ?.capabilities,
    ).toEqual({ supportsImages: false, optionDescriptors: [] });
    expect(
      parseGatewayModel(
        { id: "invalid-metadata", context_window: -1, supports_images: "yes" },
        codex,
      )?.capabilities,
    ).toBeNull();
    expect(parseGatewayModel({ name: "no ID" }, codex)).toBeNull();
  });

  it.effect("lists paginated models once and preserves explicit capability overrides", () =>
    Effect.gen(function* () {
      const requests: string[] = [];
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push(request.url);
          expect(request.method).toBe("GET");
          expect(request.headers.authorization).toBe("Bearer test-key");
          return HttpClientResponse.fromWeb(
            request,
            Response.json(
              requests.length === 1
                ? {
                    data: [{ id: "first", context_length: 1000, supports_images: true }],
                    has_more: true,
                    last_id: "first",
                  }
                : { data: [{ id: "second" }], has_more: false },
            ),
          );
        }),
      );
      const gateway = yield* makeGatewayModels({
        instanceId,
        driver: codex,
        baseUrl: "https://gateway.test/v1",
        apiKey: "test-key",
        customModels: [
          { slug: "first", capabilities: { contextWindow: 2000, supportsImages: false } },
        ],
      }).pipe(Effect.provideService(HttpClient.HttpClient, http));
      const result = yield* gateway.apply(snapshot);
      expect(result.models.map((model) => model.slug)).toEqual(["first", "second"]);
      expect(result.models[0]?.capabilities).toEqual({
        contextWindow: 2000,
        supportsImages: false,
      });
      expect(requests).toEqual([
        "https://gateway.test/v1/models",
        "https://gateway.test/v1/models?after=first",
      ]);
      yield* gateway.apply(snapshot);
      expect(requests).toHaveLength(2);
    }),
  );

  it.effect("uses Anthropic headers and does not leak keys on failed refresh", () =>
    Effect.gen(function* () {
      let failed = false;
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          expect(request.url).toBe("https://gateway.test/v1/models");
          expect(request.headers["x-api-key"]).toBe("private-test-key");
          expect(request.headers["anthropic-version"]).toBe("2023-06-01");
          return HttpClientResponse.fromWeb(
            request,
            failed
              ? new Response("private-test-key", { status: 401 })
              : Response.json({ data: [{ id: "claude-custom", max_input_tokens: 200000 }] }),
          );
        }),
      );
      const gateway = yield* makeGatewayModels({
        instanceId,
        driver: ProviderDriverKind.make("claudeAgent"),
        baseUrl: "https://gateway.test",
        apiKey: "private-test-key",
        customModels: [],
      }).pipe(Effect.provideService(HttpClient.HttpClient, http));
      expect((yield* gateway.apply(snapshot)).models[0]?.slug).toBe("claude-custom");
      failed = true;
      const error = yield* Effect.flip(gateway.refresh);
      expect(error.detail).not.toContain("private-test-key");
      expect((yield* gateway.apply(snapshot)).models[0]?.slug).toBe("claude-custom");
    }),
  );
});

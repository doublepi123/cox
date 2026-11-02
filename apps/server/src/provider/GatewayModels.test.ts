import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
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

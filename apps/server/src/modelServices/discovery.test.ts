import { describe, expect, it } from "@effect/vitest";
import { ModelServiceConfig, ModelServiceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Context from "effect/Context";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  discoverModelService,
  fetchModelServiceModels,
  modelServiceEndpoint,
  parseModelServiceModel,
} from "./discovery.ts";

const decode = Schema.decodeSync(ModelServiceConfig);
const id = ModelServiceId.make("models-test");
const config = (patch: Partial<ModelServiceConfig> = {}): ModelServiceConfig =>
  decode({
    name: "Test service",
    baseUrl: "https://models.test/v1",
    apiKey: "private-test-key",
    protocols: ["openai-chat"],
    ...patch,
  });

describe("model service discovery", () => {
  it.effect("retains explicit ignored models when the upstream advertises them again", () =>
    Effect.gen(function* () {
      const http = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json(
              request.url === "https://models.dev/api.json" ? {} : { data: [{ id: "ignored" }] },
            ),
          ),
        ),
      );
      const result = yield* discoverModelService({ serviceId: id }).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
      );
      expect(result.models.find((model) => model.id === "ignored")).toMatchObject({
        ignored: true,
        available: true,
      });
    }).pipe(
      Effect.provide(
        ServerSettingsService.layerTest({
          modelServices: {
            [id]: config({
              models: [{ id: "ignored", ignored: true, source: "discovered", capabilities: null }],
            }),
          },
        }),
      ),
    ),
  );
  it.effect.each([
    { metadataOnly: false, cleared: false },
    { metadataOnly: true, cleared: false },
    { metadataOnly: false, cleared: true },
    { metadataOnly: true, cleared: true },
  ])(
    "preserves manual reasoning across repeated refreshes with metadataOnly=$metadataOnly and cleared=$cleared",
    ({ metadataOnly, cleared }) => {
      const optionDescriptors = cleared
        ? []
        : [
            {
              id: "reasoningEffort",
              label: "My reasoning levels",
              type: "select" as const,
              currentValue: "ultra",
              options: [
                { id: "high", label: "High" },
                { id: "max", label: "Maximum", description: "Custom maximum" },
                { id: "ultra", label: "Ultra", isDefault: true },
              ],
            },
          ];
      return Effect.gen(function* () {
        const settings = yield* ServerSettingsService;
        let upstreamRequests = 0;
        const http = HttpClient.make((request) =>
          Effect.sync(() => {
            const metadata = request.url === "https://models.dev/api.json";
            if (!metadata) upstreamRequests++;
            return HttpClientResponse.fromWeb(
              request,
              Response.json(
                metadata
                  ? {
                      openai: {
                        models: {
                          "gpt-test": {
                            id: "gpt-test",
                            limit: { context: 128000 },
                            reasoning_options: [{ type: "effort", values: ["low", "high"] }],
                          },
                        },
                      },
                    }
                  : {
                      data: [
                        { id: "gpt-test", supported_reasoning_efforts: ["medium", "high"] },
                        { id: "new-model" },
                      ],
                    },
              ),
            );
          }),
        );
        for (let refresh = 0; refresh < 2; refresh++) {
          const result = yield* discoverModelService({ serviceId: id, metadataOnly }).pipe(
            Effect.provideService(HttpClient.HttpClient, http),
          );
          const model = result.models.find((model) => model.id === "gpt-test");
          expect(model?.source).toBe("manual");
          expect(model?.capabilities?.optionDescriptors).toEqual(optionDescriptors);
          expect(model?.capabilities?.contextWindow).toBe(128000);
          const saved = (yield* settings.getSettings).modelServices[id]!;
          expect(saved.models.find((model) => model.id === "gpt-test")).toEqual(model);
          expect(saved.revision).toBe(refresh + 1);
          if (!metadataOnly)
            expect(result.models.some((model) => model.id === "new-model")).toBe(true);
        }
        expect(upstreamRequests).toBe(metadataOnly ? 0 : 2);
      }).pipe(
        Effect.provide(
          ServerSettingsService.layerTest({
            modelServices: {
              [id]: config({
                models: [{ id: "gpt-test", source: "manual", capabilities: { optionDescriptors } }],
              }),
            },
          }),
        ),
      );
    },
  );

  it.effect("enriches manually added models without calling the upstream model-list endpoint", () =>
    Effect.gen(function* () {
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          expect(request.url).toBe("https://models.dev/api.json");
          expect(request.headers.authorization).toBeUndefined();
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              openai: {
                models: {
                  "gpt-test": {
                    id: "gpt-test",
                    name: "GPT Test",
                    limit: { context: 128000 },
                    tool_call: true,
                  },
                },
              },
            }),
          );
        }),
      );
      const result = yield* discoverModelService({ serviceId: id, metadataOnly: true }).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
      );
      expect(result.models[0]).toMatchObject({
        id: "gpt-test",
        name: "GPT Test",
        source: "manual",
        capabilities: { contextWindow: 128000 },
        supportsTools: true,
      });
    }).pipe(
      Effect.provide(
        ServerSettingsService.layerTest({
          modelServices: {
            [id]: config({ models: [{ id: "gpt-test", source: "manual", capabilities: null }] }),
          },
        }),
      ),
    ),
  );
  it.effect("keeps upstream discovery usable when models.dev is unavailable", () =>
    Effect.gen(function* () {
      const http = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            request.url.startsWith("https://models.dev/")
              ? Response.json({}, { status: 503 })
              : Response.json({ data: [{ id: "gpt-5" }] }),
          ),
        ),
      );
      const result = yield* discoverModelService({ serviceId: id }).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
      );
      expect(result.models[0]).toMatchObject({ id: "gpt-5", name: "GPT-5", capabilities: null });
    }).pipe(Effect.provide(ServerSettingsService.layerTest({ modelServices: { [id]: config() } }))),
  );
  it("preserves exact model IDs, declared protocols and explicit capabilities", () => {
    const found = parseModelServiceModel(
      {
        id: "Vendor/Model-X",
        supported_endpoint_types: ["openai-response", "anthropic"],
        context_length: 64000,
        input_modalities: ["text", "image"],
        output_modalities: ["text"],
        supports_reasoning: false,
        supports_tools: true,
        max_output_tokens: 8192,
      },
      ["openai-chat"],
    );
    expect(found).toMatchObject({
      id: "Vendor/Model-X",
      protocols: ["openai-responses", "anthropic-messages"],
      capabilities: { contextWindow: 64000, supportsImages: true },
      supportsTools: true,
      inputModalities: ["text", "image"],
      outputModalities: ["text"],
      supportsReasoning: false,
      maxOutputTokens: 8192,
    });
    expect(parseModelServiceModel({ id: "unknown" }, ["openai-chat"])).toMatchObject({
      capabilities: null,
    });
    expect(
      parseModelServiceModel({ id: "declared-unsupported", protocols: ["unknown"] }, [
        "openai-chat",
      ])?.protocols,
    ).toEqual([]);
  });
  it("uses the protocol's standard version only for an unversioned origin", () => {
    expect(
      modelServiceEndpoint({ baseUrl: "https://models.test" }, "anthropic-messages", "models").href,
    ).toBe("https://models.test/v1/models");
    expect(
      modelServiceEndpoint({ baseUrl: "https://models.test/proxy/v1" }, "openai-chat", "models")
        .href,
    ).toBe("https://models.test/proxy/v1/models");
    expect(modelServiceEndpoint({ baseUrl: "https://models.test" }, "gemini", "models").href).toBe(
      "https://models.test/v1beta/models",
    );
  });
  it.effect("paginates Anthropic metadata with the right headers and refuses redirects", () =>
    Effect.gen(function* () {
      const requests: string[] = [];
      const http = HttpClient.make((request, _url, _signal, fiber) =>
        Effect.sync(() => {
          requests.push(request.url);
          expect(request.method).toBe("GET");
          expect(request.headers["x-api-key"]).toBe("private-test-key");
          expect(request.headers["anthropic-version"]).toBe("2023-06-01");
          const init = Context.getOrUndefined(fiber.context, FetchHttpClient.RequestInit);
          expect(init?.redirect).toBe("manual");
          return HttpClientResponse.fromWeb(
            request,
            Response.json(
              requests.length === 1
                ? { data: [{ id: "first" }], has_more: true, last_id: "first" }
                : { data: [{ id: "Second" }], has_more: false },
            ),
          );
        }),
      );
      const models = yield* fetchModelServiceModels(
        config({ protocols: ["anthropic-messages"] }),
      ).pipe(Effect.provideService(HttpClient.HttpClient, http));
      expect(models.map((model) => model.id)).toEqual(["first", "Second"]);
      expect(requests[1]).toBe("https://models.test/v1/models?after_id=first");
    }),
  );
  it.effect("discovers Gemini metadata without guessing image or tool support", () =>
    Effect.gen(function* () {
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          expect(request.headers["x-goog-api-key"]).toBe("private-test-key");
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              models: [
                {
                  name: "models/Gemini-X",
                  displayName: "Gemini X",
                  inputTokenLimit: 32000,
                  outputTokenLimit: 4000,
                },
              ],
            }),
          );
        }),
      );
      const models = yield* fetchModelServiceModels(
        config({ baseUrl: "https://models.test/v1beta", protocols: ["gemini"] }),
      ).pipe(Effect.provideService(HttpClient.HttpClient, http));
      expect(models[0]).toMatchObject({
        id: "models/Gemini-X",
        name: "Gemini X",
        capabilities: { contextWindow: 32000 },
        maxOutputTokens: 4000,
      });
      expect(models[0]?.supportsTools).toBeUndefined();
      expect(models[0]?.capabilities?.supportsImages).toBeUndefined();
    }),
  );
  it.effect("rejects a cross-origin model-list path before exposing credentials", () =>
    Effect.gen(function* () {
      let called = false;
      const http = HttpClient.make(() =>
        Effect.sync(() => {
          called = true;
        }).pipe(Effect.andThen(Effect.die("Unexpected request"))),
      );
      const failure = yield* Effect.flip(
        fetchModelServiceModels(config({ modelsPath: "https://other.test/models" })).pipe(
          Effect.provideService(HttpClient.HttpClient, http),
        ),
      );
      expect(called).toBe(false);
      expect(failure.detail).toContain("origin");
      expect(failure.detail).not.toContain("private-test-key");
    }),
  );
  it.effect("rejects repeated cursors and does not install a partial catalog", () =>
    Effect.gen(function* () {
      const http = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ data: [{ id: "partial" }], has_more: true, last_id: "same" }),
          ),
        ),
      );
      const failure = yield* Effect.flip(
        fetchModelServiceModels(config()).pipe(Effect.provideService(HttpClient.HttpClient, http)),
      );
      expect(failure.detail).toContain("repeated");
    }),
  );
  it.effect("does not mark retained models missing when a later discovery page fails", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettingsService;
      const before = (yield* settings.getSettings).modelServices[id]!;
      let pages = 0;
      const http = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            ++pages === 1
              ? Response.json({
                  data: [{ id: "first-page" }],
                  has_more: true,
                  last_id: "first-page",
                })
              : Response.json({}, { status: 503 }),
          ),
        ),
      );
      const failure = yield* discoverModelService({ serviceId: id }).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.flip,
      );
      expect(failure.detail).toContain("HTTP 503");
      expect((yield* settings.getSettings).modelServices[id]).toEqual(before);
      expect(pages).toBe(2);
    }).pipe(
      Effect.provide(
        ServerSettingsService.layerTest({
          modelServices: {
            [id]: config({
              models: [{ id: "keep", source: "discovered", available: true, capabilities: null }],
            }),
          },
        }),
      ),
    ),
  );
  it.effect(
    "retains manual entries and marks removed models unavailable after a successful refresh",
    () =>
      Effect.gen(function* () {
        const settings = yield* ServerSettingsService;
        const http = HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(request, Response.json({ data: [{ id: "new" }] })),
          ),
        );
        const result = yield* discoverModelService({ serviceId: id }).pipe(
          Effect.provideService(HttpClient.HttpClient, http),
        );
        expect(result.models.map((model) => model.id)).toEqual(["new", "manual", "removed"]);
        expect(result.models.find((model) => model.id === "removed")).toMatchObject({
          available: false,
          source: "discovered",
        });
        expect(result.models.find((model) => model.id === "manual")).toMatchObject({
          source: "manual",
        });
        const saved = (yield* settings.getSettings).modelServices[id];
        expect(saved?.revision).toBe(1);
        expect(saved?.apiKey).toBe("private-test-key");
      }).pipe(
        Effect.provide(
          ServerSettingsService.layerTest({
            modelServices: {
              [id]: config({
                models: [
                  { id: "manual", capabilities: null, source: "manual" },
                  { id: "removed", capabilities: null, source: "discovered" },
                ],
              }),
            },
          }),
        ),
      ),
  );
  it.effect(
    "marks an empty successful upstream catalog as missing and restores entries if they return",
    () =>
      Effect.gen(function* () {
        let returned = false;
        const http = HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json(
                request.url === "https://models.dev/api.json"
                  ? {}
                  : { data: returned ? [{ id: "removed" }] : [] },
              ),
            ),
          ),
        );
        const first = yield* discoverModelService({ serviceId: id }).pipe(
          Effect.provideService(HttpClient.HttpClient, http),
        );
        expect(first.models.find((model) => model.id === "removed")).toMatchObject({
          available: false,
          ignored: true,
        });
        expect(first.models.find((model) => model.id === "manual")).toMatchObject({
          source: "manual",
        });
        returned = true;
        const next = yield* discoverModelService({ serviceId: id }).pipe(
          Effect.provideService(HttpClient.HttpClient, http),
        );
        expect(next.models.find((model) => model.id === "removed")).toMatchObject({
          available: true,
          ignored: true,
        });
      }).pipe(
        Effect.provide(
          ServerSettingsService.layerTest({
            modelServices: {
              [id]: config({
                models: [
                  { id: "removed", source: "discovered", ignored: true, capabilities: null },
                  { id: "manual", source: "manual", capabilities: null },
                ],
              }),
            },
          }),
        ),
      ),
  );
  it.effect("keeps the previous catalog on failure and rejects a concurrent connection edit", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettingsService;
      const before = (yield* settings.getSettings).modelServices[id]!;
      const failed = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ error: "private-test-key" }, { status: 401 }),
          ),
        ),
      );
      const error = yield* Effect.flip(
        discoverModelService({ serviceId: id }).pipe(
          Effect.provideService(HttpClient.HttpClient, failed),
        ),
      );
      expect(error.detail).not.toContain("private-test-key");
      expect((yield* settings.getSettings).modelServices[id]?.models).toEqual(before.models);
      const changed = HttpClient.make((request) =>
        request.url.startsWith("https://models.dev/")
          ? Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({}, { status: 503 })))
          : settings
              .updateSettings({
                modelServices: { [id]: { ...before, apiKey: "rotated-test-key" } },
              })
              .pipe(
                Effect.orDie,
                Effect.as(
                  HttpClientResponse.fromWeb(
                    request,
                    Response.json({ data: [{ id: "replacement" }] }),
                  ),
                ),
              ),
      );
      const conflict = yield* Effect.flip(
        discoverModelService({ serviceId: id }).pipe(
          Effect.provideService(HttpClient.HttpClient, changed),
        ),
      );
      expect(conflict.detail).toContain("changed");
      expect((yield* settings.getSettings).modelServices[id]?.apiKey).toBe("rotated-test-key");
      expect((yield* settings.getSettings).modelServices[id]?.models).toEqual(before.models);
    }).pipe(
      Effect.provide(
        ServerSettingsService.layerTest({
          modelServices: { [id]: config({ models: [{ id: "old", capabilities: null }] }) },
        }),
      ),
    ),
  );
});

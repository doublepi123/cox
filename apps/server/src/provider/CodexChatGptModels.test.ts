import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { chatGptModels } from "./CodexChatGptModels.ts";

it.effect(
  "uses each selected profile's token and the server's visible catalog order and names",
  () =>
    Effect.gen(function* () {
      const requests: string[] = [];
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          assert.strictEqual(request.url, "https://api.openai.com/v1/models");
          requests.push(request.headers.authorization!);
          return HttpClientResponse.fromWeb(
            request,
            new Response(
              JSON.stringify({
                models:
                  request.headers.authorization === "Bearer account-a"
                    ? [
                        {
                          slug: "second",
                          display_name: "Second from OpenAI",
                          visibility: "list",
                          default_reasoning_level: "low",
                          supported_reasoning_levels: [
                            { effort: "low", description: "Fast" },
                            { effort: "high", description: "Deep" },
                          ],
                        },
                        {
                          slug: "hidden",
                          display_name: "Hidden",
                          visibility: "hidden",
                          default_reasoning_level: null,
                          supported_reasoning_levels: null,
                        },
                        {
                          slug: "first",
                          display_name: "First from OpenAI",
                          visibility: "list",
                          default_reasoning_level: "high",
                          supported_reasoning_levels: [{ effort: "high", description: "Deep" }],
                        },
                      ]
                    : [
                        {
                          slug: "account-b-only",
                          display_name: "B",
                          visibility: "list",
                          default_reasoning_level: null,
                          supported_reasoning_levels: null,
                        },
                      ],
              }),
            ),
          );
        }),
      );
      const native = [
        {
          slug: "first",
          name: "Cached first",
          isCustom: false,
          capabilities: { optionDescriptors: [] },
        },
        { slug: "not-entitled", name: "Cached other", isCustom: false, capabilities: null },
      ];
      const a = yield* chatGptModels("account-a", native).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
      );
      assert.deepEqual(
        a.map((model) => [model.slug, model.name]),
        [
          ["second", "Second from OpenAI"],
          ["first", "First from OpenAI"],
        ],
      );
      assert.strictEqual(a[1]!.capabilities?.optionDescriptors?.[0]?.id, "reasoningEffort");
      assert.deepEqual(a[0]!.capabilities?.optionDescriptors, [
        {
          id: "reasoningEffort",
          label: "Reasoning",
          type: "select",
          options: [
            { id: "low", label: "Low", isDefault: true },
            { id: "high", label: "High" },
          ],
          currentValue: "low",
        },
      ]);
      const b = yield* chatGptModels("account-b", native).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
      );
      assert.deepEqual(
        b.map((model) => model.slug),
        ["account-b-only"],
      );
      assert.isNull(b[0]!.capabilities);
      assert.deepEqual(requests, ["Bearer account-a", "Bearer account-b"]);
    }),
);

it.effect("does not present a cached catalog as account entitlements when discovery fails", () =>
  Effect.gen(function* () {
    const http = HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 503 }))),
    );
    const error = yield* Effect.flip(
      chatGptModels("account-a", []).pipe(Effect.provideService(HttpClient.HttpClient, http)),
    );
    assert.strictEqual(error._tag, "ChatGptCatalogError");
  }),
);

it.effect("merges account speed tiers into native models that only report reasoning", () =>
  Effect.gen(function* () {
    const http = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(
            JSON.stringify({
              models: [
                {
                  slug: "with-priority",
                  display_name: "Priority model",
                  visibility: "list",
                  service_tiers: [{ id: "priority", name: "Fast", description: "Lower latency" }],
                  default_service_tier: "priority",
                },
                {
                  slug: "with-fast",
                  display_name: "Fast model",
                  visibility: "list",
                  additional_speed_tiers: ["fast"],
                },
                { slug: "standard-only", display_name: "Standard model", visibility: "list" },
              ],
            }),
          ),
        ),
      ),
    );
    const reasoning = {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select" as const,
      options: [{ id: "high", label: "High" }],
      currentValue: "high",
    };
    const models = yield* chatGptModels("account-a", [
      {
        slug: "with-priority",
        name: "Native model",
        isCustom: false,
        capabilities: { optionDescriptors: [reasoning] },
      },
    ]).pipe(Effect.provideService(HttpClient.HttpClient, http));
    assert.deepEqual(models[0]!.capabilities?.optionDescriptors?.[0], reasoning);
    const priority = models[0]!.capabilities?.optionDescriptors?.find(
      (option) => option.id === "serviceTier",
    );
    assert.strictEqual(priority?.type, "select");
    if (priority?.type === "select") {
      assert.strictEqual(priority.currentValue, "priority");
      assert.deepEqual(
        priority.options.map((option) => option.id),
        ["default", "priority"],
      );
    }
    const fast = models[1]!.capabilities?.optionDescriptors?.find(
      (option) => option.id === "serviceTier",
    );
    assert.strictEqual(fast?.type, "select");
    if (fast?.type === "select")
      assert.include(
        fast.options.map((option) => option.id),
        "fast",
      );
    assert.isNull(models[2]!.capabilities);
  }),
);

it.effect("preserves native speed settings instead of replacing them with catalog defaults", () =>
  Effect.gen(function* () {
    const native = {
      slug: "model",
      name: "Native",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "serviceTier",
            label: "Service Tier",
            type: "select" as const,
            options: [
              { id: "default", label: "Standard" },
              { id: "priority", label: "Fast" },
            ],
            currentValue: "priority",
          },
        ],
      },
    };
    const http = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(
            JSON.stringify({
              models: [
                {
                  slug: "model",
                  display_name: "Account model",
                  visibility: "list",
                  additional_speed_tiers: ["fast"],
                },
              ],
            }),
          ),
        ),
      ),
    );
    const models = yield* chatGptModels("account-a", [native]).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
    );
    assert.deepEqual(models[0]!.capabilities, native.capabilities);
  }),
);

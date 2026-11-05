import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { describe } from "vite-plus/test";
import * as OpenCode2Client from "./v2/OpenCode2Client.ts";
import { loadOpenCode2Agents, withOpenCode2Agents } from "./openCode2Agents.ts";

const agent = (id: string, mode: "primary" | "all" | "subagent" = "primary", hidden = false) => ({
  id,
  name: id === "orchestrator" ? "Orchestrator" : id,
  mode,
  hidden,
  request: { settings: {}, headers: {}, body: {} },
  permissions: [],
});

const discover = (input?: {
  readonly configs?: ReadonlyArray<unknown>;
  readonly emptyFirst?: boolean;
  readonly configStatus?: number;
}) =>
  Effect.gen(function* () {
    let reads = 0;
    const http = HttpClient.make((request, url) => {
      assert.strictEqual(url.searchParams.get("location[directory]"), "/project");
      const config = url.pathname === "/api/config";
      const body = config
        ? (input?.configs ?? [
            { type: "document", info: { default_agent: "build" } },
            { type: "directory", path: "/project/.opencode" },
            {
              type: "document",
              path: "/project/opencode.json",
              info: { default_agent: "orchestrator" },
            },
          ])
        : {
            location: { directory: "/project" },
            data:
              input?.emptyFirst === true && reads++ === 0
                ? []
                : [
                    agent("build"),
                    agent("orchestrator"),
                    agent("review", "all"),
                    agent("hidden", "primary", true),
                    agent("worker", "subagent"),
                  ],
          };
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json(body, { status: config ? (input?.configStatus ?? 200) : 200 }),
        ),
      );
    });
    const service = yield* OpenCode2Client.make.pipe(
      Effect.provideService(HttpClient.HttpClient, http),
    );
    const { client } = yield* service.connect({ baseUrl: "http://opencode.test", password: "" });
    return yield* loadOpenCode2Agents(client, "/project");
  });

describe("OpenCode 2 agents", () => {
  it.effect("uses directory config precedence and visible primary/all agent IDs", () =>
    Effect.gen(function* () {
      const inventory = yield* discover();
      assert.deepEqual(
        inventory.agents.map((entry) => entry.id),
        ["build", "orchestrator", "review"],
      );
      assert.strictEqual(inventory.defaultAgent, "orchestrator");
      const capabilities = withOpenCode2Agents({ contextWindow: 64000 }, inventory);
      assert.strictEqual(capabilities.contextWindow, 64000);
      const descriptor = capabilities.optionDescriptors?.[0];
      assert.isTrue(descriptor?.type === "select");
      if (descriptor?.type !== "select") return;
      assert.strictEqual(descriptor.currentValue, "orchestrator");
      assert.deepEqual(
        descriptor.options.find((option) => option.isDefault),
        {
          id: "orchestrator",
          label: "Orchestrator",
          isDefault: true,
        },
      );
    }),
  );

  it.effect("waits for a fresh directory's agents to finish loading", () =>
    Effect.gen(function* () {
      const load = yield* discover({ emptyFirst: true }).pipe(Effect.forkChild);
      yield* TestClock.adjust("250 millis");
      assert.strictEqual((yield* Fiber.join(load)).defaultAgent, "orchestrator");
    }),
  );

  it.effect.each(["hidden", "worker", "missing"])(
    "does not substitute Build for unavailable default %s",
    (id) =>
      Effect.gen(function* () {
        const inventory = yield* discover({
          configs: [{ type: "document", info: { default_agent: id } }],
        });
        assert.strictEqual(inventory.defaultAgent, undefined);
      }),
  );

  it.effect("retains agent discovery when the optional config endpoint fails", () =>
    Effect.gen(function* () {
      const inventory = yield* discover({ configStatus: 500 });
      assert.strictEqual(inventory.agents.length, 3);
      assert.strictEqual(inventory.defaultAgent, undefined);
    }),
  );

  it.effect("marks the native built-in default only when config was read successfully", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* discover({ configs: [] })).defaultAgent, "build");
    }),
  );
});

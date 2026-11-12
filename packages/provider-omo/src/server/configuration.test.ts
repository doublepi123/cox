import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { OmoSettings } from "../settings.ts";
import { omoEnvironment, omoTaskConfiguration, prepareOmoConfiguration } from "./configuration.ts";

const settings = Schema.decodeSync(OmoSettings);
const unknownSettings = Schema.decodeUnknownSync(OmoSettings);

it("retains a custom recommendation prompt and supports clearing it", () => {
  expect(settings({}).recommendationPrompt).toBe("");
  expect(
    settings({ recommendationPrompt: "Choose reliable coding models." }).recommendationPrompt,
  ).toBe("Choose reliable coding models.");
  expect(settings({ recommendationPrompt: "" }).recommendationPrompt).toBe("");
  expect(() => settings({ recommendationPrompt: "x".repeat(32_001) })).toThrow();
});

describe("OMO model configuration", () => {
  it("preserves dotted instance paths and escapes only exact dot segments", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const base = yield* fs.makeTempDirectoryScoped({ prefix: "cox-omo-instance-path-" });
        const config = settings({ binaryPath: path.join(base, "no-omo") });
        for (const [instanceId, directory] of [
          ["a.b", "a.b"],
          [".", "%2E"],
          ["..", "%2E%2E"],
        ] as const) {
          const prepared = yield* prepareOmoConfiguration(config, { PATH: "" }, base, instanceId);
          const instanceDirectory = path.join(base, "providers", "omo", directory);
          expect(prepared.settings.agentDir).toBe(path.join(instanceDirectory, "agent"));
          expect(prepared.settings.sessionDir).toBe(
            path.join(instanceDirectory, "agent", "sessions"),
          );
          expect(JSON.parse(prepared.environment.COX_OMO_TASK_CONFIG!).task.state_dir).toBe(
            path.join(instanceDirectory, "agent", "tasks"),
          );
          expect(prepared.environment.COX_OMO_MEMORY_HOME).toBe(
            path.join(instanceDirectory, "memory"),
          );
        }
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    ));
  it("isolates global memory per Cox instance, independently of shared agent configuration and projects", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const base = yield* fs.makeTempDirectoryScoped({ prefix: "cox-omo-memory-config-" });
        const config = settings({
          agentDir: path.join(base, "shared-agent"),
          binaryPath: path.join(base, "no-omo"),
          categoryModels: { deep: "cox/expert" },
        });
        const first = yield* prepareOmoConfiguration(
          config,
          { OMO_MEMORY_HOME: "/outside", PATH: "" },
          base,
          "instance-a",
        );
        const second = yield* prepareOmoConfiguration(config, {}, base, "instance-b");
        expect(first.settings.agentDir).toBe(second.settings.agentDir);
        expect(first.environment.COX_OMO_MEMORY_HOME).toBe(
          path.join(base, "providers", "omo", "instance-a", "memory"),
        );
        expect(second.environment.COX_OMO_MEMORY_HOME).toBe(
          path.join(base, "providers", "omo", "instance-b", "memory"),
        );
        expect(first.environment.OMO_MEMORY_HOME).toBe(first.environment.COX_OMO_MEMORY_HOME);
        expect(JSON.parse(first.environment.COX_OMO_FIXED_ROLES!).categories).toEqual([
          "deep",
          "deep-low",
        ]);
        const explicit = yield* prepareOmoConfiguration(
          { ...config, categoryModels: { deep: "cox/expert", "deep-low": "" } },
          {},
          base,
          "instance-a",
        );
        expect(JSON.parse(explicit.environment.COX_OMO_FIXED_ROLES!).categories).toEqual([]);
        const traversal = yield* prepareOmoConfiguration(config, {}, base, "..");
        expect(traversal.environment.COX_OMO_MEMORY_HOME).toBe(
          path.join(base, "providers", "omo", "%2E%2E", "memory"),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    ));
  it("rejects a role thinking strength outside its managed model's catalog choices", () => {
    const config = settings({
      modelServiceManaged: true,
      provider: "cox",
      model: "main",
      customModels: [
        {
          slug: "cox/main",
          capabilities: {
            optionDescriptors: [
              {
                id: "thinking",
                label: "Thinking",
                type: "select",
                options: [{ id: "high", label: "High" }],
              },
            ],
          },
        },
      ],
      agentReasoning: { oracle: "high" },
    });
    expect(omoTaskConfiguration(config, "/tasks").agents.oracle).toMatchObject({
      reasoning: "high",
    });
    expect(() =>
      omoTaskConfiguration({ ...config, agentReasoning: { oracle: "max" } }, "/tasks"),
    ).toThrow("not supported");
  });
  it("passes per-role thinking strengths to native agents, categories and custom roles", () => {
    const native = omoTaskConfiguration(
      settings({
        provider: "cox",
        model: "main",
        agentModels: { "plan-reviewer": "cox/expert" },
        agentReasoning: { "plan-reviewer": "high", explore: "", custom_role: "max" },
        categoryReasoning: { quick: "off", deep: "xhigh" },
      }),
      "/tasks",
    );
    expect(native.agents["plan-reviewer"]).toMatchObject({
      models: ["cox/expert"],
      reasoning: "high",
    });
    expect(native.agents.explore).not.toHaveProperty("reasoning");
    expect(native.agents.custom_role).toMatchObject({ models: ["cox/main"], reasoning: "max" });
    expect(native.categories.quick).toMatchObject({ reasoning: "off" });
    expect(native.categories.deep).toMatchObject({ reasoning: "xhigh" });
    expect(() => unknownSettings({ agentReasoning: { oracle: "ultra" } })).toThrow();
    expect(() => unknownSettings({ categoryReasoning: { constructor: "high" } })).toThrow();
  });
  it("keeps mutable inheritance arrays before an independent main model is selected", () => {
    const native = omoTaskConfiguration(settings({}), "/tasks");
    expect(native.agents.explore).toEqual({ models: [], models_distribution: "round_robin" });
    expect(native.categories.quick).toEqual({ models: [], models_distribution: "round_robin" });
  });

  it("defaults to OMO Native roles and still writes saved legacy entries", () => {
    expect(Object.keys(omoTaskConfiguration(settings({}), "/tasks").agents)).toEqual([
      "explore",
      "librarian",
      "plan-consultant",
      "plan-reviewer",
    ]);
    expect(Object.keys(omoTaskConfiguration(settings({}), "/tasks").categories)).toEqual([
      "visual-engineering",
      "architect",
      "ultrabrain",
      "deep-low",
      "deep-high",
      "artistry",
      "quick",
      "unspecified-low",
      "unspecified-high",
      "writing",
      "deep",
    ]);
    const legacy = omoTaskConfiguration(
      settings({ agentModels: { sisyphus: "cox/expert" }, agentReasoning: { sisyphus: "high" } }),
      "/tasks",
    );
    expect(legacy.agents.sisyphus).toEqual({
      models: ["cox/expert"],
      models_distribution: "round_robin",
      reasoning: "high",
    });
  });

  it("assigns both native deep lanes and preserves saved deep selections through the alias", () => {
    const native = omoTaskConfiguration(
      settings({
        provider: "cox",
        model: "main",
        categoryModels: { deep: "cox/expert" },
        categoryReasoning: { deep: "high" },
      }),
      "/tasks",
    );
    expect(native.categories["deep-low"]).toEqual({
      models: ["cox/expert"],
      models_distribution: "round_robin",
      reasoning: "high",
    });
    expect(native.categories["deep-high"]).toEqual({
      models: ["cox/main"],
      models_distribution: "round_robin",
    });
    expect(native.categories.deep).toEqual(native.categories["deep-low"]);
    const defaults = omoTaskConfiguration(settings({ provider: "cox", model: "main" }), "/tasks");
    expect(defaults.categories["deep-low"]?.models).toEqual(["cox/main"]);
    expect(defaults.categories["deep-high"]?.models).toEqual(["cox/main"]);
  });

  it("gives canonical deep-low overrides precedence, including explicit main-model inheritance", () => {
    const native = omoTaskConfiguration(
      settings({
        provider: "cox",
        model: "main",
        categoryModels: { deep: "cox/legacy", "deep-low": "", "deep-high": "cox/expert" },
        categoryReasoning: { deep: "high", "deep-low": "", "deep-high": "max" },
      }),
      "/tasks",
    );
    expect(native.categories["deep-low"]).toEqual({
      models: ["cox/main"],
      models_distribution: "round_robin",
    });
    expect(native.categories["deep-high"]).toMatchObject({
      models: ["cox/expert"],
      reasoning: "max",
    });
  });

  it("defaults global memory on, exposes a real boolean opt-out and forbids native sync", () => {
    expect(settings({}).automaticMemory).toBe(true);
    expect(() => unknownSettings({ automaticMemory: "false" })).toThrow();
    expect(omoTaskConfiguration(settings({}), "/tasks").memory).toEqual({
      enabled: true,
      agent: "cox-global",
      sync: { enabled: false },
      project_scope: { nudge: false, recall: false },
    });
    expect(
      omoTaskConfiguration(settings({ automaticMemory: false }), "/tasks").memory.enabled,
    ).toBe(false);
  });

  it("preserves managed upstream IDs that already start with the Cox provider name", () => {
    const native = omoTaskConfiguration(
      settings({
        modelServiceManaged: true,
        provider: "cox",
        model: "cox/model",
        customModels: [{ slug: "cox/cox/model" }],
      }),
      "/tasks",
    );
    expect(native.agents.explore?.models).toEqual(["cox/cox/model"]);
  });
  it("restricts native role assignments to exact models in the managed binding", () => {
    const config = settings({
      modelServiceManaged: true,
      provider: "cox",
      model: "Vendor/Exact",
      customModels: [{ slug: "cox/Vendor/Exact" }, { slug: "cox/other" }],
      agentModels: { explore: "cox/other" },
    });
    const native = omoTaskConfiguration(config, "/isolated/tasks");
    expect(native.agents.explore).toEqual({
      models: ["cox/other"],
      models_distribution: "round_robin",
    });
    expect(native.categories.quick).toEqual({
      models: ["cox/Vendor/Exact"],
      models_distribution: "round_robin",
    });
    expect(native.task.state_dir).toEqual("/isolated/tasks");
    expect(() =>
      omoTaskConfiguration(
        { ...config, agentModels: { explore: "anthropic/foreign" } },
        "/isolated/tasks",
      ),
    ).toThrow("not available");
  });

  it("does not double-prefix a model selector and rejects invalid roles", () => {
    const config = settings({ provider: "cox", model: "cox/model" });
    expect(omoTaskConfiguration(config, "/tasks").categories.quick).toMatchObject({
      models: ["cox/model"],
    });
    expect(() => settings({ agentModels: { "../outside": "cox/model" } })).toThrow();
    expect(() => settings({ agentModels: { constructor: "cox/model" } })).toThrow();
    expect(() => settings({ agentModels: { "1invalid": "cox/model" } })).toThrow();
    expect(() =>
      omoTaskConfiguration({ ...config, agentModels: { "1invalid": "cox/model" } }, "/tasks"),
    ).toThrow("start with a letter");
  });

  it("isolates engine state and keeps human client capabilities off descendants", () => {
    const env = omoEnvironment(settings({ agentDir: "/isolated/agent" }), {
      SENPI_RPC_CLIENT_CAPABILITIES: "interactive_user",
      OMO_RPC_CLIENT_CAPABILITIES: "interactive_user",
    });
    expect(env).toMatchObject({
      PI_CODING_AGENT_DIR: "/isolated/agent",
      SENPI_CODING_AGENT_DIR: "/isolated/agent",
      OMO_CODING_AGENT_DIR: "/isolated/agent",
    });
    expect(env.SENPI_RPC_CLIENT_CAPABILITIES).toBeUndefined();
    expect(env.OMO_RPC_CLIENT_CAPABILITIES).toBeUndefined();
  });
  it("does not mistake asynchronous push for disabling synchronization or inherit native memory roots", () => {
    const env = omoEnvironment(settings({ automaticMemory: false }), {
      OMO_MEMORY_HOME: "/outside/memory",
      OMO_MEMORY_PUSH_SYNC: "0",
      OMO_MEMORY_RUN_SUPERVISOR_PATH: "/outside/supervisor",
    });
    expect(env.OMO_MEMORY_HOME).toBeUndefined();
    expect(env.OMO_MEMORY_PUSH_SYNC).toBeUndefined();
    expect(env.OMO_MEMORY_RUN_SUPERVISOR_PATH).toBeUndefined();
    expect(env.COX_OMO_AUTOMATIC_MEMORY).toBe("0");
  });
  it("keeps ambient model credentials out of a managed runtime", () => {
    const env = omoEnvironment(settings({ modelServiceManaged: true }), {
      ANTHROPIC_API_KEY: "ambient",
      CLAUDE_CODE_OAUTH_TOKEN_2: "ambient",
      HF_TOKEN: "ambient",
      COX_MODEL_SERVICE_KEY: "scoped",
      PATH: "/bin",
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN_2).toBeUndefined();
    expect(env.HF_TOKEN).toBeUndefined();
    expect(env.COX_MODEL_SERVICE_KEY).toEqual("scoped");
    expect(env.PATH).toEqual("/bin");
  });
});

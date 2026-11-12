import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { resolveCommandPath } from "@t3tools/shared/shell";
import { omoModelReasoningLevels } from "@t3tools/shared/omoRecommendations";
import { OMO_NATIVE_AGENT_ROLES, OMO_NATIVE_CATEGORY_ROLES } from "@t3tools/shared/omoRoles";
import { piEnvironment } from "@t3tools/provider-pi/server";
import { OmoReasoningLevel } from "@t3tools/contracts";
import { OmoRoleName, type OmoSettings } from "../settings.ts";

export const OMO_VERSION = "5.1.69";
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const isOmoRoleName = Schema.is(OmoRoleName);
const isOmoReasoningLevel = Schema.is(OmoReasoningLevel);
const decodePackageManifest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ name: Schema.optional(Schema.String) })),
);

const agents = OMO_NATIVE_AGENT_ROLES.map((role) => role.name);
const categories = [...OMO_NATIVE_CATEGORY_ROLES.map((role) => role.name), "deep"];

export function omoEnvironment(
  settings: OmoSettings,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const next = piEnvironment(settings, environment);
  if (settings.modelServiceManaged) {
    for (const key of Object.keys(next)) {
      if (
        !key.startsWith("COX_") &&
        (/(?:_API_KEY|_AUTH_TOKEN|_OAUTH_TOKEN)(?:_\d+)?$/.test(key) ||
          [
            "HF_TOKEN",
            "COPILOT_GITHUB_TOKEN",
            "GITHUB_COPILOT_TOKEN",
            "GOOGLE_APPLICATION_CREDENTIALS",
            "AWS_ACCESS_KEY_ID",
            "AWS_SECRET_ACCESS_KEY",
            "AWS_SESSION_TOKEN",
            "AWS_BEARER_TOKEN_BEDROCK",
          ].includes(key))
      )
        delete next[key];
    }
  }
  if (settings.agentDir?.trim()) {
    next.OMO_CODING_AGENT_DIR = settings.agentDir.trim();
    next.SENPI_CODING_AGENT_DIR = settings.agentDir.trim();
  }
  next.COX_NATIVE_PERMISSIONS = "1";
  delete next.OMO_MEMORY_PUSH_SYNC;
  delete next.OMO_MEMORY_HOME;
  delete next.OMO_MEMORY_RUN_SUPERVISOR_PATH;
  next.COX_OMO_AUTOMATIC_MEMORY = settings.automaticMemory ? "1" : "0";
  delete next.SENPI_RPC_CLIENT_CAPABILITIES;
  delete next.OMO_RPC_CLIENT_CAPABILITIES;
  return next;
}

export function omoTaskConfiguration(settings: OmoSettings, stateDir: string) {
  const selected =
    settings.provider &&
    settings.model &&
    (settings.modelServiceManaged || !settings.model.startsWith(`${settings.provider}/`))
      ? `${settings.provider}/${settings.model}`
      : settings.model;
  const available = new Set(
    settings.customModels.map((model) => (typeof model === "string" ? model : model.slug)),
  );
  const resolve = (model: string | undefined): string | undefined => {
    const result = model || selected;
    if (settings.modelServiceManaged && (result === undefined || !available.has(result)))
      throw new Error(
        `OMO role model '${result ?? ""}' is not available in this model service binding.`,
      );
    return result;
  };
  const assign = (
    names: ReadonlyArray<string>,
    overrides: Readonly<Record<string, string>>,
    reasoning: Readonly<Record<string, string>>,
  ) =>
    Object.fromEntries(
      [...new Set([...names, ...Object.keys(overrides), ...Object.keys(reasoning)])].map((name) => {
        if (!isOmoRoleName(name))
          throw new Error(
            "OMO role names must start with a letter and use letters, numbers, underscores or hyphens; reserved names are not allowed.",
          );
        const model = resolve(overrides[name]);
        const level = reasoning[name];
        if (level && !isOmoReasoningLevel(level))
          throw new Error("Unsupported OMO thinking strength.");
        if (level && settings.modelServiceManaged) {
          const metadata = settings.customModels.find(
            (candidate) => typeof candidate !== "string" && candidate.slug === model,
          );
          const levels = omoModelReasoningLevels({
            capabilities: typeof metadata === "object" ? (metadata.capabilities ?? null) : null,
          });
          if (!levels.some((candidate) => candidate === level))
            throw new Error(
              `OMO thinking strength '${level}' is not supported by model '${model}'.`,
            );
        }
        return [
          name,
          {
            models: model === undefined ? [] : [model],
            models_distribution: "round_robin",
            ...(level ? { reasoning: level } : {}),
          },
        ];
      }),
    );
  const categoryModels = {
    ...settings.categoryModels,
    ...(Object.hasOwn(settings.categoryModels, "deep-low")
      ? { deep: settings.categoryModels["deep-low"]! }
      : Object.hasOwn(settings.categoryModels, "deep")
        ? { "deep-low": settings.categoryModels.deep! }
        : {}),
  };
  const categoryReasoning = {
    ...settings.categoryReasoning,
    ...(Object.hasOwn(settings.categoryReasoning, "deep-low")
      ? { deep: settings.categoryReasoning["deep-low"]! }
      : Object.hasOwn(settings.categoryReasoning, "deep")
        ? { "deep-low": settings.categoryReasoning.deep! }
        : {}),
  };
  return {
    agents: assign(agents, settings.agentModels, settings.agentReasoning),
    categories: assign(categories, categoryModels, categoryReasoning),
    memory: {
      enabled: settings.automaticMemory,
      agent: "cox-global",
      sync: { enabled: false },
      project_scope: { nudge: false, recall: false },
    },
    task: {
      state_dir: stateDir,
      isolation: {
        enabled: false,
        backend: "auto",
        apply: true,
        merge: "patch",
        commits: "generic",
      },
      default_execution_mode: "in-process",
      process_runner: "child-process",
      host_engine_policy: "fallback",
      host_shard_prewarm: "off",
      default_concurrency: 5,
      global_concurrency: 8,
      max_depth: 1,
      residency_max_children: "unlimited",
      resident_idle_timeout_ms: 900_000,
      ttl_ms: 86_400_000,
      resume_children: false,
      warnings: { unavailable_categories: true },
      wait: { min_ms: 5_000, default_ms: 60_000, max_ms: 600_000 },
      team: { max_members: 8, max_parallel_members: 4, max_wall_clock_minutes: 120 },
    },
    teams: {},
  };
}

export const prepareOmoConfiguration = Effect.fn("prepareOmoConfiguration")(function* (
  settings: OmoSettings,
  environment: NodeJS.ProcessEnv,
  baseDir: string,
  instanceId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* Effect.try(() => {
    if (!instanceId.trim()) throw new Error("OMO requires a Cox instance ID.");
  });
  const instanceDirectory = path.join(
    baseDir,
    "providers",
    "omo",
    instanceId === "." || instanceId === ".."
      ? instanceId.replaceAll(".", "%2E")
      : encodeURIComponent(instanceId),
  );
  const agentDir = settings.agentDir || path.join(instanceDirectory, "agent");
  const configured: OmoSettings = {
    ...settings,
    binaryPath: settings.binaryPath || "omo",
    agentDir,
    sessionDir: settings.sessionDir || path.join(agentDir, "sessions"),
  };
  const env = omoEnvironment(configured, environment);
  env.COX_OMO_MEMORY_HOME = path.join(instanceDirectory, "memory");
  env.OMO_MEMORY_HOME = env.COX_OMO_MEMORY_HOME;
  const executable = yield* resolveCommandPath(configured.binaryPath!, { env });
  if (executable) {
    const resolved = yield* fs.realPath(executable).pipe(Effect.orElseSucceed(() => executable));
    let directory = path.dirname(resolved);
    for (let index = 0; index < 7; index++) {
      const candidate = path.join(directory, "package.json");
      const manifest = yield* fs.readFileString(candidate).pipe(
        Effect.flatMap(decodePackageManifest),
        Effect.orElseSucceed(() => undefined),
      );
      if (manifest?.name === "omo-ai") {
        env.COX_OMO_PACKAGE_ROOT = directory;
        break;
      }
      const nested = path.join(directory, "node_modules", "omo-ai");
      if (yield* fs.exists(path.join(nested, "plugin", "extensions", "omo.js"))) {
        env.COX_OMO_PACKAGE_ROOT = nested;
        break;
      }
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  const stateDir = path.join(agentDir, "tasks");
  const config = yield* Effect.try(() => omoTaskConfiguration(configured, stateDir));
  env.COX_OMO_TASK_CONFIG = yield* encodeJson(config);
  env.COX_OMO_FIXED_ROLES = yield* encodeJson({
    agents: Object.entries(settings.agentModels)
      .filter(([, model]) => model !== "")
      .map(([name]) => name),
    categories: Object.entries({
      ...settings.categoryModels,
      ...(Object.hasOwn(settings.categoryModels, "deep-low")
        ? { deep: settings.categoryModels["deep-low"]! }
        : Object.hasOwn(settings.categoryModels, "deep")
          ? { "deep-low": settings.categoryModels.deep! }
          : {}),
    })
      .filter(([, model]) => model !== "")
      .map(([name]) => name),
  });
  env.COX_OMO_MANAGED_MODELS = configured.modelServiceManaged ? "1" : "0";
  env.COX_OMO_ALLOWED_MODELS = yield* encodeJson(
    configured.customModels.map((model) => (typeof model === "string" ? model : model.slug)),
  );
  yield* fs.makeDirectory(agentDir, { recursive: true });
  return { settings: configured, environment: env };
});

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { buildPiRpcLaunch, materializePiT3McpExtension } from "@t3tools/provider-pi/server";
import { OMO_TODO_BRIDGE_SOURCE } from "./todo.ts";

export const OMO_EXTENSION_SOURCE = `
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import coxBridge from "./pi-t3-mcp-extension.ts";

const excluded = new Set([
  "config-startup", "config-watch", "model-profile", "onboarding", "onboarding-scan",
  "side-panel", "telemetry", "device-service", "memory", "feedback", "thread",
  "browser-bridge", "desktop-toolkit",
]);

export default async function coxOmo(pi) {
  const root = process.env.COX_OMO_PACKAGE_ROOT || dirname(createRequire(pathToFileURL(process.argv[1])).resolve("omo-ai/package.json"));
  if (!root) throw new Error("Cox could not locate the omo-ai package. Use the Cox-managed installation or the official omo binary.");
  const entry = await import(pathToFileURL(join(root, "plugin", "extensions", "omo.js")).href);
  const tasks = await import(pathToFileURL(join(root, "plugin", "extensions", "omo-task.js")).href);
  if (typeof entry.composeOmoSenpiExtension !== "function" || !Array.isArray(entry.omoSenpiComponents) || typeof tasks.createTaskComponent !== "function")
    throw new Error("This OMO Native version does not expose the required Cox integration interfaces.");
  const config = JSON.parse(process.env.COX_OMO_TASK_CONFIG || "{}");
  const fixed = JSON.parse(process.env.COX_OMO_FIXED_ROLES || "{}");
  const managed = process.env.COX_OMO_MANAGED_MODELS === "1";
  const allowed = new Set(JSON.parse(process.env.COX_OMO_ALLOWED_MODELS || "[]"));
  const registries = new WeakMap();
  let nativeTaskRegistered = false;
  const permit = model => model && allowed.has(model.provider + "/" + model.id);
  const scopedRegistry = registry => {
    if (!managed || !registry) return registry;
    let scoped = registries.get(registry);
    if (scoped) return scoped;
    scoped = new Proxy(registry, {
      get(target, key) {
        if (key === "getAvailable" || key === "getAll") return (...args) => target[key](...args).filter(permit);
        if (key === "find" || key === "getModelOfType") return (...args) => {
          const model = target[key](...args);
          return permit(model) ? model : undefined;
        };
        if (["stream", "streamSimple", "complete", "getApiKeyAndHeaders"].includes(key)) return (model, ...args) => {
          if (!permit(model)) throw new Error("The requested model is outside this Cox binding.");
          return target[key](model, ...args);
        };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    registries.set(registry, scoped);
    return scoped;
  };
  const components = entry.omoSenpiComponents.filter(c => !excluded.has(c.name)).map(c =>
    c.name === "task" ? tasks.createTaskComponent({ loadConfig: () => ({ config, diagnostics: [], layers: [], sources: [] }) }) : c);
  const owned = new Proxy(pi, {
    get(target, key) {
      if (key === "registerTool") {
        const register = target.registerTool.bind(target);
        return tool => {
          register(tool);
          if (tool.name === "task") nativeTaskRegistered = true;
        };
      }
      if (key === "on") return (name, handler, options) => target.on(name, (event, ctx) => {
        const scoped = !managed || !ctx ? ctx : new Proxy(ctx, {
          get(context, property) {
            if (property === "modelRegistry") return scopedRegistry(context.modelRegistry);
            const value = Reflect.get(context, property, context);
            return typeof value === "function" ? value.bind(context) : value;
          },
        });
        return handler(event, scoped);
      }, options);
      if (key === "getFlag") return name => name === "omo-senpi-disabled" ? false : target.getFlag(name);
      if (key === "registerFlag") return (name, options) => {
        if (name === "omo-senpi-disabled" || entry.omoSenpiComponents.some(c => name === "omo-senpi-" + c.name + "-disabled")) return;
        target.registerFlag(name, options);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await entry.composeOmoSenpiExtension(components, { env: { ...process.env, OMO_SENPI_DISABLED: "0" } })(owned);
  const bridge = await coxBridge(pi);
  ${OMO_TODO_BRIDGE_SOURCE}
  pi.on("before_agent_start", async (_event, ctx) => {
    if (!pi.getPermissionPreset?.()) throw new Error("OMO Native's permission system is not active.");
    if (process.env.COX_OMO_MANAGED_MODELS === "1" && ctx.model?.provider !== "cox")
      throw new Error("This OMO Native instance must use a model from its Cox model service binding.");
    if (ctx.model?.provider && ctx.model?.id) {
      const selected = ctx.model.provider + "/" + ctx.model.id;
      for (const group of ["agents", "categories"]) {
        const explicit = new Set(fixed[group] || []);
        for (const [name, role] of Object.entries(config[group] || {})) {
          if (!explicit.has(name) && Array.isArray(role.models)) role.models.splice(0, role.models.length, selected);
        }
      }
    }
  });
  pi.rpc.handle("cox.omo.ready", async () => {
    await bridge.ensureReady().catch(() => undefined);
    const coxOrchestration = bridge.getHealth();
    const tool = pi.getAllTools().find(tool => tool.name === "task");
    const required = process.env.COX_OMO_TOOLS_REQUIRED === "1";
    const nativeTaskStatus = !nativeTaskRegistered ? (pi.getFlag("omo-task") === false ? "disabled" : "unregistered") : !tool || tool.exposure === "hidden" ? "excluded" :
      pi.getActiveTools().includes("task") ? "active" :
      coxOrchestration.searchReady && tool.allowLazyActivation !== false && ["search", "deferred"].includes(tool.exposure) ? "searchable" : "inactive";
    const nativeTaskReady = ["active", "searchable"].includes(nativeTaskStatus);
    const nativeTaskAvailable = !required || nativeTaskReady || ["excluded", "disabled"].includes(nativeTaskStatus);
    const coxRequired = !!process.env.T3_MCP_URL || !!process.env.T3_MCP_BEARER_TOKEN;
    const coxAvailable = !coxRequired || coxOrchestration.available;
    return {
      ready: (!required || nativeTaskReady) && (!coxRequired || coxOrchestration.coxOrchestrationReady),
      available: nativeTaskAvailable && coxAvailable,
      nativeTaskReady,
      coxOrchestrationReady: coxOrchestration.coxOrchestrationReady,
      nativeTask: { required, registered: nativeTaskRegistered, status: nativeTaskStatus },
      coxOrchestration: { ...coxOrchestration, required: coxRequired },
    };
  });
}
`;

export const materializeOmoExtension: typeof materializePiT3McpExtension = Effect.fn(
  "materializeOmoExtension",
)(function* (cacheDir: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* materializePiT3McpExtension(cacheDir);
  const dest = `${cacheDir.replace(/\\/g, "/")}/cox-omo-extension.ts`;
  const existing = yield* fs.readFileString(dest).pipe(Effect.orElseSucceed(() => ""));
  if (existing !== OMO_EXTENSION_SOURCE) {
    yield* Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* fs.makeTempDirectoryScoped({ directory: cacheDir });
        const temporary = `${directory.replace(/\\/g, "/")}/cox-omo-extension.ts`;
        yield* fs.writeFileString(temporary, OMO_EXTENSION_SOURCE, { mode: 0o600 });
        yield* fs.rename(temporary, dest).pipe(Effect.retry({ times: 3 }));
      }),
    );
  }
  return dest;
});

export const buildOmoLaunch: typeof buildPiRpcLaunch = (input) => {
  const launch = buildPiRpcLaunch(input);
  const mode = input.runtimeMode;
  const preset =
    mode === "full-access" ? "full-access" : mode === "auto-accept-edits" ? "accept-edits" : "ask";
  return {
    args: [
      ...launch.args,
      "--omo-senpi-disabled",
      "--permission-preset",
      preset,
      ...(input.disableTools ? ["--omo-senpi-task-disabled"] : []),
    ],
    env: {
      ...launch.env,
      COX_NATIVE_PERMISSIONS: "1",
      OMO_SENPI_DISABLED: "1",
      COX_OMO_EXTENSION_REQUIRED:
        input.extensionPath !== undefined && !input.disableExtensions ? "1" : "0",
      COX_OMO_TOOLS_REQUIRED: input.disableTools ? "0" : "1",
      COX_OMO_EPHEMERAL: input.ephemeral ? "1" : "0",
    },
  };
};

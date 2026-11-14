import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { buildPiRpcLaunch, materializePiT3McpExtension } from "@t3tools/provider-pi/server";
import { OMO_TODO_BRIDGE_SOURCE } from "./todo.ts";
import { OMO_SCHEDULE_BRIDGE_SOURCE } from "./schedule.ts";
import { OMO_CODE_ORCHESTRATION_INSTRUCTIONS } from "@t3tools/provider-core/server/orchestrationInstructions";
import { omoPermissionPreset } from "./permissions.ts";
import { OMO_SUBAGENT_TRANSCRIPT_SOURCE } from "./subagents.ts";
import { OMO_RUNTIME_ASSETS_SOURCE } from "./runtimeAssets.ts";
import { OMO_MEMORY_SOURCE } from "./memory.ts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import type { ModelSelection } from "@t3tools/contracts";

export function omoSessionSelection(selection: ModelSelection) {
  return {
    model: selection.model,
    thinking: getModelSelectionStringOptionValue(selection, "thinking"),
  };
}

export const OMO_EXTENSION_SOURCE = `
import { pathToFileURL } from "node:url";
import { Type } from "typebox";
import coxBridge from "./pi-t3-mcp-extension.ts";

${OMO_RUNTIME_ASSETS_SOURCE}
${OMO_MEMORY_SOURCE}

const excluded = new Set([
  "config-startup", "config-watch", "model-profile", "onboarding", "onboarding-scan",
  "side-panel", "telemetry", "device-service", "feedback", "thread",
  "browser-bridge", "desktop-toolkit",
]);

export default async function coxOmo(pi) {
  const runtime = await loadCoxOmoRuntimeAssets();
  const { entry, tasks } = runtime;
  pi.on("session_start", (_event, ctx) => runtime.assertNativeSession(ctx));
  let selectionError;
  let selectionBaseline;
  pi.rpc.handle("cox.omo.prepare", async data => {
    process.env.COX_OMO_SESSION_SELECTION = JSON.stringify(data);
    return { prepared: true };
  });
  pi.on("session_start", async (event, ctx) => {
    if (event.reason === "reload") return;
    selectionError = undefined;
    selectionBaseline = { model: ctx.model, thinkingLevel: pi.getThinkingLevel?.() };
    try {
      const selection = JSON.parse(process.env.COX_OMO_SESSION_SELECTION || "{}");
      if (selection.model && selection.model !== "default") {
        if (managed && !allowed.has(selection.model)) throw new Error("The selected model is outside this Cox binding.");
        const model = ctx.modelRegistry.getAvailable().find(model => model.provider + "/" + model.id === selection.model);
        if (!model || !(await pi.setSessionModel(model))) throw new Error("OMO Native could not restore the selected Cox model.");
      }
      if (selection.thinking) pi.setSessionThinkingLevel(selection.thinking);
    } catch (error) {
      selectionError = error instanceof Error ? error.message : String(error);
      ctx.abort("system");
    }
  });
  if (runtime.kind === "npm") {
    if (!runtime.permissions.decisionModulePath) throw new Error("The selected OMO npm engine has no child permission module.");
    const childPermissions = await import(pathToFileURL(runtime.permissions.decisionModulePath).href);
    if (typeof childPermissions.bindDecisionPreset !== "function" || typeof childPermissions.releaseDecisionPreset !== "function")
      throw new Error("The selected OMO npm engine cannot synchronize native child permissions.");
    let permissionParent;
    const detach = () => {
      if (permissionParent) childPermissions.releaseDecisionPreset(permissionParent);
      permissionParent = undefined;
    };
    const bind = (_event, ctx) => {
      detach();
      if (!ctx?.sessionManager) return;
      permissionParent = ctx.sessionManager;
      childPermissions.bindDecisionPreset({ sessionManager: permissionParent,
        namedPreset: () => pi.getPermissionPreset?.() ?? "ask", launchFlagNamed: () => false,
        recordedPreset: () => undefined });
    };
    pi.on("session_start", bind);
    pi.on("before_agent_start", bind);
    pi.on("session_before_switch", detach);
    pi.on("session_shutdown", detach);
  }
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
  const memory = process.env.COX_OMO_EPHEMERAL === "1" || process.env.COX_OMO_AUTOMATIC_MEMORY === "0"
    ? { name: "memory", register() {} }
    : await createCoxOmoMemoryComponent({ root: runtime.packageRoot, config, env: process.env,
      resolveModule: runtime.resolveModule, resolveImport: runtime.resolveImport, loadModules: runtime.loadModules });
  const components = entry.omoSenpiComponents.filter(c => !excluded.has(c.name) &&
    (c.name !== "task" || process.env.COX_OMO_TOOLS_REQUIRED !== "0")).map(c =>
    c.name === "task" ? tasks.createTaskComponent({ loadConfig: () => ({ config, diagnostics: [], layers: [], sources: [] }) }) :
    c.name === "memory" ? memory : c);
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
  const bridge = await coxBridge(pi, {
    appendSystemPrompt: true,
    orchestrationInstructions: ${JSON.stringify(OMO_CODE_ORCHESTRATION_INSTRUCTIONS.trim())},
    bridgeInstructions: "Cox tools use their full mcp__cox__<name> names. Only when Cox delegation is explicitly requested or OMO native task cannot provide the required capability, use mcp__cox__orchestrator_capabilities then mcp__cox__delegate_task with the task field, not prompt. Discover optional Cox tools with tool_search using their full names. Generic subagent or parallel requests use OMO native task instead. Never change between native and Cox delegation silently after an error, denial, or exclusion.",
  });
  ${OMO_SCHEDULE_BRIDGE_SOURCE}
  ${OMO_TODO_BRIDGE_SOURCE}
  ${OMO_SUBAGENT_TRANSCRIPT_SOURCE}
  pi.on("before_agent_start", async (_event, ctx) => {
    if (selectionError) {
      ctx.abort("system");
      throw new Error(selectionError);
    }
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
    if (selectionError) throw new Error(selectionError);
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
      selectionBaseline,
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
  const preset = omoPermissionPreset(input.runtimeMode ?? "approval-required");
  return {
    args: [...launch.args, "--permission-preset", preset],
    env: {
      ...launch.env,
      ...(input.modelSelection === undefined
        ? {}
        : {
            COX_OMO_SESSION_SELECTION: JSON.stringify(omoSessionSelection(input.modelSelection)),
          }),
      COX_NATIVE_PERMISSIONS: "1",
      OMO_SENPI_DISABLED: "1",
      COX_OMO_EXTENSION_REQUIRED:
        input.extensionPath !== undefined && !input.disableExtensions ? "1" : "0",
      COX_OMO_TOOLS_REQUIRED: input.disableTools ? "0" : "1",
      COX_OMO_EPHEMERAL: input.ephemeral ? "1" : "0",
    },
  };
};

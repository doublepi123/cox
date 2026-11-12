// @effect-diagnostics nodeBuiltinImport:off -- Executes the shipped OMO extension at its native JavaScript boundary.
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import { describe, expect, it } from "vite-plus/test";
import { OMO_EXTENSION_SOURCE } from "./extension.ts";
import { OMO_RUNTIME_ASSETS_SOURCE } from "./runtimeAssets.ts";
import { OMO_MEMORY_SOURCE } from "./memory.ts";
import { omoStartupFailure } from "./runtime.ts";

interface CoxHealth {
  readonly connected: boolean;
  readonly searchReady: boolean;
  readonly available: boolean;
  readonly coxOrchestrationReady: boolean;
  readonly tools: ReadonlyArray<{ readonly name: string; readonly status: string }>;
}

const healthyCox: CoxHealth = {
  connected: true,
  searchReady: true,
  available: true,
  coxOrchestrationReady: true,
  tools: [
    { name: "mcp__cox__orchestrator_capabilities", status: "active" },
    { name: "mcp__cox__delegate_task", status: "active" },
    { name: "mcp__cox__task_status", status: "active" },
    { name: "mcp__cox__preview_snapshot", status: "searchable" },
  ],
};

async function loadReady(
  options: {
    readonly cox?: CoxHealth;
    readonly taskRegistered?: boolean;
    readonly taskDisabled?: boolean;
    readonly captureRegistration?: boolean;
    readonly taskExcluded?: boolean;
    readonly taskActive?: boolean;
    readonly taskExposure?: string;
    readonly toolsRequired?: boolean;
    readonly mcpRequired?: boolean;
    readonly readPermissionPreset?: () => string | undefined;
    readonly assertNativeSession?: (context: unknown) => void;
    readonly memoryFailure?: boolean;
    readonly memoryEnabled?: boolean;
    readonly onMemoryRegistered?: () => void;
    readonly hooks?: Map<
      string,
      Array<(event: unknown, ctx: { readonly sessionManager?: object }) => unknown>
    >;
    readonly onBridgeOptions?: (options: {
      readonly orchestrationInstructions: string;
      readonly bridgeInstructions: string;
    }) => void;
  } = {},
) {
  const requests = new Map<string, () => unknown>();
  const tools: Array<{ name: string; exposure: string }> = [];
  const source = NodeModule.stripTypeScriptTypes(
    OMO_EXTENSION_SOURCE.replace(OMO_RUNTIME_ASSETS_SOURCE, "")
      .replace(OMO_MEMORY_SOURCE, "")
      .replace(/^import .*;$/gm, "")
      .replace("export default async function", "async function"),
  );
  const entry = {
    omoSenpiComponents: [{ name: "task" }, { name: "memory" }],
    composeOmoSenpiExtension:
      (components: Array<{ name: string; register?: () => unknown }>) =>
      async (pi: { registerTool: (tool: { name: string; exposure: string }) => void }) => {
        if (options.captureRegistration) {
          const register = pi.registerTool.bind(pi);
          pi.registerTool = (tool) => register(tool);
        }
        if (options.taskRegistered !== false && !options.taskDisabled)
          pi.registerTool({ name: "task", exposure: options.taskExposure ?? "direct" });
        for (const component of components) await component.register?.();
      },
  };
  await NodeVM.runInNewContext(`${source}\ncoxOmo(pi)`, {
    process: {
      env: {
        COX_OMO_AUTOMATIC_MEMORY: options.memoryEnabled === false ? "0" : "1",
        COX_OMO_TOOLS_REQUIRED: options.toolsRequired === false ? "0" : "1",
        ...(options.mcpRequired === false
          ? {}
          : { T3_MCP_URL: "http://fixture.invalid/mcp", T3_MCP_BEARER_TOKEN: "fixture" }),
      },
    },
    crypto,
    loadCoxOmoRuntimeAssets: async () => ({
      packageRoot: "/fixture/omo",
      entry,
      tasks: { createTaskComponent: () => ({ name: "task" }) },
      assertNativeSession: (context: unknown) => options.assertNativeSession?.(context),
    }),
    createCoxOmoMemoryComponent: async () => {
      if (options.memoryFailure) throw new Error("Memory initialization refused");
      return { name: "memory", register: () => options.onMemoryRegistered?.() };
    },
    coxBridge: async (
      _pi: unknown,
      bridgeOptions: {
        readonly orchestrationInstructions: string;
        readonly bridgeInstructions: string;
      },
    ) => {
      options.onBridgeOptions?.(bridgeOptions);
      return {
        ensureReady: async () => undefined,
        getHealth: () => options.cox ?? healthyCox,
      };
    },
    pi: {
      registerTool: (tool: { name: string; exposure: string }) => {
        if (!options.taskExcluded) tools.push(tool);
      },
      getAllTools: () => tools,
      getFlag: () => (options.taskDisabled ? false : undefined),
      getPermissionPreset: () => options.readPermissionPreset?.(),
      getActiveTools: () => (options.taskActive === false ? [] : ["task"]),
      on: (
        name: string,
        handler: (event: unknown, ctx: { readonly sessionManager?: object }) => unknown,
      ) => options.hooks?.set(name, [...(options.hooks.get(name) ?? []), handler]),
      rpc: { handle: (name: string, handler: () => unknown) => requests.set(name, handler) },
    },
  });
  return (await requests.get("cox.omo.ready")!()) as {
    readonly ready: boolean;
    readonly available: boolean;
    readonly nativeTaskReady: boolean;
    readonly coxOrchestrationReady: boolean;
    readonly nativeTask: { readonly status: string };
    readonly coxOrchestration: CoxHealth;
  };
}

describe("OMO readiness separates native tasks from Cox orchestration", () => {
  it("checks the native session registry without importing a second permission engine", async () => {
    const hooks = new Map<
      string,
      Array<(event: unknown, ctx: { readonly sessionManager?: object }) => unknown>
    >();
    const manager = {};
    await loadReady({
      hooks,
      assertNativeSession: (context) => {
        if ((context as { sessionManager?: object }).sessionManager !== manager)
          throw new Error("foreign registry");
      },
    });
    expect(() => hooks.get("session_start")![0]!({}, { sessionManager: manager })).not.toThrow();
    expect(() => hooks.get("session_start")![0]!({}, { sessionManager: {} })).toThrow(
      "foreign registry",
    );
    expect(OMO_EXTENSION_SOURCE).toContain('if (runtime.kind === "npm")');
  });
  it("awaits safe memory startup before registration and supports explicit opt-out", async () => {
    let registrations = 0;
    await loadReady({ onMemoryRegistered: () => registrations++ });
    expect(registrations).toBe(1);
    await loadReady({ memoryEnabled: false, onMemoryRegistered: () => registrations++ });
    expect(registrations).toBe(1);
    await expect(loadReady({ memoryFailure: true })).rejects.toThrow(
      "Memory initialization refused",
    );
  });
  it("installs native-first routing even when Cox delegation tools are available", async () => {
    let installed:
      | { readonly orchestrationInstructions: string; readonly bridgeInstructions: string }
      | undefined;
    await loadReady({
      onBridgeOptions: (value) => {
        installed = value;
      },
    });
    expect(installed?.orchestrationInstructions).toContain("OMO's native `task`");
    expect(installed?.bridgeInstructions).toContain(
      "Generic subagent or parallel requests use OMO native task",
    );
    expect(installed?.orchestrationInstructions).not.toContain("it finishes in this turn");
  });
  it("reports both tool surfaces only after they are usable", async () => {
    expect(await loadReady()).toMatchObject({
      ready: true,
      available: true,
      nativeTaskReady: true,
      coxOrchestrationReady: true,
      nativeTask: { status: "active" },
    });
  });

  it("does not claim Cox readiness when only native task is active", async () => {
    const health = await loadReady({
      cox: { ...healthyCox, connected: false, available: false, coxOrchestrationReady: false },
    });
    expect(health).toMatchObject({
      ready: false,
      available: false,
      nativeTaskReady: true,
      coxOrchestrationReady: false,
    });
    expect(omoStartupFailure(health)).toContain("Cox MCP is not connected");
  });

  it("preserves OMO's native registerTool capture without recursive registration", async () => {
    expect(await loadReady({ captureRegistration: true })).toMatchObject({
      available: true,
      nativeTaskReady: true,
      nativeTask: { status: "active" },
    });
  });

  it("does not report an explicitly disabled native task as an initialization failure", async () => {
    const health = await loadReady({ taskDisabled: true });
    expect(health).toMatchObject({
      ready: false,
      available: true,
      nativeTaskReady: false,
      nativeTask: { status: "disabled" },
    });
    expect(omoStartupFailure(health)).toBeUndefined();
  });

  it("distinguishes user exclusions from unavailable orchestration", async () => {
    const health = await loadReady({
      taskExcluded: true,
      cox: {
        ...healthyCox,
        coxOrchestrationReady: false,
        tools: healthyCox.tools.map((tool) =>
          tool.name === "mcp__cox__delegate_task" ? { ...tool, status: "excluded" } : tool,
        ),
      },
    });
    expect(health).toMatchObject({
      ready: false,
      available: true,
      nativeTaskReady: false,
      coxOrchestrationReady: false,
      nativeTask: { status: "excluded" },
    });
    expect(omoStartupFailure(health)).toBeUndefined();
  });

  it.each([
    { taskRegistered: false, status: "unregistered" },
    { taskActive: false, status: "inactive" },
  ])("rejects a genuinely $status native task", async ({ status, ...options }) => {
    const health = await loadReady(options);
    expect(health).toMatchObject({
      ready: false,
      available: false,
      nativeTaskReady: false,
      nativeTask: { status },
    });
    expect(omoStartupFailure(health)).toContain(`Native task: ${status}`);
  });

  it("recognizes a searchable native task only with active builtin discovery", async () => {
    const health = await loadReady({ taskActive: false, taskExposure: "search" });
    expect(health).toMatchObject({ nativeTaskReady: true, nativeTask: { status: "searchable" } });
    const unavailable = await loadReady({
      taskActive: false,
      taskExposure: "search",
      cox: { ...healthyCox, searchReady: false },
    });
    expect(unavailable).toMatchObject({
      available: false,
      nativeTaskReady: false,
      nativeTask: { status: "inactive" },
    });
  });

  it("does not require tool surfaces intentionally omitted for short-lived launches", async () => {
    const health = await loadReady({
      taskRegistered: false,
      toolsRequired: false,
      mcpRequired: false,
      cox: { ...healthyCox, connected: false, available: false, coxOrchestrationReady: false },
    });
    expect(health).toMatchObject({
      ready: true,
      available: true,
      nativeTaskReady: false,
      coxOrchestrationReady: false,
    });
    expect(omoStartupFailure(health)).toBeUndefined();
  });
});

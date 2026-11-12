// @effect-diagnostics nodeBuiltinImport:off -- Executes the shipped OMO extension at its native JavaScript boundary.
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";
import { describe, expect, it } from "vite-plus/test";
import { OMO_EXTENSION_SOURCE } from "./extension.ts";
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
  } = {},
) {
  const requests = new Map<string, () => unknown>();
  const tools: Array<{ name: string; exposure: string }> = [];
  const source = NodeModule.stripTypeScriptTypes(
    OMO_EXTENSION_SOURCE.replace(/^import .*;$/gm, "")
      .replace("export default async function", "async function")
      .replace(
        'await import(pathToFileURL(join(root, "plugin", "extensions", "omo.js")).href)',
        "omoEntry",
      )
      .replace(
        'await import(pathToFileURL(join(root, "plugin", "extensions", "omo-task.js")).href)',
        "omoTasks",
      ),
  );
  await NodeVM.runInNewContext(`${source}\ncoxOmo(pi)`, {
    process: {
      env: {
        COX_OMO_PACKAGE_ROOT: "/fixture/omo",
        COX_OMO_TOOLS_REQUIRED: options.toolsRequired === false ? "0" : "1",
        ...(options.mcpRequired === false
          ? {}
          : { T3_MCP_URL: "http://fixture.invalid/mcp", T3_MCP_BEARER_TOKEN: "fixture" }),
      },
    },
    crypto,
    join: NodePath.join,
    coxBridge: async () => ({
      ensureReady: async () => undefined,
      getHealth: () => options.cox ?? healthyCox,
    }),
    omoEntry: {
      omoSenpiComponents: [{ name: "task" }],
      composeOmoSenpiExtension:
        () => async (pi: { registerTool: (tool: { name: string; exposure: string }) => void }) => {
          if (options.captureRegistration) {
            const register = pi.registerTool.bind(pi);
            pi.registerTool = (tool) => register(tool);
          }
          if (options.taskRegistered !== false && !options.taskDisabled)
            pi.registerTool({ name: "task", exposure: options.taskExposure ?? "direct" });
        },
    },
    omoTasks: { createTaskComponent: () => ({ name: "task" }) },
    pi: {
      registerTool: (tool: { name: string; exposure: string }) => {
        if (!options.taskExcluded) tools.push(tool);
      },
      getAllTools: () => tools,
      getFlag: () => (options.taskDisabled ? false : undefined),
      getActiveTools: () => (options.taskActive === false ? [] : ["task"]),
      on: () => undefined,
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

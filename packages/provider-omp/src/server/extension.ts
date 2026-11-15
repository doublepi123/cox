import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { buildPiRpcLaunch, materializePiT3McpExtension } from "@t3tools/provider-pi/server";
import { T3_CODE_ORCHESTRATION_INSTRUCTIONS } from "@t3tools/provider-core/server/orchestrationInstructions";

export const OMP_T3_MCP_EXTENSION_FILENAME = "cox-omp-extension.ts";
export const OMP_APPROVAL_MODE_ENV = "COX_OMP_APPROVAL_MODE";

export type OmpApprovalMode = "always-ask" | "write" | "yolo";

const OMP_RUNTIME_MODES: ReadonlyArray<
  "approval-required" | "auto-accept-edits" | "auto" | "full-access"
> = ["approval-required", "auto-accept-edits", "auto", "full-access"];

export function ompApprovalMode(
  runtimeMode: "approval-required" | "auto-accept-edits" | "auto" | "full-access",
): OmpApprovalMode {
  switch (runtimeMode) {
    case "approval-required":
    case "auto":
      return "always-ask";
    case "auto-accept-edits":
      return "write";
    case "full-access":
      return "yolo";
  }
}

const OMP_BRIDGE_INSTRUCTIONS =
  "Cox tools use their full mcp__cox__<name> names, such as mcp__cox__orchestrator_capabilities, mcp__cox__delegate_task and mcp__cox__task_status; mcp__cox__delegate_task takes the work in task, not prompt. Prefer omp's native task tool for generic subagent or parallel work; use Cox delegation only when Cox orchestration is explicitly requested or the native tool cannot provide the capability. Discover optional tools with tool_search using their full mcp__cox__ names when available. Never invent native task tools or switch between native and Cox delegation silently after an error, exclusion or denial.";

export const OMP_EXTENSION_SOURCE = `\
import coxBridge from "./pi-t3-mcp-extension.ts";

const APPROVAL_ENV = ${JSON.stringify(OMP_APPROVAL_MODE_ENV)};
const MCP_PREFIX = "mcp__cox__";
const READ_TOOLS = new Set(["orchestrator_capabilities", "task_status"]);

export default async function coxOmpExtension(omp) {
  const pendingToolUpdates = new Set();
  const trackToolUpdate = (promise) => {
    pendingToolUpdates.add(promise);
    void promise.then(() => pendingToolUpdates.delete(promise), () => pendingToolUpdates.delete(promise));
  };
  const settleToolUpdates = async () => {
    while (pendingToolUpdates.size > 0) await Promise.all([...pendingToolUpdates]);
  };
  const adapted = new Proxy(omp, {
    get(target, key, receiver) {
      if (key === "getPermissionPreset") {
        return () => process.env[APPROVAL_ENV] ?? "yolo";
      }
      if (key === "getCommands") {
        return () => target.getCommands().map((command) => ({ ...command, sourceInfo: { path: command.path } }));
      }
      if (key === "setActiveTools") {
        return (toolNames) => {
          trackToolUpdate(Promise.resolve(target.setActiveTools(toolNames)));
        };
      }
      if (key === "registerTool") {
        const register = target.registerTool.bind(target);
        return (tool) => {
          const base = typeof tool.name === "string" && tool.name.startsWith(MCP_PREFIX)
            ? tool.name.slice(MCP_PREFIX.length)
            : undefined;
          register(base === undefined ? tool : {
            ...tool,
            approval: READ_TOOLS.has(base) ? "read" : "exec",
            loadMode: READ_TOOLS.has(base) ? "essential" : "discoverable",
            mcpServerName: "cox",
            mcpToolName: base,
          });
        };
      }
      if (key === "on") {
        return (event, handler, options) => {
          target.on(event, async (ompEvent, ctx) => {
            const piEvent = event === "before_agent_start" && ompEvent !== null && typeof ompEvent === "object" && Array.isArray(ompEvent.systemPrompt)
              ? { ...ompEvent, systemPrompt: ompEvent.systemPrompt.join("\\n\\n") }
              : ompEvent;
            const result = await handler(piEvent, ctx);
            await settleToolUpdates();
            return result;
          }, options);
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const bridge = await coxBridge(adapted, {
    appendSystemPrompt: true,
    orchestrationInstructions: ${JSON.stringify(T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim())},
    bridgeInstructions: ${JSON.stringify(OMP_BRIDGE_INSTRUCTIONS)},
  });
  await settleToolUpdates();
  return bridge;
}
`;

export const materializeOmpExtension: typeof materializePiT3McpExtension = Effect.fn(
  "materializeOmpExtension",
)(function* (cacheDir: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* materializePiT3McpExtension(cacheDir);
  const dest = `${cacheDir.replace(/\\/g, "/")}/${OMP_T3_MCP_EXTENSION_FILENAME}`;
  const existing = yield* fs.readFileString(dest).pipe(Effect.orElseSucceed(() => ""));
  if (existing !== OMP_EXTENSION_SOURCE) {
    yield* Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* fs.makeTempDirectoryScoped({ directory: cacheDir });
        const temporary = `${directory.replace(/\\/g, "/")}/${OMP_T3_MCP_EXTENSION_FILENAME}`;
        yield* fs.writeFileString(temporary, OMP_EXTENSION_SOURCE, { mode: 0o600 });
        yield* fs.rename(temporary, dest).pipe(Effect.retry({ times: 3 }));
      }),
    );
  }
  return dest;
});

const CONTROLLED_OMP_ARGUMENTS_WITHOUT_VALUES = new Set([
  "--approve",
  "-a",
  "--no-approve",
  "-na",
  "--auto-approve",
  "--yolo",
]);

const CONTROLLED_OMP_ARGUMENTS_WITH_VALUES = new Set(["--approval-mode", "--permission-preset"]);

function withoutControlledOmpArguments(args: ReadonlyArray<string>): ReadonlyArray<string> {
  const filtered: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (CONTROLLED_OMP_ARGUMENTS_WITHOUT_VALUES.has(arg)) continue;
    const controlled = [...CONTROLLED_OMP_ARGUMENTS_WITH_VALUES].find(
      (flag) => arg === flag || arg.startsWith(`${flag}=`),
    );
    if (controlled !== undefined) {
      if (arg === controlled) index += 1;
      continue;
    }
    filtered.push(arg);
  }
  return filtered;
}

function hasExplicitExtension(args: ReadonlyArray<string>, extensionPath: string): boolean {
  const wanted = extensionPath.replace(/\\/g, "/").replace(/\/+$/, "");
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg !== "--extension" && arg !== "-e") continue;
    const configured = args[index + 1];
    if (configured !== undefined && configured.replace(/\\/g, "/").replace(/\/+$/, "") === wanted)
      return true;
    index += 1;
  }
  return false;
}

function withoutExplicitExtensions(args: ReadonlyArray<string>): ReadonlyArray<string> {
  const filtered: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === "--extension" || arg === "-e") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--extension=") || arg.startsWith("-e=")) continue;
    filtered.push(arg);
  }
  return filtered;
}

function withoutToolSelectionArgs(args: ReadonlyArray<string>): ReadonlyArray<string> {
  const filtered: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === "--tools" || arg === "--exclude-tools" || arg === "-xt") {
      index += 1;
      continue;
    }
    if (
      arg === "--no-tools" ||
      arg === "--no-builtin-tools" ||
      arg.startsWith("--tools=") ||
      arg.startsWith("--exclude-tools=")
    ) {
      continue;
    }
    filtered.push(arg);
  }
  return filtered;
}

function isOmpRuntimeMode(
  value: string | undefined,
): value is "approval-required" | "auto-accept-edits" | "auto" | "full-access" {
  return value !== undefined && (OMP_RUNTIME_MODES as readonly string[]).includes(value);
}

export const buildOmpLaunch: typeof buildPiRpcLaunch = (input) => {
  const hasT3Extension = input.disableExtensions !== true && input.extensionPath !== undefined;
  const controlled = withoutControlledOmpArguments(
    input.disableExtensions === true
      ? withoutExplicitExtensions(input.launchArgs)
      : input.launchArgs,
  );
  const launchArgs =
    input.disableTools === true ? withoutToolSelectionArgs(controlled) : controlled;
  const runtimeMode = isOmpRuntimeMode(input.runtimeMode) ? input.runtimeMode : undefined;
  const args = [
    "--mode",
    "rpc-ui",
    ...(input.ephemeral === true
      ? ["--no-session"]
      : input.sessionPath !== undefined
        ? ["--session", input.sessionPath]
        : []),
    ...launchArgs,
    ...(input.shortLived === true && !launchArgs.includes("--offline") ? ["--offline"] : []),
    ...(runtimeMode !== undefined ? ["--approval-mode", ompApprovalMode(runtimeMode)] : []),
    ...(input.disableExtensions === true ? ["--no-extensions"] : []),
    ...(input.disableTools === true ? ["--no-tools"] : []),
  ];
  if (
    hasT3Extension &&
    input.extensionPath !== undefined &&
    !hasExplicitExtension(args, input.extensionPath)
  ) {
    args.push("--extension", input.extensionPath);
  }
  const env: NodeJS.ProcessEnv = { ...buildPiRpcLaunch(input).env };
  delete env[OMP_APPROVAL_MODE_ENV];
  return {
    args,
    env: {
      ...env,
      COX_NATIVE_PERMISSIONS: "1",
      ...(runtimeMode !== undefined
        ? { [OMP_APPROVAL_MODE_ENV]: ompApprovalMode(runtimeMode) }
        : {}),
    },
  };
};

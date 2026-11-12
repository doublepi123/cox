// @effect-diagnostics nodeBuiltinImport:off -- Executes the shipped Pi extension at its native JavaScript boundary.
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";
import { PI_T3_MCP_EXTENSION_SOURCE } from "./mcpExtensionSource.ts";

interface RegisteredTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
  readonly outputSchema?: unknown;
  readonly exposure?: string;
  readonly promptSnippet?: string;
  readonly promptGuidelines?: ReadonlyArray<string>;
  readonly execute: (
    id: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<{
    readonly content: ReadonlyArray<{
      readonly type: string;
      readonly text?: string;
      readonly data?: string;
      readonly mimeType?: string;
    }>;
    readonly structuredContent?: unknown;
    readonly isError?: boolean;
  }>;
}

type AgentStartHook = (
  event: {
    systemPrompt: string;
    systemPromptOptions?: { sections?: Record<string, string> | null; forceSystemPrompt?: string };
  },
  ctx: {
    model?: { api: string };
    ui: { notify: (message: string, severity: string) => void };
  },
) => Promise<{ systemPrompt: string } | undefined>;

interface BridgeHealth {
  readonly connected: boolean;
  readonly available: boolean;
  readonly coxOrchestrationReady: boolean;
  readonly searchReady?: boolean;
  readonly reason?: string;
  readonly tools: ReadonlyArray<{
    readonly name: string;
    readonly core: boolean;
    readonly status: string;
  }>;
}

export async function loadMcpBridge(
  options: {
    readonly modern?: boolean;
    readonly result?: unknown;
    readonly toolSearchAvailable?: boolean;
    readonly toolSearchDisabled?: boolean;
    readonly toolSearchSource?: { readonly source: string; readonly path: string };
    readonly allowsTool?: (name: string) => boolean;
    readonly allowsActivation?: (name: string) => boolean;
    readonly toolExposure?: (name: string) => string | undefined;
    readonly connectFailures?: number;
    readonly listFailures?: number;
    readonly catalogNames?: ReadonlyArray<string>;
    readonly runtimeMode?: string;
    readonly inputSchema?: Record<string, unknown>;
    readonly orchestrationInstructions?: string;
    readonly bridgeInstructions?: string;
    readonly appendSystemPrompt?: boolean;
  } = {},
) {
  const handlers = new Map<string, AgentStartHook>();
  const tools: RegisteredTool[] = [];
  const requests: Array<{ readonly method: string; readonly params?: unknown }> = [];
  let activeTools = ["read"];
  let bridgeSourcePath = "/fixture/pi-t3-extension.ts";
  let toolSearchAvailable = options.toolSearchAvailable ?? false;
  let toolSearchSource = options.toolSearchSource ?? {
    source: "builtin",
    path: "builtin:tool-search",
  };
  let connectFailures = options.connectFailures ?? 0;
  let listFailures = options.listFailures ?? 0;
  const transports: Array<{
    readonly url: string;
    readonly authorization: string;
    readonly signal: AbortSignal | undefined;
  }> = [];
  const servers: Array<{ readonly name: string; readonly config: Record<string, unknown> }> = [];
  const activators: Array<(name: string) => boolean> = [];
  const catalog = [
    {
      name: "orchestrator_capabilities",
      description: "Discover available providers and models.",
      annotations: { readOnlyHint: true },
    },
    { name: "delegate_task", description: "Delegate work to another agent." },
    {
      name: "task_status",
      description: "Check delegated work.",
      annotations: { readOnlyHint: false },
    },
    { name: "preview_snapshot", description: "Inspect the collaborative browser." },
  ]
    .filter((tool) => options.catalogNames?.includes(tool.name) ?? true)
    .map((tool) => ({
      ...tool,
      inputSchema: options.inputSchema ?? { type: "object", properties: {} },
      outputSchema: { type: "object", properties: { count: { type: "number" } } },
    }));
  const source = NodeModule.stripTypeScriptTypes(
    PI_T3_MCP_EXTENSION_SOURCE.replace(/^import .*;$/gm, "").replace(
      "export default async function",
      "async function",
    ),
  );
  const bridge: { ensureReady: () => Promise<void>; getHealth: () => BridgeHealth } =
    await NodeVM.runInNewContext(`${source}\nt3McpExtension(pi, bridgeOptions)`, {
      bridgeOptions: {
        orchestrationInstructions: options.orchestrationInstructions,
        bridgeInstructions: options.bridgeInstructions,
        appendSystemPrompt: options.appendSystemPrompt,
      },
      process: {
        env: {
          T3_MCP_URL: "http://fixture.invalid/mcp",
          T3_MCP_BEARER_TOKEN: "fixture-token",
          T3_PI_MCP_EXTENSION_PATH: "/fixture/pi-t3-extension.ts",
          T3_PI_RUNTIME_MODE: options.runtimeMode,
        },
      },
      AbortSignal,
      NodePath,
      Type: { Unsafe: (schema: unknown) => schema },
      fetch: async (
        url: string,
        transport: { body: string; headers: Record<string, string>; signal?: AbortSignal },
      ) => {
        transport.signal?.throwIfAborted();
        transports.push({
          url,
          authorization: transport.headers.authorization!,
          signal: transport.signal,
        });
        const request = JSON.parse(transport.body) as {
          id: number;
          method: string;
          params?: unknown;
        };
        requests.push(request);
        if (request.method === "initialize" && connectFailures-- > 0) {
          throw new Error("Fixture connection unavailable");
        }
        if (request.method === "tools/list" && listFailures-- > 0) {
          throw new Error("Fixture catalog unavailable");
        }
        const result =
          request.method === "tools/list"
            ? { tools: catalog }
            : request.method === "tools/call"
              ? (options.result ?? { content: [{ type: "text", text: "browser snapshot" }] })
              : {};
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), {
          headers: { "content-type": "application/json" },
        });
      },
      pi: {
        on: (name: string, handler: AgentStartHook) => handlers.set(name, handler),
        registerTool: (tool: RegisteredTool) => {
          if (options.allowsTool && !options.allowsTool(tool.name)) return;
          const index = tools.findIndex((current) => current.name === tool.name);
          if (index === -1) tools.push(tool);
          else tools[index] = tool;
        },
        getActiveTools: () => activeTools,
        setActiveTools: (names: string[]) => {
          activeTools = names.filter(
            (name) =>
              (options.allowsTool?.(name) ?? true) && (options.allowsActivation?.(name) ?? true),
          );
        },
        getAllTools: () => [
          ...tools.map((tool) => ({
            name: tool.name,
            exposure: options.toolExposure?.(tool.name) ?? tool.exposure,
            sourceInfo: { source: "extension", path: bridgeSourcePath },
          })),
          ...(toolSearchAvailable &&
          !options.toolSearchDisabled &&
          (options.allowsTool?.("tool_search") ?? true)
            ? [{ name: "tool_search", sourceInfo: toolSearchSource }]
            : []),
        ],
        ...(options.modern
          ? {
              registerMcpServer: (name: string, config: Record<string, unknown>) =>
                servers.push({ name, config }),
              unregisterMcpServer: () => servers.splice(0),
              registerLazyToolActivator: (activate: (name: string) => boolean) =>
                activators.push(activate),
            }
          : {}),
      },
    });
  return {
    handlers,
    tools,
    getHealth: bridge.getHealth,
    ensureReady: bridge.ensureReady,
    setToolSearch: (available: boolean, source = toolSearchSource) => {
      toolSearchAvailable = available;
      toolSearchSource = source;
    },
    setBridgeSourcePath: (path: string) => {
      bridgeSourcePath = path;
    },
    requests,
    servers,
    activateLazyTool: (name: string) => activators.some((activate) => activate(name)),
    transports,
    getActiveTools: () => activeTools,
    restoreActiveTools: (names: string[]) => {
      activeTools = names;
    },
  };
}

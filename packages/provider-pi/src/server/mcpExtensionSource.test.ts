// @effect-diagnostics nodeBuiltinImport:off -- Pi extensions run outside Effect; these tests exercise their native filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import { assert, describe, it } from "@effect/vitest";

import { PI_T3_MCP_EXTENSION_SOURCE } from "./mcpExtensionSource.ts";
import { loadMcpBridge } from "./mcpBridge.testkit.ts";
import { OMO_CODE_ORCHESTRATION_INSTRUCTIONS } from "@t3tools/provider-core/server/orchestrationInstructions";

type RequestHook = (
  event: { payload: unknown },
  ctx: { model: { provider: string } },
) => Record<string, unknown> | undefined;

interface SkillCommand {
  readonly name: string;
  readonly source: string;
  readonly sourceInfo: { readonly path: string };
}

type InputHook = (
  event: { text: string; images?: ReadonlyArray<unknown> },
  ctx: { ui: { notify: (message: string, level: string) => void } },
) => Promise<{ action: string; text: string; images?: ReadonlyArray<unknown> } | undefined>;

async function loadHooks(
  commands: ReadonlyArray<SkillCommand> = [],
  argv: ReadonlyArray<string> = [],
) {
  const handlers = new Map<string, unknown>();
  const source = NodeModule.stripTypeScriptTypes(
    PI_T3_MCP_EXTENSION_SOURCE.replace(/^import .*;$/gm, "").replace(
      "export default async function",
      "async function",
    ),
  );
  await NodeVM.runInNewContext(`${source}\nt3McpExtension(pi)`, {
    process: { env: {}, argv },
    NodeFSP,
    NodePath,
    stripFrontmatter: (content: string) => content,
    pi: {
      on: (name: string, handler: unknown) => handlers.set(name, handler),
      getCommands: () => commands,
    },
  });
  return handlers;
}

describe("Pi orchestration prompt section", () => {
  it("keeps OMO's native-first override in both sectioned and forced prompts", async () => {
    const bridge = await loadMcpBridge({
      orchestrationInstructions: OMO_CODE_ORCHESTRATION_INSTRUCTIONS,
      bridgeInstructions: "OMO native tools first; Cox only when explicitly requested.",
    });
    const hook = bridge.handlers.get("before_agent_start")!;
    const sections: Record<string, string> = {};
    await hook(
      { systemPrompt: "base", systemPromptOptions: { sections } },
      { ui: { notify: assert.fail } },
    );
    assert.include(sections.cox_orchestration!, "OMO's native `task`");
    assert.include(sections.cox_orchestration!, "OMO native tools first");
    assert.notInclude(sections.cox_orchestration!, "Pi without one uses Cox delegation");
    const forced = await hook({ systemPrompt: "base" }, { ui: { notify: assert.fail } });
    assert.include(forced!.systemPrompt, "report its original error");
  });
  it("appends native runtime guidance when its full prompt replacement bypasses section rendering", async () => {
    const bridge = await loadMcpBridge({
      orchestrationInstructions: OMO_CODE_ORCHESTRATION_INSTRUCTIONS,
      appendSystemPrompt: true,
    });
    const result = await bridge.handlers.get("before_agent_start")!(
      { systemPrompt: "OMO full prompt", systemPromptOptions: { sections: {} } },
      { ui: { notify: assert.fail } },
    );
    assert.include(result!.systemPrompt, "OMO full prompt");
    assert.include(result!.systemPrompt, "OMO's native `task`");
  });
  it.each([
    {
      name: "on Pi builds without prompt sections",
      events: [
        { systemPrompt: "base" },
        { systemPrompt: "base", systemPromptOptions: {} },
        { systemPrompt: "base", systemPromptOptions: { sections: null } },
      ],
    },
    {
      name: "when an earlier extension forces the system prompt",
      events: [
        {
          systemPrompt: "forced",
          systemPromptOptions: { sections: {}, forceSystemPrompt: "forced" },
        },
      ],
    },
  ])("appends guidance $name", async ({ events }) => {
    const bridge = await loadMcpBridge();
    const hook = bridge.handlers.get("before_agent_start")!;
    for (const event of events) {
      const result = await hook(event, { ui: { notify: assert.fail } });
      assert.isDefined(result);
      assert.isTrue(result!.systemPrompt.startsWith(`${event.systemPrompt}\n\n`));
      assert.include(result!.systemPrompt, "orchestrator_capabilities");
      assert.include(result!.systemPrompt, "mcp__cox__delegate_task");
      assert.include(result!.systemPrompt, "task, not prompt");
      assert.include(
        result!.systemPrompt,
        "Never invent native task or silently switch delegation tools",
      );
    }
  });
});

describe("Pi project trust", () => {
  it.each([
    { name: "a trusted folder", trusted: true, argv: [], notices: 0 },
    { name: "an untrusted folder", trusted: false, argv: [], notices: 1 },
    { name: "--no-approve", trusted: false, argv: ["--approve", "-na"], notices: 0 },
  ])("sends $notices trust notice per session for $name", async ({ trusted, argv, notices }) => {
    const sent: string[] = [];
    const ctx = {
      cwd: "/repo",
      isProjectTrusted: () => trusted,
      ui: { notify: (message: string) => sent.push(message) },
    };
    // Pi reruns extension factories on session replacement without asking about trust again.
    for (const _session of [1, 2]) {
      const handlers = (await loadHooks([], ["node", "pi", ...argv])) as Map<
        string,
        (event: unknown, ctx: unknown) => unknown
      >;
      for (const _turn of [1, 2]) await handlers.get("before_agent_start")!({}, ctx);
    }
    assert.equal(sent.length, notices * 2);
    for (const message of sent)
      assert.include(message, "for /repo because the folder is not trusted");
  });
});

describe("Pi MCP tool results", () => {
  it("exposes raw authenticated calls with script output and error status", async () => {
    const requests: Array<{
      readonly method: string;
      readonly params?: { readonly name: string; readonly arguments: Record<string, unknown> };
    }> = [];
    const source = NodeModule.stripTypeScriptTypes(
      PI_T3_MCP_EXTENSION_SOURCE.replace(/^import .*;$/gm, "").replace(
        "export default async function",
        "async function",
      ),
    );
    const bridge: {
      readonly callTool: (
        name: string,
        args: Record<string, unknown>,
        signal: AbortSignal,
      ) => Promise<unknown>;
    } = await NodeVM.runInNewContext(`${source}\nt3McpExtension(pi)`, {
      process: { env: { T3_MCP_URL: "http://fixture.invalid/mcp", T3_MCP_BEARER_TOKEN: "token" } },
      AbortSignal,
      NodePath,
      pi: { on: () => {}, registerTool: () => {} },
      fetch: async (
        _url: string,
        input: { readonly body: string; readonly signal: AbortSignal },
      ) => {
        input.signal.throwIfAborted();
        const request = JSON.parse(input.body) as (typeof requests)[number];
        requests.push(request);
        return new Response(
          JSON.stringify({
            result:
              request.method === "tools/list"
                ? { tools: [] }
                : {
                    content: [{ type: "text", text: "Schedule rejected" }],
                    structuredContent: { rejected: true },
                    isError: true,
                    _meta: { private: true },
                  },
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });
    const output = await bridge.callTool(
      "schedule_task",
      { prompt: "Check" },
      new AbortController().signal,
    );
    assert.deepEqual(output, {
      content: [{ type: "text", text: "Schedule rejected" }],
      structuredContent: {
        content: [{ type: "text", text: "Schedule rejected" }],
        structuredContent: { rejected: true },
        isError: true,
      },
      isError: true,
    });
    assert.equal(requests.at(-1)?.method, "tools/call");
    assert.deepEqual(requests.at(-1)?.params, {
      name: "schedule_task",
      arguments: { prompt: "Check" },
    });
  });

  it("returns mixed screenshot blocks and typed script output without repeating structured text", async () => {
    const content = [
      { type: "text", text: "Browser screenshot" },
      { type: "image", data: "AAAA", mimeType: "image/png", _meta: { private: true } },
      { type: "text", text: "Screenshot captured" },
    ] as const;
    const result = { content, structuredContent: { count: 2 }, _meta: { private: true } };
    const bridge = await loadMcpBridge({ modern: true, result });
    const tool = bridge.tools.find((tool) => tool.name === "mcp__cox__preview_snapshot")!;
    const output = await tool.execute("snapshot", {});
    assert.deepEqual(output.content, [
      content[0],
      { type: "image", data: "AAAA", mimeType: "image/png" },
      content[2],
    ]);
    assert.deepEqual(output.structuredContent, { content, structuredContent: { count: 2 } });
    assert.deepEqual(tool.outputSchema, {
      type: "object",
      properties: {
        content: { type: "array", items: { type: "object" } },
        structuredContent: { type: "object", properties: { count: { type: "number" } } },
        isError: { type: "boolean" },
        _meta: { type: "object" },
      },
      required: ["content"],
    });
  });

  it.each([false, true])(
    "preserves image-only results and error status, isError=%s",
    async (isError) => {
      const image = { type: "image", data: "AAAA", mimeType: "image/png" };
      const result = { content: [image], isError };
      const bridge = await loadMcpBridge({ result });
      const output = await bridge.tools[0]!.execute("image", {});
      assert.deepEqual(output.content[0], image);
      assert.equal(output.content.length, isError ? 2 : 1);
      if (isError) assert.include(output.content[1]?.text ?? "", "returned an error");
      assert.equal(output.isError, isError ? true : undefined);
      assert.deepEqual(output.structuredContent, result);
    },
  );

  it("uses structured output as model text when content is empty", async () => {
    const result = { content: [], structuredContent: { count: 2 } };
    const bridge = await loadMcpBridge({ result });
    const output = await bridge.tools[0]!.execute("structured", {});
    assert.deepEqual(output.content, [{ type: "text", text: '{"count":2}' }]);
    assert.deepEqual(output.structuredContent, result);
  });
});

describe("Pi MCP tool exposure", () => {
  const discoveryContext = {
    model: { api: "anthropic-messages" },
    ui: { notify: () => undefined },
  };

  it.each(["builtin:tool-search", "<builtin:tool-search>"])(
    "keeps orchestration active and optional tools searchable with %s",
    async (path) => {
      const bridge = await loadMcpBridge({
        modern: true,
        toolSearchAvailable: true,
        toolSearchSource: { source: "builtin", path },
      });
      await bridge.handlers.get("session_start")!({ systemPrompt: "" }, discoveryContext);
      const start = bridge.handlers.get("before_agent_start");
      assert.isDefined(start);
      const prompt = await start!({ systemPrompt: "Pi system prompt" }, discoveryContext);
      assert.include(prompt?.systemPrompt ?? "", "orchestrator_capabilities");
      assert.equal(bridge.servers.length, 0);
      assert.equal(bridge.tools.length, 4);
      assert.deepEqual(bridge.getActiveTools(), [
        "read",
        "tool_search",
        "mcp__cox__orchestrator_capabilities",
        "mcp__cox__delegate_task",
        "mcp__cox__task_status",
      ]);
      assert.isTrue(bridge.getHealth().coxOrchestrationReady);
      assert.equal(
        bridge.getHealth().tools.find((tool) => tool.name === "mcp__cox__preview_snapshot")?.status,
        "searchable",
      );
      assert.deepEqual(
        bridge.tools
          .filter((tool) => tool.exposure !== "hidden")
          .map((tool) => [tool.name, tool.exposure]),
        [
          ["mcp__cox__orchestrator_capabilities", "direct"],
          ["mcp__cox__delegate_task", "direct"],
          ["mcp__cox__task_status", "direct"],
          ["mcp__cox__preview_snapshot", "deferred"],
        ],
      );
      assert.deepEqual(
        bridge.tools.filter((tool) => tool.exposure === "hidden").map((tool) => tool.name),
        [],
      );
      const result = await bridge.tools
        .find((tool) => tool.name === "mcp__cox__preview_snapshot")!
        .execute("call-1", { depth: 2 });
      assert.equal(result.content[0]?.text, "browser snapshot");
      assert.equal(bridge.requests.at(-1)?.method, "tools/call");
    },
  );

  it.each(["anthropic-messages", "openai-responses", "openai-completions"])(
    "activates the core tools before requests using %s",
    async (api) => {
      const bridge = await loadMcpBridge({ modern: true, toolSearchAvailable: true });
      await bridge.handlers.get("session_start")!(
        { systemPrompt: "" },
        { ...discoveryContext, model: { api } },
      );
      for (const name of ["orchestrator_capabilities", "delegate_task", "task_status"]) {
        assert.include(bridge.getActiveTools(), "mcp__cox__" + name);
      }
      assert.equal(
        bridge.getActiveTools().includes("mcp__cox__preview_snapshot"),
        api === "openai-completions",
      );
    },
  );

  it.each(["session_start", "model_select", "session_tree", "before_agent_start"])(
    "retries connection before reconciling at %s",
    async (hook) => {
      const bridge = await loadMcpBridge({
        modern: true,
        toolSearchAvailable: true,
        connectFailures: 1,
      });
      assert.equal(bridge.tools.length, 0);
      assert.isFalse(bridge.getHealth().connected);
      await bridge.handlers.get(hook)!(
        { systemPrompt: "" },
        { ...discoveryContext, model: { api: "openai-completions" } },
      );
      assert.isTrue(bridge.getHealth().coxOrchestrationReady);
      assert.include(bridge.getActiveTools(), "mcp__cox__preview_snapshot");
      assert.equal(bridge.requests.filter((request) => request.method === "initialize").length, 2);
    },
  );

  it("retries a failed catalog load and reports connection warnings without claiming readiness", async () => {
    const bridge = await loadMcpBridge({ modern: true, listFailures: 2 });
    const notices: string[] = [];
    const ctx = { ...discoveryContext, ui: { notify: (message: string) => notices.push(message) } };
    await bridge.handlers.get("session_start")!({ systemPrompt: "" }, ctx);
    assert.isFalse(bridge.getHealth().available);
    assert.equal(notices.length, 1);
    assert.include(notices[0]!, "Fixture catalog unavailable");
    await bridge.handlers.get("before_agent_start")!({ systemPrompt: "" }, ctx);
    assert.isTrue(bridge.getHealth().coxOrchestrationReady);
  });

  it("restores Anthropic core tools after tree navigation and before a turn", async () => {
    const bridge = await loadMcpBridge({ modern: true, toolSearchAvailable: true });
    for (const hook of ["session_tree", "before_agent_start"]) {
      bridge.restoreActiveTools(["read"]);
      await bridge.handlers.get(hook)!({ systemPrompt: "" }, discoveryContext);
      assert.isTrue(bridge.getHealth().coxOrchestrationReady);
      assert.equal(bridge.getActiveTools().length, 5);
    }
  });

  it("reconciles readiness after native post-start loadout changes using the selected model", async () => {
    const bridge = await loadMcpBridge({ modern: true, toolSearchAvailable: true });
    await bridge.handlers.get("model_select")!(
      { systemPrompt: "" },
      {
        ...discoveryContext,
        model: { api: "openai-completions" },
      },
    );
    bridge.restoreActiveTools(["read"]);
    assert.isFalse(bridge.getHealth().available);
    await bridge.ensureReady();
    assert.isTrue(bridge.getHealth().coxOrchestrationReady);
    assert.include(bridge.getActiveTools(), "mcp__cox__preview_snapshot");
  });

  it("restores Cox tools after native asynchronous MCP catalog refreshes without activating exclusions or replacements", async () => {
    const bridge = await loadMcpBridge({
      modern: true,
      toolSearchAvailable: true,
      allowsTool: (name) => name !== "mcp__cox__delegate_task",
    });
    await bridge.handlers.get("session_start")!({ systemPrompt: "" }, discoveryContext);
    bridge.restoreActiveTools(["read", "tool_search"]);
    await bridge.handlers.get("context")!({ systemPrompt: "" }, discoveryContext);
    assert.include(bridge.getActiveTools(), "mcp__cox__orchestrator_capabilities");
    bridge.restoreActiveTools(["read", "tool_search"]);
    assert.isTrue(bridge.activateLazyTool("mcp__cox__orchestrator_capabilities"));
    assert.isTrue(bridge.activateLazyTool("mcp__cox__preview_snapshot"));
    assert.isFalse(bridge.activateLazyTool("mcp__cox__delegate_task"));
    bridge.setBridgeSourcePath("/replacement.ts");
    bridge.restoreActiveTools(["read"]);
    assert.isFalse(bridge.activateLazyTool("mcp__cox__orchestrator_capabilities"));
    assert.isFalse(bridge.activateLazyTool("unrelated_tool"));
  });

  it.each([
    { source: "extension", path: "builtin:tool-search" },
    { source: "extension", path: "<builtin:tool-search>" },
    { source: "builtin", path: "/extension/tool-search.ts" },
  ])("does not trust a forged search source %j", async (toolSearchSource) => {
    const bridge = await loadMcpBridge({
      modern: true,
      toolSearchAvailable: true,
      toolSearchSource,
    });
    await bridge.handlers.get("session_start")!({ systemPrompt: "" }, discoveryContext);
    assert.notInclude(bridge.getActiveTools(), "tool_search");
    assert.isTrue(bridge.tools.every((tool) => tool.exposure === "direct"));
    assert.include(bridge.getActiveTools(), "mcp__cox__preview_snapshot");
    assert.isTrue(bridge.getHealth().coxOrchestrationReady);
  });

  it("falls back to explicit declarations when registered search cannot activate", async () => {
    const bridge = await loadMcpBridge({
      modern: true,
      toolSearchAvailable: true,
      allowsActivation: (name) => name !== "tool_search",
    });
    await bridge.handlers.get("session_start")!({ systemPrompt: "" }, discoveryContext);
    assert.isFalse(bridge.getHealth().searchReady);
    assert.include(bridge.getActiveTools(), "mcp__cox__preview_snapshot");
    assert.isTrue(bridge.tools.every((tool) => tool.exposure === "direct"));
  });

  it("reconciles when search disappears and returns without dropping selected tools", async () => {
    const bridge = await loadMcpBridge({ modern: true, toolSearchAvailable: true });
    const event = { systemPrompt: "" };
    await bridge.handlers.get("session_start")!(event, discoveryContext);
    bridge.setToolSearch(false);
    bridge.restoreActiveTools(["read"]);
    await bridge.handlers.get("model_select")!(event, discoveryContext);
    assert.isTrue(bridge.tools.every((tool) => tool.exposure === "direct"));
    assert.include(bridge.getActiveTools(), "mcp__cox__preview_snapshot");
    bridge.setToolSearch(true, { source: "builtin", path: "<builtin:tool-search>" });
    await bridge.handlers.get("session_tree")!(event, discoveryContext);
    assert.equal(
      bridge.tools.find((tool) => tool.name === "mcp__cox__preview_snapshot")?.exposure,
      "deferred",
    );
    assert.include(bridge.getActiveTools(), "mcp__cox__preview_snapshot");
  });

  it("distinguishes explicit exclusions from missing, replaced and inactive tools", async () => {
    const excluded = await loadMcpBridge({
      modern: true,
      allowsTool: (name) => name !== "mcp__cox__delegate_task",
    });
    await excluded.handlers.get("session_start")!({ systemPrompt: "" }, discoveryContext);
    assert.isTrue(excluded.getHealth().available);
    assert.isFalse(excluded.getHealth().coxOrchestrationReady);
    assert.equal(
      excluded.getHealth().tools.find((tool) => tool.name === "mcp__cox__delegate_task")?.status,
      "excluded",
    );
    const inactive = await loadMcpBridge({
      modern: true,
      allowsActivation: (name) => name !== "mcp__cox__delegate_task",
    });
    await inactive.handlers.get("session_start")!({ systemPrompt: "" }, discoveryContext);
    assert.isFalse(inactive.getHealth().available);
    assert.equal(
      inactive.getHealth().tools.find((tool) => tool.name === "mcp__cox__delegate_task")?.status,
      "inactive",
    );
    inactive.setBridgeSourcePath("/replacement.ts");
    assert.equal(inactive.getHealth().tools[0]?.status, "replaced");
    const missing = await loadMcpBridge({ catalogNames: ["delegate_task"] });
    await missing.handlers.get("session_start")!({ systemPrompt: "" }, discoveryContext);
    assert.isFalse(missing.getHealth().available);
    assert.equal(
      missing.getHealth().tools.find((tool) => tool.name === "mcp__cox__task_status")?.status,
      "missing-catalog",
    );
  });

  it("reports tools hidden by native configuration as excluded without bypassing it", async () => {
    const bridge = await loadMcpBridge({
      modern: true,
      allowsActivation: (name) => name !== "mcp__cox__delegate_task",
      toolExposure: (name) => (name === "mcp__cox__delegate_task" ? "hidden" : undefined),
    });
    await bridge.handlers.get("session_start")!({ systemPrompt: "" }, discoveryContext);
    assert.isTrue(bridge.getHealth().available);
    assert.isFalse(bridge.getHealth().coxOrchestrationReady);
    assert.equal(
      bridge.getHealth().tools.find((tool) => tool.name === "mcp__cox__delegate_task")?.status,
      "excluded",
    );
    assert.notInclude(bridge.getActiveTools(), "mcp__cox__delegate_task");
  });

  it.each(["tool_search", "mcp__cox__preview_snapshot", "mcp__cox__delegate_task"])(
    "does not bypass user exclusions for %s",
    async (excluded) => {
      const bridge = await loadMcpBridge({
        modern: true,
        toolSearchAvailable: true,
        allowsTool: (name) => name !== excluded,
      });
      for (const hook of ["session_start", "model_select", "session_tree", "before_agent_start"]) {
        await bridge.handlers.get(hook)!({ systemPrompt: "" }, discoveryContext);
        assert.notInclude(bridge.getActiveTools(), excluded);
        assert.isTrue(bridge.getHealth().available);
      }
    },
  );

  it("restores gateway declarations after model switches and older tree loadouts without excluded tools", async () => {
    const bridge = await loadMcpBridge({
      modern: true,
      toolSearchAvailable: true,
      allowsTool: (name) => name !== "mcp__cox__delegate_task",
    });
    const event = { systemPrompt: "" };
    await bridge.handlers.get("session_start")!(event, discoveryContext);
    const gatewayContext = { model: { api: "openai-completions" }, ui: { notify: assert.fail } };
    await bridge.handlers.get("model_select")!(event, gatewayContext);
    bridge.restoreActiveTools(["read", "mcp__cox__task_status"]);
    await bridge.handlers.get("session_tree")!(event, gatewayContext);
    assert.deepEqual(bridge.getActiveTools(), [
      "read",
      "mcp__cox__task_status",
      "tool_search",
      "mcp__cox__orchestrator_capabilities",
      "mcp__cox__preview_snapshot",
    ]);
    await bridge.handlers.get("model_select")!(event, discoveryContext);
    assert.equal(
      bridge.tools.find((tool) => tool.name === "mcp__cox__preview_snapshot")?.exposure,
      "deferred",
    );
    assert.include(bridge.getActiveTools(), "mcp__cox__preview_snapshot");
  });

  it.each(["legacy Pi", "disabled tool search"])(
    "keeps tool execution available with %s",
    async (mode) => {
      const bridge = await loadMcpBridge({
        modern: mode !== "legacy Pi",
        toolSearchAvailable: mode === "disabled tool search",
        toolSearchDisabled: mode === "disabled tool search",
      });
      const start = bridge.handlers.get("session_start");
      await start!({ systemPrompt: "Pi system prompt" }, discoveryContext);
      assert.include(bridge.getActiveTools(), "mcp__cox__preview_snapshot");
      assert.equal(bridge.tools.filter((tool) => tool.exposure !== "hidden").length, 4);
      assert.isTrue(
        bridge.tools
          .filter((tool) => tool.exposure !== "hidden")
          .every((tool) => tool.exposure === undefined || tool.exposure === "direct"),
      );
      const tool = bridge.tools.find((tool) => tool.name === "mcp__cox__preview_snapshot");
      assert.isDefined(tool);
      const controller = new AbortController();
      const result = await tool!.execute("call-1", { depth: 2 }, controller.signal);
      assert.equal(result.content[0]?.text, "browser snapshot");
      assert.strictEqual(bridge.transports.at(-1)?.signal, controller.signal);
      assert.equal(bridge.transports.at(-1)?.url, "http://fixture.invalid/mcp");
      assert.equal(bridge.transports.at(-1)?.authorization, "Bearer fixture-token");
      assert.deepEqual(JSON.parse(JSON.stringify(bridge.requests.at(-1))), {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "preview_snapshot", arguments: { depth: 2 } },
      });
      assert.isUndefined(tool?.promptSnippet);
      assert.isUndefined(tool?.promptGuidelines);
    },
  );
});

describe("Pi MCP tool schemas", () => {
  it.each([{ type: "object" }, {}])(
    "declares empty properties on object schemas that omit them: %j",
    async (inputSchema) => {
      const bridge = await loadMcpBridge({ inputSchema });
      assert.isAbove(bridge.tools.length, 0);
      for (const tool of bridge.tools) {
        assert.deepEqual(tool.parameters, { type: "object", properties: {} });
      }
    },
  );

  it("keeps declared properties and other schema keywords", async () => {
    const inputSchema = {
      type: "object",
      properties: { depth: { type: "number" } },
      required: ["depth"],
      additionalProperties: false,
    };
    const bridge = await loadMcpBridge({ inputSchema });
    for (const tool of bridge.tools) {
      assert.deepEqual(tool.parameters, inputSchema);
    }
  });
});

describe("Pi tool discovery permissions", () => {
  it.each(["approval-required", "auto-accept-edits", "auto"])(
    "allows annotated T3 reads in %s while gating mutations and replacements",
    async (runtimeMode) => {
      const bridge = await loadMcpBridge({ modern: true, runtimeMode });
      const hook = bridge.handlers.get("tool_call") as unknown as (
        event: { toolName: string; input: unknown },
        ctx: { ui: { confirm: (title: string) => Promise<boolean> } },
      ) => Promise<{ block: true; reason: string } | undefined>;
      const confirmations: string[] = [];
      const ctx = {
        ui: {
          confirm: async (title: string) => {
            confirmations.push(title);
            return false;
          },
        },
      };
      for (const prefix of ["mcp__cox__"]) {
        assert.isUndefined(
          await hook({ toolName: prefix + "orchestrator_capabilities", input: {} }, ctx),
        );
        assert.equal(
          (await hook({ toolName: prefix + "delegate_task", input: {} }, ctx))?.block,
          true,
        );
        assert.equal(
          (await hook({ toolName: prefix + "task_status", input: {} }, ctx))?.block,
          true,
        );
      }
      assert.equal(confirmations.length, 2);
      bridge.setBridgeSourcePath("/user/extensions/replacement.ts");
      assert.equal(
        (await hook({ toolName: "mcp__cox__orchestrator_capabilities", input: {} }, ctx))?.block,
        true,
      );
      assert.equal(
        (await hook({ toolName: "mcp__other__orchestrator_capabilities", input: {} }, ctx))?.block,
        true,
      );
      assert.equal(confirmations.length, 4);
    },
  );

  it("allows discovery without confirmation and still gates the discovered tool", async () => {
    type ToolCallHook = (
      event: { toolName: string; input: unknown },
      ctx: {
        signal: AbortSignal;
        ui: {
          confirm: (
            title: string,
            detail: string,
            options: { signal: AbortSignal },
          ) => Promise<boolean>;
        };
      },
    ) => Promise<{ block: true; reason: string } | undefined>;
    let toolCall: ToolCallHook | undefined;
    let searchPath = "builtin:tool-search";
    let searchSource = "builtin";
    const source = NodeModule.stripTypeScriptTypes(
      PI_T3_MCP_EXTENSION_SOURCE.replace(/^import .*;$/gm, "").replace(
        "export default async function",
        "async function",
      ),
    );
    await NodeVM.runInNewContext(`${source}\nt3McpExtension(pi)`, {
      process: { env: { T3_PI_RUNTIME_MODE: "approval-required" } },
      pi: {
        on: (name: string, handler: ToolCallHook) => {
          if (name === "tool_call") toolCall = handler;
        },
        getAllTools: () => [
          { name: "tool_search", sourceInfo: { source: searchSource, path: searchPath } },
        ],
      },
    });
    assert.isDefined(toolCall);
    const confirmations: string[] = [];
    const controller = new AbortController();
    const ctx = {
      signal: controller.signal,
      ui: {
        confirm: async (title: string, _detail: string, options: { signal: AbortSignal }) => {
          assert.strictEqual(options.signal, controller.signal);
          confirmations.push(title);
          return false;
        },
      },
    };
    assert.isUndefined(
      await toolCall!({ toolName: "tool_search", input: { query: "preview_snapshot" } }, ctx),
    );
    assert.equal(confirmations.length, 0);
    searchPath = "<builtin:tool-search>";
    assert.isUndefined(await toolCall!({ toolName: "tool_search", input: {} }, ctx));
    searchSource = "extension";
    assert.equal((await toolCall!({ toolName: "tool_search", input: {} }, ctx))?.block, true);
    searchSource = "builtin";
    const result = await toolCall!({ toolName: "mcp__cox__preview_snapshot", input: {} }, ctx);
    assert.equal(result?.block, true);
    assert.deepEqual(confirmations, ["Allow tool_search?", "Allow mcp__cox__preview_snapshot?"]);

    searchPath = "/extensions/custom-search.ts";
    const replaced = await toolCall!({ toolName: "tool_search", input: {} }, ctx);
    assert.equal(replaced?.block, true);
    assert.equal(confirmations.at(-1), "Allow tool_search?");
  });
});

async function loadRequestHook(): Promise<RequestHook> {
  const handlers = new Map<string, RequestHook>();
  const source = NodeModule.stripTypeScriptTypes(
    PI_T3_MCP_EXTENSION_SOURCE.replace(/^import .*;$/gm, "").replace(
      "export default async function",
      "async function",
    ),
  );
  await NodeVM.runInNewContext(`${source}\nt3McpExtension(pi)`, {
    process: { env: {} },
    pi: { on: (name: string, handler: RequestHook) => handlers.set(name, handler) },
  });
  const hook = handlers.get("before_provider_request");
  assert.isDefined(hook);
  return hook!;
}

describe("Pi upstream output-budget workaround", () => {
  it.each(["max_tokens", "max_completion_tokens"])(
    "caps %s without changing the conversation or tools",
    async (key) => {
      const hook = await loadRequestHook();
      const payload = {
        model: "moonshotai/kimi-k2.6",
        messages: [{ role: "user", content: "hello" }],
        tools: [{ type: "function", function: { name: "read" } }],
        [key]: 231_969,
      };
      const result = hook({ payload }, { model: { provider: "openrouter" } });
      assert.equal(result?.[key], 32_768);
      assert.strictEqual(result?.messages, payload.messages);
      assert.strictEqual(result?.tools, payload.tools);
      assert.equal(result?.model, payload.model);
      assert.equal(payload[key], 231_969);
    },
  );

  it("preserves smaller budgets and other providers' payloads", async () => {
    const hook = await loadRequestHook();
    for (const payload of [{ max_tokens: 8192 }, { max_completion_tokens: 32_768 }, {}, null]) {
      assert.isUndefined(hook({ payload }, { model: { provider: "openrouter" } }));
    }
    assert.isUndefined(
      hook({ payload: { max_tokens: 231_969 } }, { model: { provider: "anthropic" } }),
    );
  });
});

async function loadInputHook(commands: ReadonlyArray<SkillCommand>) {
  const handlers = await loadHooks(commands);
  const hook = handlers.get("input");
  assert.isDefined(hook);
  return hook as InputHook;
}

describe("Pi skill references", () => {
  it("loads every selected skill once while preserving inline prose, whitespace, and images", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-skill-mentions-"));
    try {
      const alpha = NodePath.join(directory, "alpha.md");
      const beta = NodePath.join(directory, "beta.md");
      await NodeFSP.writeFile(alpha, "ALPHA_INSTRUCTIONS");
      await NodeFSP.writeFile(beta, "BETA_INSTRUCTIONS");
      const hook = await loadInputHook([
        { name: "skill:alpha", source: "skill", sourceInfo: { path: alpha } },
        { name: "skill:beta", source: "skill", sourceInfo: { path: beta } },
      ]);
      const text =
        "Please use the $alpha philosophy, then $beta and $alpha\n```ts\n  const x = 1;\n```";
      const images = [{ type: "image", data: "fixture" }];
      const result = await hook({ text, images }, { ui: { notify: assert.fail } });
      assert.equal(result?.action, "transform");
      assert.isTrue(result?.text.startsWith(text + "\n\n"));
      assert.equal(result?.text.split("ALPHA_INSTRUCTIONS").length, 2);
      assert.equal(result?.text.split("BETA_INSTRUCTIONS").length, 2);
      assert.include(result?.text ?? "", `References are relative to ${directory}.`);
      assert.strictEqual(result?.images, images);
    } finally {
      await NodeFSP.rm(directory, { recursive: true });
    }
  });

  it("leaves unknown references and native skill commands for Pi", async () => {
    const hook = await loadInputHook([
      { name: "skill:alpha", source: "skill", sourceInfo: { path: "/unused" } },
    ]);
    for (const text of [
      "Explain $HOME",
      "/skill:alpha use $alpha",
      "Hello",
      "$missing",
      "Use $alpha, then continue",
      "Use ($alpha)",
    ]) {
      assert.isUndefined(await hook({ text }, { ui: { notify: assert.fail } }));
    }
  });

  it("loads additional chips without duplicating a leading native skill", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-skill-mentions-"));
    try {
      const path = NodePath.join(directory, "beta.md");
      await NodeFSP.writeFile(path, "BETA_INSTRUCTIONS");
      const hook = await loadInputHook([
        { name: "skill:alpha", source: "skill", sourceInfo: { path: "/unused" } },
        { name: "skill:beta", source: "skill", sourceInfo: { path } },
      ]);
      const text = "/skill:alpha use $alpha and $beta";
      const result = await hook({ text }, { ui: { notify: assert.fail } });
      assert.isTrue(result?.text.startsWith(text + "\n\n"));
      assert.notInclude(result?.text ?? "", '<skill name="alpha"');
      assert.include(result?.text ?? "", "BETA_INSTRUCTIONS");
    } finally {
      await NodeFSP.rm(directory, { recursive: true });
    }
  });

  it("reports an unreadable skill without deleting its reference or other selected instructions", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-skill-mentions-"));
    try {
      const path = NodePath.join(directory, "readable.md");
      await NodeFSP.writeFile(path, "READABLE_INSTRUCTIONS");
      const hook = await loadInputHook([
        {
          name: "skill:missing",
          source: "skill",
          sourceInfo: { path: NodePath.join(directory, "missing.md") },
        },
        { name: "skill:readable", source: "skill", sourceInfo: { path } },
      ]);
      const notices: string[] = [];
      const text = "Use $missing and $readable";
      const result = await hook(
        { text },
        {
          ui: {
            notify: (message) => {
              notices.push(message);
            },
          },
        },
      );
      assert.isTrue(result?.text.startsWith(text + "\n\n"));
      assert.include(result?.text ?? "", "READABLE_INSTRUCTIONS");
      assert.equal(notices.length, 1);
      assert.include(notices[0] ?? "", "Could not load skill missing");
    } finally {
      await NodeFSP.rm(directory, { recursive: true });
    }
  });
});

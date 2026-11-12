import { describe, expect, it } from "vite-plus/test";

import {
  T3_MCP_TOOL_NAMES,
  resolveT3McpToolId,
  resolveT3McpSummaryAction,
  resolveT3McpToolDefinition,
  resolveT3McpToolPresentation,
} from "./t3McpToolPresentation.ts";

describe("resolveT3McpToolPresentation", () => {
  it("recognizes every Cox tool across provider prefixes and completion suffixes", () => {
    for (const tool of T3_MCP_TOOL_NAMES) {
      const presentation = resolveT3McpToolPresentation(tool);
      for (const prefix of [
        "mcp__cox__",
        "cox.",
        "cox/",
        "cox:",
        "mcp_cox_",
        "cox · ",
        "mcp__t3-code__",
        "mcp__t3_code__",
        "mcp__t3code__",
        "T3-code.",
        "t3_code/",
        "t3code:",
        "mcp_t3-code_",
        "Cox ",
        "t3-code · ",
      ]) {
        expect(resolveT3McpToolPresentation(`${prefix}${tool} completed`), tool).toEqual(
          presentation,
        );
      }
      expect(resolveT3McpToolPresentation(`mcp__another-server__${tool}`), tool).toBeNull();
    }
  });

  it("normalizes historical tool names without advertising them as current names", () => {
    expect([...T3_MCP_TOOL_NAMES].some((name) => name.startsWith("t3_"))).toBe(false);
    for (const name of T3_MCP_TOOL_NAMES) {
      if (!name.startsWith("cox_")) continue;
      const legacy = `t3_${name.slice(4)}`;
      for (const prefix of [
        "",
        "mcp__t3-code__",
        "mcp__t3_code__",
        "T3-code.",
        "t3-code-thread_old_",
      ]) {
        expect(resolveT3McpToolId(`${prefix}${legacy}`), `${prefix}${legacy}`).toBe(name);
        expect(resolveT3McpToolPresentation(`${prefix}${legacy}`)).toEqual(
          resolveT3McpToolPresentation(name),
        );
      }
      expect(resolveT3McpToolId(`mcp__another-server__${legacy}`)).toBeNull();
    }
  });

  it("does not resolve prototype properties as tools", () => {
    for (const name of ["constructor", "toString", "__proto__", "mcp__cox__constructor"]) {
      expect(resolveT3McpToolId(name)).toBeNull();
      expect(resolveT3McpToolPresentation(name)).toBeNull();
    }
  });

  it("matches OpenCode 2's per-thread server names, whose thread ids hold underscores", () => {
    expect(
      resolveT3McpToolPresentation("t3-code-thread_opencode2-adapter_delegate_task")?.displayName,
    ).toBe("Delegate a child task");
    expect(resolveT3McpToolPresentation("t3-code-thread_opencode2-adapter_not_a_tool")).toBeNull();
    expect(resolveT3McpToolId("cox-thread_opencode2-adapter_cox_thread_read")).toBe(
      "cox_thread_read",
    );
    expect(resolveT3McpToolPresentation("cox-thread_opencode2-adapter_not_a_tool")).toBeNull();
  });
});

describe("resolveT3McpToolDefinition", () => {
  it("labels an action tool call as the action it ran", () => {
    expect(
      resolveT3McpToolDefinition("mcp__t3-code__preview_act", { action: "type" })?.labels,
    ).toEqual(resolveT3McpToolDefinition("preview_type")?.labels);
    expect(resolveT3McpToolDefinition("cox_thread_transfer", { action: "fork" })?.displayName).toBe(
      resolveT3McpToolDefinition("cox_thread_fork")?.displayName,
    );
    expect(resolveT3McpToolDefinition("preview_act", { action: "unknown" })?.labels[2]).toBe(
      "Used",
    );
  });
});

describe("resolveT3McpSummaryAction", () => {
  it("summarizes an action tool by the action each call ran", () => {
    expect(resolveT3McpSummaryAction("mcp__t3-code__cox_queue", { action: "list" })).toBe(
      "queue-list",
    );
    expect(resolveT3McpSummaryAction("cox_queue", { action: "edit" })).toBe("queue-edit");
    expect(resolveT3McpSummaryAction("cox_thread_transfer", { action: "status" })).toBe(
      "thread-transfers",
    );
    expect(resolveT3McpSummaryAction("cox_thread_configure", {})).toBe("thread-configuration");
    expect(resolveT3McpSummaryAction("schedule_task", { scheduledTaskId: "task-1" })).toBe(
      "schedule-update",
    );
    expect(resolveT3McpSummaryAction("delegate_task", { task: "x" })).toBe("delegate");
  });
});

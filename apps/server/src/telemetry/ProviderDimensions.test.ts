import { ProviderInstanceId, ThreadId, type ServerProvider } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";

import {
  type AgentThread,
  agentToolProperties,
  handoffSettings,
  providerDimensions,
  toolOutcome,
} from "./ProviderDimensions.ts";

const provider = (
  instanceId: string,
  driver: string,
  models: ReadonlyArray<{ slug: string; isCustom: boolean; aliases?: ReadonlyArray<string> }>,
  auth: Partial<ServerProvider["auth"]> = {},
) =>
  ({
    instanceId: ProviderInstanceId.make(instanceId),
    driver,
    auth: { status: "authenticated", ...auth },
    models,
  }) as unknown as ServerProvider;

const providers = [
  provider("work-codex", "codex", [{ slug: "gpt-5.5", isCustom: false }]),
  provider("claudeAgent", "claudeAgent", [
    { slug: "claude-opus-5-5", isCustom: false },
    { slug: "my-private-finetune", isCustom: true },
  ]),
  provider("opencode", "opencode", [{ slug: "ollama/acme-internal", isCustom: false }]),
];

const thread = (
  instanceId: string,
  model: string,
  overrides: Partial<AgentThread> = {},
): AgentThread => ({
  modelSelection: { instanceId: ProviderInstanceId.make(instanceId), model },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdBy: "user",
  creationSource: "web",
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: ThreadId.make("t") },
  ...overrides,
});

it("labels custom models by provider without exposing model or instance names", () => {
  expect(
    agentToolProperties({
      tool: "cox_thread_send",
      providers,
      caller: thread("claudeAgent", "my-private-finetune"),
      targets: [thread("opencode", "ollama/acme-internal"), thread("removed-instance", "gpt-5.5")],
      outcome: { outcome: "ok" },
    }).map(({ callerProvider, callerModel, targetProvider, targetModel }) => ({
      callerProvider,
      callerModel,
      targetProvider,
      targetModel,
    })),
  ).toEqual([
    {
      callerProvider: "claudeAgent",
      callerModel: "custom:claudeAgent",
      targetProvider: "opencode",
      targetModel: "custom:opencode",
    },
    {
      callerProvider: "claudeAgent",
      callerModel: "custom:claudeAgent",
      targetProvider: "unknown",
      targetModel: undefined,
    },
  ]);
});

it("labels public Codex and Claude model families only for vendor endpoints", () => {
  const model = { slug: "gpt-6-new", aliases: ["new"], isCustom: false };
  const vendor = provider("vendor", "codex", [model, { slug: "internal-name", isCustom: false }]);
  const custom = provider("custom", "codex", [model], { endpoint: "https://example.com" });
  const claude = provider("claude", "claudeAgent", [{ slug: "claude-opus-6", isCustom: false }]);
  const label = (p: ServerProvider, model: string) =>
    providerDimensions([p], { instanceId: p.instanceId, model }).model;
  expect(label(vendor, "new")).toBe("gpt-6-new");
  expect(label(vendor, "internal-name")).toBe("custom:codex");
  expect(label(custom, model.slug)).toBe("custom:codex");
  expect(label(claude, "claude-opus-6")).toBe("claude-opus-6");
});

it("records canonical model labels from the Antigravity live catalog", () => {
  const antigravity = provider("agy", "antigravity", [
    { slug: "gemini-4-neon", aliases: ["antigravity-default"], isCustom: false },
    { slug: "gemini-4-hydrogen", isCustom: false },
    { slug: "private", aliases: ["private-alias"], isCustom: true },
  ]);
  const label = (model: string) =>
    providerDimensions([antigravity], { instanceId: antigravity.instanceId, model }).model;
  expect(label("gemini-4-hydrogen")).toBe("gemini-4-hydrogen");
  expect(label("antigravity-default")).toBe("gemini-4-neon");
  expect(label("gemini-4-unlisted")).toBe("custom:antigravity");
  expect(label("private-alias")).toBe("custom:antigravity");
});

it("drops input strings outside the schema's literals, since rejected calls are recorded too", () => {
  expect(handoffSettings("delegate_task", { mode: "/home/me/secret" }, undefined)).toEqual({
    targetChosen: false,
    mode: "async",
  });
  expect(
    handoffSettings("cox_thread_launch", { workspaceStrategy: { type: "/home/me/secret" } }, {}),
  ).toEqual({ targetChosen: false, workspace: "root" });
});

it("records the binding the saved scheduled task resolved to, and none for failures", () => {
  expect(handoffSettings("schedule_task", {}, { boundThreadId: null })).toEqual({
    bindToCurrentThread: false,
  });
  expect(
    handoffSettings(
      "schedule_task",
      { bindToCurrentThread: true },
      { _tag: "OrchestratorMcpFailure", code: "invalid_request", message: "Different project." },
    ),
  ).toEqual({});
});

it("reports only identifier-shaped failure codes and known delivery values", () => {
  expect(toolOutcome({ isError: true, structuredContent: { code: "thread_not_found" } })).toEqual({
    outcome: "error",
    errorCode: "thread_not_found",
  });
  expect(
    toolOutcome({
      isError: true,
      structuredContent: { code: "ENOENT: no such file '/Users/julius/secret'" },
    }),
  ).toEqual({ outcome: "error", errorCode: "unknown" });
  expect(handoffSettings("cox_thread_send", {}, { delivery: "queued" })).toEqual({
    delivery: "queued",
  });
  expect(handoffSettings("cox_thread_send", {}, { delivery: "/Users/julius" })).toEqual({});
});

import {
  EnvironmentId,
  NodeId,
  ProviderInstanceId,
  ServerProvider,
  ThreadId,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({ subagents: [] as ReadonlyArray<OrchestrationV2Subagent> }));

vi.mock(import("../../state/entities"), () => ({
  useQuietThreadProjection: (() => ({ projection: { subagents: state.subagents } })) as never,
}));
vi.mock(import("../../state/environments"), () => ({
  useEnvironmentProviders: (() => new Map([[environmentId, [provider, omoProvider]]])) as never,
}));

import { act, fakeTimers, render } from "../../../test/render";
import { setLanguagePreference } from "../../i18n";
import { LANGUAGE_STORAGE_KEY, parseLanguagePreference } from "../../i18n/language";
import { ThreadSubagentsPanel } from "./ThreadSubagentsPanel";

const environmentId = EnvironmentId.make("environment");
const threadId = ThreadId.make("parent");
const provider = Schema.decodeSync(ServerProvider)({
  instanceId: "codex-review",
  driver: "codex",
  displayName: "Review instance",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-01T00:00:00.000Z",
  models: [],
});
const omoProvider = Schema.decodeSync(ServerProvider)({
  ...provider,
  instanceId: "omo-native",
  driver: "omo",
  displayName: "Native OMO",
});

function agent(overrides: Partial<OrchestrationV2Subagent> = {}): OrchestrationV2Subagent {
  return {
    id: NodeId.make("review"),
    threadId,
    runId: null,
    parentNodeId: NodeId.make("parent-node"),
    origin: "app_owned",
    createdBy: "user",
    driver: provider.driver,
    providerInstanceId: ProviderInstanceId.make("codex-review"),
    providerThreadId: null,
    childThreadId: ThreadId.make("child"),
    nativeTaskRef: null,
    prompt: "Review the changes",
    title: "Review task",
    model: "raw-model-name",
    status: "running",
    result: null,
    startedAt: DateTime.makeUnsafe("2026-11-01T00:00:00Z"),
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-11-01T00:02:00Z"),
    ...overrides,
  };
}

function nativeAgent(overrides: Partial<OrchestrationV2Subagent> = {}): OrchestrationV2Subagent {
  return agent({
    id: NodeId.make("atlas"),
    driver: omoProvider.driver,
    providerInstanceId: omoProvider.instanceId,
    origin: "provider_native",
    childThreadId: null,
    title: "atlas",
    prompt: "Plan the UI implementation\nKeep existing behavior.",
    ...overrides,
  });
}

function languageScope() {
  const preference = parseLanguagePreference(localStorage.getItem(LANGUAGE_STORAGE_KEY));
  setLanguagePreference("en");
  return {
    [Symbol.dispose]() {
      state.subagents = [];
      setLanguagePreference(preference);
    },
  };
}

it("shows live instances and their provider/model, with links only for app-owned child threads", async () => {
  using _language = languageScope();
  state.subagents = [
    agent(),
    agent({
      id: NodeId.make("native"),
      origin: "provider_native",
      title: "Native task",
      childThreadId: null,
      status: "waiting",
      progress: "Reading source files",
    }),
    agent({
      id: NodeId.make("queued"),
      title: "Queued task",
      status: "pending",
      childThreadId: null,
      startedAt: null,
    }),
    agent({ id: NodeId.make("finished"), title: "Finished task", status: "completed" }),
  ];
  await using screen = await render(
    <ThreadSubagentsPanel environmentId={environmentId} threadId={threadId} />,
  );
  await expect.element(screen.getByRole("heading", { name: "Active subagents" })).toBeVisible();
  await expect.element(screen.getByLabelText("3 active subagents")).toBeVisible();
  await expect
    .element(screen.getByRole("link", { name: "Open subagent Review task" }))
    .toHaveAttribute("href", "/environment/child");
  await expect.element(screen.getByText("Running", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Waiting", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Queued", { exact: true })).toBeVisible();
  expect(screen.container.querySelectorAll("a")).toHaveLength(1);
  expect(screen.container.textContent).toContain("Review instance · raw-model-name");
  expect(screen.container.textContent).not.toContain("Finished task");

  await act(() => setLanguagePreference("zh"));
  await expect.element(screen.getByRole("heading", { name: "活跃子 Agent" })).toBeVisible();
  await expect
    .element(
      screen
        .getByLabelText("子 Agent 详情：Native task")
        .getByText("Reading source files", { exact: true }),
    )
    .toBeVisible();
  await expect
    .element(screen.getByRole("link", { name: "打开子 Agent：Review task" }))
    .toBeVisible();
  expect(screen.container.textContent).toContain("Review instance · raw-model-name");

  state.subagents = state.subagents.map((entry) => ({ ...entry, status: "completed" }));
  await screen.rerender(<ThreadSubagentsPanel environmentId={environmentId} threadId={threadId} />);
  expect(screen.container.querySelector("[data-thread-subagents-panel]")).toBeNull();
});

it("counts workflow workers without duplicating the coordinator", async () => {
  using _language = languageScope();
  state.subagents = [
    agent({
      workflow: {
        phases: [],
        agents: [
          { index: 1, label: "Worker one", state: "running" },
          { index: 2, label: "Worker two", state: "queued" },
          { index: 3, label: "Finished worker", state: "completed" },
        ],
      },
    }),
  ];
  await using screen = await render(
    <ThreadSubagentsPanel environmentId={environmentId} threadId={threadId} />,
  );
  await expect.element(screen.getByLabelText("2 active subagents")).toBeVisible();
  expect(screen.container.querySelectorAll("[data-subagent-id]")).toHaveLength(2);
  expect(screen.container.textContent).not.toContain("Review task");
});

it("keeps native task details and terminal output available without a child thread", async () => {
  using _language = languageScope();
  const task = "Plan the UI implementation\nKeep existing behavior.";
  const progress = "Reading apps/web/src/components/chat";
  const result = "Use the existing projection.\nDo not create another agent.\n<raw-output>";
  state.subagents = [nativeAgent({ progress })];
  await using screen = await render(
    <ThreadSubagentsPanel environmentId={environmentId} threadId={threadId} />,
  );
  const toggle = screen.getByRole("button", { name: "Details for subagent atlas" });
  const details = document.getElementById(toggle.element().getAttribute("aria-controls")!)!;
  expect(details.hidden).toBe(true);
  await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
  await expect.element(toggle).toHaveAccessibleDescription("Running Native OMO · raw-model-name");
  await userEvent.tab();
  await expect.element(toggle).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  expect(details.hidden).toBe(false);
  await expect.element(toggle).toHaveAttribute("aria-expanded", "true");
  await expect.element(screen.getByText(task, { exact: true })).toBeVisible();
  const values = details.querySelectorAll("dd");
  expect(Array.from(details.querySelectorAll("dt"), (term) => term.textContent)).toEqual([
    "Task",
    "Progress",
    "Result",
    "Error",
  ]);
  expect(values[0]?.textContent).toBe(task);
  expect(values[1]?.textContent).toBe(progress);
  expect(values[2]?.textContent).toBe("Not reported");
  expect(values[3]?.textContent).toBe("Not reported");

  state.subagents = [
    nativeAgent({
      status: "completed",
      progress,
      result,
      completedAt: DateTime.makeUnsafe("2026-11-01T00:02:00Z"),
    }),
  ];
  await screen.rerender(<ThreadSubagentsPanel environmentId={environmentId} threadId={threadId} />);
  await expect
    .element(screen.getByRole("heading", { name: "Subagents", exact: true }))
    .toBeVisible();
  await expect
    .element(screen.getByLabelText("0 active subagents, 1 recent subagents"))
    .toBeVisible();
  await expect.element(screen.getByText("Completed", { exact: true })).toBeVisible();
  await expect.element(toggle).toHaveAccessibleDescription("Completed Native OMO · raw-model-name");
  expect(document.getElementById(toggle.element().getAttribute("aria-controls")!)).toBe(details);
  expect(details.hidden).toBe(false);
  expect(details.querySelectorAll("dd")[2]?.textContent).toBe(result);
  expect(details.querySelector("raw-output")).toBeNull();
  expect(screen.container.querySelectorAll("a")).toHaveLength(0);

  await act(() => setLanguagePreference("zh"));
  await expect
    .element(screen.getByRole("heading", { name: "子 Agent", exact: true }))
    .toBeVisible();
  await expect.element(screen.getByText("已完成", { exact: true })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "子 Agent 详情：atlas" })).toBeVisible();
  expect(Array.from(details.querySelectorAll("dt"), (term) => term.textContent)).toEqual([
    "任务",
    "进度",
    "结果",
    "错误",
  ]);
  expect(details.querySelectorAll("dd")[0]?.textContent).toBe(task);
  expect(details.querySelectorAll("dd")[1]?.textContent).toBe(progress);
  expect(details.querySelectorAll("dd")[2]?.textContent).toBe(result);
  expect(screen.container.textContent).toContain("Native OMO · raw-model-name");
  await userEvent.keyboard("{Enter}");
  expect(details.hidden).toBe(true);
});

it("retains native completed, failed, cancelled and interrupted rows with truthful status and raw errors", async () => {
  using _language = languageScope();
  const error =
    "Native tool failed\nError: <script>must remain raw</script>\n/path/to/source.ts:42";
  state.subagents = [
    nativeAgent({
      id: NodeId.make("explore"),
      title: "explore",
      status: "completed",
      result: "Found three call sites",
    }),
    nativeAgent({ id: NodeId.make("oracle"), title: "oracle", status: "failed", result: error }),
    nativeAgent({
      id: NodeId.make("cancelled"),
      title: "Cancelled native task",
      status: "cancelled",
    }),
    nativeAgent({
      id: NodeId.make("interrupted"),
      title: "Interrupted native task",
      status: "interrupted",
    }),
    agent({
      id: NodeId.make("app-completed"),
      title: "Hidden app completion",
      status: "completed",
    }),
    agent({ id: NodeId.make("app-failed"), title: "Hidden app failure", status: "failed" }),
    nativeAgent({
      id: NodeId.make("omo-app-completed"),
      origin: "app_owned",
      title: "Hidden OMO app completion",
      status: "completed",
    }),
    agent({
      id: NodeId.make("other-native-completed"),
      origin: "provider_native",
      title: "Hidden other native completion",
      status: "completed",
      childThreadId: null,
    }),
  ];
  await using screen = await render(
    <ThreadSubagentsPanel environmentId={environmentId} threadId={threadId} />,
  );
  await expect
    .element(screen.getByLabelText("0 active subagents, 4 recent subagents"))
    .toBeVisible();
  for (const status of ["Completed", "Failed", "Cancelled", "Interrupted"]) {
    await expect.element(screen.getByText(status, { exact: true })).toBeVisible();
  }
  expect(screen.container.querySelectorAll("[data-subagent-id]")).toHaveLength(4);
  expect(screen.container.textContent).not.toContain("Hidden");
  expect(screen.container.querySelectorAll(".animate-spin")).toHaveLength(0);
  const toggle = screen.getByRole("button", { name: "Details for subagent oracle" });
  await toggle.click();
  const details = document.getElementById(toggle.element().getAttribute("aria-controls")!)!;
  expect(details.querySelectorAll("dd")[2]?.textContent).toBe("Not reported");
  expect(details.querySelectorAll("dd")[3]?.textContent).toBe(error);
  expect(details.querySelector("script")).toBeNull();
  await expect.element(screen.getByText(error, { exact: true })).toBeVisible();
  await act(() => setLanguagePreference("zh"));
  await expect.element(screen.getByText("失败", { exact: true })).toBeVisible();
  expect(details.querySelectorAll("dd")[3]?.textContent).toBe(error);
});

it("caps terminal OMO history at 20 while retaining active rows and nonduplicate workflow counts", async () => {
  using _language = languageScope();
  state.subagents = [
    ...Array.from({ length: 25 }, (_, index) =>
      nativeAgent({
        id: NodeId.make(`recent-${index}`),
        title: `Recent ${index}`,
        status: "completed",
        completedAt: DateTime.makeUnsafe(Date.UTC(2026, 10, 1, 0, 0, index)),
      }),
    ),
    nativeAgent(),
    agent({
      workflow: {
        phases: [],
        agents: [
          { index: 1, label: "Worker one", state: "running" },
          { index: 2, label: "Worker two", state: "queued" },
          { index: 3, label: "Finished worker", state: "completed" },
        ],
      },
    }),
  ];
  await using screen = await render(
    <ThreadSubagentsPanel environmentId={environmentId} threadId={threadId} />,
  );
  await expect
    .element(screen.getByLabelText("3 active subagents, 20 recent subagents"))
    .toBeVisible();
  expect(
    Array.from(screen.container.querySelectorAll("[data-subagent-id]"), (row) =>
      row.getAttribute("data-subagent-id"),
    ),
  ).toEqual([
    "atlas",
    "review:agent:1",
    "review:agent:2",
    ...Array.from({ length: 20 }, (_, index) => `recent-${24 - index}`),
  ]);
  expect(screen.container.textContent).not.toContain("Review task");
  expect(screen.container.textContent).not.toContain("Finished worker");
});

it("stops the native elapsed clock at completion and never ticks retained terminal rows", async () => {
  using _language = languageScope();
  using _timers = fakeTimers();
  vi.setSystemTime(new Date("2026-11-01T00:00:05Z"));
  state.subagents = [nativeAgent()];
  await using screen = await render(
    <ThreadSubagentsPanel environmentId={environmentId} threadId={threadId} />,
  );
  expect(screen.getByLabelText("Elapsed: 5s").element().textContent).toBe("5s");
  await act(() => vi.advanceTimersByTimeAsync(2000));
  expect(screen.getByLabelText("Elapsed: 7s").element().textContent).toBe("7s");
  state.subagents = [
    nativeAgent({ status: "completed", completedAt: DateTime.makeUnsafe("2026-11-01T00:00:07Z") }),
  ];
  await screen.rerender(<ThreadSubagentsPanel environmentId={environmentId} threadId={threadId} />);
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(screen.getByLabelText("Elapsed: 7s").element().textContent).toBe("7s");
  expect(vi.getTimerCount()).toBe(0);

  state.subagents = [nativeAgent({ status: "failed", completedAt: null })];
  await screen.rerender(<ThreadSubagentsPanel environmentId={environmentId} threadId={threadId} />);
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(screen.container.querySelector('[aria-label^="Elapsed:"]')).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});

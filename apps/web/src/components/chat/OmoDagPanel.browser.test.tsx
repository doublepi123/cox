import {
  EnvironmentId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
  ThreadId,
  type OrchestrationV2Subagent,
  type OrchestrationV2WorkflowGraph,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

const state = vi.hoisted(() => ({ subagents: [] as ReadonlyArray<OrchestrationV2Subagent> }));

vi.mock(import("../../state/entities"), () => ({
  useQuietThreadProjection: (() => ({ projection: { subagents: state.subagents } })) as never,
}));
vi.mock(import("../../state/environments"), () => ({
  useEnvironmentProviders: (() => new Map([[environmentId, [omoProvider]]])) as never,
}));

import { act, render } from "../../../test/render";
import { setLanguagePreference } from "../../i18n";
import { LANGUAGE_STORAGE_KEY, parseLanguagePreference } from "../../i18n/language";
import { OmoDagPanel } from "./OmoDagPanel";

const environmentId = EnvironmentId.make("environment");
const threadId = ThreadId.make("parent");
const providerInstanceId = ProviderInstanceId.make("omo-native");
const omoProvider = Schema.decodeSync(ServerProvider)({
  instanceId: providerInstanceId,
  driver: "omo",
  displayName: "Native OMO",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-01T00:00:00.000Z",
  models: [],
});

const longLabel =
  "Build an extraordinarily long dependency node label_without-natural-breaks-<script>raw</script>";
const longPrompt =
  "Preserve this provider-owned prompt exactly.\n/path/to/source.ts:42\n<raw-output>do not translate</raw-output>";

function graph(
  overrides: Partial<OrchestrationV2WorkflowGraph> = {},
): OrchestrationV2WorkflowGraph {
  return {
    schemaVersion: 1,
    runId: "run-1",
    parentSessionId: "native-parent",
    generation: 3,
    lastSeq: 18,
    name: "Mass ULW implementation",
    status: "running",
    createdAt: 100,
    updatedAt: 500,
    nodes: [
      {
        id: "research",
        label: "Research",
        prompt: "Inspect the existing projection",
        state: "completed",
        attempt: 1,
        taskId: "task-research",
        model: "graph/research-model",
        childThreadId: ThreadId.make("child-research"),
      },
      {
        id: "design",
        label: "Design",
        prompt: "Design the graph",
        state: "paused",
        attempt: 2,
        model: "service/design-model",
        progress: "Paused at design review",
      },
      {
        id: "build",
        label: "Build",
        prompt: "Implement the graph",
        state: "running",
        attempt: 1,
        taskId: "task-build",
      },
      {
        id: "pending",
        label: longLabel,
        prompt: longPrompt,
        state: "pending",
        attempt: 0,
      },
      {
        id: "failed",
        label: "Audit",
        prompt: "Audit the result",
        state: "failed",
        attempt: 4,
        lastError: { code: "native_failed", message: "Raw native error\n/path/to/file.ts:9" },
      },
    ],
    edges: [
      { from: "research", to: "design" },
      { from: "research", to: "build" },
      { from: "design", to: "pending" },
      { from: "build", to: "pending" },
      { from: "design", to: "failed" },
    ],
    waves: [
      { index: 0, nodeIds: ["research"] },
      { index: 1, nodeIds: ["design", "build"] },
      { index: 2, nodeIds: ["pending", "failed"] },
    ],
    criticalPath: ["research", "build", "pending"],
    ...overrides,
  };
}

function coordinator(
  value: OrchestrationV2WorkflowGraph,
  overrides: Partial<OrchestrationV2Subagent> = {},
): OrchestrationV2Subagent {
  return {
    id: NodeId.make("coordinator"),
    threadId,
    runId: null,
    parentNodeId: NodeId.make("parent-node"),
    origin: "provider_native",
    createdBy: "user",
    driver: ProviderDriverKind.make("omo"),
    providerInstanceId,
    providerThreadId: null,
    childThreadId: null,
    nativeTaskRef: null,
    prompt: "Coordinator prompt must not become a graph node",
    title: "Coordinator title must not become a graph node",
    model: null,
    status: "running",
    workflow: { name: value.name, phases: [], agents: [], graph: value },
    result: null,
    startedAt: DateTime.makeUnsafe("2026-11-01T00:00:00Z"),
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-11-01T00:02:00Z"),
    ...overrides,
  };
}

function nativeTask(
  taskId: string,
  overrides: Partial<OrchestrationV2Subagent> = {},
): OrchestrationV2Subagent {
  return coordinator(graph(), {
    id: NodeId.make(`native-${taskId}`),
    title: `Native ${taskId}`,
    prompt: "Native task projection",
    nativeTaskRef: { driver: ProviderDriverKind.make("omo"), nativeId: taskId, strength: "strong" },
    workflow: undefined,
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

async function viewportScope(width: number) {
  const previous = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(width, 900);
  return {
    [Symbol.asyncDispose]: () => page.viewport(previous.width, previous.height),
  };
}

function themeScope(theme: "light" | "dark") {
  const dark = document.documentElement.classList.contains("dark");
  const colorScheme = document.documentElement.style.colorScheme;
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.style.colorScheme = theme;
  return {
    [Symbol.dispose]() {
      document.documentElement.classList.toggle("dark", dark);
      document.documentElement.style.colorScheme = colorScheme;
    },
  };
}

it("renders real dependencies, waves, run metadata and links only for available children", async () => {
  using _language = languageScope();
  state.subagents = [
    coordinator(graph({ truncated: true })),
    nativeTask("task-research", {
      model: "graph/research-model",
      childThreadId: ThreadId.make("child-research"),
    }),
    nativeTask("task-build", {
      model: "service/actual-build-model",
      progress: "Resolved native progress",
      childThreadId: ThreadId.make("child-build"),
    }),
  ];
  await using screen = await render(
    <OmoDagPanel environmentId={environmentId} threadId={threadId} />,
  );

  await expect.element(screen.getByRole("heading", { name: "Dependency graph" })).toBeVisible();
  await expect
    .element(screen.getByRole("combobox", { name: "Dependency run" }))
    .toHaveValue("coordinator:run-1");
  expect(screen.container.textContent).toContain("Mass ULW implementation");
  expect(screen.container.textContent).toContain("Generation 3");
  expect(screen.container.textContent).toContain(
    "This graph is truncated. Some nodes may be omitted.",
  );
  expect(screen.container.querySelectorAll("[data-omo-dag-node]")).toHaveLength(5);
  expect(screen.container.querySelectorAll("[data-omo-dag-edge]")).toHaveLength(5);
  expect(screen.container.querySelectorAll("[data-omo-dag-node] a")).toHaveLength(0);
  expect(screen.container.textContent).not.toContain("Coordinator title must not become");
  expect(screen.container.textContent).toContain("Wave 1");
  expect(screen.container.textContent).toContain("Wave 3");
  expect(
    screen.container.querySelector('[data-omo-dag-node="research"]')?.getAttribute("data-state"),
  ).toBe("completed");
  expect(
    screen.container.querySelector('[data-omo-dag-node="design"]')?.getAttribute("data-state"),
  ).toBe("paused");
  expect(
    screen.container.querySelector('[data-omo-dag-node="failed"]')?.getAttribute("data-state"),
  ).toBe("failed");
  await expect
    .element(screen.getByRole("link", { name: "Open graph node Research" }))
    .toHaveAttribute("href", "/environment/child-research");
  await expect
    .element(screen.getByRole("link", { name: "Open graph node Build" }))
    .toHaveAttribute("href", "/environment/child-build");
  await expect
    .element(screen.getByRole("button", { name: `Select graph node ${longLabel}` }))
    .toHaveAttribute("aria-pressed", "false");
  expect(screen.container.querySelectorAll("a")).toHaveLength(2);
  expect(screen.container.textContent).toContain("service/actual-build-model");
  expect(screen.container.textContent).toContain("Resolved native progress");
  expect(screen.container.textContent).toContain("graph/research-model");

  await screen.getByRole("button", { name: "Select graph node Audit" }).click();
  expect(screen.container.querySelector("[data-omo-dag-details]")?.textContent).toContain(
    "Raw native error\n/path/to/file.ts:9",
  );
  expect(screen.container.querySelector("raw-output")).toBeNull();
  expect(screen.container.querySelector("script")).toBeNull();

  await act(() => setLanguagePreference("zh"));
  await expect.element(screen.getByRole("heading", { name: "依赖图" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "列表视图" })).toBeVisible();
  expect(screen.container.textContent).toContain("service/actual-build-model");
  expect(screen.container.textContent).toContain("Raw native error\n/path/to/file.ts:9");
  await screen.getByRole("link", { name: "打开图节点：Research" }).click();
  expect(screen.router?.state.location.pathname).toBe("/environment/child-research");
});

it("supports zoom, reset, fit, keyboard pan and wheel scrolling without graph mutations", async () => {
  using _language = languageScope();
  state.subagents = [coordinator(graph())];
  await using screen = await render(
    <OmoDagPanel environmentId={environmentId} threadId={threadId} />,
  );
  const viewport = screen.getByRole("region", { name: "Interactive dependency graph" });
  await expect.element(viewport).toBeVisible();
  const scale = () => Number(viewport.element().getAttribute("data-scale"));
  const panX = () => Number(viewport.element().getAttribute("data-pan-x"));
  const panY = () => Number(viewport.element().getAttribute("data-pan-y"));
  const initialScale = scale();

  await screen.getByRole("button", { name: "Zoom graph in" }).click();
  expect(scale()).toBeGreaterThan(initialScale);
  await screen.getByRole("button", { name: "Reset graph view" }).click();
  expect(scale()).toBe(1);
  await screen.getByRole("button", { name: "Zoom graph out" }).click();
  expect(scale()).toBeLessThan(1);
  await screen.getByRole("button", { name: "Fit graph" }).click();
  expect(scale()).toBeLessThanOrEqual(1);

  await act(() => viewport.element().focus());
  const initialX = panX();
  await userEvent.keyboard("{ArrowRight}");
  expect(panX()).toBeLessThan(initialX);
  await userEvent.keyboard("{ArrowLeft}");
  expect(panX()).toBe(initialX);
  const initialY = panY();
  const wheel = new WheelEvent("wheel", { deltaY: 48, bubbles: true, cancelable: true });
  await act(() => {
    viewport.element().dispatchEvent(wheel);
  });
  expect(wheel.defaultPrevented).toBe(true);
  expect(panY()).toBe(initialY - 48);
  await userEvent.keyboard("0");
  expect(scale()).toBe(1);
  expect(screen.container.querySelectorAll("[data-omo-dag-edge]")).toHaveLength(5);
  expect(screen.container.querySelectorAll("input, textarea, [contenteditable=true]")).toHaveLength(
    0,
  );
});

it("keeps the selected run stable across projection refreshes and run ordering changes", async () => {
  using _language = languageScope();
  const older = graph({
    runId: "older",
    name: "Older run",
    status: "completed",
    updatedAt: 100,
  });
  const newer = graph({ runId: "newer", name: "Newer run", updatedAt: 500 });
  state.subagents = [
    coordinator(older, { id: NodeId.make("first") }),
    coordinator(newer, { id: NodeId.make("second") }),
  ];
  await using screen = await render(
    <OmoDagPanel environmentId={environmentId} threadId={threadId} />,
  );
  const picker = screen.getByRole("combobox", { name: "Dependency run" });
  await picker.selectOptions("first:older");
  await expect.element(picker).toHaveValue("first:older");
  expect(screen.container.textContent).toContain("Older run");

  state.subagents = [
    coordinator(older, { id: NodeId.make("first") }),
    coordinator(
      { ...newer, generation: 4, lastSeq: 19, updatedAt: 900 },
      { id: NodeId.make("second") },
    ),
  ];
  await screen.rerender(<OmoDagPanel environmentId={environmentId} threadId={threadId} />);
  await expect.element(picker).toHaveValue("first:older");
  expect(screen.container.textContent).toContain("Older run");
  expect(screen.container.querySelectorAll("[data-omo-dag-node]")).toHaveLength(5);
});

it.each([
  { width: 320, theme: "light" },
  { width: 360, theme: "dark" },
  { width: 390, theme: "light" },
  { width: 1280, theme: "dark" },
] as const)(
  "keeps graph, list and raw details usable at $width px in $theme mode",
  async ({ width, theme }) => {
    using _language = languageScope();
    await using _viewport = await viewportScope(width);
    using _theme = themeScope(theme);
    state.subagents = [coordinator(graph())];
    const container = document.createElement("div");
    container.style.width = `${Math.min(width - 8, 420)}px`;
    container.style.maxWidth = "100%";
    container.style.margin = "0 auto";
    await using screen = await render(
      <OmoDagPanel environmentId={environmentId} threadId={threadId} />,
      { container },
    );
    const panel = screen.container.querySelector("[data-omo-dag-panel]")!;
    const rectangle = panel.getBoundingClientRect();
    expect(rectangle.left).toBeGreaterThanOrEqual(0);
    expect(rectangle.right).toBeLessThanOrEqual(width);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    await expect
      .element(screen.getByRole("button", { name: "Graph view" }))
      .toHaveAttribute("aria-pressed", "true");

    await screen.getByRole("button", { name: "List view" }).click();
    await expect
      .element(screen.getByRole("button", { name: "List view" }))
      .toHaveAttribute("aria-pressed", "true");
    await expect
      .element(screen.getByText(`Depends on Design, Build`, { exact: true }))
      .toBeVisible();
    await screen.getByRole("button", { name: `Select graph node ${longLabel}` }).click();
    await expect.element(screen.getByText(longPrompt, { exact: true })).toBeVisible();
    expect(screen.container.querySelector("[data-omo-dag-details]")?.textContent).toContain(
      longLabel,
    );
    expect(screen.container.querySelector("raw-output")).toBeNull();
    expect(screen.container.querySelector("script")).toBeNull();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    await screen.getByRole("button", { name: "Graph view" }).click();
    await expect
      .element(screen.getByRole("region", { name: "Interactive dependency graph" }))
      .toBeVisible();
  },
);

it("expands the current run into a larger graph dialog", async () => {
  using _language = languageScope();
  state.subagents = [coordinator(graph())];
  await using screen = await render(
    <OmoDagPanel environmentId={environmentId} threadId={threadId} />,
  );
  const sideViewport = screen.getByRole("region", { name: "Interactive dependency graph" });
  await expect.element(sideViewport).toBeVisible();

  await screen.getByRole("button", { name: "Expand graph" }).click();
  const dialog = page.getByRole("dialog", { name: "Mass ULW implementation" });
  await expect.element(dialog).toBeVisible();
  const expandedViewport = dialog.getByRole("region", { name: "Interactive dependency graph" });
  await expect.element(expandedViewport).toBeVisible();
  const side = sideViewport.element().getBoundingClientRect();
  await expect
    .poll(() => expandedViewport.element().getBoundingClientRect().width)
    .toBeGreaterThan(side.width);
  await expect
    .poll(() => expandedViewport.element().getBoundingClientRect().height)
    .toBeGreaterThan(side.height);
  expect(dialog.element().querySelectorAll("[data-omo-dag-node]")).toHaveLength(5);
  expect(dialog.element().textContent).toContain("1/5");
});

it("shares node selection between the expanded dialog and the side panel", async () => {
  using _language = languageScope();
  state.subagents = [coordinator(graph())];
  await using screen = await render(
    <OmoDagPanel environmentId={environmentId} threadId={threadId} />,
  );
  await screen.getByRole("button", { name: "Expand graph" }).click();
  const dialog = page.getByRole("dialog", { name: "Mass ULW implementation" });
  await expect.element(dialog).toBeVisible();

  await dialog.getByRole("button", { name: "Select graph node Audit" }).click();
  await expect
    .element(dialog.getByRole("button", { name: "Select graph node Audit" }))
    .toHaveAttribute("aria-pressed", "true");
  expect(dialog.element().querySelector("[data-omo-dag-details]")?.textContent).toContain(
    "Raw native error\n/path/to/file.ts:9",
  );

  await dialog.getByRole("button", { name: "Close" }).click();
  await expect.element(dialog).not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("button", { name: "Select graph node Audit" }))
    .toHaveAttribute("aria-pressed", "true");
  expect(screen.container.querySelector("[data-omo-dag-details]")?.textContent).toContain(
    "Raw native error\n/path/to/file.ts:9",
  );
});

it("closes the expanded graph with Escape and returns focus to the expand button", async () => {
  using _language = languageScope();
  state.subagents = [coordinator(graph())];
  await using screen = await render(
    <OmoDagPanel environmentId={environmentId} threadId={threadId} />,
  );
  const expand = screen.getByRole("button", { name: "Expand graph" });
  await expand.click();
  const dialog = page.getByRole("dialog", { name: "Mass ULW implementation" });
  await expect.element(dialog).toBeVisible();
  const viewport = dialog.getByRole("region", { name: "Interactive dependency graph" });
  await act(() => viewport.element().focus());
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(dialog).toBeVisible();

  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(expand).toHaveFocus();
});

it("opens the expanded graph on double-click of empty side canvas only", async () => {
  using _language = languageScope();
  state.subagents = [coordinator(graph())];
  await using screen = await render(
    <OmoDagPanel environmentId={environmentId} threadId={threadId} />,
  );
  const viewport = screen.getByRole("region", { name: "Interactive dependency graph" });
  await expect.element(viewport).toBeVisible();
  const dialog = page.getByRole("dialog", { name: "Mass ULW implementation" });

  await userEvent.dblClick(screen.getByRole("button", { name: "Select graph node Audit" }));
  expect(document.querySelector("[data-omo-dag-expanded]")).toBeNull();

  await userEvent.dblClick(viewport, { position: { x: 4, y: 4 } });
  await expect.element(dialog).toBeVisible();
});

it("returns no panel for graph-less workflows", async () => {
  using _language = languageScope();
  const source = coordinator(graph());
  state.subagents = [{ ...source, workflow: { phases: [], agents: [] } }];
  await using screen = await render(
    <OmoDagPanel environmentId={environmentId} threadId={threadId} />,
  );
  expect(screen.container.querySelector("[data-omo-dag-panel]")).toBeNull();
});

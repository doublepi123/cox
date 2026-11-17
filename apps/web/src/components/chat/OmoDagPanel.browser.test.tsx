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

async function viewportScope(width: number, height = 900) {
  const previous = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(width, height);
  return {
    [Symbol.asyncDispose]: () => page.viewport(previous.width, previous.height),
  };
}

async function emitPointer(
  element: HTMLElement,
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  point: { readonly id: number; readonly x: number; readonly y: number },
) {
  await act(() => {
    element.dispatchEvent(
      new PointerEvent(type, {
        pointerId: point.id,
        pointerType: "touch",
        isPrimary: point.id === 1,
        clientX: point.x,
        clientY: point.y,
        button: 0,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
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
  await using _viewport = await viewportScope(1280);
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
  await using _viewport = await viewportScope(1280);
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
  await using _viewport = await viewportScope(1280);
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
    const initialView = width < 640 ? "List view" : "Graph view";
    await expect
      .element(screen.getByRole("button", { name: initialView }))
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
  await using _viewport = await viewportScope(1280);
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
  await using _viewport = await viewportScope(1280);
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
  await using _viewport = await viewportScope(1280);
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
  await using _viewport = await viewportScope(1280);
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

it("defaults a 390px phone to waves and opens a full-screen graph with one tap", async () => {
  using _language = languageScope();
  await using _viewport = await viewportScope(390, 844);
  state.subagents = [coordinator(graph())];
  await using screen = await render(
    <OmoDagPanel environmentId={environmentId} threadId={threadId} />,
  );
  await expect
    .element(screen.getByRole("button", { name: "List view" }))
    .toHaveAttribute("aria-pressed", "true");
  await expect.element(screen.getByText("Depends on Design, Build", { exact: true })).toBeVisible();
  const graphToggle = screen.getByRole("button", { name: "Graph view" });
  expect(graphToggle.element().getBoundingClientRect().height).toBeGreaterThanOrEqual(44);

  await graphToggle.click();

  const dialog = page.getByRole("dialog", { name: "Mass ULW implementation" });
  await expect.element(dialog).toBeVisible();
  await expect
    .element(dialog.getByRole("region", { name: "Interactive dependency graph" }))
    .toBeVisible();
  await expect.poll(() => dialog.element().getBoundingClientRect().width).toBe(390);
  await expect.poll(() => dialog.element().getBoundingClientRect().height).toBe(844);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
});

it("pans and clamps touch pinch zoom without invalid transforms or captured pointers", async () => {
  using _language = languageScope();
  await using _viewport = await viewportScope(390, 844);
  state.subagents = [coordinator(graph())];
  await using screen = await render(
    <OmoDagPanel environmentId={environmentId} threadId={threadId} />,
  );
  await screen.getByRole("button", { name: "Graph view" }).click();
  const dialog = page.getByRole("dialog", { name: "Mass ULW implementation" });
  const viewport = dialog.getByRole("region", { name: "Interactive dependency graph" });
  await expect.element(viewport).toBeVisible();
  const viewportElement = viewport.element();
  if (!(viewportElement instanceof HTMLElement)) throw new Error("Missing HTML graph viewport");
  const element = viewportElement;
  const captured = new Set<number>();
  const spies = [
    vi.spyOn(element, "setPointerCapture").mockImplementation((pointerId) => {
      captured.add(pointerId);
    }),
    vi
      .spyOn(element, "hasPointerCapture")
      .mockImplementation((pointerId) => captured.has(pointerId)),
    vi.spyOn(element, "releasePointerCapture").mockImplementation((pointerId) => {
      captured.delete(pointerId);
    }),
  ];
  using _captures = {
    [Symbol.dispose]() {
      for (const spy of spies) spy.mockRestore();
    },
  };
  const scale = () => Number(element.getAttribute("data-scale"));
  const panX = () => Number(element.getAttribute("data-pan-x"));
  const panY = () => Number(element.getAttribute("data-pan-y"));

  const initialX = panX();
  const initialY = panY();
  await emitPointer(element, "pointerdown", { id: 1, x: 100, y: 100 });
  await emitPointer(element, "pointermove", { id: 1, x: 140, y: 130 });
  await emitPointer(element, "pointerup", { id: 1, x: 140, y: 130 });
  expect(panX()).toBe(initialX + 40);
  expect(panY()).toBe(initialY + 30);
  expect(captured.size).toBe(0);

  await emitPointer(element, "pointerdown", { id: 1, x: 100, y: 100 });
  await emitPointer(element, "pointerdown", { id: 2, x: 200, y: 100 });
  expect(captured).toEqual(new Set([1, 2]));
  await emitPointer(element, "pointermove", { id: 2, x: 600, y: 100 });
  expect(scale()).toBe(2);
  await emitPointer(element, "pointermove", { id: 2, x: 1000, y: 100 });
  expect(scale()).toBe(2);
  await emitPointer(element, "pointermove", { id: 2, x: 105, y: 100 });
  expect(scale()).toBe(0.35);
  await emitPointer(element, "pointermove", { id: 2, x: 100, y: 100 });
  expect(scale()).toBe(0.35);
  expect(Number.isFinite(panX())).toBe(true);
  expect(Number.isFinite(panY())).toBe(true);
  await emitPointer(element, "pointermove", { id: 2, x: 200, y: 100 });
  await emitPointer(element, "pointermove", { id: 2, x: 1000, y: 100 });
  expect(scale()).toBe(2);

  await emitPointer(element, "pointercancel", { id: 2, x: 1000, y: 100 });
  expect(captured).toEqual(new Set([1]));
  const cancelledX = panX();
  const cancelledY = panY();
  await emitPointer(element, "pointermove", { id: 2, x: 1200, y: 200 });
  expect(panX()).toBe(cancelledX);
  expect(panY()).toBe(cancelledY);
  await emitPointer(element, "pointercancel", { id: 1, x: 100, y: 100 });
  expect(captured.size).toBe(0);
  await emitPointer(element, "pointermove", { id: 1, x: 300, y: 300 });
  expect(panX()).toBe(cancelledX);
  expect(panY()).toBe(cancelledY);

  const graphSurface = element.querySelector<HTMLElement>(".origin-top-left");
  expect(graphSurface?.style.transform).not.toMatch(/NaN|Infinity/);
  expect(Number.isFinite(scale())).toBe(true);
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

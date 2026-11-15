import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { act, render, stubGlobal } from "../../../test/render";

const state = vi.hoisted(() => ({
  context: null as unknown,
  checkpoints: [] as unknown[],
  startNewThread: vi.fn(),
}));

vi.mock(import("../../hooks/useHandleNewThread"), async (original) => ({
  ...(await original()),
  useHandleNewThread: (() => state.context) as never,
}));

vi.mock(import("../../lib/chatThreadActions"), async (original) => ({
  ...(await original()),
  resolveThreadActionProjectRef: ((context: { defaultProjectRef: unknown }) =>
    context.defaultProjectRef) as never,
  startNewThreadFromContext: state.startNewThread as never,
}));

vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useThreadCheckpointSummaries: (() => state.checkpoints) as never,
}));

vi.mock(import("./mobileWorkspaceLabels"), async (original) => ({
  ...(await original()),
  useMobileWorkspaceLabels: () => ({
    workspace: "Workspace",
    threads: "Threads",
    newThread: "New thread",
    changes: "Changes",
    terminal: "Terminal",
    servers: "Servers",
  }),
}));

import { SidebarProvider } from "../ui/sidebar";
import { MobileBranchOverflowTrigger } from "../BranchToolbar";
import { MobileWorkspaceBar } from "./MobileWorkspaceBar";

const environmentId = EnvironmentId.make("mobile-workspace-test");
const projectRef = scopeProjectRef(environmentId, ProjectId.make("mobile-project"));
const threadRef = scopeThreadRef(environmentId, ThreadId.make("mobile-thread"));

function setup() {
  state.context = {
    activeDraftThread: null,
    activeThread: null,
    defaultProjectRef: projectRef,
    handleNewThread: vi.fn(),
    routeThreadRef: threadRef,
  };
  state.checkpoints = [
    {
      checkpointTurnCount: 1,
      completedAt: "2026-01-01T00:00:00.000Z",
      files: [],
      filesTotal: { count: 3 },
    },
  ];
  state.startNewThread.mockReset().mockResolvedValue(undefined);
}

async function viewportScope(width: number, height: number) {
  const originalWidth = window.innerWidth;
  const originalHeight = window.innerHeight;
  await page.viewport(width, height);
  return {
    async [Symbol.asyncDispose]() {
      await page.viewport(originalWidth, originalHeight);
    },
  };
}

function visualViewportScope() {
  const viewport = window.visualViewport;
  if (!viewport) throw new Error("A visual viewport is required for this browser test");
  const originalHeight = Object.getOwnPropertyDescriptor(viewport, "height");
  let height = viewport.height;
  Object.defineProperty(viewport, "height", { configurable: true, get: () => height });
  return {
    resize(nextHeight: number) {
      height = nextHeight;
      viewport.dispatchEvent(new Event("resize"));
    },
    [Symbol.dispose]() {
      if (originalHeight) Object.defineProperty(viewport, "height", originalHeight);
      else Reflect.deleteProperty(viewport, "height");
    },
  };
}

function renderWorkspaceBar() {
  return render(
    <SidebarProvider defaultOpen={false}>
      <MobileWorkspaceBar />
    </SidebarProvider>,
    { router: false },
  );
}

describe("MobileWorkspaceBar", () => {
  it("provides thumb-sized workspace actions and opens the native server switcher", async () => {
    setup();
    const postMessage = vi.fn();
    using _self = stubGlobal("self", window.top);
    using _bridge = stubGlobal("__coxMobileShell__", {
      info: { platform: "ios", activeServerLabel: "Workstation", serverCount: 2 },
      bridgeToken: "mobile-bridge-token",
      postMessage,
    });
    await using _viewport = await viewportScope(390, 844);
    await using screen = await renderWorkspaceBar();

    const navigation = screen.getByRole("navigation", { name: "Workspace" });
    await expect.element(navigation).toBeVisible();
    for (const name of ["Threads", "New thread", "Changes (3)", "Terminal"]) {
      const box = screen
        .getByRole("button", { name, exact: true })
        .element()
        .getBoundingClientRect();
      expect(box.width, name).toBeGreaterThanOrEqual(44);
      expect(box.height, name).toBeGreaterThanOrEqual(44);
    }
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
    expect(navigation.element().scrollWidth).toBeLessThanOrEqual(390);

    const threads = screen.getByRole("button", { name: "Threads", exact: true });
    await threads.click();
    await expect.element(threads).toHaveAttribute("aria-pressed", "true");
    await screen.getByRole("button", { name: "New thread", exact: true }).click();
    expect(state.startNewThread).toHaveBeenCalledOnce();
    await expect.element(threads).toHaveAttribute("aria-pressed", "false");

    const changes = screen.getByRole("button", { name: "Changes (3)", exact: true });
    await changes.click();
    await expect.element(changes).toHaveAttribute("aria-pressed", "true");
    const terminal = screen.getByRole("button", { name: "Terminal", exact: true });
    await terminal.click();
    await expect.element(terminal).toHaveAttribute("aria-pressed", "true");

    await screen.getByRole("button", { name: "Servers: Workstation", exact: true }).click();
    expect(postMessage).toHaveBeenCalledWith({
      type: "hapticSelection",
      bridgeToken: "mobile-bridge-token",
    });
    expect(postMessage).toHaveBeenCalledWith({
      type: "openServerSwitcher",
      bridgeToken: "mobile-bridge-token",
    });
  });

  it("hides as soon as the visual viewport reports a software keyboard", async () => {
    setup();
    await using _viewport = await viewportScope(390, 844);
    using visualViewport = visualViewportScope();
    await using screen = await renderWorkspaceBar();
    const navigation = screen.getByRole("navigation", { name: "Workspace" });
    await expect.element(navigation).toBeVisible();

    await act(() => visualViewport.resize(600));

    await expect.element(navigation).not.toBeInTheDocument();
    await act(() => visualViewport.resize(844));
    await expect.element(screen.getByRole("navigation", { name: "Workspace" })).toBeVisible();
  });

  it.each([640, 641, 1280] as const)(
    "aligns the branch overflow trigger and workspace bar with the compact boundary at %ipx",
    async (width) => {
      setup();
      await using _viewport = await viewportScope(width, width === 1280 ? 800 : 844);
      await using screen = await render(
        <SidebarProvider defaultOpen={false}>
          <MobileBranchOverflowTrigger />
          <MobileWorkspaceBar />
        </SidebarProvider>,
        { router: false },
      );

      const overflow = screen.getByRole("button", { name: "Branch / Worktree", exact: true });
      const navigation = screen.getByRole("navigation", { name: "Workspace" });
      if (width === 640) {
        await expect.element(overflow).toBeVisible();
        await expect.element(overflow).toHaveAttribute("data-mobile-branch-overflow", "");
        await expect.element(navigation).toBeVisible();
        const box = overflow.element().getBoundingClientRect();
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
      } else {
        await expect.element(overflow).not.toBeInTheDocument();
        await expect.element(navigation).not.toBeInTheDocument();
      }
    },
  );

  it("stays hidden on a desktop viewport", async () => {
    setup();
    await using _viewport = await viewportScope(1280, 800);
    await using screen = await renderWorkspaceBar();

    await expect
      .element(screen.getByRole("navigation", { name: "Workspace" }))
      .not.toBeInTheDocument();
  });
});

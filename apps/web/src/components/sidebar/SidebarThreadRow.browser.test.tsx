import { DndContext } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import type { ComponentProps } from "react";

import "~/index.css";
import { render } from "../../../test/render";
import { makeThreadFixture } from "../../test-fixtures";
import { SortableThreadRow } from "./SidebarThreadRow";

const access = vi.hoisted(() => ({ canOperate: true }));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => access.canOperate,
  readEnvironmentScope: () => access.canOperate,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useThreadShell: () => null,
}));
vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({ data: null })) as never,
}));
vi.mock(import("../../state/terminalSessions"), async (original) => ({
  ...(await original()),
  useThreadRunningTerminalIds: () => [],
}));
vi.mock(import("../../hooks/useSupportsMultiplePullRequests"), () => ({
  useSupportsMultiplePullRequests: () => false,
}));
vi.mock(import("../../lib/openPullRequestLink"), async (original) => ({
  ...(await original()),
  useOpenPrLink: () => vi.fn(),
}));
vi.mock(import("../ThreadStatusIndicators"), async (original) => ({
  ...(await original()),
  useLinkedThreadPullRequest: () => null,
}));

function fixture(variant: "card" | "slim" | "folder" | "folder-multiline") {
  access.canOperate = true;
  const thread = makeThreadFixture({ title: "Pinned thread", runtime: null });
  const props = {
    thread,
    variant,
    variantAction: "settle" as const,
    settlementSupported: true,
    snoozeSupported: false,
    pinningSupported: true,
    isPinned: true,
    dropVerb: null,
    dragOverPinned: false,
    sweepAction: null,
    snoozeWakeLabelText: null,
    wokeAt: null,
    isActive: false,
    isRouteThread: false,
    openPullRequestsInRightPanel: false,
    jumpLabel: null,
    currentEnvironmentId: thread.environmentId,
    environmentLabel: null,
    environmentMachine: "desktop" as const,
    scratchMachineLabel: null,
    project: null,
    projectDisplayName: "Project",
    providerEntryByInstanceId: new Map(),
    timestampFormat: "locale" as const,
    onThreadClick: vi.fn(),
    onThreadActivate: vi.fn(),
    onStartRename: vi.fn(),
    onRenameTitleChange: vi.fn(),
    onCommitRename: vi.fn(),
    onCancelRename: vi.fn(),
    isRenaming: false,
    renamingTitle: "",
    onContextMenu: vi.fn(),
    onSettle: vi.fn(),
    onDelete: vi.fn(),
    onActionSweepStart: vi.fn(),
    onUnsettle: vi.fn(),
    onSnooze: vi.fn(),
    onUnsnooze: vi.fn(),
    onUnpin: vi.fn(),
    onAcknowledgeWoke: vi.fn(),
    sortableId: "pinned-row",
    sortableDisabled: true,
    contextDrag: false,
  };
  return {
    props,
    element: (overrides: Partial<ComponentProps<typeof SortableThreadRow>> = {}) => (
      <DndContext>
        <SortableContext items={[props.sortableId]}>
          <ul className="w-80 max-w-full">
            <SortableThreadRow {...props} {...overrides} />
          </ul>
        </SortableContext>
      </DndContext>
    ),
  };
}

describe("pinned sidebar thread actions", () => {
  it.each(["card", "slim", "folder", "folder-multiline"] as const)(
    "places unpin after delete with a gap, without turning the pin indicator into an action (%s)",
    async (variant) => {
      const f = fixture(variant);
      await using screen = await render(f.element());
      const row = screen.getByRole("treeitem", { name: /Pinned thread/ });
      await userEvent.hover(row);
      const remove = screen.getByRole("button", { name: "Delete thread", exact: true });
      const unpin = screen.getByRole("button", { name: "Unpin thread", exact: true });
      await expect.element(remove).toBeVisible();
      await expect.element(unpin).toBeVisible();
      const deletion = remove.element().getBoundingClientRect();
      const unpinning = unpin.element().getBoundingClientRect();
      expect(unpinning.left - deletion.right).toBeGreaterThanOrEqual(8);
      const indicator = row.element().querySelector('[role="img"][aria-label="Pinned"]');
      expect(indicator).not.toBeNull();
      expect(indicator?.closest("button")).toBeNull();
      await unpin.click();
      expect(f.props.onUnpin).toHaveBeenCalledExactlyOnceWith(
        scopeThreadRef(f.props.thread.environmentId, f.props.thread.id),
      );
      expect(f.props.onDelete).not.toHaveBeenCalled();
      expect(f.props.onThreadClick).not.toHaveBeenCalled();
      expect(f.props.onActionSweepStart).not.toHaveBeenCalled();
      await remove.click();
      expect(f.props.onDelete).toHaveBeenCalledOnce();
      expect(f.props.onUnpin).toHaveBeenCalledOnce();
    },
  );

  it("keeps unpin usable without a delete action and respects permissions", async () => {
    const f = fixture("card");
    await using screen = await render(
      f.element({ onDelete: undefined, settlementSupported: false }),
    );
    await userEvent.hover(screen.getByRole("treeitem", { name: /Pinned thread/ }));
    await expect
      .element(screen.getByRole("button", { name: "Unpin thread", exact: true }))
      .toBeVisible();
    access.canOperate = false;
    await screen.rerender(f.element({ onDelete: undefined, settlementSupported: false }));
    await expect
      .element(screen.getByRole("button", { name: "Unpin thread", exact: true }))
      .not.toBeInTheDocument();
    expect(f.props.onUnpin).not.toHaveBeenCalled();
  });

  it("keeps the action strip inside a 320px viewport", async () => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    await page.viewport(320, 740);
    try {
      const f = fixture("card");
      await using screen = await render(f.element());
      await userEvent.hover(screen.getByRole("treeitem", { name: /Pinned thread/ }));
      const remove = screen
        .getByRole("button", { name: "Delete thread", exact: true })
        .element()
        .getBoundingClientRect();
      const unpin = screen
        .getByRole("button", { name: "Unpin thread", exact: true })
        .element()
        .getBoundingClientRect();
      expect(unpin.left - remove.right).toBeGreaterThanOrEqual(8);
      expect(unpin.right).toBeLessThanOrEqual(320);
      expect(screen.container.scrollWidth).toBeLessThanOrEqual(320);
    } finally {
      await page.viewport(width, height);
    }
  });
});

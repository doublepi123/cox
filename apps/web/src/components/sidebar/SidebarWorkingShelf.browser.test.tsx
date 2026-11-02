import { DndContext } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import { expect, it } from "vite-plus/test";
import { render } from "../../../test/render";
import { SidebarDragBoundary, SidebarSectionHeader } from "./SidebarListMarkers";
import { useWorkingShelf, WORKING_SHELF_EXPANDED_KEY } from "./useWorkingShelf";

const threads = [{ id: "current", title: "Current working thread" }];

function WorkingShelf({ count = 1 }: { readonly count?: number }) {
  const shelf = useWorkingShelf(
    count === 1 ? threads : [...threads, { id: "new", title: "New work" }],
  );
  return (
    <DndContext>
      <SortableContext items={["sidebar-marker-working-header", "sidebar-marker-pinned-header"]}>
        <ul>
          <SidebarSectionHeader
            marker="working-header"
            label="处理中"
            count={count}
            toggle={{ expanded: shelf.expanded, onToggle: shelf.toggle }}
          />
          {shelf.visibleThreads.map((thread) => (
            <li key={thread.id} aria-current={thread.id === "current" ? "page" : undefined}>
              {thread.title}
            </li>
          ))}
          <SidebarDragBoundary
            marker="pinned-header"
            label="Pinned"
            sectionLabel="其他对话"
            visible={false}
            isDropTarget={false}
          />
          <li>Ordinary conversation</li>
        </ul>
      </SortableContext>
    </DndContext>
  );
}

it("fully collapses current work, persists the choice and keeps ordinary threads visible", async () => {
  const previous = localStorage.getItem(WORKING_SHELF_EXPANDED_KEY);
  using _storage = {
    [Symbol.dispose]: () =>
      previous === null
        ? localStorage.removeItem(WORKING_SHELF_EXPANDED_KEY)
        : localStorage.setItem(WORKING_SHELF_EXPANDED_KEY, previous),
  };
  localStorage.removeItem(WORKING_SHELF_EXPANDED_KEY);
  await using screen = await render(<WorkingShelf />);
  const toggle = screen.getByTestId("sidebar-working-shelf-toggle");
  await expect.element(toggle).toHaveAttribute("aria-expanded", "true");
  await expect.element(screen.getByText("Current working thread", { exact: true })).toBeVisible();
  await toggle.click();
  await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
  await expect
    .element(screen.getByText("Current working thread", { exact: true }))
    .not.toBeInTheDocument();
  await expect.element(screen.getByText("其他对话", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Ordinary conversation", { exact: true })).toBeVisible();
  expect(localStorage.getItem(WORKING_SHELF_EXPANDED_KEY)).toBe("false");
  await screen.rerender(<WorkingShelf key="remounted" count={2} />);
  await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
  await expect.element(screen.getByText("New work", { exact: true })).not.toBeInTheDocument();
  await toggle.click();
  await expect.element(toggle).toHaveAttribute("aria-expanded", "true");
  await expect.element(screen.getByText("Current working thread", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("New work", { exact: true })).toBeVisible();
});

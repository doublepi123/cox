import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../test/render";
import { openCommandPalette } from "../commandPaletteBus";
import { useCommandPaletteStore } from "../commandPaletteStore";
import { makeThreadFixture } from "../test-fixtures";
import type { Project, Thread } from "../types";
import { CommandPalette } from "./CommandPalette";

const entities = vi.hoisted(() => ({
  projects: [] as ReadonlyArray<Project>,
  threads: [] as ReadonlyArray<Thread>,
}));
vi.mock("../state/entities", async (original) => ({
  ...(await original<typeof import("../state/entities")>()),
  useProjects: () => entities.projects,
  useThreadShells: () => entities.threads,
}));

function setup(state: { projects?: ReadonlyArray<Project>; threads?: ReadonlyArray<Thread> } = {}) {
  useCommandPaletteStore.setState(useCommandPaletteStore.getInitialState(), true);
  entities.projects = state.projects ?? [];
  entities.threads = state.threads ?? [];
}

describe("CommandPalette open intents", () => {
  it("leaves a submenu only on a fresh, unmodified Backspace", async () => {
    setup();
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette({ open: "new-thread-in" });
    const rootInput = page.getByPlaceholder("Search commands, projects, and threads...");

    const submenuInput = page.getByPlaceholder("Search...");
    await expect.element(submenuInput).toHaveFocus();

    for (const init of [
      { repeat: true },
      { ctrlKey: true },
      { isComposing: true },
    ] satisfies ReadonlyArray<KeyboardEventInit>) {
      const event = new KeyboardEvent("keydown", {
        key: "Backspace",
        bubbles: true,
        cancelable: true,
        ...init,
      });
      await act(() => submenuInput.element().dispatchEvent(event));
      expect(event.defaultPrevented).toBe(false);
      await expect.element(submenuInput).toBeVisible();
    }

    await userEvent.keyboard("{Backspace}");
    await expect.element(rootInput).toHaveFocus();
  });

  it("opens New thread in... with focus in the search input, not the Back button", async () => {
    setup();
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette({ open: "new-thread-in" });

    await expect.element(page.getByPlaceholder("Search...")).toHaveFocus();
  });

  it("opens a search intent with its query in the focused input", async () => {
    setup();
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette({ query: "acme" });

    const input = page.getByPlaceholder("Search commands, projects, and threads...");
    await expect.element(input).toHaveFocus();
    await expect.element(input).toHaveValue("acme");
  });

  it("opens a searched project's latest listed thread when newer threads are parked or hidden", async () => {
    const environmentId = EnvironmentId.make("local");
    const projectId = ProjectId.make("acme");
    const parentId = ThreadId.make("parent");
    setup({
      projects: [
        {
          id: projectId,
          environmentId,
          title: "Acme",
          workspaceRoot: "/work/acme",
          repositoryIdentity: null,
          defaultModelSelection: null,
          createdAt: "2026-03-01T00:00:00.000Z",
          updatedAt: "2026-03-01T00:00:00.000Z",
          scripts: [],
        },
      ],
      threads: [
        makeThreadFixture({
          id: parentId,
          environmentId,
          projectId,
          latestUserMessageAt: "2026-03-02T00:00:00.000Z",
        }),
        makeThreadFixture({
          id: ThreadId.make("settled"),
          environmentId,
          projectId,
          latestUserMessageAt: "2026-03-05T00:00:00.000Z",
          settledOverride: "settled",
        }),
        makeThreadFixture({
          id: ThreadId.make("snoozed"),
          environmentId,
          projectId,
          latestUserMessageAt: "2026-03-06T00:00:00.000Z",
          snoozedUntil: "2099-01-01T00:00:00.000Z",
        }),
        makeThreadFixture({
          id: ThreadId.make("subagent"),
          environmentId,
          projectId,
          updatedAt: "2026-03-03T00:00:00.000Z",
          lineage: {
            rootThreadId: parentId,
            parentThreadId: parentId,
            relationshipToParent: "subagent",
          },
        }),
      ],
    });
    await using screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette({ query: "Acme" });
    await page.getByRole("option", { name: /Acme/ }).first().click();

    await vi.waitFor(() => expect(screen.router?.state.location.pathname).toBe("/local/parent"));
  });
});

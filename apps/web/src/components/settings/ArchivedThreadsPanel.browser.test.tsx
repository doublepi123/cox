import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { makeThreadProjectionFixture } from "../../test-fixtures";
import { ArchivedThreadsPanel } from "./ArchivedThreadsPanel";

const environmentId = EnvironmentId.make("local");
const projectId = ProjectId.make("archive");
const project = { id: projectId, title: "archive", workspaceRoot: "/archive" };

vi.mock("./SettingsScopeContext", async (original) => ({
  ...(await original<typeof import("./SettingsScopeContext")>()),
  useSettingsScope: () => ({
    scope: { kind: "all", environmentIds: [environmentId] },
    groups: [],
    environments: [],
  }),
}));
vi.mock("../../hooks/useThreadActions", () => ({ useThreadActions: () => ({}) }));
vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("../../lib/archivedThreadsState", () => ({
  useArchivedThreadSnapshots: () => ({
    snapshots: [
      {
        environmentId,
        snapshot: {
          projects: [project],
          threads: Array.from({ length: 1000 }, (_, index) => {
            const title = `Archived thread ${String(index).padStart(4, "0")}`;
            const base = makeThreadProjectionFixture().thread;
            const id = ThreadId.make(title);
            return {
              ...base,
              id,
              projectId,
              title,
              archivedAt: base.updatedAt,
              latestRunId: null,
              latestUserMessageAt: null,
              activeRunId: null,
              status: "idle",
              pendingRuntimeRequest: null,
              hasActionableProposedPlan: false,
              itemCount: 0,
              visibleItemCount: 0,
              lineage: { rootThreadId: id, parentThreadId: null, relationshipToParent: null },
            };
          }),
        },
      },
    ],
    isLoading: false,
    error: null,
  }),
}));

it("mounts archived thread rows near the viewport as the list scrolls", async () => {
  await using screen = await render(
    <>
      <style>{"[data-settings-page-scroll] { height: 400px; overflow: auto; }"}</style>
      <ArchivedThreadsPanel />
    </>,
  );
  const first = screen.getByText("Archived thread 0999", { exact: true });
  const last = screen.getByText("Archived thread 0000", { exact: true });
  await expect.element(first, { timeout: 3000 }).toBeVisible();
  await expect.element(last, { timeout: 3000 }).not.toBeInTheDocument();
  const scroller = screen.container.querySelector<HTMLElement>("[data-settings-page-scroll]")!;
  scroller.scrollTop = scroller.scrollHeight;
  await expect.element(last, { timeout: 3000 }).toBeVisible();
  await expect.element(first, { timeout: 3000 }).not.toBeInTheDocument();
});

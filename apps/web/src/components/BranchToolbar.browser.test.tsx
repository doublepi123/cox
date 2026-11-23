import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import { BranchToolbar } from "./BranchToolbar";

vi.mock("../state/entities", async (original) => ({
  ...(await original<typeof import("../state/entities")>()),
  useProject: () => ({ workspaceRoot: "/scratch", trackedFolders: [] }),
  useThreadShellsForProjectRefs: () => [],
}));
vi.mock("../worktreeRepositoryChoiceStore", async (original) => ({
  ...(await original<typeof import("../worktreeRepositoryChoiceStore")>()),
  useWorktreeBaseBranch: () => null,
}));

it("shows Current checkout in the thread panel when a worktree cannot be created", async () => {
  await using screen = await render(
    <BranchToolbar
      layout="panel"
      panelSection="workspace"
      environmentId={EnvironmentId.make("local")}
      threadId={ThreadId.make("draft")}
      projectId={ProjectId.make("scratch")}
      worktreePath={null}
      isServerThread={false}
      showGitControls={false}
      envMode="worktree"
      envLocked={false}
      startFromOrigin={false}
      onEnvModeChange={() => {}}
      onStartFromOriginChange={() => {}}
    />,
  );
  await expect.element(screen.getByText("Current checkout", { exact: true })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: /Run context/ })).not.toBeInTheDocument();
  await expect.element(screen.getByText("New worktree", { exact: true })).not.toBeInTheDocument();
});

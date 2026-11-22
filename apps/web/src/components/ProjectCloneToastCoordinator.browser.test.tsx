import { ProjectId, type ProjectCloneSnapshot } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { ENVIRONMENT_ID } from "../../test/fakeEnvironment";
import { render } from "../../test/render";
import { ProjectCloneToastCoordinator } from "./ProjectCloneToastCoordinator";
import { ToastProvider } from "./ui/toast";

let clones: ReadonlyArray<ProjectCloneSnapshot> = [];

vi.mock("../hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => vi.fn() }));
vi.mock("../hooks/useRemoveClonedProject", () => ({ useRemoveClonedProject: () => vi.fn() }));
vi.mock("../state/environments", () => ({
  useEnvironments: () => ({ environments: [{ environmentId: ENVIRONMENT_ID }] }),
}));
vi.mock("../state/projectClones", () => ({
  useEnvironmentProjectClones: () => clones,
  isProjectCloneToastSilenced: () => false,
  silenceProjectCloneToasts: vi.fn(),
}));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));

it("shows a failed clone after dismissal and shows progress on retry", async () => {
  const running: ProjectCloneSnapshot = {
    projectId: ProjectId.make("pending-clone"),
    remoteUrl: "https://example.com/pending-clone.git",
    destinationPath: "/projects/pending-clone",
    repository: null,
    phase: "running",
    stage: "connecting",
    percent: null,
    detail: null,
    error: null,
    startedAt: "2026-11-22T10:00:00.000Z",
    endedAt: null,
    sequence: 1,
  };
  const failed: ProjectCloneSnapshot = {
    ...running,
    phase: "failed",
    error: "Repository not found",
    endedAt: "2026-11-22T10:00:01.000Z",
    sequence: 2,
  };
  const ui = () => (
    <ToastProvider>
      <ProjectCloneToastCoordinator />
    </ToastProvider>
  );
  const progress = page.getByText("Cloning pending-clone", { exact: true });
  const failure = page.getByText("Failed to clone pending-clone", { exact: true });
  const dismiss = page.getByRole("button", { name: "Dismiss notification" });

  clones = [running];
  await using screen = await render(ui());
  await expect.element(progress).toBeVisible();
  await dismiss.click();
  await expect.element(progress).not.toBeInTheDocument();

  clones = [failed];
  await screen.rerender(ui());
  await expect.element(failure).toBeVisible();
  await dismiss.click();
  await expect.element(failure).not.toBeInTheDocument();

  const startedAt = "2026-11-22T10:00:02.000Z";
  clones = [{ ...running, startedAt, sequence: 3 }];
  await screen.rerender(ui());
  await expect.element(progress).toBeVisible();

  clones = [{ ...failed, startedAt, endedAt: "2026-11-22T10:00:03.000Z", sequence: 4 }];
  await screen.rerender(ui());
  await expect.element(failure).toBeVisible();
});

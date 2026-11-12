import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({ move: vi.fn() }));
const threadRef = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
};
vi.mock(
  "~/state/entities",
  () =>
    ({
      readThreadShell: () => ({
        id: "thread",
        projectId: "project-a",
      }),
      useThreadShell: () => ({ title: "Move this thread" }),
      useProjects: () => [
        {
          id: "project-a",
          environmentId: "environment",
          title: "Source",
          workspaceRoot: "/work/source",
          projectIcon: { kind: "monogram", text: "SO", color: "blue" },
        },
        {
          id: "project-b",
          environmentId: "environment",
          title: "Target",
          workspaceRoot: "/work/target",
          projectIcon: { kind: "monogram", text: "TA", color: "green" },
        },
      ],
    }) as never,
);
vi.mock(
  "~/state/threads",
  () =>
    ({
      threadEnvironment: { moveToProject: "move-to-project" },
    }) as never,
);
vi.mock(
  "~/state/use-orchestration-command",
  () =>
    ({
      useOrchestrationCommand: () => state.move,
    }) as never,
);

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { act, render } from "../../test/render";
import {
  openThreadProjectMoveDialog,
  ThreadProjectMoveDialogHost,
} from "./ThreadProjectMoveDialog";

it("searches for a target project and moves only the conversation", async () => {
  state.move.mockResolvedValue(AsyncResult.success({ sequence: 1 }));
  await using _screen = await render(
    <RegistryContext.Provider value={appAtomRegistry}>
      <ThreadProjectMoveDialogHost />
    </RegistryContext.Provider>,
  );
  await act(() => openThreadProjectMoveDialog(threadRef));

  await expect.element(page.getByText("Target", { exact: true })).toBeVisible();
  expect(page.getByRole("button", { name: "Source /work/source" })).not.toBeInTheDocument();
  await page.getByRole("textbox", { name: "Search projects" }).fill("target");
  await page.getByRole("button", { name: "Target /work/target" }).click();

  expect(state.move).toHaveBeenCalledWith({
    environmentId: threadRef.environmentId,
    input: {
      threadId: threadRef.threadId,
      projectId: ProjectId.make("project-b"),
      expectedProjectId: ProjectId.make("project-a"),
    },
  });
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
});

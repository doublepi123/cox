import {
  EnvironmentId,
  SourceControlProviderKind,
  ThreadId,
  type VcsStatusResult,
} from "@t3tools/contracts";
import type { RunVcsStackedActionInput } from "@t3tools/client-runtime/state/vcs";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import * as Option from "effect/Option";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../test/render";
import { GitActionsControl } from "./GitActionsControl";

const commit = vi.hoisted(() => ({
  status: undefined as VcsStatusResult | undefined,
  run: vi.fn(),
}));

vi.mock("../state/session", async (original) => ({
  ...(await original<typeof import("../state/session")>()),
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
}));

vi.mock("../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: {
      ...commit.status,
      versionControlSystems: [],
      sourceControlProviders: [
        {
          kind: SourceControlProviderKind.make("github"),
          label: "GitHub",
          status: "available",
          version: Option.none(),
          installHint: "Install gh",
          detail: Option.none(),
          auth: {
            status: "authenticated",
            account: Option.none(),
            host: Option.none(),
            detail: Option.none(),
          },
        },
      ],
    },
  }),
}));

vi.mock("../state/sourceControlActions", () => ({
  useGitStackedAction: () => ({ run: commit.run }),
  useSourceControlActionRunning: vi.fn(),
  useVcsInitAction: vi.fn(),
  useVcsPullAction: vi.fn(),
  useSourceControlPublishRepositoryAction: () => ({
    isAllowed: true,
    isPending: false,
    run: vi.fn(),
  }),
}));

function setup() {
  commit.status = undefined;
  commit.run.mockReset();
  commit.run.mockReturnValue(new Promise(() => {}));
}

it("keeps edits to a retry selection when branch status arrives after the failure", async () => {
  setup();
  const status: VcsStatusResult = {
    isRepo: true,
    hasPrimaryRemote: false,
    isDefaultRef: true,
    refName: "main",
    hasWorkingTreeChanges: true,
    workingTree: {
      files: ["include.txt", "later.txt", "also-later.txt"].map((path) => ({
        path,
        insertions: 1,
        deletions: 0,
      })),
      insertions: 3,
      deletions: 0,
    },
    hasUpstream: false,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
  } as VcsStatusResult;
  commit.status = status;
  commit.run.mockImplementation(async ({ actionId, onProgress }: RunVcsStackedActionInput) => {
    onProgress?.({
      actionId,
      cwd: "/repo",
      action: "commit",
      kind: "action_failed",
      phase: "commit",
      message: "Commit rejected",
      createdBranch: "feature/retry",
    });
    return AsyncResult.failure(Cause.fail(new Error("Commit rejected")));
  });
  const ui = () => (
    <GitActionsControl
      threadRef={{ environmentId: EnvironmentId.make("test"), threadId: ThreadId.make("test") }}
      target={{ key: "repo", cwd: "/repo", name: "Repo" }}
      showChanges={false}
    />
  );
  await using screen = await render(ui());
  const openCommit = async () => {
    await userEvent.click(screen.getByRole("button", { name: "Git action options" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Commit", exact: true }));
    await userEvent.click(screen.getByRole("button", { name: "Edit", exact: true }));
  };
  // The dialog lists one unlabeled checkbox per changed file, in the status order.
  const fileCheckbox = (index: number) => screen.getByRole("checkbox").nth(index);
  await openCommit();
  await userEvent.click(fileCheckbox(1));
  await act(() => {
    screen
      .getByRole("button", { name: "Commit on new branch", exact: true })
      .element()
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(commit.run).toHaveBeenCalledOnce();

  await openCommit();
  await userEvent.click(fileCheckbox(2));
  commit.status = { ...status, refName: "feature/retry", isDefaultRef: false } as VcsStatusResult;
  await screen.rerender(ui());

  await expect.element(fileCheckbox(1)).not.toBeChecked();
  await expect.element(fileCheckbox(2)).not.toBeChecked();
});

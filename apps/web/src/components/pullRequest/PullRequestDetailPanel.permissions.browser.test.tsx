import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  EnvironmentId,
  ProjectId,
  SourceControlProviderKind,
  type PullRequestDetailView,
} from "@t3tools/contracts";
import { page } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";
import appCss from "~/index.css?inline";
import { createWorkspaceFocusController, workspaceAreaProps } from "~/lib/workspaceFocus";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { act, fakeTimers, render } from "../../../test/render";

const { command, permissions, shown } = vi.hoisted(() => ({
  command: vi.fn(),
  shown: { detail: null as PullRequestDetailView | null },
  permissions: { checkout: true, operate: true },
}));

vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: (_environmentId: unknown, scope: unknown) =>
    scope === AuthOrchestrationOperateScope ? permissions.operate : permissions.checkout,
  readEnvironmentScope: (_environmentId: unknown, scope: unknown) =>
    scope === AuthOrchestrationOperateScope ? permissions.operate : permissions.checkout,
}));
vi.mock(import("~/state/sourceControlActions"), async (original) => ({
  ...(await original()),
  usePreparePullRequestThreadAction: (() => ({
    isAllowed: permissions.checkout,
    run: vi.fn(),
    error: null,
  })) as never,
}));
vi.mock(import("./usePullRequestDetail"), async (original) => ({
  ...(await original()),
  usePullRequestDetail: (() => ({
    canWriteSourceControl: permissions.checkout,
    detailQuery: { isPending: false, refresh: vi.fn() },
    activityQuery: { isPending: false, refresh: vi.fn(), error: null },
    activity: null,
    sharedSummary: shown.detail ?? detail,
    coreDetail: shown.detail ?? detail,
    detail: shown.detail ?? detail,
  })) as never,
}));
vi.mock(import("~/state/usePullRequestStack"), async (original) => ({
  ...(await original()),
  usePullRequestStack: (() => ({
    data: null,
    isFresh: true,
    isPending: false,
    error: null,
    refresh: vi.fn(),
  })) as never,
}));
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => command) as never,
}));

import { PullRequestDetailPanel } from "./PullRequestDetailPanel";

const detail: PullRequestDetailView = {
  provider: SourceControlProviderKind.make("github"),
  projectId: ProjectId.make("project"),
  projectTitle: "Project",
  workspaceRoot: "/workspace",
  repository: "owner/repo",
  number: 1,
  title: "Test pull request",
  body: "Original description",
  url: "https://github.com/owner/repo/pull/1",
  author: { login: "author", name: null, avatarUrl: null },
  viewer: "author",
  state: "open",
  isDraft: false,
  mergeability: "conflicting",
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  headBranch: "feature",
  baseBranch: "main",
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
  mergedAt: null,
  closedAt: null,
  reviewers: [],
  labels: [],
  checks: [{ name: "Unit tests", status: "success", description: null, url: null }],
  comments: [],
  commentCount: 0,
  commentsTruncated: false,
  reviewThreads: [],
  commits: [],
  mergeCapabilities: { merge: false, squash: false, rebase: false },
  capabilities: {
    diff: true,
    comment: false,
    search: true,
    actions: [],
    mergeMethods: [],
    review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
    reviewers: { request: false, listCandidates: false },
    edit: { changeRequest: true, comment: false },
  },
  viewerPermissions: {
    actions: [],
    comment: false,
    resolve: false,
    verdicts: [],
    requestReviewers: false,
  },
};

const environmentId = EnvironmentId.make("environment");
const draftId = DraftId.make("conflicts-draft");
const panel = (attach = false) => (
  <PullRequestDetailPanel
    environmentId={environmentId}
    reference={detail}
    context="page"
    shortcutsEnabled={false}
    getShortcutContext={() => ({
      terminalFocus: false,
      terminalOpen: false,
      previewFocus: false,
      previewOpen: false,
      isWeb: true,
      isDesktop: false,
    })}
    {...(attach ? { composerDraftTarget: draftId } : {})}
  />
);

function setup() {
  permissions.checkout = true;
  permissions.operate = true;
  shown.detail = null;
  command.mockReset();
  useComposerDraftStore.setState({ draftsByThreadKey: {} });
}

it.each([AuthSourceControlWriteScope, AuthOrchestrationOperateScope])(
  "disables conflict checkout when the connection loses %s",
  async (scope) => {
    setup();
    await using screen = await render(panel());
    const resolve = screen.getByRole("button", { name: "Resolve conflicts" });
    await expect.element(resolve).toBeEnabled();
    if (scope === AuthSourceControlWriteScope) permissions.checkout = false;
    else permissions.operate = false;
    await screen.rerender(panel());
    await expect.element(resolve).toBeDisabled();
  },
);

it("can still add conflict resolution to an existing composer without checkout scopes", async () => {
  setup();
  permissions.checkout = false;
  permissions.operate = false;
  await using screen = await render(panel(true));
  const resolve = screen.getByRole("button", { name: "Resolve conflicts" });
  await expect.element(resolve).toBeEnabled();
  await act(() => resolve.click());
  const draft = useComposerDraftStore.getState().getComposerDraft(draftId);
  expect(draft?.prompt).toContain("conflicts");
  expect(draft?.prompt).toContain(detail.url);
});

it("sends the commit displayed in the merge request", async () => {
  setup();
  command.mockResolvedValue({ _tag: "Success", value: undefined });
  shown.detail = {
    ...detail,
    headSha: "shown-head",
    mergeability: "mergeable",
    mergeCapabilities: { merge: false, squash: true, rebase: false },
    capabilities: { ...detail.capabilities, actions: ["merge"], mergeMethods: ["squash"] },
    viewerPermissions: { ...detail.viewerPermissions!, actions: ["merge"] },
  };
  await using screen = await render(panel());
  await screen.getByRole("button", { name: "Squash and merge" }).click();
  await screen.getByRole("button", { name: "Confirm merge?" }).click();
  await vi.waitFor(() =>
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ action: "merge", expectedHeadSha: "shown-head" }),
      }),
    ),
  );
});

it("keeps a merge and a review on the head the reader was shown until they load new commits", async () => {
  setup();
  command.mockResolvedValue({ _tag: "Success", value: undefined });
  const at = (headSha: string): PullRequestDetailView => ({
    ...detail,
    headSha,
    mergeability: "mergeable",
    mergeCapabilities: { merge: false, squash: true, rebase: false },
    capabilities: {
      ...detail.capabilities,
      actions: ["merge"],
      mergeMethods: ["squash"],
      review: { ...detail.capabilities.review, verdicts: ["approve"] },
    },
    viewerPermissions: { ...detail.viewerPermissions, actions: ["merge"], verdicts: ["approve"] },
  });
  const sent = (key: "action" | "verdict") =>
    command.mock.calls.flatMap(([call]) =>
      call?.input?.[key] === undefined ? [] : [call.input.expectedHeadSha],
    );
  const merge = async () => {
    await screen.getByRole("button", { name: "Squash and merge" }).click();
    await screen.getByRole("button", { name: "Confirm merge?" }).click();
  };
  shown.detail = at("shown-head");
  await using screen = await render(panel());
  await expect.element(screen.getByRole("button", { name: "Squash and merge" })).toBeVisible();
  // A background refresh brings a push the reader has not looked at.
  shown.detail = at("pushed-head");
  await screen.rerender(panel());
  await expect.element(screen.getByText(/still applies to shown-h/)).toBeVisible();
  await merge();
  await screen.getByRole("button", { name: "Review pull request" }).click();
  // The composer popup is portalled outside the rendered tree.
  await page.getByRole("button", { name: "Submit review" }).click();
  await vi.waitFor(() => expect(sent("verdict")).toEqual(["shown-head"]));
  expect(sent("action")).toEqual(["shown-head"]);

  await screen.getByRole("button", { name: "Load new commits" }).click();
  await merge();
  await vi.waitFor(() => expect(sent("action")).toEqual(["shown-head", "pushed-head"]));
});

it("keeps a screen reader's place when scrolling the description condenses the header", async () => {
  setup();
  shown.detail = {
    ...detail,
    body: Array.from({ length: 80 }, (_, line) => `Line ${line}`).join("\n\n"),
  };
  const style = document.createElement("style");
  style.textContent = appCss;
  document.head.append(style);
  using _style = { [Symbol.dispose]: () => style.remove() };
  using _shown = {
    [Symbol.dispose]: () => {
      shown.detail = null;
    },
  };
  const controller = createWorkspaceFocusController(document);
  using _controller = { [Symbol.dispose]: () => controller.dispose() };
  await using screen = await render(
    <div {...workspaceAreaProps("pull-requests", 1)} className="flex h-[600px] flex-col">
      {panel()}
    </div>,
  );
  const openOnHost = screen.getByRole("button", { name: "Open pull request #1 on host" });
  await expect.element(openOnHost).toBeVisible();
  const expanded = openOnHost.element() as HTMLButtonElement;
  expanded.focus();
  await expect.element(screen.getByText("Line 79")).toBeInTheDocument();
  let scroller = screen.getByText("Line 79").element().parentElement;
  while (scroller && getComputedStyle(scroller).overflowY !== "auto") {
    scroller = scroller.parentElement;
  }
  using _timers = fakeTimers();
  using moves = vi.spyOn(HTMLElement.prototype, "focus");
  // Browse mode scrolls a heading into view without moving DOM focus.
  await act(() => {
    scroller!.scrollTop = scroller!.scrollHeight;
  });
  await vi.waitFor(() => expect(expanded.closest("[inert]")).not.toBeNull());
  await act(() => vi.advanceTimersToNextFrame());
  // A programmatic focus() pulls the screen reader's browse cursor back to the header.
  expect(moves).not.toHaveBeenCalled();
});

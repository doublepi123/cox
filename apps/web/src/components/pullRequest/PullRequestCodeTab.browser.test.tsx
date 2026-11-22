import { WorkerPoolManager } from "@pierre/diffs/worker";
import { createWorkspaceFocusController, workspaceAreaProps } from "~/lib/workspaceFocus";
import {
  EnvironmentId,
  ProjectId,
  SourceControlProviderKind,
  type PullRequestDetailView,
  type PullRequestDiffResult,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import "~/index.css";

const { diffAtom, pagedDiffAtom, orderDiffAtom } = await vi.hoisted(async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const filePatch = (path: string) =>
    [
      `diff --git a/${path} b/${path}`,
      "index 1111111..2222222 100644",
      `--- a/${path}`,
      `+++ b/${path}`,
      "@@ -1,6 +1,6 @@",
      "-before()",
      "+after()",
      " one()",
      " two()",
      " three()",
      " four()",
      " five()",
      "",
    ].join("\n");
  const firstPage: PullRequestDiffResult = {
    patch: filePatch("a.ts"),
    truncated: false,
    nextCursor: null,
  };
  const pages: Record<string, PullRequestDiffResult> = {
    first: {
      patch: Array.from({ length: 40 }, (_, index) => filePatch(`early-${index}.ts`)).join(""),
      truncated: true,
      nextCursor: "page-2",
    },
    "page-2": { patch: filePatch("late.ts"), truncated: false, nextCursor: null },
  };
  return {
    // An environment query whose refetch returns equal content hands back the previous value
    // itself, so a refresh publishes a new result around the very same page.
    diffAtom: Atom.make(() => AsyncResult.success(firstPage)),
    orderDiffAtom: Atom.make(() =>
      AsyncResult.success({
        patch: [
          "src/c.browser.test.tsx",
          "src/b.test.ts",
          "src/a.logic.test.ts",
          "src/c.tsx",
          "src/b.ts",
          "src/a.logic.ts",
        ]
          .map(filePatch)
          .join(""),
        truncated: false,
        nextCursor: null,
      }),
    ),
    pagedDiffAtom: Atom.family((cursor: string) =>
      Atom.make(() => AsyncResult.success(pages[cursor]!)),
    ),
  };
});

const mocks = vi.hoisted(() => ({
  paged: false,
  orderFixture: false,
  diffCommits: [] as Array<string | undefined>,
}));

vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => vi.fn()) as never,
}));
vi.mock(import("~/state/pullRequests"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    pullRequestEnvironment: {
      ...actual.pullRequestEnvironment,
      diff: (({ input }: { input: { cursor?: string; commit?: string } }) => {
        mocks.diffCommits.push(input.commit);
        return mocks.orderFixture
          ? orderDiffAtom
          : mocks.paged
            ? pagedDiffAtom(input.cursor ?? "first")
            : diffAtom;
      }) as never,
    },
  };
});

import { render } from "../../../test/render";
import PullRequestCodeTab from "./PullRequestCodeTab";

const detail: PullRequestDetailView = {
  provider: SourceControlProviderKind.make("github"),
  projectId: ProjectId.make("project"),
  projectTitle: "Project",
  workspaceRoot: "/workspace",
  repository: "owner/repo",
  number: 1,
  title: "Test pull request",
  body: "",
  url: "https://github.com/owner/repo/pull/1",
  author: { login: "author", name: null, avatarUrl: null },
  viewer: "author",
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  additions: 1,
  deletions: 1,
  changedFiles: 1,
  headBranch: "feature",
  baseBranch: "main",
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
  mergedAt: null,
  closedAt: null,
  reviewers: [],
  labels: [],
  checks: [],
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
    edit: { changeRequest: false, comment: false },
  },
  viewerPermissions: {
    actions: [],
    comment: false,
    resolve: false,
    verdicts: [],
    requestReviewers: false,
  },
};

function setup({ paged }: { paged: boolean }) {
  mocks.paged = paged;
  mocks.diffCommits = [];
}

const tab = (
  refreshToken: number,
  revealRequest: { readonly path: string; readonly nonce: number } | null = null,
) => (
  <PullRequestCodeTab
    scrollerRef={() => {}}
    environmentId={EnvironmentId.make("environment")}
    reference={detail}
    detail={detail}
    selectedCommitOid={null}
    onSelectedCommitChange={() => {}}
    onRefresh={() => {}}
    refreshToken={refreshToken}
    revealRequest={revealRequest}
  />
);

it("keeps tests in source order when a source basename contains a dot", async () => {
  setup({ paged: false });
  mocks.orderFixture = true;
  using _restore = {
    [Symbol.dispose]: () => {
      mocks.orderFixture = false;
    },
  };
  const container = document.createElement("div");
  container.className = "flex h-[700px] w-[900px]";
  await using screen = await render(tab(0), { container });
  await screen.getByRole("button", { name: "Show file tree" }).click();
  try {
    await vi.waitFor(() => {
      const tree = container.querySelector('[aria-label="Pull request #1 files"]');
      const paths = Array.from(
        tree?.shadowRoot?.querySelectorAll("[data-item-path]") ?? [],
        (row) => row.getAttribute("data-item-path"),
      ).filter((path) => path?.includes(".test."));
      expect(paths).toEqual(["src/a.logic.test.ts", "src/b.test.ts", "src/c.browser.test.tsx"]);
    });
  } finally {
    await screen.getByRole("button", { name: "Hide file tree" }).click();
  }
});

it("keeps the diff after a refresh that brings back the same page", async () => {
  setup({ paged: false });
  const container = document.createElement("div");
  container.className = "flex h-[700px] w-[900px]";
  await using screen = await render(tab(0), { container });
  await expect.element(screen.getByText("1 file", { exact: true })).toBeVisible();

  await screen.rerender(tab(1));

  await expect
    .element(screen.getByText("This pull request has no file changes."))
    .not.toBeInTheDocument();
  await expect.element(screen.getByText("1 file", { exact: true })).toBeVisible();
});

function pagedContainer() {
  const container = document.createElement("div");
  container.className = "flex h-[500px] w-[900px]";
  return container;
}

// Rows are virtualized, so a header far down is not rendered until the view scrolls to it.
async function expectFileHeaderShown(
  screen: Awaited<ReturnType<typeof render>>,
  container: HTMLElement,
  path: string,
) {
  const header = screen.getByText(path, { exact: true }).first();
  await expect.element(header).toBeInTheDocument();
  await vi.waitFor(() => {
    const top = header.element().getBoundingClientRect().top;
    const bounds = container.getBoundingClientRect();
    expect(top).toBeGreaterThanOrEqual(bounds.top);
    expect(top).toBeLessThan(bounds.top + bounds.height / 2);
  });
}

it("scrolls to a file asked for as the tab opens", async () => {
  setup({ paged: true });
  const container = pagedContainer();
  await using screen = await render(tab(0, { path: "early-39.ts", nonce: 1 }), { container });

  await expectFileHeaderShown(screen, container, "early-39.ts");
});

it("pages forward to a file asked for that is not loaded yet, then scrolls to it", async () => {
  setup({ paged: true });
  const container = pagedContainer();
  await using screen = await render(tab(0), { container });
  await expect.element(screen.getByText("early-0.ts", { exact: true }).first()).toBeVisible();

  await screen.rerender(tab(0, { path: "late.ts", nonce: 1 }));

  await expectFileHeaderShown(screen, container, "late.ts");
});

it("never requests the diff of a selected commit the pull request no longer has", async () => {
  setup({ paged: false });
  const container = document.createElement("div");
  container.className = "flex h-[700px] w-[900px]";
  // The timeline can open a commit that a force-push removed from the pull request.
  await using screen = await render(
    <PullRequestCodeTab
      scrollerRef={() => {}}
      environmentId={EnvironmentId.make("environment")}
      reference={detail}
      detail={{
        ...detail,
        commits: [
          {
            oid: "kept",
            messageHeadline: "Kept commit",
            committedDate: "2026-09-01T00:00:00Z",
          },
        ],
      }}
      selectedCommitOid="gone"
      onSelectedCommitChange={() => {}}
      onRefresh={() => {}}
    />,
    { container },
  );

  await expect.element(screen.getByText("1 file", { exact: true })).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Diff scope: All commits" }))
    .toBeVisible();
  expect(mocks.diffCommits).not.toContain("gone");
});

it("hands panel focus from the loading diff to the diff once the diff workers start", async () => {
  setup({ paged: false });
  let ready = false;
  let start = () => {};
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  using isInitialized = vi
    .spyOn(WorkerPoolManager.prototype, "isInitialized")
    .mockImplementation(() => ready);
  using initialize = vi.spyOn(WorkerPoolManager.prototype, "initialize").mockReturnValue(started);
  const container = document.createElement("div");
  container.className = "flex h-[700px] w-[900px]";
  // A conversation off the diff puts a panel where the loading body was, which could reuse its node.
  const withOrphan: PullRequestDetailView = {
    ...detail,
    reviewThreads: [
      {
        id: "thread",
        path: "gone.ts",
        line: 1,
        side: "right",
        isResolved: false,
        isOutdated: false,
        comments: [
          {
            id: "comment",
            author: { login: "reviewer", name: null, avatarUrl: null },
            body: "Rename this.",
            createdAt: "2026-09-01T00:00:00Z",
            url: null,
          },
        ],
      },
    ],
  };
  await using screen = await render(
    <div {...workspaceAreaProps("panel", 4, "Workspace panel")} className="flex flex-1">
      <PullRequestCodeTab
        scrollerRef={() => {}}
        environmentId={EnvironmentId.make("environment")}
        reference={detail}
        detail={withOrphan}
        selectedCommitOid={null}
        onSelectedCommitChange={() => {}}
        onRefresh={() => {}}
      />
    </div>,
    { container },
  );
  const focus = createWorkspaceFocusController(document);
  using _focus = { [Symbol.dispose]: focus.dispose };
  await expect.element(screen.getByText("Loading pull request diff...")).toBeVisible();
  expect(focus.focus("panel")).toBe(true);

  ready = true;
  start();
  await vi.waitFor(() =>
    expect(document.activeElement).toBe(container.querySelector(".diff-render-surface")),
  );
});

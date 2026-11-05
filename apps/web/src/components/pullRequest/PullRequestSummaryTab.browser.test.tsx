import { SourceControlProviderKind } from "@t3tools/contracts";
import { EnvironmentId, ProjectId, type PullRequestDetailView } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({ update: vi.fn(), refresh: vi.fn(), canUpdate: true }));

vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.update) as never,
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
}));
vi.mock(import("~/state/pullRequests"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  const denied = Atom.make(false);
  return {
    ...actual,
    pullRequestEnvironment: {
      ...actual.pullRequestEnvironment,
      update: {
        ...actual.pullRequestEnvironment.update,
        permissionAtom: () => (state.canUpdate ? allowed : denied),
      },
    },
  };
});

function setup() {
  state.update.mockReset();
  state.update.mockResolvedValue({ _tag: "Success", value: undefined });
  state.canUpdate = true;
  state.refresh.mockReset();
}

import { act, render as renderUi } from "../../../test/render";
import { PullRequestSummaryTab } from "./PullRequestSummaryTab";
import { toastManager } from "../ui/toast";

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
  mergeability: "mergeable",
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
    comment: true,
    search: true,
    actions: [],
    mergeMethods: [],
    review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
    reviewers: { request: false, listCandidates: false },
    edit: { changeRequest: true, comment: true },
  },
  viewerPermissions: {
    actions: [],
    comment: true,
    resolve: false,
    verdicts: [],
    requestReviewers: false,
  },
};

// The comment filter persists to localStorage, so tests that touch it start and end empty.

const tab = (value = detail) => (
  <PullRequestSummaryTab
    scrollerRef={() => {}}
    environmentId={EnvironmentId.make("environment")}
    threadRef={null}
    reference={value}
    detail={value}
    activityPending={false}
    activityError={null}
    onRefresh={state.refresh}
  />
);

async function render(value = detail) {
  const screen = await renderUi(tab(value));
  const { container } = screen;
  const heading = (title: string) => {
    const section = container.querySelector(`section[aria-label="${title}"]`);
    expect(section, `section ${title}`).not.toBeNull();
    return [...section!.querySelectorAll("button")].find(
      (button) => button.querySelector("span")?.textContent === title,
    )!;
  };
  return Object.assign(screen, {
    click: (title: string) => act(async () => heading(title).click()),
    expanded: (title: string) => heading(title).getAttribute("aria-expanded"),
    visibleText: () => container.innerText,
  });
}

it("keeps an unsaved description when collapsed and reopened, and after a failed save", async () => {
  setup();
  state.update.mockResolvedValue({ _tag: "Failure", cause: new Error("offline") });
  await using screen = await render();
  await act(async () =>
    screen.container.querySelector<HTMLButtonElement>('[aria-label="Edit description"]')!.click(),
  );
  const textarea = screen.container.querySelector("textarea")!;
  await userEvent.clear(textarea);
  await userEvent.type(textarea, "Unsaved description");
  await screen.click("Description");
  expect(screen.expanded("Description")).toBe("false");
  await screen.click("Description");
  expect(screen.container.querySelector("textarea")!.value).toBe("Unsaved description");

  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(state.update).toHaveBeenCalledTimes(1);
  await expect.element(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  expect(screen.container.querySelector("textarea")!.value).toBe("Unsaved description");
});

it("ticks a description checkbox placed after an attachment and edits from the ticked body", async () => {
  setup();
  let finishSave = (_result: unknown) => {};
  state.update.mockReturnValueOnce(new Promise((resolve) => (finishSave = resolve)));
  const body = "Intro\n\nhttps://example.com/shot.png\n\n## Test plan\n- [ ] First\n- [ ] Second";
  const ticked = body.replace("- [ ] Second", "- [x] Second");
  await using screen = await render({ ...detail, body, observedAt: 1 });
  const boxes = () => screen.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  expect([...boxes()].map((box) => box.disabled)).toEqual([false, false]);

  await userEvent.click(boxes()[1]!);
  expect(state.update).toHaveBeenCalledWith({
    environmentId: "environment",
    input: expect.objectContaining({ number: 1, body: ticked }),
  });
  expect([...boxes()].map((box) => box.checked)).toEqual([false, true]);
  await act(async () => finishSave({ _tag: "Success", value: undefined }));

  await act(async () =>
    screen.container.querySelector<HTMLButtonElement>('[aria-label="Edit description"]')!.click(),
  );
  expect(screen.container.querySelector("textarea")!.value).toBe(ticked);
});

it("leaves description checkboxes read-only without the right to edit it", async () => {
  setup();
  const body = "- [ ] First";
  {
    await using screen = await render({ ...detail, body, viewer: "someone-else" });
    expect(
      screen.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled,
    ).toBe(true);
  }
  state.canUpdate = false;
  await using screen = await render({ ...detail, body });
  expect(screen.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled).toBe(
    true,
  );
  expect(state.update).not.toHaveBeenCalled();
});

it("rolls back a failed checkbox save, reports it, and refreshes the host", async () => {
  setup();
  state.update.mockResolvedValue({ _tag: "Failure", cause: new Error("offline") });
  using toast = vi.spyOn(toastManager, "add").mockImplementation(() => "save-error");
  await using screen = await render({ ...detail, body: "- [ ] Ship it", observedAt: 1 });
  const checkbox = screen.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  await userEvent.click(checkbox);
  await vi.waitFor(() => expect(checkbox.checked).toBe(false));
  expect(state.refresh).toHaveBeenCalledOnce();
  expect(toast).toHaveBeenCalledWith({ type: "error", title: "Could not save the description" });
});

it.each([true, false])(
  "keeps later checkbox changes when the first pending save succeeds=%s",
  async (firstSaved) => {
    setup();
    using _toast = vi.spyOn(toastManager, "add").mockImplementation(() => "save-error");
    let finishFirst = (_result: unknown) => {};
    let finishLast = (_result: unknown) => {};
    state.update
      .mockReturnValueOnce(new Promise((resolve) => (finishFirst = resolve)))
      .mockReturnValueOnce(new Promise((resolve) => (finishLast = resolve)));
    const body = "- [ ] First\n- [ ] Second";
    await using screen = await render({ ...detail, body, observedAt: 1 });
    const boxes = () =>
      screen.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    await userEvent.click(boxes()[0]!);
    await userEvent.click(boxes()[1]!);
    expect(state.update.mock.calls.map(([target]) => target.input.body)).toEqual([
      "- [x] First\n- [ ] Second",
      "- [x] First\n- [x] Second",
    ]);
    await act(async () => finishFirst({ _tag: firstSaved ? "Success" : "Failure" }));
    expect([...boxes()].map((box) => box.checked)).toEqual([true, true]);
    expect(state.refresh).not.toHaveBeenCalled();
    await act(async () => finishLast({ _tag: "Success", value: undefined }));
    expect([...boxes()].map((box) => box.checked)).toEqual([true, true]);
    expect(state.refresh).toHaveBeenCalledOnce();
  },
);

it("keeps the latest body after ticking and unticking the same pending checkbox", async () => {
  setup();
  let finishFirst = (_result: unknown) => {};
  let finishLast = (_result: unknown) => {};
  state.update
    .mockReturnValueOnce(new Promise((resolve) => (finishFirst = resolve)))
    .mockReturnValueOnce(new Promise((resolve) => (finishLast = resolve)));
  await using screen = await render({ ...detail, body: "- [ ] Ship it", observedAt: 1 });
  const box = screen.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  await userEvent.click(box);
  await userEvent.click(box);
  expect(state.update.mock.calls.map(([target]) => target.input.body)).toEqual([
    "- [x] Ship it",
    "- [ ] Ship it",
  ]);
  await act(async () => finishFirst({ _tag: "Success", value: undefined }));
  expect(box.checked).toBe(false);
  expect(state.refresh).not.toHaveBeenCalled();
  await act(async () => finishLast({ _tag: "Success", value: undefined }));
  expect(box.checked).toBe(false);
  expect(state.refresh).toHaveBeenCalledOnce();
});

it("writes the full body for a quoted task after a multi-line video", async () => {
  setup();
  const body =
    '\n\n## 𝄞\r\n\r\n<video controls>\r\n<source src="https://example.com/a.mp4">\r\n</video>\r\n\r\n> 1. [X] Ship it\r\n';
  await using screen = await render({ ...detail, body, observedAt: 1 });
  await userEvent.click(
    screen.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!,
  );
  expect(state.update).toHaveBeenCalledWith({
    environmentId: "environment",
    input: expect.objectContaining({ body: body.replace("[X]", "[ ]") }),
  });
});

it("ignores host readings during saves and accepts a reading after the last save", async () => {
  setup();
  let finishSave = (_result: unknown) => {};
  state.update.mockReturnValueOnce(new Promise((resolve) => (finishSave = resolve)));
  const value = { ...detail, body: "- [ ] Ship it", observedAt: 1 };
  await using screen = await render(value);
  const checkbox = () =>
    screen.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  await userEvent.click(checkbox());
  await screen.rerender(tab({ ...value, observedAt: 2 }));
  expect(checkbox().checked).toBe(true);
  await act(async () => finishSave({ _tag: "Success", value: undefined }));
  expect(checkbox().checked).toBe(true);
  await screen.rerender(tab({ ...value, observedAt: 3 }));
  expect(checkbox().checked).toBe(false);
});

it("preserves an editor opened during a checkbox save across failure and host refresh", async () => {
  setup();
  using _toast = vi.spyOn(toastManager, "add").mockImplementation(() => "save-error");
  let finishSave = (_result: unknown) => {};
  state.update.mockReturnValueOnce(new Promise((resolve) => (finishSave = resolve)));
  const value = { ...detail, body: "- [ ] Ship it", observedAt: 1 };
  await using screen = await render(value);
  await userEvent.click(
    screen.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!,
  );
  await act(async () =>
    screen.container.querySelector<HTMLButtonElement>('[aria-label="Edit description"]')!.click(),
  );
  expect(screen.container.querySelector("textarea")!.value).toBe("- [x] Ship it");
  expect(screen.container.querySelector("textarea")!.disabled).toBe(true);
  await act(async () => finishSave({ _tag: "Failure" }));
  await screen.rerender(tab({ ...value, observedAt: 2 }));
  const textarea = screen.container.querySelector("textarea")!;
  expect(textarea.disabled).toBe(false);
  expect(textarea.value).toBe("- [x] Ship it");
  await userEvent.clear(textarea);
  await userEvent.type(textarea, "Retry description");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await vi.waitFor(() => expect(screen.container.querySelector("textarea")).toBeNull());
  expect(screen.container.textContent).toContain("Retry description");
});

it("does not close another pull request's editor when a previous save completes", async () => {
  setup();
  let finishSave = (_result: unknown) => {};
  state.update.mockReturnValueOnce(new Promise((resolve) => (finishSave = resolve)));
  await using screen = await render({ ...detail, observedAt: 1 });
  const edit = () =>
    act(async () =>
      screen.container.querySelector<HTMLButtonElement>('[aria-label="Edit description"]')!.click(),
    );
  await edit();
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.rerender(
    tab({
      ...detail,
      url: "https://github.com/owner/repo/pull/2",
      number: 2,
      body: "Second description",
      observedAt: 1,
    }),
  );
  await edit();
  await act(async () => finishSave({ _tag: "Success", value: undefined }));
  expect(screen.container.querySelector("textarea")!.value).toBe("Second description");
});

it.each([1, undefined])(
  "retries failed tasks from confirmed prose before refresh observedAt=%s",
  async (observedAt) => {
    setup();
    using _toast = vi.spyOn(toastManager, "add").mockImplementation(() => "save-error");
    state.update
      .mockResolvedValueOnce({ _tag: "Success" })
      .mockResolvedValueOnce({ _tag: "Failure" });
    const original = "Original prose\n\n- [ ] Ship it";
    const confirmed = "Confirmed prose\n\n- [ ] Ship it";
    await using screen = await render({ ...detail, body: original, observedAt });
    await act(async () =>
      screen.container.querySelector<HTMLButtonElement>('[aria-label="Edit description"]')!.click(),
    );
    const textarea = screen.container.querySelector("textarea")!;
    await userEvent.clear(textarea);
    await userEvent.type(textarea, confirmed.replaceAll("[", "[["));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(screen.container.querySelector("textarea")).toBeNull());
    const checkbox = () =>
      screen.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await userEvent.click(checkbox());
    await vi.waitFor(() => expect(state.refresh).toHaveBeenCalledTimes(2));
    expect(checkbox().checked).toBe(false);
    expect(screen.container.textContent).toContain("Confirmed prose");
    await userEvent.click(checkbox());
    expect(state.update.mock.calls.map(([target]) => target.input.body)).toEqual([
      confirmed,
      confirmed.replace("[ ]", "[x]"),
      confirmed.replace("[ ]", "[x]"),
    ]);
  },
);

it.each([
  [true, true, false],
  [true, false, false],
  [false, true, false],
  [false, false, false],
  [true, true, true],
  [true, false, true],
  [false, true, true],
  [false, false, true],
])(
  "retries from the confirmed queued body first=%s last=%s reverse=%s",
  async (firstSaved, lastSaved, reverse) => {
    setup();
    using _toast = vi.spyOn(toastManager, "add").mockImplementation(() => "save-error");
    let finishFirst = (_result: unknown) => {};
    let finishLast = (_result: unknown) => {};
    state.update
      .mockReturnValueOnce(new Promise((resolve) => (finishFirst = resolve)))
      .mockReturnValueOnce(new Promise((resolve) => (finishLast = resolve)));
    const original = "- [ ] First\n- [ ] Second";
    const first = "- [x] First\n- [ ] Second";
    const last = "- [x] First\n- [x] Second";
    await using screen = await render({ ...detail, body: original, observedAt: 1 });
    const boxes = () =>
      screen.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    await userEvent.click(boxes()[0]!);
    await userEvent.click(boxes()[1]!);
    await act(async () =>
      (reverse ? finishLast : finishFirst)({
        _tag: (reverse ? lastSaved : firstSaved) ? "Success" : "Failure",
      }),
    );
    expect([...boxes()].map((box) => box.checked)).toEqual([true, !reverse || lastSaved]);
    expect(state.refresh).not.toHaveBeenCalled();
    await act(async () =>
      (reverse ? finishFirst : finishLast)({
        _tag: (reverse ? firstSaved : lastSaved) ? "Success" : "Failure",
      }),
    );
    expect([...boxes()].map((box) => box.checked)).toEqual([firstSaved || lastSaved, lastSaved]);
    expect(state.refresh).toHaveBeenCalledOnce();
    const confirmed = lastSaved ? last : firstSaved ? first : original;
    await userEvent.click(boxes()[1]!);
    expect(state.update.mock.lastCall![0].input.body).toBe(
      confirmed.replace(
        lastSaved ? "[x] Second" : "[ ] Second",
        lastSaved ? "[ ] Second" : "[x] Second",
      ),
    );
  },
);

it("does not settle a new draft or close its editor after returning to the same pull request", async () => {
  setup();
  let finishOld = (_result: unknown) => {};
  let finishCurrent = (_result: unknown) => {};
  state.update
    .mockReturnValueOnce(new Promise((resolve) => (finishOld = resolve)))
    .mockReturnValueOnce(new Promise((resolve) => (finishCurrent = resolve)));
  const value = { ...detail, body: "- [ ] Ship it", observedAt: 1 };
  await using screen = await render(value);
  const edit = () =>
    act(async () =>
      screen.container.querySelector<HTMLButtonElement>('[aria-label="Edit description"]')!.click(),
    );
  await edit();
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.rerender(tab({ ...value, url: "https://github.com/owner/repo/pull/2", number: 2 }));
  await edit();
  await screen.rerender(tab(value));
  await userEvent.click(
    screen.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!,
  );
  await edit();
  const textarea = screen.container.querySelector("textarea")!;
  expect(textarea.value).toBe("- [x] Ship it");
  await act(async () => finishOld({ _tag: "Success" }));
  expect(screen.container.querySelector("textarea")).toBe(textarea);
  expect(textarea.value).toBe("- [x] Ship it");
  expect(textarea.disabled).toBe(true);
  expect(state.refresh).not.toHaveBeenCalled();
  await act(async () => finishCurrent({ _tag: "Success" }));
  expect(screen.container.querySelector("textarea")).toBe(textarea);
  expect(textarea.disabled).toBe(false);
  expect(state.refresh).toHaveBeenCalledOnce();
});

it("ignores an earlier visit's save completion after returning to the same pull request", async () => {
  setup();
  let finishPrevious = (_result: unknown) => {};
  let finishCurrent = (_result: unknown) => {};
  state.update
    .mockReturnValueOnce(new Promise((resolve) => (finishPrevious = resolve)))
    .mockReturnValueOnce(new Promise((resolve) => (finishCurrent = resolve)));
  const value = { ...detail, body: "- [ ] First", observedAt: 1 };
  await using screen = await render(value);
  const edit = () =>
    act(async () =>
      screen.container.querySelector<HTMLButtonElement>('[aria-label="Edit description"]')!.click(),
    );
  await edit();
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.rerender(tab({ ...detail, url: "https://github.com/owner/repo/pull/2", number: 2 }));
  await edit();
  await screen.rerender(tab(value));
  await edit();
  const textarea = screen.container.querySelector("textarea")!;
  await userEvent.clear(textarea);
  await userEvent.type(textarea, "New visit\n\n- [[ ] First");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await act(async () => finishPrevious({ _tag: "Success", value: undefined }));
  expect(screen.container.querySelector("textarea")!.value).toBe("New visit\n\n- [ ] First");
  expect(screen.container.querySelector("textarea")!.disabled).toBe(true);
  await act(async () => finishCurrent({ _tag: "Success", value: undefined }));
  expect(screen.container.querySelector("textarea")).toBeNull();
  expect(screen.container.textContent).toContain("New visit");
});

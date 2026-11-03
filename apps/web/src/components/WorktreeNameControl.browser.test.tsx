import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { act, render } from "../../test/render";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { setLanguagePreference } from "../i18n";
import { WorktreeNameControl } from "./WorktreeNameControl";
import "~/index.css";

const draftId = DraftId.make("worktree-name-test");
function setup() {
  const initialState = useComposerDraftStore.getState();
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(
      scopeProjectRef(EnvironmentId.make("local-test"), ProjectId.make("project-test")),
      draftId,
      { threadId: ThreadId.make("thread-test"), envMode: "worktree" },
    );
  return {
    [Symbol.dispose]() {
      useComposerDraftStore.setState(initialState, true);
      setLanguagePreference("system");
    },
  };
}
describe("worktree naming control", () => {
  it("shows translated naming instructions and stores or clears an explicit name", async () => {
    using _setup = setup();
    setLanguagePreference("zh");
    await using screen = await render(<WorktreeNameControl target={draftId} />);
    await expect
      .element(screen.getByRole("button", { name: "工作树名称", exact: true }))
      .toHaveTextContent("自动命名");
    await screen.getByRole("button", { name: "工作树名称", exact: true }).click();
    await screen.getByLabelText("工作树名称（可选）", { exact: true }).fill("feat/my worktree");
    expect(useComposerDraftStore.getState().getDraftSession(draftId)?.worktreeName).toBe(
      "feat/my worktree",
    );
    await expect
      .element(screen.getByText("分支名称：feat/my-worktree", { exact: true }))
      .toBeVisible();
    await screen.getByLabelText("工作树名称（可选）", { exact: true }).fill("");
    expect(useComposerDraftStore.getState().getDraftSession(draftId)?.worktreeName).toBe("");
    await expect
      .element(
        screen.getByText(
          "留空时，Cox 会根据首条消息推荐名称，再创建工作树；生成失败则使用随机名称。",
          { exact: true },
        ),
      )
      .toBeVisible();
  });
  it("keeps Enter available to an IME while editing a worktree name", async () => {
    using _setup = setup();
    setLanguagePreference("en");
    await using screen = await render(<WorktreeNameControl target={draftId} multiple />);
    await screen.getByRole("button", { name: "Worktree name", exact: true }).click();
    const field = screen.getByLabelText("Worktree name (optional)", { exact: true });
    await field.fill("feature");
    await act(async () => {
      field.element().dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          keyCode: 229,
          isComposing: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await expect.element(field).toBeVisible();
    await expect
      .element(
        screen.getByText("Each model gets a unique suffix when a name is specified.", {
          exact: true,
        }),
      )
      .toBeVisible();
  });
});

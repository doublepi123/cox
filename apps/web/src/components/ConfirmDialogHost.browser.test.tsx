import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { act, render } from "../../test/render";
import { requestConfirmDialog, resetConfirmDialogForTests } from "../confirmDialog";
import { setLanguagePreference, translate } from "../i18n";
import { ConfirmDialogHost } from "./ConfirmDialogHost";
import { NoActiveThreadState } from "./NoActiveThreadState";
import "../index.css";

function testLanguage(language: "en" | "zh") {
  setLanguagePreference(language);
  return {
    [Symbol.dispose]() {
      resetConfirmDialogForTests();
      setLanguagePreference("system");
    },
  };
}

it("localizes destructive confirmation and preserves the thread title verbatim", async () => {
  using _language = testLanguage("zh");
  await using _screen = await render(<ConfirmDialogHost />, { router: false });
  const title = "New thread · Settings · <script>";
  let confirmation: Promise<boolean> | undefined;
  await act(() => {
    confirmation = requestConfirmDialog(
      [
        translate("zh", 'Delete thread "{title}"?', { title }),
        translate("zh", "This permanently clears conversation history for this thread."),
      ].join("\n"),
      { variant: "destructive" },
    );
  });
  await expect
    .element(page.getByRole("heading", { name: `确定删除对话“${title}”？`, exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByText("这会永久清除此对话的聊天记录。", { exact: true }))
    .toBeVisible();
  await expect.element(page.getByRole("button", { name: "确认", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  expect(await confirmation).toBe(false);
});

it("switches shared confirmation buttons without changing caller-owned content", async () => {
  using _language = testLanguage("en");
  await using _screen = await render(<ConfirmDialogHost />, { router: false });
  await act(() => {
    requestConfirmDialog("User supplied prompt without a question mark");
  });
  await expect.element(page.getByRole("heading", { name: "Confirm action" })).toBeVisible();
  await act(() => {
    setLanguagePreference("zh");
  });
  await expect.element(page.getByRole("heading", { name: "确认操作" })).toBeVisible();
  await expect
    .element(page.getByText("User supplied prompt without a question mark", { exact: true }))
    .toBeVisible();
  await expect.element(page.getByRole("button", { name: "确认", exact: true })).toBeVisible();
});

it("updates empty-thread navigation copy when the language changes", async () => {
  using _language = testLanguage("en");
  await using screen = await render(<NoActiveThreadState />, { router: false });
  await expect.element(screen.getByText("No active thread", { exact: true })).toBeVisible();
  await act(() => {
    setLanguagePreference("zh");
  });
  await expect.element(screen.getByText("没有打开的对话", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("选择一个对话继续", { exact: true })).toBeVisible();
});

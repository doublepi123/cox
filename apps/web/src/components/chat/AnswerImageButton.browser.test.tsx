import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { setLanguagePreference } from "../../i18n";
import * as imageExport from "./answerImage";
import { AnswerImageButton } from "./AnswerImageButton";

vi.mock(import("./answerImage"), { spy: true });

const source = {
  messageId: "answer-123",
  text: "Only this answer.\n\n**Keep raw content unchanged.**",
  timestamp: "November 6, 2026",
  cwd: undefined,
};

async function png(height = 2): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = 2;
  canvas.height = height;
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob!)));
}

function navigatorProperty(key: string, value: unknown): Disposable {
  const previous = Object.getOwnPropertyDescriptor(navigator, key);
  Object.defineProperty(navigator, key, { configurable: true, value });
  return {
    [Symbol.dispose]() {
      if (previous) Object.defineProperty(navigator, key, previous);
      else Reflect.deleteProperty(navigator, key);
    },
  };
}

describe("response image actions", () => {
  it("previews only the selected answer, preserves its snapshot, and saves or copies its PNG", async () => {
    using _render = vi.spyOn(imageExport, "renderAnswerImage").mockResolvedValue(await png());
    using write = vi.spyOn(navigator.clipboard, "write").mockResolvedValue();
    using save = vi.spyOn(imageExport, "saveAnswerImage").mockImplementation(() => {});
    using revoke = vi.spyOn(URL, "revokeObjectURL");
    await using screen = await render(<AnswerImageButton {...source} />);
    await screen.getByRole("button", { name: "Export response as image" }).click();
    await expect.element(page.getByRole("img", { name: "Response image preview" })).toBeVisible();
    const card = document.querySelector(".answer-image-card")!;
    expect(card.textContent).toContain("Only this answer.");
    expect(card.textContent).not.toContain("Export response as image");
    const url = page
      .getByRole("img", { name: "Response image preview" })
      .element()
      .getAttribute("src")!;

    await screen.rerender(<AnswerImageButton {...source} text="A different response arrived." />);
    expect(card.textContent).not.toContain("A different response arrived.");
    await page.getByRole("button", { name: "Copy image", exact: true }).click();
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
    const item = write.mock.calls[0]![0][0]!;
    expect(item.types).toEqual(["image/png"]);
    expect((await item.getType("image/png")).size).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Save PNG" }).click();
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ name: "cox-response-answer-123.png", type: "image/png" }),
      "cox-response-answer-123.png",
    );
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await vi.waitFor(() => expect(revoke).toHaveBeenCalledWith(url));
    expect(document.querySelector(".answer-image-staging")).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Export response as image" }).element(),
    );
  });

  it("offers retry after generation fails and keeps saving available after clipboard denial", async () => {
    using generate = vi
      .spyOn(imageExport, "renderAnswerImage")
      .mockRejectedValueOnce(new Error("A resource could not load"))
      .mockResolvedValue(await png());
    using _write = vi
      .spyOn(navigator.clipboard, "write")
      .mockRejectedValue(new DOMException("Denied", "NotAllowedError"));
    await using screen = await render(<AnswerImageButton {...source} />);
    await screen.getByRole("button", { name: "Export response as image" }).click();
    await vi.waitFor(() =>
      expect(page.getByRole("alert").element().textContent).toContain("A resource could not load"),
    );
    await page.getByRole("button", { name: "Regenerate image" }).click();
    await expect.element(page.getByRole("img", { name: "Response image preview" })).toBeVisible();
    expect(generate).toHaveBeenCalledTimes(2);
    await page.getByRole("button", { name: "Copy image", exact: true }).click();
    await vi.waitFor(() =>
      expect(page.getByRole("alert").element().textContent).toContain("Save the PNG instead."),
    );
    await expect.element(page.getByRole("button", { name: "Save PNG" })).toBeEnabled();
    await expect
      .element(page.getByRole("button", { name: "Copy image", exact: true }))
      .toBeEnabled();
  });

  it("uses native file sharing when supported and treats cancellation as a normal dismissal", async () => {
    using _render = vi.spyOn(imageExport, "renderAnswerImage").mockResolvedValue(await png());
    const share = vi.fn().mockRejectedValue(new DOMException("Cancelled", "AbortError"));
    const canShare = vi.fn().mockReturnValue(true);
    using _share = navigatorProperty("share", share);
    using _canShare = navigatorProperty("canShare", canShare);
    await using screen = await render(<AnswerImageButton {...source} />);
    await screen.getByRole("button", { name: "Export response as image" }).click();
    await page.getByRole("button", { name: "Share image" }).click();
    await vi.waitFor(() => expect(share).toHaveBeenCalledOnce());
    expect(share.mock.calls[0]![0].files[0]).toMatchObject({
      name: "cox-response-answer-123.png",
      type: "image/png",
    });
    expect(canShare).toHaveBeenCalled();
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Save PNG" })).toBeEnabled();
  });

  it("cancels in-flight generation when closed and translates only interface labels", async () => {
    setLanguagePreference("zh");
    using _language = { [Symbol.dispose]: () => setLanguagePreference("system") };
    let signal: AbortSignal | undefined;
    using _render = vi
      .spyOn(imageExport, "renderAnswerImage")
      .mockImplementation((_node, nextSignal) => {
        signal = nextSignal;
        return new Promise<Blob>(() => {});
      });
    await using screen = await render(<AnswerImageButton {...source} />);
    await screen.getByRole("button", { name: "导出回答为图片" }).click();
    await vi.waitFor(() =>
      expect(page.getByRole("dialog").element().textContent).toContain("正在生成图片"),
    );
    expect(document.querySelector(".answer-image-card")!.textContent).toContain(
      source.text.split("\n")[0],
    );
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    expect(signal?.aborted).toBe(true);
    expect(document.querySelector(".answer-image-staging")).toBeNull();
  });

  it("keeps download available when native sharing and image clipboard access are unavailable", async () => {
    using _render = vi.spyOn(imageExport, "renderAnswerImage").mockResolvedValue(await png());
    using _clipboard = navigatorProperty("clipboard", undefined);
    using _share = navigatorProperty("share", undefined);
    await using screen = await render(<AnswerImageButton {...source} />);
    await screen.getByRole("button", { name: "Export response as image" }).click();
    await expect.element(page.getByRole("button", { name: "Save PNG" })).toBeEnabled();
    await expect
      .element(page.getByRole("button", { name: "Copy image", exact: true }))
      .toBeDisabled();
    await expect.element(page.getByRole("button", { name: "Share image" })).not.toBeInTheDocument();
  });

  it.each([390, 1280])(
    "keeps a long preview scrollable with reachable actions at %spx",
    async (width) => {
      const previous = { width: window.innerWidth, height: window.innerHeight };
      await page.viewport(width, 800);
      await using _viewport = {
        [Symbol.asyncDispose]: () => page.viewport(previous.width, previous.height),
      };
      using _render = vi.spyOn(imageExport, "renderAnswerImage").mockResolvedValue(await png(4000));
      await using screen = await render(<AnswerImageButton {...source} />);
      await screen.getByRole("button", { name: "Export response as image" }).click();
      await expect.element(page.getByRole("img", { name: "Response image preview" })).toBeVisible();
      await expect.element(page.getByRole("button", { name: "Save PNG" })).toBeVisible();
      const image = page.getByRole("img", { name: "Response image preview" }).element();
      const viewport = image.parentElement!;
      expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight);
      const dialog = page.getByRole("dialog").element().getBoundingClientRect();
      const save = page.getByRole("button", { name: "Save PNG" }).element().getBoundingClientRect();
      expect(dialog.left).toBeGreaterThanOrEqual(0);
      expect(dialog.right).toBeLessThanOrEqual(window.innerWidth);
      expect(save.bottom).toBeLessThanOrEqual(window.innerHeight);
      expect(save.top).toBeGreaterThan(0);
    },
  );
});

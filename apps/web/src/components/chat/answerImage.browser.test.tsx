import { describe, expect, it, vi } from "vite-plus/test";
import { commands, page } from "vite-plus/test/browser";

import "~/index.css";
import { fakeTimers, render } from "../../../test/render";
import ChatMarkdown from "../ChatMarkdown";
import { __setClientSettingsForTests, getClientSettings } from "../../hooks/useSettings";
import {
  ANSWER_IMAGE_WIDTH,
  answerImageErrorMessage,
  renderAnswerImage,
  saveAnswerImage,
} from "./answerImage";
import { AnswerImageButton } from "./AnswerImageButton";
import { AnswerImageContext } from "./answerImageContext";
import { HostImageUrlContext } from "./hostImageUrl";
import "./answerImage.css";

declare module "vite-plus/test/browser" {
  interface BrowserCommands {
    startAnswerImageResources: (image: string) => Promise<string>;
    setAnswerImageResourceState: (
      origin: string,
      state: "ready" | "cors-blocked" | "unavailable",
    ) => Promise<void>;
    stopAnswerImageResources: (origin: string) => Promise<void>;
  }
}

async function imageResources() {
  const origin = await commands.startAnswerImageResources(redImage());
  return { origin, [Symbol.asyncDispose]: () => commands.stopAnswerImageResources(origin) };
}

function redImage(): string {
  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 32;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "rgb(255, 0, 0)";
  context.fillRect(0, 0, 32, 32);
  return canvas.toDataURL();
}

describe("local response image rendering", () => {
  it("exports and regenerates links whose displayed Google favicon cannot be read across origins", async () => {
    await using resources = await imageResources();
    const text = "A short answer with an [example link](https://example.com).";
    await using screen = await render(
      <>
        <ChatMarkdown text={text} cwd={undefined} />
        <AnswerImageButton
          messageId="cross-origin-link"
          text={text}
          timestamp="November 8, 2026"
          cwd={undefined}
        />
      </>,
    );
    const favicon = screen.container.querySelector<HTMLImageElement>("a img")!;
    expect(favicon.src).toContain("https://www.google.com/s2/favicons?");
    favicon.loading = "eager";
    await vi.waitFor(() => expect(favicon.naturalWidth).toBe(32));
    expect(favicon.complete).toBe(true);
    expect(resources.origin).not.toBe(location.origin);
    await expect(fetch(`${resources.origin}/favicon.png`)).rejects.toThrow();

    using fetches = vi.spyOn(window, "fetch");
    await screen.getByRole("button", { name: "Export response as image" }).click();
    await expect.element(page.getByRole("img", { name: "Response image preview" })).toBeVisible();
    const card = document.querySelector(".answer-image-card")!;
    expect(card.querySelector("a img")).toBeNull();
    expect(card.querySelector("a svg")).not.toBeNull();
    expect(card.querySelector("a")?.getAttribute("href")).toBe("https://example.com");
    expect(card.textContent).toContain("example link");
    const firstUrl = page
      .getByRole("img", { name: "Response image preview" })
      .element()
      .getAttribute("src");
    await page.getByRole("button", { name: "Regenerate image" }).click();
    await expect.element(page.getByRole("img", { name: "Response image preview" })).toBeVisible();
    expect(
      page.getByRole("img", { name: "Response image preview" }).element().getAttribute("src"),
    ).not.toBe(firstUrl);
    expect(fetches.mock.calls.some(([url]) => String(url).includes("favicon"))).toBe(false);
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
  });

  it.each(["cors-blocked", "unavailable"] as const)(
    "reports a %s body image and regenerates it after recovery without reloading modules",
    async (state) => {
      await using resources = await imageResources();
      await commands.setAnswerImageResourceState(resources.origin, state);
      const imageUrl = `${resources.origin}/redirect.png?token=private-test-value`;
      const text = `A response with ![Body image](${imageUrl}).`;
      await using screen = await render(
        <AnswerImageButton
          messageId="cross-origin-image"
          text={text}
          timestamp="November 8, 2026"
          cwd={undefined}
        />,
      );
      await screen.getByRole("button", { name: "Export response as image" }).click();
      const image = document.querySelector<HTMLImageElement>(".answer-image-card img")!;
      image.loading = "eager";
      await vi.waitFor(() => expect(image.naturalWidth).toBe(32));
      await expect
        .element(
          page.getByText(
            "An image in this response could not be loaded. Check image access and try again.",
            { exact: true },
          ),
        )
        .toBeVisible();
      expect(page.getByRole("alert").element().textContent).not.toContain("private-test-value");
      await expect
        .element(page.getByRole("img", { name: "Response image preview" }))
        .not.toBeInTheDocument();

      await commands.setAnswerImageResourceState(resources.origin, "ready");
      await page.getByRole("button", { name: "Regenerate image" }).click();
      await expect.element(page.getByRole("img", { name: "Response image preview" })).toBeVisible();
      const preview = page
        .getByRole("img", { name: "Response image preview" })
        .element() as HTMLImageElement;
      await preview.decode();
      const canvas = document.createElement("canvas");
      canvas.width = preview.naturalWidth;
      canvas.height = preview.naturalHeight;
      const context = canvas.getContext("2d")!;
      context.drawImage(preview, 0, 0);
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      let redPixels = 0;
      for (let index = 0; index < data.length; index += 4) {
        if (data[index]! > 220 && data[index + 1]! < 40 && data[index + 2]! < 40) redPixels++;
      }
      expect(redPixels).toBeGreaterThan(500);
      await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
    },
  );

  it("rejects a broken body image with a readable error", async () => {
    await using screen = await render(
      <article className="answer-image-card" style={{ width: ANSWER_IMAGE_WIDTH }}>
        <img src="data:image/png;base64,broken" alt="Unavailable body image" />
      </article>,
    );
    const card = screen.container.querySelector<HTMLElement>("article")!;
    const error = await renderAnswerImage(card, new AbortController().signal).catch(
      (error: unknown) => error,
    );
    expect(answerImageErrorMessage(error)).toBe(
      "An image in this response could not be loaded. Check image access and try again.",
    );
  });

  it("produces a real, nonempty PNG containing Markdown, code, tables, math, images and folded text", async () => {
    const previousSettings = getClientSettings();
    __setClientSettingsForTests({ ...previousSettings, mathRenderingEnabled: true });
    using _settings = { [Symbol.dispose]: () => __setClientSettingsForTests(previousSettings) };
    const text = [
      "# 回答 Answer",
      "A **formatted** response with a list:",
      "- First item\n- Second item",
      `\`\`\`ts\nconst longLine = '${"complete-code-".repeat(18)}';\n\`\`\``,
      `| Name | Value |\n| --- | --- |\n| Long | ${"long-value-".repeat(25)} |`,
      "Inline math $x^2$.",
      `$$${"a + ".repeat(45)}z$$`,
      "```mermaid\ngraph LR\n  A[Start] --> B[Finish]\n```",
      `<details><summary>More details</summary>\n\nHidden conclusion.\n\n</details>`,
      "![Red image](/work/export-image.png)",
    ].join("\n\n");
    await using screen = await render(
      <div className="answer-image-staging" inert>
        <article className="answer-image-card" style={{ width: ANSWER_IMAGE_WIDTH }}>
          <HostImageUrlContext value={() => redImage()}>
            <AnswerImageContext value={true}>
              <ChatMarkdown text={text} cwd={undefined} />
            </AnswerImageContext>
          </HostImageUrlContext>
          <footer>End of response</footer>
        </article>
      </div>,
    );
    const card = screen.container.querySelector<HTMLElement>("article")!;
    const blob = await renderAnswerImage(card, new AbortController().signal);
    expect(blob.type).toBe("image/png");
    expect(blob.size).toBeGreaterThan(5000);
    expect([...new Uint8Array(await blob.slice(0, 8).arrayBuffer())]).toEqual([
      137, 80, 78, 71, 13, 10, 26, 10,
    ]);
    expect(card.scrollWidth).toBe(720);
    expect(card.textContent).toContain("Hidden conclusion.");
    expect(card.querySelector(".katex")).not.toBeNull();
    expect(card.querySelector("[data-markdown-mermaid] svg")).not.toBeNull();
    const longMath = card.querySelector<HTMLElement>('[data-markdown-math="display"]')!;
    const formula = longMath.querySelector<HTMLElement>(".katex")!;
    expect(formula.getBoundingClientRect().width).toBeLessThanOrEqual(656);
    const pre = card.querySelector("pre")!;
    expect(getComputedStyle(pre).whiteSpace).toBe("pre-wrap");
    const panel = card.querySelector<HTMLElement>('[data-slot="collapsible-panel"]')!;
    expect(panel.getBoundingClientRect().height).toBeGreaterThan(0);
    const copy = card.querySelector<HTMLElement>('[role="toolbar"]')!;
    expect(getComputedStyle(copy).display).toBe("none");

    const bitmap = await createImageBitmap(blob);
    try {
      expect(bitmap.width).toBe(1440);
      expect(bitmap.height).toBeGreaterThan(600);
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(bitmap, 0, 0);
      const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
      let redPixels = 0;
      let visiblePixels = 0;
      for (let index = 0; index < data.length; index += 4) {
        if (data[index]! > 220 && data[index + 1]! < 40 && data[index + 2]! < 40) redPixels++;
        if (data[index + 3]! > 0) visiblePixels++;
      }
      expect(redPixels).toBeGreaterThan(500);
      expect(visiblePixels).toBeGreaterThan(bitmap.width * bitmap.height * 0.9);
    } finally {
      bitmap.close();
    }
  });

  it("rejects cancelled generation and oversized responses rather than returning a cropped image", async () => {
    await using screen = await render(
      <article className="answer-image-card" style={{ width: 720, height: 17_000 }}>
        Too long
      </article>,
    );
    const card = screen.container.querySelector<HTMLElement>("article")!;
    const controller = new AbortController();
    const pending = renderAnswerImage(card, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await expect(renderAnswerImage(card, new AbortController().signal)).rejects.toThrow("too long");
  });

  it("downloads a PNG with a safe name and releases its object URL after the download starts", () => {
    using _timers = fakeTimers();
    using create = vi.spyOn(URL, "createObjectURL");
    using revoke = vi.spyOn(URL, "revokeObjectURL");
    let download: { name: string; url: string; connected: boolean } | undefined;
    using _click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      download = { name: this.download, url: this.href, connected: this.isConnected };
    });
    const blob = new Blob(["png"], { type: "image/png" });
    saveAnswerImage(blob, "cox-response-test.png");
    const url = create.mock.results[0]!.value;
    expect(download).toEqual({ name: "cox-response-test.png", url, connected: true });
    expect(document.querySelector(`a[href="${url}"]`)).toBeNull();
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30_000);
    expect(revoke).toHaveBeenCalledWith(url);
  });
});

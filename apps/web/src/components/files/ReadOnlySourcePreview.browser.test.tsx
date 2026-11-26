import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import "~/index.css";

import { render } from "../../../test/render";

import { getSyntaxHighlighterPromise } from "~/lib/syntaxHighlighting";

// The pool starts its workers before showing any code, which can outlast a cold CI browser.
vi.mock(import("~/components/DiffWorkerPoolProvider"), () => ({
  DiffWorkerPoolProvider: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

import ReadOnlySourcePreview from "./ReadOnlySourcePreview";

const LINE_COUNT = 301;
const text = `${Array.from({ length: LINE_COUNT }, (_, index) => `line ${index + 1}`).join("\n")}\n`;

// The browser ignores a copy event's data unless the event is cancelled, and copies the selection itself.
function copiedText(target: Element) {
  const clipboardData = new DataTransfer();
  const handled = !target.dispatchEvent(
    new ClipboardEvent("copy", { clipboardData, bubbles: true, cancelable: true, composed: true }),
  );
  return handled ? clipboardData.getData("text/plain") : null;
}

describe("ReadOnlySourcePreview", () => {
  it("opens a find field on mod+f after a click in the file, as the editable view does", async () => {
    await getSyntaxHighlighterPromise("typescript");
    await using screen = await render(
      <div className="flex h-100 flex-col">
        <ReadOnlySourcePreview name="other.ts" text={'export const needle = "findme";\n'} />
      </div>,
    );
    const root = screen.container.querySelector("diffs-container")!.shadowRoot!;
    const firstRow = () => root.querySelector("[data-line]");
    await vi.waitFor(() => expect(firstRow()?.textContent).toContain("needle"));

    await userEvent.click(firstRow()!);
    await userEvent.keyboard("{ControlOrMeta>}f{/ControlOrMeta}");

    await vi.waitFor(() => {
      let active = document.activeElement;
      while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
      expect(active).toBeInstanceOf(HTMLInputElement);
    });

    await userEvent.keyboard("findme");
    await vi.waitFor(() =>
      expect(Array.from(CSS.highlights.get("diffs-search-focus") ?? [], String)).toEqual([
        "findme",
      ]),
    );

    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() =>
      expect(screen.container.querySelector("[data-diffs-search]")).toBeNull(),
    );
  });

  it("updates rendered text and search matches when text changes without remounting", async () => {
    await getSyntaxHighlighterPromise("typescript");
    await using screen = await render(
      <div className="flex h-100 flex-col">
        <ReadOnlySourcePreview name="stream.ts" text={"const first = 1;\n"} />
      </div>,
    );
    const root = screen.container.querySelector("diffs-container")!.shadowRoot!;
    await vi.waitFor(() => expect(root.textContent).toContain("first"));

    await screen.rerender(
      <div className="flex h-100 flex-col">
        <ReadOnlySourcePreview name="stream.ts" text={"const first = 1;\nconst second = 2;\n"} />
      </div>,
    );
    await vi.waitFor(() => expect(root.textContent).toContain("second"));

    await userEvent.click(root.querySelector("[data-line]")!);
    await userEvent.keyboard("{ControlOrMeta>}f{/ControlOrMeta}");
    await vi.waitFor(() => {
      let active = document.activeElement;
      while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
      expect(active).toBeInstanceOf(HTMLInputElement);
    });
    await userEvent.keyboard("second");
    await vi.waitFor(() =>
      expect(Array.from(CSS.highlights.get("diffs-search-focus") ?? [], String)).toEqual([
        "second",
      ]),
    );
  });

  it("copies the whole file after Select All, wherever the preview is scrolled", async () => {
    // File paints nothing until the shared highlighter has loaded; once it has, mount renders synchronously.
    await getSyntaxHighlighterPromise("text");
    await using screen = await render(
      <div className="flex h-100 flex-col">
        <ReadOnlySourcePreview name="notes.txt" text={text} wordWrap={false} />
      </div>,
    );
    const root = screen.container.querySelector("diffs-container")!.shadowRoot!;
    const rows = () => root.querySelectorAll("[data-line]");
    await vi.waitFor(() => expect(rows()[0]?.textContent).toBe("line 1"));
    // Only rows near the viewport are mounted, so the browser's own copy would stop there.
    expect(rows().length).toBeLessThan(LINE_COUNT);

    await userEvent.click(rows()[0]!);
    await userEvent.keyboard("{ControlOrMeta>}a{/ControlOrMeta}");
    expect(copiedText(rows()[0]!)).toBe(text);

    const scroller = screen.container.querySelector(".file-preview-virtualizer")!;
    scroller.scrollTop = scroller.scrollHeight;
    await vi.waitFor(() => expect(rows()[0]?.textContent).not.toBe("line 1"));
    expect(copiedText(rows()[0]!)).toBe(text);

    document.getSelection()!.removeAllRanges();
    await userEvent.click(rows()[rows().length - 1]!);
    await userEvent.keyboard("{ControlOrMeta>}a{/ControlOrMeta}");
    expect(copiedText(rows()[0]!)).toBe(text);

    // A selection that stops inside the mounted rows at either end stays the browser's to copy.
    const pre = root.querySelector("pre")!;
    const firstText = rows()[0]!.querySelector("span")!.firstChild!;
    const lastText = [...rows()]
      .findLast((row) => row.querySelector("span") !== null)!
      .querySelector("span")!.firstChild!;
    document.getSelection()!.setBaseAndExtent(pre, 0, lastText, 4);
    expect(copiedText(rows()[0]!)).toBeNull();
    document.getSelection()!.setBaseAndExtent(firstText, 4, pre, pre.childNodes.length);
    expect(copiedText(rows()[0]!)).toBeNull();
  });

  it.each([
    ["a lone carriage return", "\r"],
    ["a carriage return and line feed", "\r\n"],
  ])("copies the whole of a file whose lines end in %s", async (_name, ending) => {
    const contents = text.replaceAll("\n", ending);
    await getSyntaxHighlighterPromise("text");
    await using screen = await render(
      <div className="flex h-100 flex-col">
        <ReadOnlySourcePreview name="notes.txt" text={contents} wordWrap={false} />
      </div>,
    );
    const root = screen.container.querySelector("diffs-container")!.shadowRoot!;
    const rows = () => root.querySelectorAll("[data-line]");
    await vi.waitFor(() => expect(rows()[0]?.textContent).toBe("line 1"));

    await userEvent.click(rows()[0]!);
    await userEvent.keyboard("{ControlOrMeta>}a{/ControlOrMeta}");
    const scroller = screen.container.querySelector(".file-preview-virtualizer")!;
    scroller.scrollTop = scroller.scrollHeight;
    await vi.waitFor(() => expect(rows()[0]?.textContent).not.toBe("line 1"));
    expect(copiedText(rows()[0]!)).toBe(contents);
  });

  it.each([
    { contents: text, height: 400 },
    // Short enough that rows of the selection stay mounted with the preview scrolled to the bottom.
    { contents: text.split("\n").slice(0, 163).join("\n"), height: 800 },
  ])(
    "restores and copies a partial selection after scrolling away and back ($height px)",
    async ({ contents, height }) => {
      await getSyntaxHighlighterPromise("text");
      await using screen = await render(
        <div className="flex flex-col" style={{ height }}>
          <ReadOnlySourcePreview name="notes.txt" text={contents} wordWrap={false} />
        </div>,
      );
      const root = screen.container.querySelector("diffs-container")!.shadowRoot!;
      const rows = () => root.querySelectorAll("[data-line]");
      await vi.waitFor(() => expect(rows()[0]?.textContent).toBe("line 1"));

      const rowText = (line: number) =>
        [...rows()].find((row) => row.textContent === `line ${line}`)!.querySelector("span")!
          .firstChild!;
      document.getSelection()!.setBaseAndExtent(rowText(5), 0, rowText(20), "line 20".length);
      const selected = Array.from({ length: 16 }, (_, index) => `line ${index + 5}`).join("\n");

      const scroller = screen.container.querySelector(".file-preview-virtualizer")!;
      scroller.scrollTop = scroller.scrollHeight;
      await vi.waitFor(() => expect(rows()[0]?.textContent).not.toBe("line 1"));
      scroller.scrollTop = 0;
      await vi.waitFor(() => expect(rows()[0]?.textContent).toBe("line 1"));

      expect(document.getSelection()!.toString()).toBe(selected);
      expect(copiedText(rows()[0]!) ?? document.getSelection()!.toString()).toBe(selected);
    },
  );

  it("drops a selection scrolled out of the mounted window when a click lands on its edge", async () => {
    await getSyntaxHighlighterPromise("text");
    await using screen = await render(
      <div className="flex h-100 flex-col">
        <ReadOnlySourcePreview name="notes.txt" text={text} wordWrap={false} />
      </div>,
    );
    const root = screen.container.querySelector("diffs-container")!.shadowRoot!;
    const rows = () => root.querySelectorAll("[data-line]");
    await vi.waitFor(() => expect(rows()[0]?.textContent).toBe("line 1"));

    const rowText = (index: number) => rows()[index]!.querySelector("span")!.firstChild!;
    document.getSelection()!.setBaseAndExtent(rowText(4), 0, rowText(19), 4);
    const scroller = screen.container.querySelector(".file-preview-virtualizer")!;
    scroller.scrollTop = scroller.scrollHeight;
    await vi.waitFor(() => expect(rows()[0]?.textContent).not.toBe("line 1"));
    expect(copiedText(rows()[0]!)).toContain("line 5\n");

    // The first mounted row is where the scrolled-out selection is parked, far above the viewport.
    rows()[0]!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }));
    document.getSelection()!.collapse(rowText(0), 0);
    expect(copiedText(rows()[0]!)).toBeNull();
  });

  it("copies an active drag released outside the preview after its anchor unmounts", async () => {
    await getSyntaxHighlighterPromise("text");
    await using screen = await render(
      <div className="flex h-[400px] flex-col">
        <ReadOnlySourcePreview name="notes.txt" text={text} wordWrap={false} />
      </div>,
    );
    const root = screen.container.querySelector("diffs-container")!.shadowRoot!;
    const scroller = screen.container.querySelector<HTMLElement>(".file-preview-virtualizer")!;
    const row = (line: number) => root.querySelector<HTMLElement>('[data-line="' + line + '"]');
    const rowText = (row: Element) => row.querySelector("span")!.firstChild!;
    const wait = { timeout: 5000 };
    const start = await vi.waitFor(() => {
      expect(row(5)?.textContent).toBe("line 5");
      expect(row(10)?.textContent).toBe("line 10");
      return row(5)!;
    }, wait);
    const lineHeight = start.getBoundingClientRect().height;
    const selection = document.getSelection()!;
    start.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, composed: true, button: 0 }),
    );
    try {
      selection.setBaseAndExtent(rowText(start), 0, rowText(row(10)!), "line 10".length);
      scroller.scrollTop = 165 * lineHeight;
      const [first, end] = await vi.waitFor(() => {
        expect(row(5)).toBeNull();
        const first = root.querySelector<HTMLElement>("[data-line]");
        expect(Number(first?.dataset.line)).toBeGreaterThan(5);
        const end = row(170);
        expect(end?.textContent).toBe("line 170");
        const viewport = scroller.getBoundingClientRect();
        const rect = end!.getBoundingClientRect();
        expect(rect.top).toBeGreaterThanOrEqual(viewport.top);
        expect(rect.bottom).toBeLessThanOrEqual(viewport.bottom);
        return [first!, end!] as const;
      }, wait);
      // Chromium leaves an unmounted selection endpoint at the edge of the rendered rows.
      selection.setBaseAndExtent(rowText(first), 0, rowText(end), "line 170".length);
    } finally {
      document.body.dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true, pointerType: "mouse" }),
      );
    }

    const from = text.indexOf("line 5\n");
    const to = text.indexOf("line 170\n") + "line 170".length;
    expect(copiedText(row(170)!)).toBe(text.slice(from, to));
  });

  it("extends a selection with Shift+click after its anchor scrolls out of the mounted window", async () => {
    await getSyntaxHighlighterPromise("text");
    await using screen = await render(
      <div className="flex h-[400px] flex-col">
        <ReadOnlySourcePreview name="notes.txt" text={text} wordWrap={false} />
      </div>,
    );
    const root = screen.container.querySelector("diffs-container")!.shadowRoot!;
    const rows = () => root.querySelectorAll("[data-line]");
    await vi.waitFor(() => expect(rows()[0]?.textContent).toBe("line 1"));

    await userEvent.click(rows()[2]!.querySelector("span")!, { position: { x: 1, y: 5 } });
    const scroller = screen.container.querySelector(".file-preview-virtualizer")!;
    scroller.scrollTop = scroller.scrollHeight;
    await vi.waitFor(() => expect(rows()[0]?.textContent).not.toBe("line 1"));
    const lastSpan = [...rows()]
      .findLast((row) => row.querySelector("span") !== null)!
      .querySelector("span")!;
    await userEvent.click(lastSpan, {
      position: { x: 1, y: 5 },
      modifiers: ["Shift"],
    });

    const clicked = document.getSelection()!.getComposedRanges({ shadowRoots: [root] })[0]!;
    const lastLine = clicked.endContainer.textContent!;
    expect(Number(lastLine.replace("line ", ""))).toBeGreaterThan(250);
    expect(copiedText(rows()[0]!)).toBe(
      text.slice(text.indexOf("line 3\n"), text.indexOf(`${lastLine}\n`)),
    );
  });
});

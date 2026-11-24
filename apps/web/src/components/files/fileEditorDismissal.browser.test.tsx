import { DEFAULT_THEMES, preloadHighlighter } from "@pierre/diffs";
import { Editor, type EditorFactory } from "@pierre/diffs/edit";
import { EditProvider, File } from "@pierre/diffs/react";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

import { isMacPlatform } from "~/lib/utils";
import { installFileEditorDismissal } from "./fileEditorDismissal";

describe("installFileEditorDismissal", () => {
  it("leaves the editor focused when Escape belongs to an IME composition", async () => {
    let editor: Editor<"file" | "file-diff", undefined, undefined> | undefined;
    const createEditor: EditorFactory<undefined, undefined> = (...args) =>
      (editor = new Editor(...args));
    await preloadHighlighter({ themes: Object.values(DEFAULT_THEMES), langs: ["typescript"] });
    await using screen = await render(
      <div data-testid="file-surface">
        <EditProvider createEditor={createEditor}>
          <File file={{ name: "server.ts", contents: "const server = 1;\n" }} edit />
        </EditProvider>
      </div>,
    );
    const shadowRoot = screen.container.querySelector("diffs-container")?.shadowRoot;
    const content = shadowRoot?.querySelector<HTMLElement>("[data-content]");
    expect(content).toBeTruthy();
    content!.focus();
    const range = { start: { line: 0, character: 6 }, end: { line: 0, character: 12 } };
    editor!.setSelections([{ ...range, direction: "forward" }]);
    const onDismiss = vi.fn();
    const onAppKeyDown = vi.fn();
    window.addEventListener("keydown", onAppKeyDown);
    using _appKeyDown = {
      [Symbol.dispose]: () => window.removeEventListener("keydown", onAppKeyDown),
    };
    using _dismissal = {
      [Symbol.dispose]: installFileEditorDismissal({
        root: screen.getByTestId("file-surface").element() as HTMLElement,
        editor: editor!,
        isBlocked: () => false,
        onDismiss,
      }),
    };
    const pressEscape = (init: KeyboardEventInit) => {
      const event = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        composed: true,
        cancelable: true,
        ...init,
      });
      content!.dispatchEvent(event);
      return event;
    };

    expect(pressEscape({ isComposing: true, keyCode: 27 }).defaultPrevented).toBe(false);
    expect(pressEscape({ keyCode: 229 }).defaultPrevented).toBe(false);

    expect(onDismiss).not.toHaveBeenCalled();
    expect(onAppKeyDown).not.toHaveBeenCalled();
    expect(editor!.getViewState().selections).toMatchObject([range]);
    expect(shadowRoot!.activeElement).toBe(content);

    expect(pressEscape({ keyCode: 27 }).defaultPrevented).toBe(true);
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(shadowRoot!.activeElement).toBeNull();
  });
});

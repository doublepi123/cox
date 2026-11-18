import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "./index.css";

const viewports = [
  ["Chrome Android", 412, 915],
  ["iOS Safari", 390, 844],
] as const;

it.each(viewports)(
  "keeps the %s page scale at 1 when the composer is focused and blurred",
  async (_label, width, height) => {
    await page.viewport(width, height);
    document.body.replaceChildren();
    const editor = document.createElement("div");
    editor.className = "composer-tiptap";
    editor.contentEditable = "true";
    editor.textContent = "尽管提问";
    document.body.append(editor);
    const scale = () => window.visualViewport?.scale ?? 1;
    const before = scale();
    editor.focus();
    const fontSize = Number.parseFloat(getComputedStyle(editor).fontSize);
    const focused = scale();
    editor.blur();
    const after = scale();
    expect(fontSize).toBeGreaterThanOrEqual(16);
    expect(before).toBe(1);
    expect(focused).toBe(1);
    expect(after).toBe(1);
  },
);

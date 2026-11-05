import { describe, expect, it } from "vite-plus/test";

import { setMarkdownTaskChecked, taskListMarkerOffset } from "./markdownTaskList.ts";

describe("setMarkdownTaskChecked", () => {
  const markdown = "- [ ] First\n- [x] Second\n";

  it("checks and unchecks the task marker at the supplied offset", () => {
    expect(setMarkdownTaskChecked(markdown, 2, true)).toBe("- [x] First\n- [x] Second\n");
    expect(setMarkdownTaskChecked(markdown, 14, false)).toBe("- [ ] First\n- [ ] Second\n");
    expect(setMarkdownTaskChecked("1. [X] Ordered\n", 3, false)).toBe("1. [ ] Ordered\n");
  });

  it.each([-1, 0, 3, 200, 2.5, NaN, Infinity])(
    "leaves the document unchanged for invalid marker offset %s",
    (offset) => {
      expect(setMarkdownTaskChecked(markdown, offset, true)).toBe(markdown);
    },
  );

  it("preserves CRLF, Unicode and all text except the marker's state", () => {
    const body = "## 𝄞\r\n\r\n> - [X] Ship **it**\r\n  - [ ] Later\r\n";
    const offset = body.indexOf("[X]");
    expect(setMarkdownTaskChecked(body, offset, false)).toBe(body.replace("[X]", "[ ]"));
    expect(setMarkdownTaskChecked(body, offset, true)).toBe(body.replace("[X]", "[x]"));
    expect(setMarkdownTaskChecked("- [!] Not a task", 2, true)).toBe("- [!] Not a task");
  });
});

describe("taskListMarkerOffset", () => {
  it.each([
    "- [ ] Unordered",
    "+ [x] Unordered",
    "* [X] Unordered",
    "12. [ ] Ordered",
    "2) [x] Ordered",
  ])("finds the first marker in %s", (item) => {
    expect(taskListMarkerOffset(item, 0)).toBe(item.indexOf("["));
  });

  it("resolves nested and quoted tasks from their list-item source offsets", () => {
    const body = "Before\r\n- [ ] First\r\n  - [x] Nested\r\n> 1. [X] Quoted\r\n";
    for (const start of [body.indexOf("- ["), body.indexOf("- [x]"), body.indexOf("1.")]) {
      expect(taskListMarkerOffset(body, start)).toBe(body.indexOf("[", start));
    }
  });

  it("never searches a later line or an inline marker", () => {
    expect(taskListMarkerOffset("- Not a task\n- [ ] Later", 0)).toBeNull();
    expect(taskListMarkerOffset("- Inline [ ] text", 0)).toBeNull();
    expect(taskListMarkerOffset("[ ] Not a list item", 0)).toBeNull();
    expect(taskListMarkerOffset("- [!] Invalid", 0)).toBeNull();
  });

  it.each([-1, 100, 0.5, NaN, Infinity])("refuses invalid list-item offset %s", (offset) => {
    expect(taskListMarkerOffset("- [ ] First", offset)).toBeNull();
  });
});

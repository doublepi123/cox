import { describe, expect, it } from "vite-plus/test";

import { inlineMarkdownUnitMarks, parseInlineMarkdown } from "./composer-rich-text";

describe("composer rich text markdown", () => {
  it("preserves unmatched markers, escaped markers, and identifiers", () => {
    for (const text of [
      "plain text",
      "snake_case",
      "unmatched **",
      "** spaced **",
      "\\*literal\\*",
    ]) {
      expect(parseInlineMarkdown(text)).toEqual([{ text, marks: [] }]);
    }
  });

  it("renders triple markers and nested styles", () => {
    expect(parseInlineMarkdown("***both***")).toEqual([
      { text: "both", marks: ["bold", "italic"] },
    ]);
    expect(parseInlineMarkdown("*a **b** c*")).toEqual([
      { text: "a ", marks: ["italic"] },
      { text: "b", marks: ["italic", "bold"] },
      { text: " c", marks: ["italic"] },
    ]);
    expect(parseInlineMarkdown("**a `code` c**")).toEqual([
      { text: "a ", marks: ["bold"] },
      { text: "code", marks: ["bold", "code"] },
      { text: " c", marks: ["bold"] },
    ]);
  });

  it("preserves crossing italic and bold spans", () => {
    expect(parseInlineMarkdown("*a**b*****c**")).toEqual([
      { text: "a", marks: ["italic"] },
      { text: "b", marks: ["italic", "bold"] },
      { text: "c", marks: ["bold"] },
    ]);
  });

  it("keeps repeated and alternate delimiters literal inside an active mark", () => {
    const repeated = "*".repeat(10_000);
    expect(parseInlineMarkdown(repeated + "text" + repeated)).toEqual([
      { text: repeated.slice(2) + "text", marks: ["bold"] },
      { text: repeated.slice(2), marks: [] },
    ]);
    const alternate = "__".repeat(5_000);
    expect(parseInlineMarkdown("**~~" + alternate + "text" + alternate + "~~**")).toEqual([
      { text: alternate + "text" + alternate, marks: ["bold", "strike"] },
    ]);
  });

  it("keeps code span contents literal", () => {
    expect(parseInlineMarkdown("`**not bold**`")).toEqual([
      { text: "**not bold**", marks: ["code"] },
    ]);
  });

  it.each([
    "foo****bar",
    "foo____bar",
    "foo~~~~bar",
    "foo.****.bar",
    "foo.____.bar",
    "foo.~~~~.bar",
  ])("preserves empty delimiter pairs after invalidating code around %s", (content) => {
    const text = `${content}\` after`;
    expect(parseInlineMarkdown(text)).toEqual([{ text, marks: [] }]);
    expect(inlineMarkdownUnitMarks(text)).toEqual(Array.from({ length: text.length }, () => []));
  });

  it("maps each source character to its marks, or null for a dropped delimiter", () => {
    const bold = ["bold"];
    expect(inlineMarkdownUnitMarks("**`*` w** \\*")).toEqual([
      null,
      null,
      null,
      ["bold", "code"],
      null,
      bold,
      bold,
      null,
      null,
      [],
      [],
      [],
    ]);
  });

  it("maps UTF-16 units without splitting a styled surrogate pair", () => {
    expect(inlineMarkdownUnitMarks("**😀中**")).toEqual([
      null,
      null,
      ["bold"],
      ["bold"],
      ["bold"],
      null,
      null,
    ]);
  });

  it.each([
    "plain 中😀",
    "**bold**",
    "*a **b** c*",
    "**a `code` c**",
    "*a**b*****c**",
    "**unterminated *italic*",
    "\\*literal\\* and _snake_case",
    "~~**中😀**~~",
    "**path\\**",
    "`**not bold**`",
  ])("keeps source-unit offsets consistent with parsed spans for %s", (text) => {
    const units = inlineMarkdownUnitMarks(text);
    expect(units).toHaveLength(text.length);
    const parsed = parseInlineMarkdown(text);
    const expected = parsed.flatMap((span) =>
      Array.from({ length: span.text.length }, (_, index) => ({
        text: span.text[index],
        marks: span.marks,
      })),
    );
    expect(
      units.flatMap((marks, index) => (marks === null ? [] : [{ text: text[index], marks }])),
    ).toEqual(expected);
  });
});

import { githubHeadingSlug } from "./markdownFragments";

// Definitions, footnotes, raw HTML, container directives and display math can tie blocks together.
const DOCUMENT_WIDE_SYNTAX = /^ {0,3}(?:\[[^\]\n]+\]:|<[A-Za-z!?/]|:::|\$\$)|\[\^/m;
const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})/;
// After a blank line these still continue the previous block: a list item or indented content.
const CONTINUATION_PATTERN = /^(?:[ \t]|(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$))/;

const ATX_HEADING_PATTERN =
  /^(?:[ \t]*(?:>|[-*+](?=[ \t])|\d{1,9}[.)](?=[ \t])))*[ \t]*#{1,6}(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;

const SETEXT_UNDERLINE_PATTERN =
  /^(?:[ \t]*(?:>|[-*+](?=[ \t])|\d{1,9}[.)](?=[ \t])))*[ \t]*(?:=+|-+)[ \t]*$/;

/**
 * Cuts Markdown at blank lines that close every open block, so each piece renders exactly as it
 * would inside the whole text. Returns null when the text uses syntax that spans blocks, such as
 * headings with the same slug, whose ids are numbered across the whole text.
 */
export function splitMarkdownBlocks(text: string): string[] | null {
  if (
    text.startsWith("\ufeff") ||
    text.includes("\r") ||
    DOCUMENT_WIDE_SYNTAX.test(text) ||
    /^ {0,3}`?★ Insight[ \t]+─{3,}/m.test(text)
  )
    return null;
  const blocks: string[] = [];
  let blockStart = 0;
  let lineStart = 0;
  let fence: string | null = null;
  let fenceIndent = 0;
  let afterBlankLine = false;
  const headingKeys = new Set<string>();
  const needsWholeHeading = (headingText: string | undefined) => {
    if (headingText === undefined) return false;
    if (/[`*_~[\]<&\\!$]|:(?!\s|$)/.test(headingText)) return true;
    const key = githubHeadingSlug(headingText);
    if (!key) return false;
    if (headingKeys.has(key)) return true;
    headingKeys.add(key);
    return false;
  };
  const headingNeedsWholeDocument = (line: string, mayUnderline = true) =>
    (mayUnderline && SETEXT_UNDERLINE_PATTERN.test(line)) ||
    needsWholeHeading(ATX_HEADING_PATTERN.exec(line)?.[1]);

  let afterContentLine = false;
  for (const line of text.split("\n")) {
    const fenceMatch = FENCE_PATTERN.exec(line);
    const marker = fenceMatch?.[1];
    const opener =
      marker?.[0] === "`" && line.slice(fenceMatch![0].length).includes("`") ? undefined : marker;
    const mayUnderline = afterContentLine;
    afterContentLine = false;
    if (fence !== null) {
      // A line left of an indented fence may end the list item holding it, which isn't tracked.
      if (/\S/.test(line.slice(0, fenceIndent))) {
        const rest = text.slice(lineStart).split("\n");
        for (const restLine of rest) {
          if (headingNeedsWholeDocument(restLine)) return null;
        }
        break;
      }
      if (
        opener &&
        opener[0] === fence[0] &&
        opener.length >= fence.length &&
        line.trim() === opener
      ) {
        fence = null;
      }
    } else if (line.trim() === "") {
      afterBlankLine = true;
    } else {
      if (headingNeedsWholeDocument(line, mayUnderline)) return null;
      afterContentLine = opener === undefined;
      if (afterBlankLine && lineStart > blockStart && !CONTINUATION_PATTERN.test(line)) {
        blocks.push(text.slice(blockStart, lineStart));
        blockStart = lineStart;
      }
      afterBlankLine = false;
      fence = opener ?? null;
      if (opener) fenceIndent = line.indexOf(opener);
    }
    lineStart += line.length + 1;
  }
  blocks.push(text.slice(blockStart));
  return blocks;
}

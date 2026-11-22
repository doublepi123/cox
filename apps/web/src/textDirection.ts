export type TextDirection = "ltr" | "rtl";

// Hebrew through Arabic Extended-A, their presentation forms, and the
// supplementary right-to-left blocks.
export const RTL_LETTER = /[֐-ࣿיִ-﷿ﹰ-﻿\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;
export const LETTER = /\p{L}/u;

const SENTENCE_END = /(?<=[.!?؟])(?<!\b(?:e\.g|i\.e)\.)\s+|\n+/i;

function majority(
  directions: Iterable<TextDirection | undefined>,
  tie?: () => TextDirection | undefined,
): TextDirection | undefined {
  let first: TextDirection | undefined;
  let rtl = 0;
  let ltr = 0;
  for (const direction of directions) {
    if (direction === undefined) continue;
    first ??= direction;
    if (direction === "rtl") rtl += 1;
    else ltr += 1;
  }
  if (rtl === ltr) return tie ? tie() : first;
  return rtl > ltr ? "rtl" : "ltr";
}

function sentenceDirection(text: string): TextDirection | undefined {
  return majority(
    text.split(/\s+/).map((word) => {
      const letter = LETTER.exec(word)?.[0];
      return letter === undefined ? undefined : RTL_LETTER.test(letter) ? "rtl" : "ltr";
    }),
  );
}

export function textDirection(text: string): TextDirection | undefined {
  if (!RTL_LETTER.test(text)) return LETTER.test(text) ? "ltr" : undefined;
  return majority(text.split(SENTENCE_END).map(sentenceDirection), () => sentenceDirection(text));
}

const MARKDOWN_CODE_OR_URL =
  /(`{3,}|~{3,})[\s\S]*?(?:\1|$)|(`{1,2})(?!`)[\s\S]*?(?<!`)\2(?!`)|https?:\/\/\S+/g;

export function markdownProseDirection(markdown: string): TextDirection | undefined {
  return textDirection(markdown.replace(MARKDOWN_CODE_OR_URL, " "));
}

import remarkParse from "remark-parse";
import { unified } from "unified";
import { describe, expect, it } from "vite-plus/test";

import { CHAT_MARKDOWN_REMARK_PLUGINS } from "./markdownPipeline.ts";
import { remarkKeepWindowsPaths, remarkKeepWindowsProsePaths } from "./markdownWindowsPaths.ts";

it.each([
  [String.raw`C:\R&D folder\.t3\shot.png`, String.raw`C:\R&D folder\.t3\shot.png`],
  [String.raw`C:\R&amp;D folder\.t3\shot.png`, String.raw`C:\R&D folder\.t3\shot.png`],
  [String.raw`C:\work\&stuff\.t3\shot.png`, String.raw`C:\work\&stuff\.t3\shot.png`],
  [String.raw`C:\work\&amp;lt;\.t3\shot.png`, String.raw`C:\work\&lt;\.t3\shot.png`],
])("preserves separators and decodes references once in %s", (authored, expected) => {
  const parser = unified().use(remarkParse).use(remarkKeepWindowsPaths);
  for (const prefix of ["", "!"]) {
    expect(parser.parse(`${prefix}[shot](<${authored}>)`)).toMatchObject({
      children: [{ children: [{ url: expected }] }],
    });
  }
  expect(parser.parse(`[shot]: <${authored}>`)).toMatchObject({
    children: [{ type: "definition", url: expected }],
  });
});

describe.each([
  ["chat Markdown", CHAT_MARKDOWN_REMARK_PLUGINS],
  ["prose paths only", [remarkKeepWindowsProsePaths]],
] as const)("%s", (_, plugins) => {
  const processor = unified()
    .use(remarkParse)
    .use([...plugins]);

  it.each([
    ["space", " "],
    ["tab", "\t"],
    ["no-break space", "\u00a0"],
    ["em space", "\u2003"],
    ["narrow no-break space", "\u202f"],
    ["byte order mark", "\ufeff"],
  ])("separates a Windows path from an ordinary escape across a %s", (_, space) => {
    const markdown = String.raw`Before${space}C:\Users\me\_build${space}\*literal\*`;

    expect(processor.parse(markdown).children).toMatchObject([
      {
        type: "paragraph",
        children: [
          {
            type: "text",
            value: String.raw`Before${space}C:\Users\me\_build${space}*literal*`,
          },
        ],
      },
    ]);
  });

  it("preserves path escapes after decoded whitespace and across separate text nodes", () => {
    const markdown = String.raw`one\_two C:\a\_b \*x\* three\_four&#x20;D:\c\_d \*y\* *em*E:\e\_f \*z\*`;

    expect(processor.parse(markdown).children).toMatchObject([
      {
        type: "paragraph",
        children: [
          { type: "text", value: String.raw`one_two C:\a\_b *x* three_four D:\c\_d *y* ` },
          { type: "emphasis", children: [{ type: "text", value: "em" }] },
          { type: "text", value: String.raw`E:\e\_f *z*` },
        ],
      },
    ]);
  });
});

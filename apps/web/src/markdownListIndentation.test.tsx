import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vite-plus/test";

import { remarkNormalizeListItemIndentation } from "@t3tools/shared/markdownListIndentation";
import { remarkCodexDirectives } from "@t3tools/shared/codexMarkdownDirectives";
import { CHAT_USER_MARKDOWN_REMARK_PLUGINS } from "@t3tools/shared/markdownPipeline";

function renderMarkdown(markdown: string): string {
  return renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={[
        remarkGfm,
        remarkNormalizeListItemIndentation,
        remarkCodexDirectives,
        ...CHAT_USER_MARKDOWN_REMARK_PLUGINS,
      ]}
    >
      {markdown}
    </ReactMarkdown>,
  );
}

describe("remarkNormalizeListItemIndentation", () => {
  it.each([
    "-       Read [the guide][guide].\n\n[guide]: https://example.com/guide",
    '> [guide]: https://example.com/guide\n>   "Guide"\n\n-       Read [the guide][GUIDE].',
    ">>[my\n> > guide]: https://example.com/guide\n\n-       Read [the guide][my guide].",
  ])("uses document reference definitions in recovered items: %j", (markdown) => {
    expect(renderMarkdown(markdown)).toBe(renderMarkdown(markdown.replace("-       ", "- ")));
    expect(renderMarkdown(markdown)).toContain('<a href="https://example.com/guide"');
  });

  it.each([
    ["-     \tfoo\n          bar", '<span data-leading-whitespace="">  </span>bar'],
    ["-        foo\n      \tbar", "\nbar"],
    [
      "-       first\n\n        ```\n        \tcode\n        ```",
      "<pre><code>\tcode\n</code></pre>",
    ],
  ])("keeps indentation aligned to tab stops: %j", (markdown, expected) => {
    expect(renderMarkdown(markdown)).toContain(expected);
  });

  it("renders a leading directive in over-indented list content", () => {
    expect(renderMarkdown('-       :codex-file-citation{path="src/a.ts"}')).toContain(
      '<li><a href="src/a.ts">a.ts</a></li>',
    );
  });

  it("renders same-line over-indented list content as list text", () => {
    const html = renderMarkdown(`why did you do this?

-       for (const step of rest.steps) {
-           if (step.request.body) {
-               step.request.body = "<redacted>";
-           }
-       }`);

    expect(html).not.toContain("<pre>");
    expect(html).toContain("<li>for (const step of rest.steps) {</li>");
    expect(html).toContain("<li>if (step.request.body) {</li>");
    expect(html).toContain("<li>step.request.body = &quot;&lt;redacted&gt;&quot;;</li>");
  });

  it("preserves every recovered block separated by blank lines", () => {
    const html = renderMarkdown(`-       **first block**

        [second block](https://example.com)`);

    expect(html).toContain("<strong>first block</strong>");
    expect(html).toContain('<a href="https://example.com">second block</a>');
  });

  it("recursively normalizes lists in recovered tail blocks", () => {
    const html = renderMarkdown(`-       first block

        -       nested block`);

    expect(html).not.toContain("<pre>");
    expect(html).toContain("<li>nested block</li>");
  });

  it("preserves fenced code blocks within list items", () => {
    const html = renderMarkdown(`- \`\`\`ts
  const value = 1;
  \`\`\``);

    expect(html).toContain('<pre><code class="language-ts">const value = 1;');
  });

  it("preserves indented code blocks that start below a list marker", () => {
    const html = renderMarkdown(`-
      const value = 1;`);

    expect(html).toContain("<pre><code>const value = 1;");
  });
});

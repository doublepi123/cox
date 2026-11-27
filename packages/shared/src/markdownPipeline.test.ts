import { expect, it } from "vite-plus/test";
import { unified } from "unified";
import rehypeRaw from "rehype-raw";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import {
  CHAT_MARKDOWN_REHYPE_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS,
  CHAT_USER_MARKDOWN_REMARK_PLUGINS,
  chatMarkdownImageSources,
} from "./markdownPipeline.ts";

it("preserves exactly the typed prose indentation in a user message over the sanitizer", () => {
  const markdown =
    "Plan\n   Step one\n        Step two\n\n- Item\n    detail\n\n    \n        code";
  const render = (isUser: boolean) => {
    const processor = unified()
      .use(remarkParse)
      .use(CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS)
      .use(isUser ? CHAT_USER_MARKDOWN_REMARK_PLUGINS : [])
      .use(remarkRehype)
      .use(CHAT_MARKDOWN_REHYPE_PLUGINS);
    return processor.runSync(processor.parse(markdown), markdown);
  };
  const tree = render(true);
  expect(tree.children[0]).toMatchObject({
    tagName: "p",
    children: [
      { value: "Plan" },
      { tagName: "br" },
      { value: "\n" },
      {
        tagName: "span",
        properties: { dataLeadingWhitespace: "" },
        children: [{ value: "" }, { value: "   " }],
      },
      { value: "Step one" },
      { tagName: "br" },
      { value: "\n" },
      {
        tagName: "span",
        properties: { dataLeadingWhitespace: "" },
        children: [{ value: "" }, { value: "        " }],
      },
      { value: "Step two" },
    ],
  });
  expect(JSON.stringify(tree)).toContain('"value":"  "');
  expect(JSON.stringify(tree)).toContain('"tagName":"pre"');
  expect(JSON.stringify(render(false))).not.toContain("dataLeadingWhitespace");
});

it("preserves in-app thread links through the shared Markdown sanitizer", () => {
  const processor = unified()
    .use(remarkParse)
    .use(CHAT_MARKDOWN_REMARK_PLUGINS)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(CHAT_MARKDOWN_REHYPE_PLUGINS);
  const tree = processor.runSync(
    processor.parse(
      '[Open thread](t3-thread://v1/thread)\n\n<t3-thread://v2/environment/thread:a%3A1>\n\n<a href="javascript:alert(1)">Unsafe</a>',
    ),
  );
  expect(tree.children[0]).toMatchObject({
    tagName: "p",
    children: [
      {
        tagName: "a",
        properties: { href: "t3-thread://v1/thread" },
        children: [{ type: "text", value: "Open thread" }],
      },
    ],
  });
  expect(tree.children[2]).toMatchObject({
    tagName: "p",
    children: [
      {
        tagName: "a",
        properties: { href: "t3-thread://v2/environment/thread:a%3A1" },
        children: [{ type: "text", value: "t3-thread://v2/environment/thread:a%3A1" }],
      },
    ],
  });
  expect(JSON.stringify(tree)).not.toContain("javascript:");
});

it("normalizes editor file links but sanitizes other custom schemes", () => {
  const processor = unified()
    .use(remarkParse)
    .use(CHAT_MARKDOWN_REMARK_PLUGINS)
    .use(remarkRehype)
    .use(CHAT_MARKDOWN_REHYPE_PLUGINS);
  const tree = processor.runSync(
    processor.parse(
      "[Editor](VSCODE://file/workspace/file.ts)\n\n[Bad](vscode://evil.test/workspace/file.ts)\n\n[Code](javascript:alert(1))",
    ),
  );
  expect(JSON.stringify(tree)).toContain("vscode://file/workspace/file.ts");
  expect(JSON.stringify(tree)).not.toContain("evil.test/workspace");
  expect(JSON.stringify(tree)).not.toContain("javascript:");
});

it("builds the tree rehype-raw builds for markdown without HTML", () => {
  type Node = {
    type: string;
    tagName?: string;
    value?: string;
    position?: unknown;
    data?: unknown;
    children?: Node[];
  };
  // What the round trip changes that renders the same; see `needsHtmlParser`.
  const comparable = (node: Node): Node => {
    const { position, children, data, ...rest } = node;
    const result: Node =
      node.type === "text" || node.type === "root" ? rest : { ...rest, position, data };
    if (!children) return result;
    const merged: Node[] = [];
    for (const child of children.map(comparable)) {
      const last = merged.at(-1);
      if (child.type === "text" && last?.type === "text") last.value += child.value ?? "";
      else merged.push(child);
    }
    // Blank text inside a table moves in front of it; the JSX runtime drops it in tables.
    const inTable = /^(?:table|thead|tbody|tfoot|tr)$/.test(node.tagName ?? "");
    result.children = merged.filter(
      (child, index) =>
        child.type !== "text" ||
        child.value?.trim() ||
        !(inTable || merged[index + 1]?.tagName === "table"),
    );
    return result;
  };
  const tree = (rehypePlugins: typeof CHAT_MARKDOWN_REHYPE_PLUGINS, markdown: string) => {
    const processor = unified()
      .use(remarkParse)
      .use(CHAT_MARKDOWN_REMARK_PLUGINS)
      .use(remarkRehype, { allowDangerousHtml: true })
      .use(rehypePlugins);
    return comparable(processor.runSync(processor.parse(markdown)) as Node);
  };
  const [first, , ...rest] = CHAT_MARKDOWN_REHYPE_PLUGINS;
  const withRaw = [first!, rehypeRaw, ...rest];
  for (const markdown of [
    "- [ ] open\n- [x] done\n\nNote[^1]\n\n[^1]: The note.",
    "| a | b |\n| :- | -: |\n| `c` | ![d](./d.png) |\n\n```ts title=x\nconst a = 1;\n```",
    // The HTML parser moves the footnote's link out of the label's link.
    "[note[^x]](https://example.com)\n\n[^x]: text",
    "**a** **b**\r\n> - | a |\r\n>   | - |\r\n>   | b |\r\n\n-\tx\n\n  y",
  ]) {
    expect(tree(CHAT_MARKDOWN_REHYPE_PLUGINS, markdown)).toEqual(tree(withRaw, markdown));
  }
});

it("keeps uppercase HTTP(S) link and image URLs by lowercasing the scheme before sanitizing", () => {
  const processor = unified()
    .use(remarkParse)
    .use(CHAT_MARKDOWN_REMARK_PLUGINS)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(CHAT_MARKDOWN_REHYPE_PLUGINS);
  type Node = { tagName?: string; properties?: object; children?: Node[] };
  const elements = (node: Node): Node[] => [
    ...(node.tagName === "a" || node.tagName === "img" ? [node] : []),
    ...(node.children ?? []).flatMap(elements),
  ];
  const tree = processor.runSync(
    processor.parse(
      [
        "[upper](HTTPS://Example.com/A?Key=Value#Part) [mixed](hTtP://Example.com/B) [js](JAVASCRIPT:alert(1))",
        "",
        "![shot](HTTPS://Example.com/Shot.png)",
        "",
        '<picture><source media="(prefers-color-scheme: dark)" srcset="HTTPS://Example.com/Dark.png"><img src="HTTP://Example.com/Light.png"></picture>',
      ].join("\n"),
    ),
  ) as Node;
  expect(elements(tree).map((node) => node.properties)).toEqual([
    { href: "https://Example.com/A?Key=Value#Part" },
    { href: "http://Example.com/B" },
    {},
    { src: "https://Example.com/Shot.png", alt: "shot", dataStandalone: true },
    { src: "http://Example.com/Light.png", dataDarkSrc: "https://Example.com/Dark.png" },
  ]);
});

it("keeps uppercase FILE link and image URLs by lowercasing the scheme before sanitizing", () => {
  const processor = unified()
    .use(remarkParse)
    .use(CHAT_MARKDOWN_REMARK_PLUGINS)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(CHAT_MARKDOWN_REHYPE_PLUGINS);
  type Node = { tagName?: string; properties?: object; children?: Node[] };
  const elements = (node: Node): Node[] => [
    ...(node.tagName === "a" || node.tagName === "img" ? [node] : []),
    ...(node.children ?? []).flatMap(elements),
  ];
  const markdown = [
    '[upper](FILE:///tmp/A.md) <a href="FiLe:///C:/Demo%20A.md">raw</a>',
    "",
    "![shot](FILE:///tmp/Shot.png)",
    "",
    '<picture><source media="(prefers-color-scheme: dark)" srcset="FILE:///tmp/Dark.png"><source media="(prefers-color-scheme: light)" srcset="FILE:///tmp/Light.png"><img src="FILE://host/tmp/Fallback.png"></picture>',
  ].join("\n");
  const tree = processor.runSync(processor.parse(markdown)) as Node;
  expect(elements(tree).map((node) => node.properties)).toEqual([
    { href: "file:///tmp/A.md" },
    { href: "file:///C:/Demo%20A.md" },
    { src: "file:///tmp/Shot.png", alt: "shot", dataStandalone: true },
    {
      src: "file://host/tmp/Fallback.png",
      dataDarkSrc: "file:///tmp/Dark.png",
      dataLightSrc: "file:///tmp/Light.png",
    },
  ]);
  expect(chatMarkdownImageSources(markdown)).toHaveLength(4);
});

it("keeps raw and percent-encoded Windows drive file links through the shared Markdown sanitizer", () => {
  const processor = unified()
    .use(remarkParse)
    .use(CHAT_MARKDOWN_REMARK_PLUGINS)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(CHAT_MARKDOWN_REHYPE_PLUGINS);
  type Node = { tagName?: string; properties?: { href?: string }; children?: Node[] };
  const hrefs = (node: Node): Array<string | undefined> => [
    ...(node.tagName === "a" ? [node.properties?.href] : []),
    ...(node.children ?? []).flatMap(hrefs),
  ];
  const tree = processor.runSync(
    processor.parse(
      [
        "[report.md](<C:%5CUsers%5Ctest%5Creport.md#L7>)",
        "[lower](c:%5cUsers/test%5creport.md)",
        "[raw](C:\\Users\\test\\report.md)",
        "[ref][win]",
        "",
        "[win]: <D:%5Cwork%5Creport.md#L12>",
      ].join("\n"),
    ),
  ) as Node;
  expect(hrefs(tree)).toEqual([
    "file:///C:/Users/test/report.md#L7",
    "file:///c:/Users/test/report.md",
    "file:///C:/Users/test/report.md",
    "file:///D:/work/report.md#L12",
  ]);
});

it("keeps backslashes that CommonMark would read as escapes in prose Windows paths", () => {
  const processor = unified()
    .use(remarkParse)
    .use(CHAT_MARKDOWN_REMARK_PLUGINS)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(CHAT_MARKDOWN_REHYPE_PLUGINS);
  type Node = { type: string; value?: string; tagName?: string; children?: Node[] };
  const text = (node: Node): string =>
    node.type === "text"
      ? (node.value ?? "")
      : node.tagName === "code"
        ? `<code>${(node.children ?? []).map(text).join("")}</code>`
        : (node.children ?? []).map(text).join("");
  const render = (markdown: string) => text(processor.runSync(processor.parse(markdown)) as Node);

  expect(
    render(String.raw`Saved to C:\Users\me\.t3\_build and (C:\.scratch) and C:/work\.config.`),
  ).toBe(String.raw`Saved to C:\Users\me\.t3\_build and (C:\.scratch) and C:/work\.config.`);
  expect(render(String.raw`Escaped C:\\Users\\me`)).toBe(String.raw`Escaped C:\\Users\\me`);
  expect(render(String.raw`See C:\x and \*this\* and Note:\*that\*.`)).toBe(
    String.raw`See C:\x and *this* and Note:*that*.`,
  );
  expect(render(String.raw`${"`"}C:\me\.t3${"`"} and C:\me\.t3`)).toBe(
    String.raw`<code>C:\me\.t3</code> and C:\me\.t3`,
  );
});

it("keeps an image on its own line under a label but leaves inline images inline", () => {
  const processor = unified()
    .use(remarkParse)
    .use(CHAT_MARKDOWN_REMARK_PLUGINS)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(CHAT_MARKDOWN_REHYPE_PLUGINS);
  type Node = { type: string; value?: string; tagName?: string; children?: Node[] };
  const shape = (node: Node): string =>
    node.type === "text"
      ? (node.value ?? "")
      : node.tagName === "br" || node.tagName === "img"
        ? `<${node.tagName}>`
        : (node.children ?? []).map(shape).join("");
  const render = (markdown: string) => shape(processor.runSync(processor.parse(markdown)) as Node);

  expect(
    render("**Palette**\n![Palette](/tmp/palette.png)\n**Hero** (dark)\n![Hero](/tmp/hero.png)"),
  ).toBe("Palette<br>\n<img><br>\nHero (dark)<br>\n<img>");
  expect(render("Built [![CI](/ci.svg)](/ci)\nand wrapped")).toBe("Built <img>\nand wrapped");
  expect(render("**Dialog** (native) ![a](/a.png) ![b](/b.png)")).toBe(
    "Dialog (native)<br>\n<img> <img>",
  );
  expect(render("Hard-wrapped\nprose")).toBe("Hard-wrapped\nprose");
});

it("keeps original task positions but removes synthetic recovered list-item positions", () => {
  const markdown =
    "This PR updates local tool config\n\n- [ ] Earlier\n-       Prose\n\n        - [ ] Nested\n\n- [ ] Parent\n  - [x] Standard nested\n";
  const processor = unified().use(remarkParse).use(CHAT_MARKDOWN_REMARK_PLUGINS);
  const tree = processor.runSync(processor.parse(markdown), markdown);
  type Node = {
    type: string;
    checked?: boolean | null;
    position?: { start: { offset?: number } };
    children?: Node[];
  };
  const tasks: Node[] = [];
  const collect = (node: Node) => {
    if (node.type === "listItem" && typeof node.checked === "boolean") tasks.push(node);
    node.children?.forEach(collect);
  };
  collect(tree as Node);
  expect(tasks).toHaveLength(4);
  expect(tasks.map((task) => task.position?.start.offset)).toEqual([
    markdown.indexOf("- [ ] Earlier"),
    undefined,
    markdown.indexOf("- [ ] Parent"),
    markdown.indexOf("- [x] Standard nested"),
  ]);
});

it("moves a <picture>'s color-scheme sources onto its <img>, which the renderer resolves", () => {
  const processor = unified()
    .use(remarkParse)
    .use(CHAT_MARKDOWN_REMARK_PLUGINS)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(CHAT_MARKDOWN_REHYPE_PLUGINS);
  type Node = { type: string; tagName?: string; properties?: object; children?: Node[] };
  const tags = (node: Node): string[] => [
    ...(node.tagName ? [node.tagName] : []),
    ...(node.children ?? []).flatMap(tags),
  ];
  const images = (node: Node): Node[] =>
    node.tagName === "img" ? [node] : (node.children ?? []).flatMap(images);
  const tree = processor.runSync(
    processor.parse(
      [
        "<picture>",
        '  <source media="(prefers-color-scheme: dark)" srcset="docs/dark.webp 1x, docs/dark@2x.webp 2x">',
        '  <source media="(prefers-color-scheme: dark)" srcset="docs/dark-unused.webp">',
        '  <source media="(min-width: 600px)" srcset="docs/wide.webp">',
        '  <img src="docs/light.webp" alt="Studio">',
        "</picture>",
        "",
        '<picture><source media="(prefers-color-scheme: light)" srcset="javascript:alert(1)"><img src="docs/dark.webp"></picture>',
        "",
        String.raw`<picture><source media="(prefers-color-scheme: dark)" srcset="C:\shots\dark.png"><img src="C:\shots\light.png"></picture>`,
        "",
        '<picture><source media="(prefers-color-scheme: dark)" srcset="https://example.com/a\u00a0b.png 2x"><img src="https://example.com/light.png"></picture>',
        "",
        '<picture><source media="(prefers-color-scheme: light)" srcset=" \thttps://example.com/\u00a0light\u00a0v2.png,\thttps://example.com/2x.png 2x"><img src="https://example.com/dark.png"></picture>',
      ].join("\n"),
    ),
  ) as Node;

  expect(tags(tree)).toEqual([
    "picture",
    "img",
    "p",
    "picture",
    "img",
    "p",
    "picture",
    "img",
    "p",
    "picture",
    "img",
    "p",
    "picture",
    "img",
  ]);
  expect(images(tree).map((image) => image.properties)).toEqual([
    { src: "docs/light.webp", alt: "Studio", dataDarkSrc: "docs/dark.webp" },
    { src: "docs/dark.webp" },
    { dataLocalSrc: String.raw`C:\shots\light.png`, dataDarkSrc: "file:///C:/shots/dark.png" },
    { src: "https://example.com/light.png", dataDarkSrc: "https://example.com/a\u00a0b.png" },
    {
      src: "https://example.com/dark.png",
      dataLightSrc: "https://example.com/\u00a0light\u00a0v2.png",
    },
  ]);
});

it("ends bare URLs at CJK punctuation and restores surrounding emphasis", () => {
  const parser = unified().use(remarkParse).use(CHAT_MARKDOWN_REMARK_PLUGINS);
  const source = "可以看了：**http://localhost:18780**（已重启）。";
  const result = parser.runSync(parser.parse(source), source);
  expect(result).toMatchObject({
    children: [
      {
        children: [
          { type: "text", value: "可以看了：" },
          { type: "strong", children: [{ type: "link", url: "http://localhost:18780" }] },
          { type: "text", value: "（已重启）。" },
        ],
      },
    ],
  });
  const explicit = "[https://example.com/a。b](https://example.com/a。b)";
  expect(parser.runSync(parser.parse(explicit), explicit)).toMatchObject({
    children: [{ children: [{ type: "link", url: "https://example.com/a。b" }] }],
  });
});

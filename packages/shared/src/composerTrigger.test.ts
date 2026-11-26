import remarkParse from "remark-parse";
import { unified } from "unified";
import { assert, describe, expect, it } from "vite-plus/test";

import { detectComposerTrigger, serializeComposerFileLink } from "./composerTrigger.ts";
import { resolveMarkdownFileLinkTarget } from "./markdownLinks.ts";

describe("detectComposerTrigger", () => {
  it.each(["\u3000", "\u00a0"])("detects completion after Unicode space %j", (space) => {
    for (const [token, kind, query] of [
      ["@src", "path", "src"],
      ["#123", "pull-request", "123"],
      ["$review", "skill", "review"],
      ["/model", "slash-command", "model"],
    ]) {
      const prefix = `日本語${space}`;
      const text = `${prefix}${token}`;
      expect(detectComposerTrigger(text, text.length)).toEqual({
        kind,
        query,
        rangeStart: prefix.length,
        rangeEnd: text.length,
      });
    }
  });

  it.each([
    ["Run /tmp/build.sh", "Run /tmp/build.sh".length],
    ["/etc/hosts", "/etc/hosts".length],
    ["Use /etc/hosts now", "Use /et".length],
    ["cmd /foo\\bar", "cmd /foo\\bar".length],
    ["/Windows\\System32", "/Windows\\System32".length],
  ])("keeps the path in %j out of the slash menu", (text, cursor) => {
    expect(detectComposerTrigger(text, cursor)).toBeNull();
  });

  it("keeps a slash in the line-leading model picker query", () => {
    expect(detectComposerTrigger("/model openai/gpt", 17)).toMatchObject({
      kind: "slash-model",
      query: "openai/gpt",
    });
  });

  it.each(["Use /", "Use /review"])("detects the inline slash token in %j", (text) => {
    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: "slash-command",
      query: text.slice(5),
      rangeStart: 4,
      rangeEnd: text.length,
    });
  });

  it.each(["Use/review", "https://example.com/review", "Use /review "])(
    "does not trigger for %j",
    (text) => expect(detectComposerTrigger(text, text.length)).toBeNull(),
  );

  it.each(["$", "€", "𑿝"])("detects %s skill prefixes and their source range", (prefix) => {
    const text = `Use ${prefix}review`;
    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: "skill",
      query: "review",
      rangeStart: 4,
      rangeEnd: text.length,
    });
  });

  it.each([
    "budget $9.99",
    "only $.99",
    "about €20",
    "raise $10k",
    "$1,000",
    "£2e6",
    "raise $10k.",
  ])("does not open the skill menu for the amount in %j", (text) =>
    expect(detectComposerTrigger(text, text.length)).toBeNull(),
  );

  it.each(["$", "$1password", "$2fa"])("still detects the skill prefix %j", (text) => {
    expect(detectComposerTrigger(text, text.length)).toMatchObject({
      kind: "skill",
      query: text.slice(1),
    });
  });
});

describe("serializeComposerFileLink", () => {
  it.each(["reports:final.md", "file:notes.md"])("disambiguates the colon filename %s", (path) => {
    const link = serializeComposerFileLink(path);
    expect(link).toBe(`[${path}](./${path})`);
    expect(resolveMarkdownFileLinkTarget(`./${path}`, "/workspace")).toBe(`/workspace/${path}`);
  });

  it("encodes markdown-sensitive destination characters", () => {
    expect(serializeComposerFileLink("docs/My File (draft).md")).toBe(
      "[My File (draft).md](docs/My%20File%20%28draft%29.md)",
    );
  });

  it("preserves literal HTML entities in the file label and destination", () => {
    const path = "docs/R&copy;.md";
    const paragraph = unified().use(remarkParse).parse(serializeComposerFileLink(path)).children[0];
    assert(paragraph?.type === "paragraph");
    const link = paragraph.children[0];
    assert(link?.type === "link");
    expect(link.children).toMatchObject([{ type: "text", value: "R&copy;.md" }]);
    expect(resolveMarkdownFileLinkTarget(link.url, "/workspace")).toBe(`/workspace/${path}`);
  });

  it("supports windows paths", () => {
    expect(serializeComposerFileLink("C:\\repo\\src\\index.ts")).toBe(
      "[index.ts](C:%5Crepo%5Csrc%5Cindex.ts)",
    );
  });

  it("preserves paths that legitimately start with an at sign", () => {
    expect(serializeComposerFileLink("@scope/package.json")).toBe(
      "[package.json](@scope/package.json)",
    );
  });
});

import type {
  Heading,
  Link,
  Paragraph,
  PhrasingContent,
  Root,
  RootContent,
  TableCell,
  Text,
} from "mdast";
import { isLocalEditorFileUrl } from "@t3tools/contracts";
import { remarkKeepWindowsPaths } from "./markdownWindowsPaths.ts";
import { type PluggableList, type Processor, unified } from "unified";
import remarkParse from "remark-parse";
import type { Transformer } from "unified";
import remarkRehype from "remark-rehype";
import { find, html } from "property-information";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { remarkGithubAlerts } from "./markdownGithubAlerts.ts";
import {
  remarkEnableLeadingWhitespace,
  remarkKeepLeadingWhitespace,
} from "./markdownLeadingWhitespace.ts";
import { remarkNormalizeListItemIndentation } from "./markdownListIndentation.ts";
import {
  remarkEnableOrderedListNumbers,
  remarkKeepOrderedListNumbers,
} from "./markdownOrderedListNumbers.ts";
import {
  CODEX_ARTIFACT_TEMPLATE_HAST_PROPERTIES,
  remarkCodexDirectives,
} from "./codexMarkdownDirectives.ts";
import {
  isWindowsDrivePathHref,
  normalizeMarkdownLinkDestination,
  parseMarkdownSandboxFileLink,
} from "./markdownLinks.ts";
import { THREAD_LINK_PROTOCOL } from "./threadLinks.ts";

type MarkdownImageHastNode = {
  type?: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: MarkdownImageHastNode[];
};

function meaningfulHastChildren(node: MarkdownImageHastNode): MarkdownImageHastNode[] {
  return (node.children ?? []).filter(
    (child) => !(child.type === "text" && (child as { value?: string }).value?.trim() === ""),
  );
}

const STANDALONE_IMAGE_BLOCKS = new Set([
  "p",
  "div",
  "li",
  "td",
  "th",
  "figure",
  "center",
  "blockquote",
]);

function soleImageDescendant(node: MarkdownImageHastNode): MarkdownImageHastNode | undefined {
  const children = meaningfulHastChildren(node);
  if (children.length !== 1) return undefined;
  const only = children[0];
  if (only?.type !== "element") return undefined;
  if (only.tagName === "img") return only;
  return only.tagName === "a" || only.tagName === "strong" || only.tagName === "em"
    ? soleImageDescendant(only)
    : undefined;
}

function markStandaloneImages(node: MarkdownImageHastNode) {
  if (node.type === "root" || (node.tagName && STANDALONE_IMAGE_BLOCKS.has(node.tagName))) {
    const image = soleImageDescendant(node);
    if (image) image.properties = { ...image.properties, dataStandalone: true };
  }
  node.children?.forEach((child) => {
    if (child.type === "element") markStandaloneImages(child);
  });
}

function rehypePreserveBareAnchorPlaceholders() {
  return (tree: MarkdownImageHastNode) => {
    const anchors: Array<MarkdownImageHastNode | null> = [];
    let rawTextTag: string | undefined;
    const visit = (node: MarkdownImageHastNode) => {
      if (node.type === "raw" && typeof node.value === "string") {
        // Scan whole tags, attributes, and comments so embedded closing-anchor text cannot match a placeholder.
        const tags = /<!--[\s\S]*?(?:-->|$)|<\/?[A-Za-z](?:[^"'<>]|"[^"]*"|'[^']*')*>/g;
        let offset = 0;
        while (rawTextTag !== "plaintext") {
          // Raw text ends at its closing tag even inside comment-looking text.
          const matcher = rawTextTag ? new RegExp(`</${rawTextTag}\\s*>`, "gi") : tags;
          matcher.lastIndex = offset;
          const match = matcher.exec(node.value);
          if (!match) break;
          const [tag] = match;
          offset = matcher.lastIndex;
          if (rawTextTag) {
            rawTextTag = undefined;
            continue;
          }
          if (tag.startsWith("<!--")) continue;
          const closing = /^<\/([a-z]+)\s*>$/i.exec(tag)?.[1]?.toLowerCase();
          const opening = /^<([a-z]+)(?:\s|\/?>)/i.exec(tag)?.[1]?.toLowerCase();
          if (
            opening &&
            /^(?:script|style|textarea|title|xmp|iframe|noembed|noframes|plaintext)$/.test(opening)
          ) {
            rawTextTag = opening;
          } else if (opening === "a") {
            anchors.push(node.value === tag && /^<a\s*\/?>$/i.test(tag) ? node : null);
          } else if (closing === "a") {
            anchors.pop();
          }
        }
      }
      node.children?.forEach(visit);
    };

    visit(tree);
    for (const anchor of anchors) {
      if (anchor) anchor.type = "text";
    }
  };
}

const COLOR_SCHEME_MEDIA = /^\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)$/i;
const FIRST_SRCSET_URL = /^[\t\n\f\r ]*([^\t\n\f\r ]+)/;

/**
 * The renderer resolves an `<img>`'s `src` (workspace files, host media) but never a `<source>`'s
 * `srcset`, which would load unresolved whenever its media matched. A color-scheme source moves
 * onto the `<img>` for the renderer to pick by theme; every source is then dropped.
 */
function moveColorSchemeSourcesToImage(picture: MarkdownImageHastNode) {
  if (!picture.children) return;
  const image = picture.children.find((child) => child.tagName === "img");
  for (const source of picture.children) {
    if (source.tagName !== "source" || !image) continue;
    const media = source.properties?.media;
    const scheme = typeof media === "string" ? COLOR_SCHEME_MEDIA.exec(media)?.[1] : undefined;
    const srcSet = source.properties?.srcSet;
    const candidate = Array.isArray(srcSet) ? srcSet[0] : srcSet;
    const url =
      typeof candidate === "string"
        ? (FIRST_SRCSET_URL.exec(candidate)?.[1]?.replace(/,+$/, "") ?? "")
        : "";
    const key = scheme?.toLowerCase() === "dark" ? "dataDarkSrc" : "dataLightSrc";
    // As in a browser, the first source that matches a scheme is the one shown.
    if (scheme && url && image.properties?.[key] === undefined) {
      // The sanitizer reads a drive letter as a protocol; as a file URL it resolves to the same path.
      const value = isWindowsDrivePathHref(url) ? `file:///${url.replaceAll("\\", "/")}` : url;
      image.properties = { ...image.properties, [key]: value };
    }
  }
  picture.children = picture.children.filter((child) => child.tagName !== "source");
}

function normalizeHttpScheme(url: string): string {
  return url.replace(/^(?:https?|file):/i, (scheme) => scheme.toLowerCase());
}

function rehypePreserveImageSourceMeta() {
  return (tree: MarkdownImageHastNode) => {
    const visit = (node: MarkdownImageHastNode) => {
      const src = node.properties?.src;
      const title = node.properties?.title;
      if (node.type === "element" && node.tagName === "picture") {
        moveColorSchemeSourcesToImage(node);
      }
      if (node.type === "element" && node.tagName === "img") {
        node.properties = {
          ...node.properties,
          ...(typeof src === "string" && isWindowsDrivePathHref(src) ? { dataLocalSrc: src } : {}),
          ...(typeof title === "string" ? { dataMarkdownTitle: title } : {}),
        };
        for (const key of ["src", "dataDarkSrc", "dataLightSrc"]) {
          const value = node.properties[key];
          if (typeof value === "string") node.properties[key] = normalizeHttpScheme(value);
        }
      }
      node.children?.forEach(visit);
    };

    visit(tree);
    markStandaloneImages(tree);
  };
}

function rehypeNormalizeLocalFileLinks() {
  return (tree: MarkdownImageHastNode) => {
    const visit = (node: MarkdownImageHastNode) => {
      const href = node.properties?.href;
      if (node.type === "element" && node.tagName === "a" && typeof href === "string") {
        // The sanitizer compares schemes case-sensitively, so lowercase accepted link schemes first.
        const lowered = normalizeHttpScheme(href);
        if (/^sandbox:/i.test(lowered)) {
          node.properties = { ...node.properties };
          if (parseMarkdownSandboxFileLink(lowered)) {
            node.properties.href = lowered.replace(/^sandbox:/i, "sandbox:");
          } else {
            delete node.properties.href;
          }
        } else if (lowered !== href) {
          node.properties = { ...node.properties, href: lowered };
        } else {
          try {
            const url = new URL(href);
            if (url.protocol === "cursor:" || url.protocol === "vscode:") {
              node.properties = { ...node.properties };
              if (isLocalEditorFileUrl(url)) node.properties.href = url.href;
              else delete node.properties.href;
            }
          } catch {}
        }
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

const IMAGE_SRC_PROTOCOLS = [...(defaultSchema.protocols?.src ?? []), "file", "t3-context"];

const CHAT_MARKDOWN_SANITIZE_SCHEMA = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    "*": (defaultSchema.attributes?.["*"] ?? []).filter((attribute) => attribute !== "title"),
    // Fence languages plus the two math classes the web chat's math plugin emits.
    code: [
      ["className", /^language-./, "math-inline", "math-display"],
      "dataCodeMeta",
      "dataInlineCode",
    ],
    blockquote: [...(defaultSchema.attributes?.blockquote ?? []), "dataAlert"],
    span: [...(defaultSchema.attributes?.span ?? []), "dataLeadingWhitespace"],
    div: [...(defaultSchema.attributes?.div ?? []), ...CODEX_ARTIFACT_TEMPLATE_HAST_PROPERTIES],
    a: [...(defaultSchema.attributes?.a ?? []), "dataPullRequestAutolink"],
    img: [
      ...(defaultSchema.attributes?.img ?? []),
      "dataDarkSrc",
      "dataLightSrc",
      "dataLocalSrc",
      "dataMarkdownTitle",
      "dataStandalone",
    ],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: [
      ...(defaultSchema.protocols?.href ?? []),
      "file",
      "cursor",
      "vscode",
      "t3-citation",
      "t3-context",
      THREAD_LINK_PROTOCOL,
    ],
    src: IMAGE_SRC_PROTOCOLS,
    dataDarkSrc: IMAGE_SRC_PROTOCOLS,
    dataLightSrc: IMAGE_SRC_PROTOCOLS,
  },
} satisfies Parameters<typeof rehypeSanitize>[0];

export const CHAT_MARKDOWN_REMARK_PLUGINS: PluggableList = [
  remarkGfm,
  remarkKeepWindowsPaths,
  remarkEndAutolinksAtCjkPunctuation,
  remarkGithubAlerts,
  remarkKeepOrderedListNumbers,
  remarkNormalizeListItemIndentation,
  remarkCodexDirectives,
  remarkBreakAroundImageLines,
  remarkPreserveCodeMeta,
  remarkNormalizeLinksAndTagInlineCode,
];

export const CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS: PluggableList = [
  remarkGfm,
  remarkKeepLeadingWhitespace,
  remarkKeepWindowsPaths,
  remarkEndAutolinksAtCjkPunctuation,
  remarkGithubAlerts,
  remarkKeepOrderedListNumbers,
  remarkNormalizeListItemIndentation,
  remarkCodexDirectives,
  remarkBreakAroundImageLines,
  remarkBreaks,
  remarkPreserveCodeMeta,
  remarkNormalizeLinksAndTagInlineCode,
];

// Users type paths like ~/a and (~/b, which GFM's single-tilde strikethrough hides as <del>.
// Appended after the base list, this reconfigures its remark-gfm entry; ~~double~~ still strikes.
export const CHAT_USER_MARKDOWN_REMARK_PLUGINS: PluggableList = [
  remarkEnableOrderedListNumbers,
  [remarkGfm, { singleTilde: false }],
  remarkEnableLeadingWhitespace,
];

// Start tags an HTML parser closes an open `<p>` for.
const CLOSES_PARAGRAPH = new Set(
  "address article aside blockquote center details dialog dir div dl fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr li listing main menu nav ol p plaintext pre search section summary table ul xmp dd dt".split(
    " ",
  ),
);
const HEADING = /^h[1-6]$/;

interface HtmlScope {
  readonly anchor: boolean;
  readonly paragraph: boolean;
  readonly heading: boolean;
}

/**
 * Whether the tree needs the HTML parser: raw HTML, or nesting it repairs (a footnote call in a
 * link label nests `<a>`). Otherwise it only rewrites properties as hast-util-to-parse5 does and
 * drops `data`, both repeated here, and moves blank text that renders the same.
 */
function needsHtmlParser(node: MarkdownImageHastNode, scope: HtmlScope): boolean {
  if (node.type === "raw") return true;
  let inner = scope;
  if (node.type === "element" && node.tagName) {
    const { tagName } = node;
    const heading = HEADING.test(tagName);
    if (
      (tagName === "a" && scope.anchor) ||
      (scope.paragraph && CLOSES_PARAGRAPH.has(tagName)) ||
      (heading && scope.heading)
    ) {
      return true;
    }
    inner = {
      anchor: scope.anchor || tagName === "a",
      paragraph: scope.paragraph || tagName === "p",
      heading: scope.heading || heading,
    };
    const properties = node.properties ?? {};
    for (const key of Object.keys(properties)) {
      const value = properties[key];
      const info = find(html, key);
      if (
        value === false ||
        value === null ||
        value === undefined ||
        Number.isNaN(value) ||
        (!value && info.boolean)
      ) {
        delete properties[key];
      } else if (value === true && !info.boolean && !info.overloadedBoolean) {
        properties[key] = "";
      }
    }
    delete (node as { data?: unknown }).data;
  }
  return (node.children ?? []).some((child) => needsHtmlParser(child, inner));
}

const TOP_SCOPE: HtmlScope = { anchor: false, paragraph: false, heading: false };

/** rehype-raw reparses the whole tree through an HTML parser, which most trees can skip. */
function rehypeRawWhenPresent(this: Processor) {
  const transform = rehypeRaw.call(this) as unknown as (
    tree: MarkdownImageHastNode,
    file: unknown,
  ) => unknown;
  return (tree: MarkdownImageHastNode, file: unknown) =>
    needsHtmlParser(tree, TOP_SCOPE) ? transform(tree, file) : undefined;
}

export const CHAT_MARKDOWN_REHYPE_PLUGINS: PluggableList = [
  rehypePreserveBareAnchorPlaceholders,
  rehypeRawWhenPresent,
  rehypePreserveImageSourceMeta,
  rehypeNormalizeLocalFileLinks,
  [rehypeSanitize, CHAT_MARKDOWN_SANITIZE_SCHEMA],
];

const isImageNode = (node: PhrasingContent | undefined): boolean =>
  node?.type === "image" ||
  node?.type === "imageReference" ||
  ((node?.type === "link" || node?.type === "linkReference") &&
    node.children.length === 1 &&
    isImageNode(node.children[0]));
const endsLine = (node: PhrasingContent | undefined) =>
  node === undefined ||
  node.type === "break" ||
  (node.type === "text" && /(?:\r\n|\r|\n)[ \t]*$/.test(node.value));
const startsLine = (node: PhrasingContent | undefined) =>
  node === undefined ||
  node.type === "break" ||
  (node.type === "text" && /^[ \t]*(?:\r\n|\r|\n)/.test(node.value));

// A caption line ending in a screenshot reads as a figure, so the trailing images get a line.
function trailingImagesStart(children: readonly PhrasingContent[]): number | undefined {
  let start: number | undefined;
  for (let index = children.length - 1; index >= 0; index--) {
    const child = children[index]!;
    if (isImageNode(child)) start = index;
    else if (child.type !== "break" && !(child.type === "text" && !child.value.trim()))
      return start;
  }
  return undefined;
}

function breakLinesAroundImages(paragraph: Paragraph) {
  const children = paragraph.children;
  if (!children.some(isImageNode)) return;
  const ownsLine = (index: number) =>
    isImageNode(children[index]) &&
    endsLine(children[index - 1]) &&
    startsLine(children[index + 1]);
  const trailingStart = trailingImagesStart(children);
  paragraph.children = children.flatMap((child, index): PhrasingContent[] => {
    // Kept indentation after a line ending already sits on a line of its own.
    const beforeTrailing =
      index + 1 === trailingStart &&
      !(child.type === "text" && !child.value.trim() && endsLine(children[index - 1]));
    if (child.type !== "text") {
      return beforeTrailing && child.type !== "break" ? [child, { type: "break" }] : [child];
    }
    const afterImage = ownsLine(index - 1);
    const beforeImage = ownsLine(index + 1);
    if (!afterImage && !beforeImage && !beforeTrailing) return [child];
    const parts: PhrasingContent[] = [];
    let value = child.value;
    if (afterImage) {
      value = value.replace(/^[ \t]*(?:\r\n|\r|\n)/, "");
      parts.push({ type: "break" });
    }
    const breakAfter = (beforeImage && /(?:\r\n|\r|\n)[ \t]*$/.test(value)) || beforeTrailing;
    if (breakAfter) value = value.replace(/[ \t]*(?:(?:\r\n|\r|\n)[ \t]*)?$/, "");
    if (value) parts.push({ type: "text", value });
    if (breakAfter) parts.push({ type: "break" });
    return parts;
  });
}

/**
 * Agents label screenshots with a line like `**Palette**` right above the image. CommonMark
 * joins those lines into one paragraph, which puts the image inline beside its label. An
 * image alone on its source line keeps that line; prose and inline badges still wrap.
 */
function remarkBreakAroundImageLines() {
  return (tree: Root) => {
    const visit = (node: Root | RootContent) => {
      if (node.type === "paragraph") breakLinesAroundImages(node);
      else if ("children" in node) node.children.forEach(visit);
    };
    visit(tree);
  };
}

type MarkdownAstNode = {
  type?: string;
  meta?: unknown;
  url?: string;
  data?: {
    hProperties?: Record<string, unknown>;
  };
  children?: MarkdownAstNode[];
};

function remarkPreserveCodeMeta() {
  return (tree: MarkdownAstNode) => {
    const visit = (node: MarkdownAstNode) => {
      if (node.type === "code" && typeof node.meta === "string" && node.meta.trim().length > 0) {
        node.data = {
          ...node.data,
          hProperties: {
            ...node.data?.hProperties,
            dataCodeMeta: node.meta.trim(),
          },
        };
      }
      node.children?.forEach(visit);
    };

    visit(tree);
  };
}

const CJK_PUNCTUATION = /(?=[　-〿＀-￯])[\p{P}\p{S}]/u;

function cjkPunctuationIndex(link: Link): number {
  const label = link.children.length === 1 ? link.children[0] : undefined;
  if (label?.type !== "text" || !/^https?:\/\//i.test(link.url)) return -1;
  if (link.url !== label.value && link.url !== `http://${label.value}`) return -1;
  const index = label.value.search(/[^!-~]/u);
  return index > 0 && CJK_PUNCTUATION.test(label.value.charAt(index)) ? index : -1;
}

function isBareLink(link: Link, source: string): boolean {
  const start = link.position?.start.offset;
  const end = link.position?.end.offset;
  const label = link.children[0];
  return (
    !link.position ||
    (start !== undefined &&
      end !== undefined &&
      label?.type === "text" &&
      source.slice(start, end) === label.value)
  );
}

function cjkPunctuationOffsets(node: RootContent, source: string): number[] {
  if (node.type === "link") {
    const index = cjkPunctuationIndex(node);
    const start = node.position?.start.offset;
    return index > 0 && start !== undefined && isBareLink(node, source) ? [start + index] : [];
  }
  return "children" in node && node.type !== "linkReference"
    ? (node.children as RootContent[]).flatMap((child) => cjkPunctuationOffsets(child, source))
    : [];
}

const hasReference = (node: RootContent): boolean =>
  node.type === "linkReference" ||
  node.type === "imageReference" ||
  node.type === "footnoteReference" ||
  ("children" in node && (node.children as RootContent[]).some(hasReference));

function countBelow(sorted: readonly number[], value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (sorted[middle]! < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

function reparseAtCjkPunctuation(
  processor: Processor,
  block: Paragraph | Heading | TableCell,
  source: string,
  offsets: number[],
): boolean {
  const from = block.children[0]?.position?.start;
  const to = block.children.at(-1)?.position?.end;
  if (from?.offset === undefined || to?.offset === undefined || hasReference(block)) return false;
  const base = from.offset;
  const text = source.slice(base, to.offset);

  if (
    text.includes("\t") ||
    /[\r\n][ ]*>/.test(text) ||
    (/[\r\n] /.test(text) && text.includes("`")) ||
    (block.type === "tableCell" && text.includes("\\|"))
  ) {
    return false;
  }
  const marks = offsets.map((offset) => offset - base);

  for (let attempt = 0; attempt < 16; attempt++) {
    marks.sort((a, b) => a - b);
    const tabs = marks.map((mark, index) => mark + index);
    const unmarked = (offset: number) => offset - countBelow(tabs, offset);
    const marked = [0, ...marks]
      .map((start, index) => text.slice(start, marks[index] ?? text.length))
      .join("\t");
    const [paragraph, ...rest] = (processor.parse(marked) as Root).children;
    if (paragraph?.type !== "paragraph" || rest.length > 0) return false;
    const more = cjkPunctuationOffsets(paragraph, marked);
    if (more.length > 0) {
      marks.push(...more.map(unmarked));
      continue;
    }

    let tabCount = 0;
    const moved = new Set<object>();
    const restore = (node: RootContent): boolean => {
      for (const point of node.position ? [node.position.start, node.position.end] : []) {
        const offset = point.offset;
        if (offset === undefined || moved.has(point)) continue;
        moved.add(point);
        const tabsOnLine = countBelow(tabs, offset) - countBelow(tabs, offset - point.column + 1);
        point.column = (point.line === 1 ? from.column - 1 : 0) + point.column - tabsOnLine;
        point.line += from.line - 1;
        point.offset = base + unmarked(offset);
      }
      if (node.type === "text") {
        tabCount += node.value.split("\t").length - 1;
        node.value = node.value.replaceAll("\t", "");
      } else if (
        ("value" in node && node.value.includes("\t")) ||
        ("url" in node && node.url.includes("\t"))
      ) {
        return false;
      }
      if (!("children" in node)) return true;
      const children = node.children as RootContent[];
      if (!children.every(restore)) return false;
      node.children = children.filter(
        (child) => child.type !== "text" || child.value !== "",
      ) as typeof node.children;
      return true;
    };
    if (!restore(paragraph) || tabCount !== tabs.length) return false;
    block.children = paragraph.children;
    return true;
  }
  return false;
}

function splitAtCjkPunctuation(node: RootContent, source: string) {
  if (!("children" in node) || node.type === "link" || node.type === "linkReference") return;
  const children = node.children as RootContent[];
  for (let index = 0; index < children.length; index++) {
    const child = children[index]!;
    if (child.type !== "link") {
      splitAtCjkPunctuation(child, source);
      continue;
    }
    const at = isBareLink(child, source) ? cjkPunctuationIndex(child) : -1;
    const label = child.children[0];
    if (at < 0 || label?.type !== "text") continue;

    const length = label.value.slice(0, at).replace(/[!"'*,.:;?_~]+$/, "").length;
    const tail: Text = { type: "text", value: label.value.slice(length) };
    const start = child.position?.start;
    if (child.position && start?.offset !== undefined) {
      const end = {
        line: start.line,
        column: start.column + length,
        offset: start.offset + length,
      };
      tail.position = { start: end, end: child.position.end };
      child.position = { start, end };
      label.position = { start, end };
    }
    child.url = child.url.slice(0, child.url.length - label.value.length + length);
    label.value = label.value.slice(0, length);
    children.splice(index + 1, 0, tail);
    index++;
  }
}

function remarkEndAutolinksAtCjkPunctuation(this: Processor): Transformer<Root> {
  return (tree, file) => {
    const source = String(file);
    if (!CJK_PUNCTUATION.test(source)) return;
    const visit = (node: RootContent) => {
      if (node.type === "paragraph" || node.type === "heading" || node.type === "tableCell") {
        const offsets = cjkPunctuationOffsets(node, source);
        if (offsets.length > 0) reparseAtCjkPunctuation(this, node, source, offsets);
        splitAtCjkPunctuation(node, source);
      } else if ("children" in node) {
        (node.children as RootContent[]).forEach(visit);
      }
    };
    tree.children.forEach(visit);
  };
}

function remarkNormalizeLinksAndTagInlineCode() {
  return (tree: MarkdownAstNode) => {
    const visit = (node: MarkdownAstNode, insideLink: boolean) => {
      if ((node.type === "link" || node.type === "definition") && typeof node.url === "string") {
        const path = node.url.replace(/%5C/gi, "\\");
        if (/^[A-Za-z]:[\\/]/.test(path)) {
          node.url = `file:///${path.replaceAll("\\", "/")}`;
        }
      }
      if (node.type === "inlineCode" && !insideLink) {
        node.data = {
          ...node.data,
          hProperties: {
            ...node.data?.hProperties,
            dataInlineCode: "",
          },
        };
      }
      const childInsideLink = insideLink || node.type === "link" || node.type === "linkReference";
      node.children?.forEach((child) => visit(child, childInsideLink));
    };

    visit(tree, false);
  };
}

export { shouldPreserveAssistantLineBreaks } from "./assistantInsights.ts";

const imageSourceProcessor = unified()
  .use(remarkParse)
  .use(CHAT_MARKDOWN_REMARK_PLUGINS)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(CHAT_MARKDOWN_REHYPE_PLUGINS);

interface ImageSourceNode {
  readonly type: string;
  readonly tagName?: string;
  readonly properties?: {
    readonly src?: unknown;
    readonly dataLocalSrc?: unknown;
    readonly dataDarkSrc?: unknown;
    readonly dataLightSrc?: unknown;
  };
  readonly children?: ReadonlyArray<ImageSourceNode>;
}

/**
 * The sources of the images chat markdown shows, read as ChatMarkdown's `img` renderer reads
 * them. Code, comments, and plain links show no image, so they add none.
 */
export function chatMarkdownImageSources(markdown: string): Array<string> {
  const sources: Array<string> = [];
  const visit = (node: ImageSourceNode) => {
    if (node.type === "element" && node.tagName === "img") {
      const { src, dataLocalSrc, dataDarkSrc, dataLightSrc } = node.properties ?? {};
      // The sanitizer drops a Windows drive path from `src`; the renderer reads it from here.
      if (typeof dataLocalSrc === "string") {
        sources.push(normalizeMarkdownLinkDestination(dataLocalSrc).replaceAll("\\", "/"));
      } else if (typeof src === "string") {
        sources.push(normalizeMarkdownLinkDestination(src));
      }
      // A `<picture>` shows one of these instead, by the viewer's theme.
      for (const variant of [dataDarkSrc, dataLightSrc]) {
        if (typeof variant === "string") sources.push(normalizeMarkdownLinkDestination(variant));
      }
    }
    node.children?.forEach(visit);
  };
  visit(imageSourceProcessor.runSync(imageSourceProcessor.parse(markdown)) as ImageSourceNode);
  return sources;
}

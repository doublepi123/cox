import { parseMarkdownFileLink } from "./markdownLinks.ts";

export type ComposerTriggerKind =
  | "path"
  | "pull-request"
  | "slash-command"
  | "slash-model"
  | "skill";
export type ComposerSlashCommand = "model" | "plan" | "default";

export interface ComposerTrigger {
  kind: ComposerTriggerKind;
  query: string;
  rangeStart: number;
  rangeEnd: number;
}

function composerFileLinkBasename(path: string): string {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separatorIndex >= 0 ? path.slice(separatorIndex + 1) : path;
}

function escapeMarkdownLinkLabel(label: string): string {
  return label
    .replaceAll("\\", "\\\\")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replaceAll("&", "\\&");
}

function encodeMarkdownLinkDestination(path: string): string {
  return encodeURI(path)
    .replaceAll("(", "%28")
    .replaceAll(")", "%29")
    .replaceAll("&", "%26")
    .replaceAll("#", "%23")
    .replaceAll("?", "%3F")
    .replaceAll("\\", "%5C");
}

const DRIVE_OR_ROOTED_PATH_PATTERN = /^(?:[a-z]:[\\/]|[\\/])/i;
const URI_SCHEME_PREFIX_PATTERN = /^[a-z][a-z\d+.-]*:/i;

// Relative paths need `./` when the parser rejects them or reads their prefix as a URI scheme.
function needsDotSlashPrefix(path: string): boolean {
  return (
    path.length > 0 &&
    !DRIVE_OR_ROOTED_PATH_PATTERN.test(path) &&
    (URI_SCHEME_PREFIX_PATTERN.test(path) ||
      !parseMarkdownFileLink(encodeMarkdownLinkDestination(path)))
  );
}

export function serializeComposerFileLink(path: string): string {
  const label = escapeMarkdownLinkLabel(composerFileLinkBasename(path));
  const destination = encodeMarkdownLinkDestination(path);
  return `[${label}](${needsDotSlashPrefix(path) ? `./${destination}` : destination})`;
}

/** The file a composer link names. Drops only the `./` serializeComposerFileLink adds, not one the author wrote. */
export function composerFileLinkPath(encodedDestination: string, decodedPath: string): string {
  if (!encodedDestination.startsWith("./")) return decodedPath;
  const bare = decodedPath.slice(2);
  return needsDotSlashPrefix(bare) &&
    encodeMarkdownLinkDestination(bare) === encodedDestination.slice(2)
    ? bare
    : decodedPath;
}

function clampCursor(text: string, cursor: number): number {
  if (!Number.isFinite(cursor)) return text.length;
  return Math.max(0, Math.min(text.length, Math.floor(cursor)));
}

function isWhitespace(char: string): boolean {
  return /\s/.test(char);
}

/** A second slash or backslash makes the whole word a path, even when the caret precedes it. */
export function isPathWord(
  text: string,
  wordStart: number,
  cursor: number,
  isWhitespaceChar: (char: string) => boolean,
): boolean {
  let wordEnd = cursor;
  while (wordEnd < text.length && !isWhitespaceChar(text[wordEnd] ?? "")) {
    wordEnd += 1;
  }
  return /[/\\]/.test(text.slice(wordStart + 1, wordEnd));
}

/**
 * `$5`, `€9.99` and `$10k` are money, not skills. Matches the amounts the inline skill
 * token regexes already refuse to render as skills, plus the punctuation prose puts after
 * one (`$10k.`, `($5)`).
 */
export function isCurrencyAmountQuery(query: string): boolean {
  return /^\.?[0-9][0-9,._]*(?:[kKmMbBtT]|[eE][0-9]+)?[.,;:!?)]*$/.test(query);
}

export function detectComposerTrigger(
  text: string,
  cursorInput: number,
  isWhitespaceChar?: (char: string) => boolean,
): ComposerTrigger | null {
  const cursor = clampCursor(text, cursorInput);
  const lineStart = text.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
  const linePrefix = text.slice(lineStart, cursor);

  if (linePrefix.startsWith("/")) {
    const commandMatch = /^\/(\S*)$/.exec(linePrefix);
    if (commandMatch && isPathWord(text, lineStart, cursor, isWhitespaceChar ?? isWhitespace)) {
      return null;
    }
    if (commandMatch) {
      const commandQuery = commandMatch[1] ?? "";
      if (commandQuery.toLowerCase() === "model") {
        return {
          kind: "slash-model",
          query: "",
          rangeStart: lineStart,
          rangeEnd: cursor,
        };
      }
      return {
        kind: "slash-command",
        query: commandQuery,
        rangeStart: lineStart,
        rangeEnd: cursor,
      };
    }

    const modelMatch = /^\/model(?:\s+(.*))?$/.exec(linePrefix);
    if (modelMatch) {
      return {
        kind: "slash-model",
        query: (modelMatch[1] ?? "").trim(),
        rangeStart: lineStart,
        rangeEnd: cursor,
      };
    }
  }

  const wsCheck = isWhitespaceChar ?? isWhitespace;
  let tokenIdx = cursor - 1;
  while (tokenIdx >= 0 && !wsCheck(text[tokenIdx] ?? "")) {
    tokenIdx -= 1;
  }
  const tokenStart = tokenIdx + 1;

  const token = text.slice(tokenStart, cursor);
  if (token.startsWith("/")) {
    if (isPathWord(text, tokenStart, cursor, wsCheck)) return null;
    return {
      kind: "slash-command",
      query: token.slice(1),
      rangeStart: tokenStart,
      rangeEnd: cursor,
    };
  }
  const pullRequestMatch = /^#([\p{L}\p{N}][\p{L}\p{N}_-]*)?$/u.exec(token);
  if (pullRequestMatch)
    return {
      kind: "pull-request",
      query: pullRequestMatch[1] ?? "",
      rangeStart: tokenStart,
      rangeEnd: cursor,
    };
  const skillPrefix = /^\p{Sc}/u.exec(token);
  if (skillPrefix) {
    if (isCurrencyAmountQuery(token.slice(skillPrefix[0].length))) return null;
    return {
      kind: "skill",
      query: token.slice(skillPrefix[0].length),
      rangeStart: tokenStart,
      rangeEnd: cursor,
    };
  }
  if (!token.startsWith("@")) {
    return null;
  }

  return {
    kind: "path",
    query: token.slice(1),
    rangeStart: tokenStart,
    rangeEnd: cursor,
  };
}

export function replaceTextRange(
  text: string,
  rangeStart: number,
  rangeEnd: number,
  replacement: string,
): { text: string; cursor: number } {
  const safeStart = Math.max(0, Math.min(text.length, rangeStart));
  const safeEnd = Math.max(safeStart, Math.min(text.length, rangeEnd));
  const nextText = `${text.slice(0, safeStart)}${replacement}${text.slice(safeEnd)}`;
  return { text: nextText, cursor: safeStart + replacement.length };
}

/** A message that only invokes a slash command, such as `/context all`, not a path like `/src/a.ts`. */
export function isSlashCommand(message: {
  readonly text: string;
  readonly attachments: ReadonlyArray<unknown>;
}): boolean {
  return message.attachments.length === 0 && /^\/[\w:-]+(?:\s|$)/u.test(message.text.trim());
}

export function isClearComposerCommand(text: string): boolean {
  return /^\/clear\s*$/i.test(text.trim());
}

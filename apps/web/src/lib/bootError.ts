const ISSUE_URL = "https://github.com/doublepi123/cox/issues/new";
const MAX_CAUSES = 3;
const MAX_ERROR_CHARS = 6000;
const COPY_BLOCKED = "Copy was blocked. The text is selected so you can copy it manually.";
function safeString(value: unknown) {
  try {
    return String(value);
  } catch {
    return "";
  }
}
function describeOne(value: unknown) {
  if (value instanceof Error) {
    const header = value.message ? `${value.name}: ${value.message}` : value.name;
    // V8 stacks start with the header; Safari and Firefox stacks do not.
    const stack = typeof value.stack === "string" ? value.stack : "";
    return stack === header || stack.startsWith(`${header}\n`)
      ? stack
      : [header, stack].filter(Boolean).join("\n");
  }
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? safeString(value);
  } catch {
    return safeString(value);
  }
}
/** Hosts can name private machines, and pairing tokens live in query strings and hashes. */
function redact(text: string) {
  return text
    .replace(/\b[a-z][\w+.-]*:\/\/[^\s/?#'"()]+/gi, "")
    .replace(/[?#][^\s'"()]*=[^\s'"()]*?((?::\d+){1,2})?(?=[\s'"()]|$)/g, "$1");
}
export interface BootErrorEnvironment {
  readonly version: string;
  readonly channel: string;
  readonly surface: "web";
  readonly platform: string;
  readonly userAgent: string;
  readonly time: string;
}
/** Plain text that is shown and copied as-is, so users see exactly what they share. */
export function buildErrorReport(error: unknown, environment: BootErrorEnvironment) {
  const parts: Array<string> = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current != null && !seen.has(current) && parts.length <= MAX_CAUSES) {
    seen.add(current);
    const text = describeOne(current);
    parts.push(parts.length === 0 ? text : `Caused by: ${text}`);
    current = current instanceof Error ? current.cause : undefined;
  }
  let details = redact(parts.join("\n") || "(no error message)");
  if (details.length > MAX_ERROR_CHARS) {
    details = `${details.slice(0, MAX_ERROR_CHARS)}\n[truncated]`;
  }
  return [
    details,
    "",
    `Version: ${environment.version}`,
    `Channel: ${environment.channel}`,
    `Surface: ${environment.surface}`,
    `Platform: ${environment.platform}`,
    `User agent: ${environment.userAgent}`,
    `Time: ${environment.time}`,
  ].join("\n");
}
function readEnvironment(): BootErrorEnvironment {
  const version = import.meta.env.APP_VERSION;
  return {
    version,
    channel:
      import.meta.env.VITE_RELEASE_CHANNEL || /-(nightly|preview)\./.exec(version)?.[1] || "stable",
    surface: "web",
    platform: navigator.platform,
    userAgent: navigator.userAgent,
    time: new Date().toISOString(),
  };
}
function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: ReadonlyArray<Node | string> = [],
) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}
function selectContents(target: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(target);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}
function copySelection() {
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  }
}
/** Plain http has no Clipboard API, but the legacy copy command still works on a selection. */
function copyText(target: HTMLElement, onCopied: () => void, onBlocked: (hint: string) => void) {
  const fallback = () => {
    selectContents(target);
    if (copySelection()) return onCopied();
    onBlocked(
      /Mac|iPhone|iPad/.test(navigator.platform) ? "Press ⌘C to copy" : "Press Ctrl+C to copy",
    );
  };
  const clipboard = window.isSecureContext ? navigator.clipboard : undefined;
  if (typeof clipboard?.writeText !== "function") return fallback();
  clipboard.writeText(target.textContent ?? "").then(onCopied, fallback);
}
export function showBootError(error: unknown): void {
  console.error("Cox failed to start.", error);
  const shell = document.getElementById("boot-shell");
  if (!shell) return;
  const report = buildErrorReport(error, readEnvironment());
  const heading = element("h1", { textContent: "Cox failed to start" });
  const explanation = element("p", {
    textContent:
      navigator.onLine === false
        ? "This browser appears to be offline. Reconnect and reload."
        : "Check that the local Cox server is running, then reload.",
  });
  const reload = element("button", { type: "button", textContent: "Reload" });
  reload.addEventListener("click", () => window.location.reload());
  const details = element("pre", { tabIndex: 0, textContent: report });
  const copy = element("button", { type: "button", textContent: "Copy error details" });
  copy.addEventListener("click", () =>
    copyText(
      details,
      () => {
        copy.textContent = "Copied";
      },
      () => {
        copy.textContent = COPY_BLOCKED;
      },
    ),
  );
  const issue = element("a", {
    href: ISSUE_URL,
    target: "_blank",
    rel: "noopener noreferrer",
    textContent: "Report an issue",
  });
  shell.replaceChildren(heading, explanation, reload, copy, issue, details);
}

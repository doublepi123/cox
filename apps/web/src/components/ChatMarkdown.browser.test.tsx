import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { type ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { commands, page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../test/render";
import "../index.css";

import { filesystemEnvironment } from "../state/filesystem";
import { useRightPanelStore } from "../rightPanelStore";
import { setMarkdownTaskChecked } from "@t3tools/shared/markdownTaskList";
import { chatMarkdownClipboardPayload } from "../markdown-clipboard";
import { HostImageUrlContext } from "./chat/hostImageUrl";

const deniedVideoEnvironment = EnvironmentId.make("denied-video-environment");

vi.mock(import("../state/filesystem"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useFilesystemReadAccess: (environmentId: EnvironmentId | null) =>
      environmentId === deniedVideoEnvironment
        ? { canReadFiles: false, isPending: false, error: null }
        : actual.useFilesystemReadAccess(environmentId),
  };
});

const { workspaceSearch, filesystemMetadata } = vi.hoisted(() => ({
  workspaceSearch: vi.fn(),
  filesystemMetadata: vi.fn(),
}));
const threadWorktrees = vi.hoisted(() => new Map<ThreadId, string>());
vi.mock("../state/entities", async (original) => {
  const actual = await original<typeof import("../state/entities")>();
  return {
    ...actual,
    readThreadShell: (ref: Parameters<typeof actual.readThreadShell>[0]) => {
      const worktreePath = threadWorktrees.get(ref.threadId);
      return worktreePath === undefined ? actual.readThreadShell(ref) : { worktreePath };
    },
  };
});
const parsedSources = vi.hoisted(() => [] as string[]);
vi.mock(import("../markdown/wordsHast"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    wordsHast: (source, options) => {
      parsedSources.push(source);
      return actual.wordsHast(source, options);
    },
  };
});

vi.mock(import("../state/use-atom-query-runner"), async (original) => ({
  ...(await original()),
  useAtomQueryRunner: ((family: unknown) =>
    family === filesystemEnvironment.getMetadata ? filesystemMetadata : workspaceSearch) as never,
}));

// Atoms derived from the server config run in the real registry over a missing config.
vi.mock(import("../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const noConfig = Atom.make(null);
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: (() => noConfig) as never },
  };
});
vi.mock(import("../state/session"), async (original) => {
  const { AuthStandardClientScopes } = await import("@t3tools/contracts");
  const granted = new Set<string>(AuthStandardClientScopes);
  const hasScope = (environmentId: unknown, scope: string) =>
    environmentId !== null && granted.has(scope);
  return {
    ...(await original()),
    useEnvironmentScope: hasScope as never,
    readEnvironmentScope: hasScope as never,
  };
});
const { renderDiagram } = vi.hoisted(() => ({
  renderDiagram: vi.fn<(source: string) => Promise<string> | undefined>(),
}));
// Control rendering latency without running Mermaid layout.
vi.mock(import("./chat/MermaidDiagram"), async (original) => {
  const { use } = await import("react");
  return {
    ...(await original()),
    MermaidDiagram: ({ source }: { source: string }) => {
      const pending = renderDiagram(source);
      return <svg role="img" aria-label={pending ? use(pending) : "Diagram"} />;
    },
  };
});

const settingsOverrides = vi.hoisted(() => ({ mathRenderingEnabled: false }));
vi.mock(import("../hooks/useSettings"), async (original) => {
  const actual = await original();
  type Settings = ReturnType<typeof actual.getClientSettings>;
  function useClientSettings<T = Settings>(select?: (settings: Settings) => T): T {
    const settings = { ...actual.getClientSettings(), ...settingsOverrides };
    return select ? select(settings) : (settings as T);
  }
  return { ...actual, useClientSettings };
});

import ChatMarkdown from "./ChatMarkdown";
import { AudioPreview } from "./files/AudioPreview";

it("keeps compact audio playback loaded across signed URL renewals", async () => {
  const original =
    "data:audio/wav;base64,UklGRiUAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQEAAACA";
  const renewed = `${original}#renewed`;
  const preview = (src: string, revision = "clip-v1") => (
    <AudioPreview compact name="clip.wav" src={src} revision={revision} />
  );
  await using screen = await render(preview(original));
  const audio = screen.container.querySelector("audio")!;
  await act(() => {
    audio.dispatchEvent(new Event("loadedmetadata"));
    audio.dispatchEvent(new Event("play"));
  });
  await screen.rerender(preview(renewed));
  expect(screen.container.querySelector("audio")).toBe(audio);
  expect(audio.getAttribute("src")).toBe(original);
  await expect.element(screen.getByRole("button", { name: "Pause clip.wav" })).toBeEnabled();
  await screen.rerender(preview(renewed, "clip-v2"));
  expect(screen.container.querySelector("audio")).not.toBe(audio);
  expect(screen.container.querySelector("audio")?.getAttribute("src")).toBe(renewed);
});

function setup() {
  parsedSources.length = 0;
  settingsOverrides.mathRenderingEnabled = false;
  renderDiagram.mockReset();
  threadWorktrees.clear();
  workspaceSearch.mockReset().mockResolvedValue(AsyncResult.success({ entries: [] }));
  filesystemMetadata.mockReset().mockResolvedValue(AsyncResult.success({ entries: [null] }));
}

function renderText(text: string, props: Partial<Parameters<typeof ChatMarkdown>[0]> = {}) {
  return render(<ChatMarkdown cwd="/tmp/project" text={text} {...props} />);
}

it("typesets Words inline and display equations in chat", async () => {
  setup();
  settingsOverrides.mathRenderingEnabled = true;
  await using screen = await renderText("Inline $x^2$.\n\n$$\n\\frac{1}{2}\n$$");

  await expect.element(screen.getByRole("group", { name: "Inline equation" })).toBeVisible();
  await expect.element(screen.getByRole("group", { name: "Display equation" })).toBeVisible();
  await vi.waitFor(() => {
    expect(screen.container.querySelector('[data-markdown-math="inline"] .katex')).not.toBeNull();
    expect(
      screen.container.querySelector('[data-markdown-math="display"] .katex-display'),
    ).not.toBeNull();
  });
});

it("explains why a host video cannot be played when file access is missing", async () => {
  setup();
  await using screen = await renderText("![Demo](/tmp/demo.mp4)", {
    threadRef: {
      environmentId: deniedVideoEnvironment,
      threadId: ThreadId.make("thread"),
    },
  });
  await vi.waitFor(() =>
    expect(screen.getByRole("alert").element().textContent).toContain(
      "This connection cannot read host files.",
    ),
  );
  await expect
    .element(screen.getByRole("button", { name: /retry video/i }))
    .not.toBeInTheDocument();
});

function buttonsLabelled(container: HTMLElement, label: string) {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].filter(
    (button) => button.getAttribute("aria-label") === label,
  );
}

it("shows unavailable audio when a workspace embed has no thread", async () => {
  setup();
  await using screen = await renderText("![recording](clip.wav)");
  expect(screen.container.textContent).toContain("Audio unavailable");
  expect(screen.container.textContent).not.toContain("Loading audio");
  expect(screen.container.querySelector("audio")).toBeNull();
});

it("loads a host image through the page's own route when there is no environment", async () => {
  setup();
  const pixel =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  const hostImageUrl = vi.fn((_path: string) => pixel);
  await using screen = await render(
    <HostImageUrlContext value={hostImageUrl}>
      <ChatMarkdown cwd={undefined} text="![Shot](</work/my shot.png>)" />
    </HostImageUrlContext>,
  );
  await expect.element(screen.getByAltText("Shot")).toHaveAttribute("src", pixel);
  expect(new Set(hostImageUrl.mock.calls.map(([path]) => path))).toEqual(
    new Set(["/work/my shot.png"]),
  );
});

it("sizes a raw HTML image by width and height written with px units", async () => {
  setup();
  const largeImage = `data:image/svg+xml,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"/>',
  )}`;
  await using screen = await render(
    <HostImageUrlContext value={() => largeImage}>
      <ChatMarkdown
        cwd={undefined}
        parseRawHtml
        text={
          '### PR Review in progress <img src="/work/spinner.gif" alt="spinner" width="14px" height="7px" />'
        }
      />
    </HostImageUrlContext>,
  );
  const image = screen.getByAltText("spinner");
  await expect.element(image).toHaveAttribute("src", largeImage);
  const element = image.element() as HTMLImageElement;
  await element.decode();
  const { width, height } = element.getBoundingClientRect();
  expect({ width, height }).toEqual({ width: 14, height: 7 });
});

it("fades a streaming reply's blocks in once, not again when it remounts", async () => {
  setup();
  const message = (
    <ChatMarkdown
      cwd="/tmp/project"
      text={"Finished block\n\nStill growing"}
      isStreaming
      streamingId="remounted-reply"
    />
  );
  {
    await using first = await render(
      <ChatMarkdown
        cwd="/tmp/project"
        text={"Finished block\n\n"}
        isStreaming
        streamingId="remounted-reply"
      />,
    );
    expect(first.getByText("Finished block").element().closest("[data-streaming]")).not.toBeNull();
    await first.rerender(message);
    expect(first.getByText("Still growing").element().closest("[data-streaming]")).not.toBeNull();
  }
  await using screen = await render(message);
  await expect
    .element(screen.getByText("Still growing"))
    .toHaveStyle({ opacity: "1", transitionDuration: "0s" });
  expect(parsedSources.filter((source) => source.includes("Finished block"))).toHaveLength(1);
});

it("reuses the parse of a remounted message that has stable extensions", async () => {
  setup();
  const extensions = { userMessage: true };
  const message = <ChatMarkdown cwd="/tmp/project" text="Cached text" extensions={extensions} />;
  {
    await using first = await render(
      <ChatMarkdown cwd="/tmp/project" text="Cached text" extensions={extensions} isStreaming />,
    );
    await first.rerender(message);
  }
  await using screen = await render(message);
  await expect.element(screen.getByText("Cached text")).toBeVisible();
  const parses = () => parsedSources.filter((source) => source === "Cached text").length;
  expect(parses()).toBe(1);
  await screen.rerender(
    <ChatMarkdown cwd="/tmp/project" text="Cached text" extensions={{ userMessage: true }} />,
  );
  expect(parses()).toBe(2);
});

describe("ChatMarkdown favicon privacy", () => {
  it("suppresses private link images while preserving public links across updates", async () => {
    setup();
    const markdown = (url: string) => <ChatMarkdown cwd="/tmp/project" text={`[Link](${url})`} />;
    await using screen = await render(markdown("https://example.com"));
    const { container, rerender } = screen;
    expect([...container.querySelectorAll("img")].map((image) => image.src)).toEqual([
      "https://www.google.com/s2/favicons?domain=example.com&sz=32",
    ]);
    for (const url of ["http://192.168.1.10:8080", "http://localhost:3000", "http://home.arpa"]) {
      await rerender(markdown(url));
      expect(container.querySelectorAll("img")).toHaveLength(0);
    }
    await rerender(markdown("https://example.com"));
    expect(container.querySelectorAll("img")).toHaveLength(1);
    await rerender(markdown("https://github.com/pingdotgg/t3code/pull/1"));
    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(container.querySelector("a svg")).not.toBeNull();
  });
});

describe("ChatMarkdown streaming", () => {
  it("runs only a complete single-line shell block after a click", async () => {
    setup();
    const onRunShellCommand = vi.fn();
    const message = (text: string, isStreaming = false) => (
      <ChatMarkdown
        cwd="/tmp/project"
        text={text}
        isStreaming={isStreaming}
        onRunShellCommand={onRunShellCommand}
      />
    );
    await using screen = await render(message("```bash\necho hello\n```", true));
    const { container, rerender } = screen;
    const runButtons = () => buttonsLabelled(container, "Run in terminal");
    expect(runButtons()).toHaveLength(0);

    await rerender(message("```bash\necho hello\n```"));
    await act(async () => runButtons()[0]!.click());
    expect(onRunShellCommand).toHaveBeenCalledExactlyOnceWith("echo hello");

    for (const text of [
      "~~~bash\necho tilde\n~~~",
      "> ```bash\n> echo quote\n> ```",
      "````bash\necho four\n````",
      "- Command\n\n  ```bash\n  echo list\n  ```",
      "```bash\r\necho crlf\r\n```\r",
    ]) {
      await rerender(message(text));
      expect(runButtons()).toHaveLength(1);
    }

    for (const text of [
      "```bash\necho one\necho two\n```",
      "```typescript\necho hello\n```",
      "```bash\n\n```",
      "```bash\necho hello\n\n```",
      "```bash\necho hello\\\n```",
      "```bash\necho safe \u202e#\n```",
      "```bash\necho incomplete",
      "~~~bash\necho incomplete",
      "````bash\necho incomplete\n```",
      '<pre><code class="language-bash">echo html</code></pre>',
    ]) {
      await rerender(message(text));
      expect(runButtons()).toHaveLength(0);
    }
  });

  it("toggles a task whose checkbox starts on the next line", async () => {
    setup();
    const text = "-\n  [ ] Same\n\n```txt\nx\n```\n\n- [ ] Same";
    let edited: string | undefined;
    await using screen = await render(
      <ChatMarkdown
        cwd="/workspace/repo"
        text={text}
        onTaskListChange={({ markerOffset, checked }) => {
          edited = setMarkdownTaskChecked(text, markerOffset, checked);
        }}
      />,
    );
    const checkboxes =
      screen.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(checkboxes).toHaveLength(2);
    await act(async () => checkboxes[0]!.click());
    expect(edited).toBe(text.replace("[ ] Same", "[x] Same"));
  });

  it("edits the current task text and marker after reusing a renderer", async () => {
    setup();
    let editedText: string | undefined;
    let rerender: (next: ReactElement) => Promise<void> = async () => {};
    const message = (text: string): ReactElement => (
      <ChatMarkdown
        cwd="/tmp/project"
        text={text}
        onTaskListChange={({ markerOffset, checked }) => {
          editedText = setMarkdownTaskChecked(text, markerOffset, checked);
          void rerender(message(editedText));
        }}
      />
    );
    await using rendered = await render(message("- [ ] First\n- [ ] Second"));
    rerender = rendered.rerender;
    const { container } = rendered;
    const checkboxes = () => container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    const original = checkboxes()[1]!;
    await rerender(message("- [ ] A longer first task\n- [ ] Second"));
    expect(checkboxes()[1]).toBe(original);

    await act(async () => original.click());
    expect(editedText).toBe("- [ ] A longer first task\n- [x] Second");
    await vi.waitFor(() => expect(checkboxes()[1]!.checked).toBe(true));
    await rerender(message("- [ ] A longer first task\n- [ ] Second"));
    expect(checkboxes()[1]).toBe(original);
    expect(checkboxes()[1]!.checked).toBe(false);
  });

  it.each([
    ["read-only", undefined],
    ["editable", () => {}],
  ])(
    "unchecks the remaining %s task when the checked row above it is removed",
    async (_, onTaskListChange) => {
      setup();
      const message = (text: string) => (
        <ChatMarkdown cwd="/tmp/project" text={text} onTaskListChange={onTaskListChange} />
      );
      await using screen = await render(message("- [x] Completed item\n- [ ] Pending item"));
      await screen.rerender(message("- [ ] Pending item"));
      const checkboxes =
        screen.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
      expect(checkboxes).toHaveLength(1);
      expect(checkboxes[0]!.checked).toBe(false);
    },
  );
});

describe("ChatMarkdown workspace file opens", () => {
  const threadRef = {
    environmentId: EnvironmentId.make("workspace"),
    threadId: ThreadId.make("thread"),
  };

  it("opens a path from Markdown rendered in another checkout under that checkout", async () => {
    setup();
    const scratchThread = { ...threadRef, threadId: ThreadId.make("scratch-thread") };
    threadWorktrees.set(scratchThread.threadId, "/scratch/thread");
    filesystemMetadata.mockResolvedValue(AsyncResult.success({ entries: [{ kind: "file" }] }));
    using openFile = vi
      .spyOn(useRightPanelStore.getState(), "openFile")
      .mockImplementation(() => {});
    await using screen = await renderText("[State](packages/state/filesystem.ts)", {
      cwd: "/repo-a",
      threadRef: scratchThread,
    });
    await act(async () => screen.container.querySelector("a")!.click());
    await vi.waitFor(() =>
      expect(openFile).toHaveBeenCalledExactlyOnceWith(
        scratchThread,
        "/repo-a/packages/state/filesystem.ts",
        undefined,
      ),
    );
  });

  it("keeps a newer absolute file open when an earlier repo-relative lookup finishes", async () => {
    setup();
    const result = AsyncResult.success({
      entries: [{ path: "notes/a.md", kind: "file" }],
      truncated: false,
    });
    let resolvePending!: (value: typeof result) => void;
    const pending = new Promise<typeof result>((resolve) => {
      resolvePending = resolve;
    });
    workspaceSearch.mockReturnValueOnce(pending);
    using openFile = vi
      .spyOn(useRightPanelStore.getState(), "openFile")
      .mockImplementation(() => {});
    await using screen = await renderText(
      "[Notes](physics/notes/a.md) and [Other](/elsewhere/b.md:9)",
      {
        cwd: "/school/physics",
        threadRef,
      },
    );
    const { container } = screen;
    const [notes, other] = container.querySelectorAll("a");
    await act(async () => notes!.click());
    expect(workspaceSearch).toHaveBeenCalledOnce();
    expect(openFile).not.toHaveBeenCalled();

    await act(async () => other!.click());
    await act(async () => resolvePending(result));

    expect(openFile).toHaveBeenCalledExactlyOnceWith(threadRef, "/elsewhere/b.md", 9);
    expect(workspaceSearch).toHaveBeenCalledOnce();
  });
});

describe("ChatMarkdown skill chips", () => {
  it("shows the skill's details and opens its instructions", async () => {
    setup();
    const threadRef = {
      environmentId: EnvironmentId.make("workspace"),
      threadId: ThreadId.make("thread"),
    };
    await using screen = await renderText("Run $review now", {
      threadRef,
      skills: [
        {
          name: "review",
          displayName: "Review",
          description: "Reviews the current branch.",
          path: "/skills/review/SKILL.md",
          enabled: true,
        },
      ],
    });
    using openFile = vi
      .spyOn(useRightPanelStore.getState(), "openFile")
      .mockImplementation(() => {});

    await userEvent.click(screen.getByRole("button", { name: "Skill Review. Show details" }));
    await expect.element(page.getByText("Reviews the current branch.")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "View instructions" }));

    expect(openFile).toHaveBeenCalledExactlyOnceWith(threadRef, "/skills/review/SKILL.md");
  });
});

describe("ChatMarkdown headings", () => {
  it("never gives two headings the same id, even when a suffix matches another heading", async () => {
    setup();
    await using screen = await renderText(
      '## Setup\n\n## Setup\n\n## Setup-1\n\n<h2 id="install-1">Pinned</h2>\n\n## Install\n\n## Install',
      { parseRawHtml: true },
    );
    const { container } = screen;
    expect([...container.querySelectorAll("h2")].map((heading) => heading.id)).toEqual([
      "user-content-setup",
      "user-content-setup-1",
      "user-content-setup-1-1",
      "user-content-install-1",
      "user-content-install",
      "user-content-install-2",
    ]);
  });
});

describe("ChatMarkdown inline code selection", () => {
  it("selects the whole inline code span on double-click, but only a word in fenced code", async () => {
    setup();
    await using screen = await renderText(
      "Run `migration-gate --dry-run` first.\n\n```txt\nfenced-block word\n```",
    );
    await userEvent.dblClick(screen.getByText("migration-gate --dry-run"));
    expect(window.getSelection()?.toString()).toBe("migration-gate --dry-run");

    window.getSelection()?.removeAllRanges();
    const fenced = screen.container.querySelector("pre code")!;
    await userEvent.dblClick(fenced, { position: { x: 4, y: 4 } });
    expect(window.getSelection()?.toString()).toBe("fenced");
  });

  it("selects the whole line on triple-click beside a favicon link or a file chip", async () => {
    setup();
    await using screen = await renderText(
      "Before [docs](https://example.com/docs) after words\n\nBefore [App.tsx](/tmp/project/src/App.tsx) after words",
    );
    const tripleClickWord = async (paragraph: HTMLElement, word: string) => {
      const text = [...paragraph.childNodes].find((node) => node.textContent?.includes(word))!;
      const range = document.createRange();
      range.setStart(text, text.textContent!.indexOf(word));
      range.setEnd(text, text.textContent!.indexOf(word) + word.length);
      const wordBox = range.getBoundingClientRect();
      const paragraphBox = paragraph.getBoundingClientRect();
      window.getSelection()?.removeAllRanges();
      await userEvent.tripleClick(paragraph, {
        position: {
          x: wordBox.left - paragraphBox.left + wordBox.width / 2,
          y: wordBox.top - paragraphBox.top + wordBox.height / 2,
        },
      });
      return window.getSelection()?.toString().trim();
    };

    const paragraphs = screen.container.querySelectorAll("p");
    expect(paragraphs).toHaveLength(2);
    const selections = [];
    const lines = [];
    for (const paragraph of paragraphs) {
      lines.push(paragraph.textContent?.trim(), paragraph.textContent?.trim());
      selections.push(
        await tripleClickWord(paragraph, "Before"),
        await tripleClickWord(paragraph, "after"),
      );
    }
    expect(selections).toEqual(lines);
  });

  it("selects the whole line on triple-click beside a desktop-draggable inline-code file chip", async () => {
    setup();
    filesystemMetadata.mockResolvedValue(AsyncResult.success({ entries: [{ kind: "file" }] }));
    await using screen = await renderText(
      "The template (`config/app.yaml.example`) and two docs still say 5 fps.",
      {
        threadRef: {
          environmentId: EnvironmentId.make("workspace"),
          threadId: ThreadId.make("thread"),
        },
      },
    );
    const chip = screen.container.querySelector<HTMLAnchorElement>("a.chat-markdown-file-link")!;
    expect(chip.draggable).toBe(true);
    chip.draggable = true;
    const paragraph = screen.container.querySelector("p")!;
    const text = [...paragraph.childNodes].find((node) =>
      node.textContent?.includes("and two docs"),
    )!;
    const range = document.createRange();
    range.setStart(text, text.textContent!.indexOf("and"));
    range.setEnd(text, text.textContent!.indexOf("and") + 3);
    const wordBox = range.getBoundingClientRect();
    const paragraphBox = paragraph.getBoundingClientRect();
    await userEvent.tripleClick(paragraph, {
      position: {
        x: wordBox.left - paragraphBox.left + wordBox.width / 2,
        y: wordBox.top - paragraphBox.top + wordBox.height / 2,
      },
    });
    expect(window.getSelection()?.toString().trim()).toBe(paragraph.textContent?.trim());
  });
});

describe("ChatMarkdown Windows file links", () => {
  const environmentId = EnvironmentId.make("env-windows");
  const renderWindows = (text: string, parseRawHtml: boolean) =>
    renderText(text, {
      cwd: "C:/Users/shawn/project",
      environmentId,
      lineBreaks: !parseRawHtml,
      parseRawHtml,
    });
  const fileHrefs = (container: HTMLElement) =>
    [...container.querySelectorAll(".chat-markdown-file-link")].map((chip) =>
      chip.getAttribute("href"),
    );

  it("still rejects unsafe schemes", async () => {
    setup();
    for (const parseRawHtml of [true, false]) {
      await using screen = await renderWindows(
        "[unsafe](javascript:alert(1)) and [unknown](d:alert(1))",
        parseRawHtml,
      );
      const { container } = screen;
      expect(container.innerHTML).not.toContain("javascript:");
      expect(container.innerHTML).not.toContain("d:alert");
      expect(fileHrefs(container)).toEqual([]);
    }
  });
});

it("disables synthetic checkbox offsets in the shared file-preview renderer", async () => {
  setup();
  const onTaskListChange = vi.fn();
  const text =
    "This PR updates local tool config\n\n- [ ] Earlier\n-       Prose\n\n        - [ ] Nested\n";
  await using screen = await renderText(text, { onTaskListChange });
  const boxes = screen.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  expect(boxes).toHaveLength(2);
  expect(boxes[0]!.disabled).toBe(false);
  expect(boxes[1]!.disabled).toBe(true);
  await act(async () => boxes[1]!.click());
  expect(onTaskListChange).not.toHaveBeenCalled();
  expect(screen.container.textContent).toContain("Prose");
  expect(screen.container.textContent).toContain("Nested");
});

it.each([false, true])(
  "keeps raw HTML checkboxes inert alongside real tasks parseRawHtml=%s",
  async (parseRawHtml) => {
    setup();
    const text =
      '- [ ] Real <input type="checkbox">\n\n<ul class="contains-task-list"><li class="task-list-item"><input type="checkbox">Fake</li></ul>';
    const onTaskListChange = vi.fn();
    await using screen = await renderText(text, { onTaskListChange, parseRawHtml });
    const boxes = screen.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(boxes).toHaveLength(parseRawHtml ? 3 : 1);
    expect(boxes[0]!.disabled).toBe(false);
    for (const box of [...boxes].slice(1)) {
      expect(box.disabled).toBe(true);
      await act(async () => box.click());
    }
    expect(onTaskListChange).not.toHaveBeenCalled();
    await act(async () => boxes[0]!.click());
    expect(onTaskListChange).toHaveBeenCalledExactlyOnceWith({ markerOffset: 2, checked: true });
  },
);

it.each([
  ["عنوان التفاصيل", "محتوى الفقرة"],
  ["כותרת פרטים", "תוכן הפסקה"],
])("uses right-to-left direction in the disclosure %s", async (summary, content) => {
  setup();
  await using screen = await render(
    <ChatMarkdown
      cwd={undefined}
      text={"<details>\n<summary>" + summary + "</summary>\n\n" + content + "\n\n</details>"}
    />,
  );
  const trigger = screen.getByRole("button", { name: summary });
  const button = trigger.element();
  expect(getComputedStyle(button).direction).toBe("rtl");
  expect(getComputedStyle(button).textAlign).toBe("start");
  await trigger.click();
  const body = screen.getByText(content, { exact: true });
  await expect.element(body).toBeVisible();
  expect(getComputedStyle(body.element()).direction).toBe("rtl");
});

describe("ChatMarkdown alert copy", () => {
  it("copies a fully selected callout as alert Markdown and a partial one as text", async () => {
    await using screen = await renderText("> [!WARNING]\n> Back up first.");
    const [label, body] = screen.container.querySelectorAll('[role="note"] > p');
    const select = (startNode: Node, endNode: Node, endOffset: number) => {
      const range = document.createRange();
      range.setStart(startNode, 0);
      range.setEnd(endNode, endOffset);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      return chatMarkdownClipboardPayload(selection)?.text;
    };
    const labelText = label!.lastChild!;
    const bodyText = body!.firstChild!;

    expect(select(labelText, bodyText, bodyText.textContent!.length)).toBe(
      "> [!WARNING]\n> Back up first.",
    );
    expect(select(labelText, bodyText, "Back up".length)).toBe("Warning\n\nBack up");
  });
});

it("preserves typed list values and the first copied item number", async () => {
  await using screen = await render(
    <ChatMarkdown
      cwd={undefined}
      text={"3. First\n5. Second\n6. Third\n\nAfter"}
      extensions={{ userMessage: true, leadingWhitespace: true }}
    />,
  );
  const list = screen.container.querySelector("ol")!;
  const items = list.querySelectorAll("li");
  expect(items[1]!.getAttribute("value")).toBe("5");
  const range = document.createRange();
  range.setStart(items[1]!.firstChild!, 0);
  const end = screen.container.querySelector("p:last-child")!;
  range.setEnd(end, end.childNodes.length);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  try {
    expect(chatMarkdownClipboardPayload(selection)?.text).toBe("5. Second\n6. Third\n\nAfter");
  } finally {
    selection.removeAllRanges();
  }
});

it("stays open while the pointer selects the path, then closes when it leaves", async () => {
  setup();
  await using screen = await renderText("[notes](/tmp/project/docs/notes.md)");
  await userEvent.hover(screen.container.querySelector(".chat-markdown-file-link")!);
  const path = page.getByText("/tmp/project/docs/notes.md");
  await expect.element(path).toBeVisible();

  // Forced so the pointer lands on the popup even when it ignores pointer events.
  await userEvent.tripleClick(path, { force: true });
  expect(window.getSelection()?.toString().trim()).toBe("/tmp/project/docs/notes.md");
  await expect.element(path).toBeVisible();

  await commands.resetPointer();
  await expect.element(path).not.toBeInTheDocument();
});

describe("ChatMarkdown link tooltips", () => {
  it("shows each link's address on one shared tooltip as the pointer moves between links", async () => {
    setup();
    await using screen = await render(
      <ChatMarkdown
        cwd="/tmp/project"
        text="[First](https://example.com/a) and [Second](https://example.org/b)"
      />,
    );
    await userEvent.hover(screen.getByRole("link", { name: /First/ }));
    await expect.element(page.getByText("https://example.com/a")).toBeVisible();
    await userEvent.hover(screen.getByRole("link", { name: /Second/ }));
    await expect.element(page.getByText("https://example.org/b")).toBeVisible();
    expect(document.querySelectorAll('[data-slot="tooltip-popup"]')).toHaveLength(1);
  });
});

describe("ChatMarkdown details", () => {
  it("opens collapsed details by click, and by keyboard without losing focus", async () => {
    setup();
    await using screen = await render(
      <ChatMarkdown
        cwd="/tmp/project"
        text={
          "<details><summary>First</summary>\n\nHidden one\n\n</details>\n\n<details><summary>Second</summary>\n\nHidden two\n\n</details>"
        }
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "First" }));
    await expect.element(screen.getByText("Hidden one")).toBeVisible();
    await userEvent.tab();
    const second = screen.getByRole("button", { name: "Second" });
    await expect.element(second).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await expect.element(screen.getByText("Hidden two")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Second" })).toHaveFocus();
  });
});

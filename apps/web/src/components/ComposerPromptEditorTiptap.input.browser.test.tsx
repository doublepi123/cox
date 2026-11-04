import type { ComposerFileAttachment } from "../composerDraftStore";
import { formatInlineContextReference } from "../lib/composerContextReferences";
import { fileContextReference } from "../lib/composerContextRecords";
import {
  reconcileAttachmentContextReferences,
  type RetainedContextPayloads,
  useRetainedContextPayloads,
} from "./chat/composerContextUndo";

import type { ServerProviderSkill } from "@t3tools/contracts";
import type { Editor } from "@tiptap/core";
import { createElement, createRef, useEffect, useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { commands, userEvent } from "vite-plus/test/browser";

import { act, fakeTimers, render } from "../../test/render";

import { serializeEditorDoc } from "~/composer-rich-text-doc";
import { isMacPlatform } from "~/lib/utils";
import {
  ComposerPromptEditorTiptap as ComposerPromptEditor,
  type ComposerPromptEditorHandle,
  type ComposerPromptEditorProps,
} from "./ComposerPromptEditorTiptap";

const babysit: ServerProviderSkill = {
  name: "babysit",
  path: "/skills/babysit/SKILL.md",
  enabled: true,
};

declare module "vite-plus/test/browser" {
  interface BrowserCommands {
    setImeComposition: (text: string) => Promise<void>;
    commitImeText: (text: string) => Promise<void>;
  }
}

function Composer({
  value,
  richTextEnabled,
  skills,
  onChange,
}: {
  value: string;
  richTextEnabled: boolean;
  skills: ReadonlyArray<ServerProviderSkill>;
  onChange?: ComposerPromptEditorProps["onChange"] | undefined;
}) {
  const [prompt, setPrompt] = useState({ value, cursor: value.length });
  return (
    <ComposerPromptEditor
      editorRef={createRef<ComposerPromptEditorHandle>()}
      value={prompt.value}
      cursor={prompt.cursor}
      richTextEnabled={richTextEnabled}
      contextRecords={new Map()}
      skills={skills}
      disabled={false}
      placeholder=""
      onChange={(...args) => {
        setPrompt({ value: args[0], cursor: args[1] });
        onChange?.(...args);
      }}
      onPaste={() => {}}
    />
  );
}

function composer(
  value: string,
  richTextEnabled = true,
  skills: ReadonlyArray<ServerProviderSkill> = [],
  onChange?: ComposerPromptEditorProps["onChange"],
) {
  return (
    <Composer value={value} richTextEnabled={richTextEnabled} skills={skills} onChange={onChange} />
  );
}

function editorIn(container: HTMLElement) {
  const element = container.querySelector<HTMLElement & { editor: Editor }>(".tiptap");
  if (!element) throw new Error("Composer did not mount");
  return element.editor;
}

async function mountEditor(...props: Parameters<typeof composer>) {
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(await render(composer(...props)));
  const editor = editorIn(screen.container);
  const environment = stack.move();
  return Object.assign(screen, {
    [Symbol.asyncDispose]: () => environment.disposeAsync(),
    editor,
    /** Rerenders the same composer with new props, as a parent would. */
    update: async (...next: Parameters<typeof composer>) => {
      await screen.rerender(composer(...next));
      return editorIn(screen.container);
    },
  });
}

async function replaceDomText(editor: Editor, text: string, isComposing = false) {
  await act(async () => {
    const node = editor.view.dom.querySelector("p")?.firstChild;
    if (!(node instanceof Text)) throw new Error("Composition text is missing");
    node.data = text;
    window.getSelection()?.collapse(node, text.length);
    if (isComposing) {
      editor.view.dom.dispatchEvent(new CompositionEvent("compositionupdate", { data: text }));
    }
    editor.view.dom.dispatchEvent(
      new InputEvent("input", {
        inputType: isComposing ? "insertCompositionText" : "insertText",
        data: text,
        isComposing,
      }),
    );
  });
}

function typeText(editor: Editor, from: number, to: number, text: string) {
  const insert = () => editor.state.tr.insertText(text, from, to);
  if (
    !editor.view.someProp("handleTextInput", (handler) =>
      handler(editor.view, from, to, text, insert),
    )
  ) {
    editor.view.dispatch(insert());
  }
}

function textWithMark(editor: Editor, name: string) {
  const text: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.isText && node.marks.some((mark) => mark.type.name === name)) {
      text.push(node.textContent);
    }
  });
  return text;
}

it.each([
  { value: "clean _build and node", code: [] },
  { value: "clean `_build` and `node", code: ["_build"] },
])("keeps a typed underscore literal after $value", async ({ value, code }) => {
  await using screen = await mountEditor(value);
  const { editor } = screen;
  await act(async () => {
    editor.commands.focus("end");
    const { from, to } = editor.state.selection;
    typeText(editor, from, to, "_");
  });
  expect(serializeEditorDoc(editor.state.doc).value).toBe(`${value}_`);
  expect(textWithMark(editor, "italic")).toEqual([]);
  expect(textWithMark(editor, "code")).toEqual(code);
});

it("bolds with Mod+B only when text is selected", async () => {
  await using screen = await mountEditor("ship it");
  const { editor } = screen;
  const modB = isMacPlatform(navigator.platform) ? "{Meta>}b{/Meta}" : "{Control>}b{/Control}";
  await act(async () => {
    editor.commands.focus("end");
  });
  await vi.waitFor(() => expect(document.activeElement).toBe(editor.view.dom));
  await userEvent.keyboard(modB);
  // Without the guard, Tiptap stores bold for the next typed text.
  expect(editor.state.storedMarks).toBeNull();

  await act(async () => {
    editor.commands.setTextSelection({ from: 1, to: 5 });
  });
  await userEvent.keyboard(modB);
  await vi.waitFor(() => expect(textWithMark(editor, "bold")).toEqual(["ship"]));
});

it.each([false, true])(
  "composes an umlaut without wrapping the preedit text (rich text: %s)",
  async (richTextEnabled) => {
    // The middle dot stands in for the provisional text shown by the Compose key.
    await using screen = await mountEditor("·", richTextEnabled);
    const { editor } = screen;
    await act(async () => {
      editor.view.focus();
      editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart"));
    });
    await replaceDomText(editor, '"', true);
    expect(serializeEditorDoc(editor.state.doc).value).toBe('"');
    await replaceDomText(editor, "ö", true);
    await act(async () => {
      editor.view.dom.dispatchEvent(new CompositionEvent("compositionend", { data: "ö" }));
    });
    expect(serializeEditorDoc(editor.state.doc).value).toBe("ö");
  },
);

it("lets composition replace selected text without surrounding it", async () => {
  await using screen = await mountEditor("word");
  const { editor } = screen;
  await act(async () => {
    editor.commands.setTextSelection({ from: 1, to: 5 });
    editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart"));
    typeText(editor, 1, 5, '"');
  });
  expect(serializeEditorDoc(editor.state.doc).value).toBe('"');
});

it.each([false, true])(
  "keeps the preedit DOM through repeated pinyin Backspace and a delayed controlled echo (rich text: %s)",
  async (richTextEnabled) => {
    let echo = () => {};
    let commit = () => {};
    let pending = { value: "nihao", cursor: 5 };
    let delayed = pending;
    function DelayedComposer() {
      const [prompt, setPrompt] = useState(pending);
      useEffect(() => {
        echo = () => setPrompt(delayed);
        commit = () => setPrompt(pending);
      }, []);
      return (
        <ComposerPromptEditor
          editorRef={createRef<ComposerPromptEditorHandle>()}
          value={prompt.value}
          cursor={prompt.cursor}
          richTextEnabled={richTextEnabled}
          contextRecords={new Map()}
          skills={[]}
          disabled={false}
          placeholder=""
          onChange={(value, cursor) => {
            pending = { value, cursor };
          }}
          onPaste={() => {}}
        />
      );
    }
    await using screen = await render(<DelayedComposer />);
    const editor = editorIn(screen.container);
    await act(async () => {
      editor.view.focus();
      editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    });
    const node = editor.view.dom.querySelector("p")!.firstChild;
    for (const text of ["niha", "nih"]) {
      delayed = pending;
      await act(async () => {
        editor.view.dom.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Backspace",
            code: "Backspace",
            keyCode: 229,
            isComposing: true,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      await replaceDomText(editor, text, true);
      await vi.waitFor(() => expect(serializeEditorDoc(editor.state.doc).value).toBe(text));
      expect(pending.value).toBe(text);
      await act(async () => echo());
      expect(editor.view.dom.querySelector("p")!.firstChild).toBe(node);
      expect(editor.view.dom.textContent).toBe(text);
      expect(editor.view.composing).toBe(true);
    }
    await replaceDomText(editor, "你好", true);
    await act(async () => {
      commit();
      editor.view.dom.dispatchEvent(
        new CompositionEvent("compositionend", { bubbles: true, data: "你好" }),
      );
    });
    expect(serializeEditorDoc(editor.state.doc).value).toBe("你好");
    expect(document.activeElement).toBe(editor.view.dom);
    await userEvent.keyboard("{Backspace}");
    await vi.waitFor(() => expect(serializeEditorDoc(editor.state.doc).value).toBe("你"));
  },
);

it("defers an external draft replacement until composition ends", async () => {
  const prompt = (value: string) => (
    <ComposerPromptEditor
      editorRef={createRef<ComposerPromptEditorHandle>()}
      value={value}
      cursor={value.length}
      contextRecords={new Map()}
      skills={[]}
      disabled={false}
      placeholder=""
      onChange={() => {}}
      onPaste={() => {}}
    />
  );
  await using screen = await render(prompt("nihao"));
  const editor = editorIn(screen.container);
  await act(async () => {
    editor.view.focus();
    editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  });
  await screen.rerender(prompt("replacement"));
  expect(editor.view.dom.textContent).toBe("nihao");
  await act(async () => {
    editor.view.dom.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true, data: "nihao" }),
    );
  });
  await vi.waitFor(() => expect(editor.view.dom.textContent).toBe("replacement"));
});

it.each([
  { richTextEnabled: false, value: "" },
  { richTextEnabled: true, value: "" },
  { richTextEnabled: false, value: "前文 " },
  { richTextEnabled: true, value: "前文 " },
])(
  "keeps native pinyin composition active through repeated Backspace (rich text: $richTextEnabled, prefix: '$value')",
  async ({ richTextEnabled, value }) => {
    await using screen = await mountEditor(value, richTextEnabled);
    const { editor } = screen;
    const compositionStart = vi.fn();
    const compositionEnd = vi.fn();
    editor.view.dom.addEventListener("compositionstart", compositionStart);
    editor.view.dom.addEventListener("compositionend", compositionEnd);
    await act(async () => editor.view.focus());
    await commands.setImeComposition("nihao");
    await vi.waitFor(() =>
      expect(serializeEditorDoc(editor.state.doc).value).toBe(`${value}nihao`),
    );
    for (const text of ["niha", "nih", "ni", "n"]) {
      const event = new KeyboardEvent("keydown", {
        key: "Backspace",
        code: "Backspace",
        keyCode: 229,
        isComposing: true,
        bubbles: true,
        cancelable: true,
      });
      editor.view.dom.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      await commands.setImeComposition(text);
      await vi.waitFor(() =>
        expect(serializeEditorDoc(editor.state.doc).value).toBe(`${value}${text}`),
      );
      expect(editor.view.dom.textContent).toBe(`${value}${text}`);
      expect(editor.view.composing).toBe(true);
      expect(compositionStart).toHaveBeenCalledOnce();
      expect(compositionEnd).not.toHaveBeenCalled();
    }
    await commands.setImeComposition("nihao");
    await commands.commitImeText("你好");
    await vi.waitFor(() => expect(serializeEditorDoc(editor.state.doc).value).toBe(`${value}你好`));
    expect(editor.view.composing).toBe(false);
    expect(compositionEnd).toHaveBeenCalledOnce();
    await userEvent.keyboard("{Backspace}{Backspace}");
    await vi.waitFor(() => expect(serializeEditorDoc(editor.state.doc).value).toBe(value));
  },
);

it.each([false, true])(
  "can cancel native pinyin composition after deleting its final character (rich text: %s)",
  async (richTextEnabled) => {
    await using screen = await mountEditor("前文 ", richTextEnabled);
    const { editor } = screen;
    const compositionStart = vi.fn();
    const compositionEnd = vi.fn();
    editor.view.dom.addEventListener("compositionstart", compositionStart);
    editor.view.dom.addEventListener("compositionend", compositionEnd);
    await act(async () => editor.view.focus());
    for (const text of ["ni", "n", ""]) {
      await commands.setImeComposition(text);
      await vi.waitFor(() =>
        expect(serializeEditorDoc(editor.state.doc).value).toBe(`前文 ${text}`),
      );
    }
    expect(editor.view.composing).toBe(false);
    expect(compositionStart).toHaveBeenCalledOnce();
    expect(compositionEnd).toHaveBeenCalledOnce();
    await commands.setImeComposition("hao");
    await commands.commitImeText("好");
    await vi.waitFor(() => expect(serializeEditorDoc(editor.state.doc).value).toBe("前文 好"));
  },
);

it("skips only inert transactions during composition", async () => {
  await using screen = await mountEditor("nihao");
  const { editor } = screen;
  await act(async () => {
    editor.view.focus();
    editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  });
  const onTransaction = vi.fn();
  editor.on("transaction", onTransaction);
  await act(async () => editor.view.dispatch(editor.state.tr));
  expect(onTransaction).not.toHaveBeenCalled();
  for (const buildTransaction of [
    () => editor.state.tr.setMeta("addToHistory", false),
    () => editor.state.tr.setSelection(editor.state.selection),
    () => editor.state.tr.scrollIntoView(),
    () => editor.state.tr.insertText("你好"),
    () => editor.state.tr.setStoredMarks([]),
  ]) {
    const transaction = buildTransaction();
    await act(async () => editor.view.dispatch(transaction));
    expect(onTransaction).toHaveBeenCalledWith(expect.objectContaining({ transaction }));
  }
  await act(async () => {
    editor.view.dom.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  });
  onTransaction.mockClear();
  const transaction = editor.state.tr;
  await act(async () => editor.view.dispatch(transaction));
  expect(onTransaction).toHaveBeenCalledWith(expect.objectContaining({ transaction }));
});

it("leaves IME fallback key events to the browser without running composer commands", async () => {
  const onCommandKeyDown = vi.fn(() => false);
  await using screen = await render(
    <ComposerPromptEditor
      editorRef={createRef<ComposerPromptEditorHandle>()}
      value="nihao"
      cursor={5}
      contextRecords={new Map()}
      skills={[]}
      disabled={false}
      placeholder=""
      onChange={() => {}}
      onCommandKeyDown={onCommandKeyDown}
      onPaste={() => {}}
    />,
  );
  const editor = editorIn(screen.container);
  for (const composition of [
    { isComposing: true, keyCode: 8 },
    { isComposing: false, keyCode: 229 },
  ]) {
    const event = new KeyboardEvent("keydown", {
      key: "Backspace",
      code: "Backspace",
      bubbles: true,
      cancelable: true,
      ...composition,
    });
    editor.view.dom.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  }
  expect(onCommandKeyDown).not.toHaveBeenCalled();
});

it("keeps unknown dollar names editable when restoring and pasting a draft", async () => {
  const value = "echo $HOME $PATH $anything $notaskill $20 $20k $babysit ";
  await using screen = await mountEditor(value, true, [babysit]);
  const { editor } = screen;
  expect(editor.state.doc.textContent).toBe(value.replace("$babysit", ""));
  expect(serializeEditorDoc(editor.state.doc).value).toBe(value);
  await act(async () => {
    editor.commands.setTextSelection("echo $HO".length + 1);
    editor.commands.insertContent("X");
  });
  expect(serializeEditorDoc(editor.state.doc).value).toBe(value.replace("$HOME", "$HOXME"));
  await act(async () => {
    editor.commands.selectAll();
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", value);
    editor.view.dom.dispatchEvent(new ClipboardEvent("paste", { clipboardData, cancelable: true }));
  });
  expect(editor.state.doc.textContent).toBe(value.replace("$babysit", ""));
  expect(serializeEditorDoc(editor.state.doc).value).toBe(value);
});

it("keeps the caret inside unknown dollar text across rich and plain remounts", async () => {
  const value = "echo $HOME now";
  await using screen = await mountEditor(value);
  let { editor } = screen;
  await act(async () => {
    editor.commands.setTextSelection("echo $HO".length + 1);
  });
  editor = await screen.update(value, false);
  await act(async () => {
    editor.commands.insertContent("X");
  });
  expect(serializeEditorDoc(editor.state.doc).value).toBe("echo $HOXME now");
  editor = await screen.update(value, true);
  await act(async () => {
    editor.commands.insertContent("Y");
  });
  expect(serializeEditorDoc(editor.state.doc).value).toBe("echo $HOXYME now");
});

const file = {
  type: "file",
  id: "file-1",
  name: "notes.txt",
  mimeType: "text/plain",
  sizeBytes: 5,
  file: new File(["notes"], "notes.txt", { type: "text/plain" }),
} satisfies ComposerFileAttachment;

describe("composer context undo lifetime", () => {
  async function mountComposer(destinationValue = "") {
    const initialValue = `Draft A ${formatInlineContextReference(fileContextReference(file))}`;
    const editorRef = createRef<ComposerPromptEditorHandle>();
    let current: { value: string; files: ComposerFileAttachment[] };
    let retained: RetainedContextPayloads;

    function Composer({ targetKey }: { targetKey: string }) {
      const [drafts, setDrafts] = useState<
        Record<string, { value: string; files: ComposerFileAttachment[] }>
      >({
        a: { value: initialValue, files: [file] },
        b: { value: destinationValue, files: [] },
      });
      const payloads = useRetainedContextPayloads(targetKey);
      const draft = drafts[targetKey]!;
      useEffect(() => {
        current = draft;
        retained = payloads;
      });
      const editorProps = {
        draftKey: targetKey,
        editorRef,
        value: draft.value,
        cursor: 0,
        contextRecords: new Map(
          draft.files.map((entry) => [
            fileContextReference(entry).contextId,
            { kind: "file" as const, record: entry },
          ]),
        ),
        skills: [],
        disabled: false,
        placeholder: "",
        onChange: (value, _cursor, _expandedCursor, _adjacent, contextIds) => {
          const changes = reconcileAttachmentContextReferences({
            referencedContextIds: new Set(contextIds),
            files: draft.files,
            images: [],
            previewAnnotations: [],
            retained: payloads,
          });
          setDrafts({
            ...drafts,
            [targetKey]: {
              value,
              files: [
                ...draft.files.filter((entry) => !changes.filesToRemove.includes(entry.id)),
                ...changes.filesToRestore,
              ],
            },
          });
        },
        onPaste: () => {},
      } satisfies ComposerPromptEditorProps;
      return createElement(ComposerPromptEditor, editorProps);
    }

    await using stack = new AsyncDisposableStack();
    const screen = stack.use(await render(createElement(Composer, { targetKey: "a" })));
    const editor = () => editorIn(screen.container);
    const environment = stack.move();
    return Object.assign(screen, {
      [Symbol.asyncDispose]: () => environment.disposeAsync(),
      initialValue,
      show: (targetKey: string) => screen.rerender(createElement(Composer, { targetKey })),
      editor,
      draft: () => current,
      retained: () => retained,
      deleteDraft: async () => {
        await act(async () => {
          const currentEditor = editor();
          currentEditor.view.dispatch(
            currentEditor.state.tr.delete(1, currentEditor.state.doc.content.size - 1),
          );
        });
      },
      undo: async () => {
        await act(async () => {
          editor().commands.undo();
        });
      },
    });
  }

  it("restores a deleted chip and its file bytes on same-draft undo, then releases them on unmount", async () => {
    await using composer = await mountComposer();
    await composer.deleteDraft();
    expect(composer.draft()).toEqual({ value: "", files: [] });
    const retained = composer.retained();
    expect(retained.files.get(fileContextReference(file).contextId)?.file).toBe(file.file);

    await composer.show("a");
    await composer.undo();
    expect(serializeEditorDoc(composer.editor().state.doc).value).toBe(composer.initialValue);
    expect(composer.draft()).toEqual({ value: composer.initialValue, files: [file] });
    expect(composer.draft().files[0]?.file).toBe(file.file);

    await composer.deleteDraft();
    await composer.unmount();
    expect(retained.files.size).toBe(0);
  });

  it.each(["", "Draft B"])(
    "releases deleted payloads and prevents undo into the previous draft when switching to %j",
    async (destinationValue) => {
      await using composer = await mountComposer(destinationValue);
      await composer.deleteDraft();
      expect(composer.draft()).toEqual({ value: "", files: [] });
      const retained = composer.retained();
      expect(retained.files.get(fileContextReference(file).contextId)?.file).toBe(file.file);

      await composer.show("b");
      expect(retained.files.size).toBe(0);
      await composer.undo();
      expect(serializeEditorDoc(composer.editor().state.doc).value).toBe(destinationValue);
      expect(composer.draft()).toEqual({ value: destinationValue, files: [] });

      await composer.show("a");
      await composer.undo();
      expect(serializeEditorDoc(composer.editor().state.doc).value).toBe("");
      expect(composer.draft()).toEqual({ value: "", files: [] });
    },
  );
});

describe("an Arabic line", () => {
  async function focusEnd(editor: Editor) {
    // ProseMirror rewrites the DOM caret 20ms after focus. Run that now, or it
    // can undo the first arrow key before ProseMirror reads the native move.
    using _timers = fakeTimers();
    await act(async () => {
      editor.commands.focus("end");
    });
    await vi.waitFor(() => expect(document.activeElement).toBe(editor.view.dom));
    vi.runOnlyPendingTimers();
  }

  it("leaves inline code through its start with ArrowRight, which points back", async () => {
    // Positions: اكتب at 1-5, sumBy at 6-11, الان at 12-16.
    await using screen = await mountEditor("اكتب `sumBy` الان");
    const { editor } = screen;
    await focusEnd(editor);
    const caret = () => ({
      head: editor.state.selection.head,
      inCode: (editor.state.storedMarks ?? editor.state.selection.$head.marks()).length > 0,
    });
    const visited = [caret()];
    while (visited.at(-1)!.head > 5) {
      const before = visited.at(-1)!;
      await userEvent.keyboard("{ArrowRight}");
      await vi.waitFor(() => {
        const after = caret();
        expect(after.head < before.head || after.inCode !== before.inCode).toBe(true);
      });
      visited.push(caret());
    }
    expect(visited.some((stop) => stop.inCode)).toBe(true);
  });

  it("shows the backticks on either side of inline code it is editing", async () => {
    await using screen = await mountEditor("اكتب `sumBy` الان");
    const { editor } = screen;
    await act(async () => {
      editor.commands.setTextSelection("اكتب su".length + 1);
    });
    const code = editor.view.dom.querySelector("code")!;
    const word = document.createRange();
    word.selectNodeContents([...code.childNodes].find((node) => node instanceof Text)!);
    const text = word.getBoundingClientRect();
    const [open, close] = [...editor.view.dom.querySelectorAll(".composer-rich-marker")].map(
      (marker) => marker.getBoundingClientRect(),
    );
    expect(open!.right).toBeLessThanOrEqual(text.left + 1);
    expect(close!.left).toBeGreaterThanOrEqual(text.right - 1);
  });

  it("starts the next line on the right", async () => {
    await using screen = await mountEditor("اكتب الدالة");
    const { editor } = screen;
    await focusEnd(editor);
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
    await vi.waitFor(() => expect(editor.state.doc.childCount).toBe(2));
    const box = editor.view.dom.getBoundingClientRect();
    expect(editor.view.coordsAtPos(editor.state.selection.head).left).toBeGreaterThan(
      box.left + box.width / 2,
    );
  });
});

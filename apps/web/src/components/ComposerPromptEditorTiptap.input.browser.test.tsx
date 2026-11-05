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
import { redoDepth, undoDepth } from "@tiptap/pm/history";
import { NodeSelection } from "@tiptap/pm/state";
import { createElement, createRef, useEffect, useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { commands, userEvent } from "vite-plus/test/browser";

import { act, fakeTimers, render } from "../../test/render";

import { flatToMarkdown, pmToFlat, serializeEditorDoc } from "~/composer-rich-text-doc";
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

it.each([
  { word: "ship", prefix: "", source: ["**ship**"] },
  { word: "path\\", prefix: "", source: [] },
  { word: "2*3", prefix: "", source: [] },
  { word: "b", prefix: "*", source: [] },
  { word: "word", prefix: "\\\\*", source: [] },
  { word: "word", prefix: "\\\\**", source: [] },
  { word: "word", prefix: "\\", source: [] },
  { word: "word", prefix: "\\\\", source: ["**word**"] },
  { word: "word", prefix: "\\\\\\", source: [] },
  {
    word: "word",
    prefix: "`path\\`",
    prefixText: "path\\",
    source: ["**word**"],
    code: ["path\\"],
  },
])(
  "bolds $word after '$prefix' with Mod+B only when text is selected",
  async ({ word, prefix, prefixText = prefix, source, code = [] }) => {
    const value = `${prefix}${word} it`;
    await using screen = await mountEditor(value);
    const { editor } = screen;
    const modB = isMacPlatform(navigator.platform) ? "{Meta>}b{/Meta}" : "{Control>}b{/Control}";
    await act(async () => {
      editor.commands.focus("end");
    });
    await vi.waitFor(() => expect(document.activeElement).toBe(editor.view.dom));
    await userEvent.keyboard(modB);
    expect(editor.state.storedMarks).toBeNull();

    await act(async () => {
      editor.commands.setTextSelection({
        from: prefixText.length + 1,
        to: prefixText.length + word.length + 1,
      });
    });
    await userEvent.keyboard(modB);
    await vi.waitFor(() =>
      expect(serializeEditorDoc(editor.state.doc).value).toBe(`${prefix}**${word}** it`),
    );
    expect(textWithMark(editor, "markdownSource")).toEqual(source);
    const depth = undoDepth(editor.state);
    await userEvent.keyboard("{End}");
    expect(serializeEditorDoc(editor.state.doc).value).toBe(`${prefix}**${word}** it`);
    expect(textWithMark(editor, "bold")).toEqual([word]);
    expect(textWithMark(editor, "code")).toEqual(code);
    expect(undoDepth(editor.state)).toBe(depth);
    await act(async () => {
      editor.commands.setTextSelection({
        from: prefixText.length + 1,
        to: prefixText.length + word.length + 1,
      });
    });

    await userEvent.keyboard(modB);
    await vi.waitFor(() => expect(serializeEditorDoc(editor.state.doc).value).toBe(value));
  },
);

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

it.each([
  { at: "inside bold", selection: 5, composed: "**bo漢ld** after", bold: ["bo漢ld"] },
  {
    at: "over the opening markers",
    selection: { from: 1, to: 3 },
    composed: "漢bold** after",
    bold: [],
  },
  { at: "after the closing markers", selection: 9, composed: "**bold**漢 after", bold: ["bold"] },
])("undoes composition $at in revealed Markdown through the earlier paste", async (row) => {
  await using screen = await mountEditor("");
  const { editor } = screen;
  const value = () => serializeEditorDoc(editor.state.doc).value;
  await act(async () => {
    editor.view.focus();
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", "**bold** after");
    editor.view.dom.dispatchEvent(new ClipboardEvent("paste", { clipboardData, cancelable: true }));
    editor.commands.insertContent("!");
    editor.commands.undo();
    editor.commands.setTextSelection(3);
  });
  expect(value()).toBe("**bold** after");
  expect(textWithMark(editor, "markdownSource")).toEqual(["**bold**"]);
  await act(async () => {
    editor.commands.setTextSelection(row.selection);
    editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart"));
    editor.view.dom.dispatchEvent(new CompositionEvent("compositionend", { data: "" }));
  });
  expect([undoDepth(editor.state), redoDepth(editor.state)]).toEqual([1, 1]);
  await act(async () => {
    editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart"));
    editor.view.dispatch(editor.state.tr.insertText("漢").setMeta("composition", 2));
    editor.view.dom.dispatchEvent(new CompositionEvent("compositionend", { data: "漢" }));
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
  });
  expect(value()).toBe(row.composed);
  await act(async () => {
    editor.commands.undo();
  });
  expect(value()).toBe("**bold** after");
  await act(async () => {
    editor.commands.undo();
  });
  expect(value()).toBe("");
  await act(async () => {
    editor.commands.redo();
    editor.commands.redo();
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
  });
  expect(value()).toBe(row.composed);
  expect(textWithMark(editor, "bold")).toEqual(row.bold);
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

it.each([
  { selection: 5, prefix: "**bo", suffix: "ld** after", bold: ["bo你好ld"] },
  { selection: { from: 1, to: 3 }, prefix: "", suffix: "bold** after", bold: [] },
  { selection: 9, prefix: "**bold**", suffix: " after", bold: ["bold"] },
])("keeps native pinyin preedit intact in revealed source at $selection", async (row) => {
  await using screen = await mountEditor("");
  const { editor } = screen;
  const value = () => serializeEditorDoc(editor.state.doc).value;
  await focusAt(editor, "end");
  await act(async () => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", "**bold** after");
    editor.view.dom.dispatchEvent(new ClipboardEvent("paste", { clipboardData, cancelable: true }));
    editor.commands.insertContent("!");
    editor.commands.undo();
    editor.commands.setTextSelection(3);
    editor.commands.setTextSelection(row.selection);
  });
  expect([undoDepth(editor.state), redoDepth(editor.state)]).toEqual([1, 1]);
  const compositionStart = vi.fn();
  const compositionEnd = vi.fn();
  editor.view.dom.addEventListener("compositionstart", compositionStart);
  editor.view.dom.addEventListener("compositionend", compositionEnd);
  for (const text of ["nihao", "niha", "nih", "ni", "n"]) {
    await commands.setImeComposition(text);
    await vi.waitFor(() => expect(value()).toBe(`${row.prefix}${text}${row.suffix}`));
    expect(editor.view.composing).toBe(true);
    expect(compositionStart).toHaveBeenCalledOnce();
    expect(compositionEnd).not.toHaveBeenCalled();
    const event = new KeyboardEvent("keydown", {
      key: "Backspace",
      keyCode: 229,
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    editor.view.dom.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  }
  await commands.commitImeText("你好");
  await vi.waitFor(() => expect(value()).toBe(`${row.prefix}你好${row.suffix}`));
  expect(compositionEnd).toHaveBeenCalledOnce();
  await userEvent.keyboard("{End}");
  expect(textWithMark(editor, "bold")).toEqual(row.bold);
  await act(async () => editor.commands.undo());
  expect(value()).toBe("**bold** after");
  await act(async () => editor.commands.undo());
  expect(value()).toBe("");
  await act(async () => {
    editor.commands.redo();
    editor.commands.redo();
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
  });
  expect(value()).toBe(`${row.prefix}你好${row.suffix}`);
  expect(textWithMark(editor, "bold")).toEqual(row.bold);
});

it.each([false, true])(
  "keeps a %s source selection across reveal and serialization",
  async (reverse) => {
    const value = "**first** and *second* end";
    await using screen = await mountEditor(value);
    const { editor } = screen;
    await act(async () => {
      editor.commands.setTextSelection(reverse ? { from: 17, to: 1 } : { from: 1, to: 17 });
    });
    const { selection } = editor.state;
    expect(selection.anchor > selection.head).toBe(reverse);
    expect(editor.state.doc.textBetween(selection.from, selection.to)).toBe(
      "**first** and *second*",
    );
    expect(serializeEditorDoc(editor.state.doc).value).toBe(value);
    await act(async () => {
      editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    });
    expect(textWithMark(editor, "bold")).toEqual(["first"]);
    expect(textWithMark(editor, "italic")).toEqual(["second"]);
    expect(undoDepth(editor.state)).toBe(0);
  },
);

async function focusAt(editor: Editor, position: number | "end") {
  using _timers = fakeTimers();
  await act(async () => {
    editor.commands.focus(position);
  });
  await vi.waitFor(() => expect(document.activeElement).toBe(editor.view.dom));
  vi.runOnlyPendingTimers();
}

describe("Markdown markers around styled text", () => {
  it.each([
    { keys: "{Backspace}", expected: "**** after" },
    { keys: "X", expected: "**X** after" },
  ])("keeps a styled chip selected for $keys when showing source", async ({ keys, expected }) => {
    await using screen = await mountEditor("$babysit after", true, [babysit]);
    const { editor } = screen;
    await focusAt(editor, "end");
    await act(async () => {
      editor.view.dispatch(editor.state.tr.addMark(1, 2, editor.schema.marks.bold!.create()));
    });
    expect(editor.state.doc.nodeAt(1)?.type.name).toBe("composer-skill");
    await act(async () => {
      editor.commands.setNodeSelection(1);
    });
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    expect((editor.state.selection as NodeSelection).node.type.name).toBe("composer-skill");
    await userEvent.keyboard(keys);
    await userEvent.keyboard("{End}");
    await vi.waitFor(() => expect(serializeEditorDoc(editor.state.doc).value).toBe(expected));
  });

  it.each([
    {
      name: "deleting the opening markers removes bold",
      value: "**bold** after",
      caret: 1,
      keys: "{Delete}{Delete}",
      expected: "bold** after",
      marks: {},
    },
    {
      name: "turning ** into * makes it italic",
      value: "**bold** after",
      caret: 1,
      keys: "{Delete}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{Delete}",
      expected: "*bold* after",
      marks: { italic: ["bold"] },
    },
    {
      name: "backspacing from the closing edge keeps italic",
      value: "**bold** after",
      caret: 1,
      keys: async (editor: Editor) => {
        await userEvent.keyboard("{Delete}");
        await vi.waitFor(() => expect(editor.state.doc.textContent).toBe("*bold** after"));
        for (let position = 2; position <= 8; position += 1) {
          await userEvent.keyboard("{ArrowRight}");
          await vi.waitFor(() => expect(editor.state.selection.from).toBe(position));
        }
        await userEvent.keyboard("{Backspace}");
        await vi.waitFor(() =>
          expect(serializeEditorDoc(editor.state.doc).value).toBe("*bold* after"),
        );
      },
      expected: "*bold* after",
      marks: { italic: ["bold"] },
    },
    {
      name: "retyping deleted closing markers restores bold",
      value: "**bold** after",
      caret: 3,
      keys: "{ArrowRight}{ArrowRight}{Delete}{Delete}**",
      expected: "**bold** after",
      marks: { bold: ["bold"] },
    },
    {
      name: "retyping the closing backtick restores code",
      value: "`code` after",
      caret: 3,
      keys: "{ArrowRight}{ArrowRight}{Delete}`",
      expected: "`code` after",
      marks: { code: ["code"] },
    },
    {
      name: "retyping the closing star restores italic",
      value: "*word* after",
      caret: 3,
      keys: "{ArrowRight}{ArrowRight}{Delete}*",
      expected: "*word* after",
      marks: { italic: ["word"] },
    },
    {
      name: "retyping the closing tildes restores strike",
      value: "~~word~~ after",
      caret: 3,
      keys: "{ArrowRight}{ArrowRight}{Delete}{Delete}~~",
      expected: "~~word~~ after",
      marks: { strike: ["word"] },
    },
    {
      name: "deleting a backtick removes inline code",
      value: "`code` after",
      caret: 1,
      keys: "{Delete}",
      expected: "code` after",
      marks: {},
    },
    {
      name: "deleting strike delimiters removes strike",
      value: "~~word~~ after",
      caret: 1,
      keys: "{Delete}{Delete}",
      expected: "word~~ after",
      marks: {},
    },
    {
      name: "wrapping shown source with typed delimiters nests its style",
      value: "**bold** after",
      caret: 3,
      keys: async (editor: Editor) => {
        await act(async () => editor.commands.setTextSelection({ from: 3, to: 7 }));
        await userEvent.keyboard("_");
      },
      expected: "***bold*** after",
      marks: { bold: ["bold"], italic: ["bold"] },
    },
    {
      name: "a line break inside bold keeps both halves bold",
      value: "**bold** after",
      caret: 3,
      keys: "{Shift>}{Enter}{/Shift}",
      expected: "**bo**\n**ld** after",
      marks: { bold: ["bo", "ld"] },
    },
    {
      name: "splitting a list item inside bold keeps both halves bold",
      value: "- **bold** after",
      caret: 5,
      keys: "{Enter}",
      expected: "- **bo**\n- **ld** after",
      marks: { bold: ["bo", "ld"] },
    },
  ])("edits the markers as text: $name", async ({ value, caret, keys, expected, marks }) => {
    await using screen = await mountEditor(value);
    const { editor } = screen;
    await focusAt(editor, caret);
    if (typeof keys === "string") await userEvent.keyboard(keys);
    else await keys(editor);
    await userEvent.keyboard("{End}");
    await vi.waitFor(() => expect(serializeEditorDoc(editor.state.doc).value).toBe(expected));
    for (const name of ["bold", "italic", "strike", "code"] as const) {
      expect(textWithMark(editor, name)).toEqual(marks[name as keyof typeof marks] ?? []);
    }
  });

  it.each([
    { pasted: "X", expected: "**helloXworld** after", bold: ["helloXworld"] },
    { pasted: "*new*", expected: "**hello*new*world** after", bold: ["hello", "new", "world"] },
    {
      pasted: "one\ntwo",
      expected: "**hello**\none\ntwo\n**world** after",
      bold: ["hello", "world"],
    },
    {
      pasted: "<script>alert(1)</script>",
      expected: "**hello<script>alert(1)</script>world** after",
      bold: ["hello<script>alert(1)</script>world"],
    },
  ])(
    "preserves Markdown when pasting $pasted into shown source",
    async ({ pasted, expected, bold }) => {
      await using screen = await mountEditor("**helloworld** after");
      const { editor } = screen;
      await focusAt(editor, "hello".length + 1);
      await act(async () => {
        const clipboardData = new DataTransfer();
        clipboardData.setData("text/plain", pasted);
        editor.view.dom.dispatchEvent(
          new ClipboardEvent("paste", { clipboardData, cancelable: true }),
        );
        editor.commands.setTextSelection(editor.state.doc.content.size - 1);
      });
      expect(serializeEditorDoc(editor.state.doc).value).toBe(expected);
      expect(textWithMark(editor, "bold")).toEqual(bold);
      expect(editor.view.dom.querySelector("script")).toBeNull();
      await act(async () => editor.commands.undo());
      expect(serializeEditorDoc(editor.state.doc).value).toBe("**helloworld** after");
      await act(async () => {
        editor.commands.redo();
        editor.commands.setTextSelection(editor.state.doc.content.size - 1);
      });
      expect(serializeEditorDoc(editor.state.doc).value).toBe(expected);
    },
  );

  it.each([
    "foo****bar",
    "foo____bar",
    "foo~~~~bar",
    "foo.****.bar",
    "foo.____.bar",
    "foo.~~~~.bar",
  ])(
    "keeps literal delimiter pairs when deleting the opening code backtick around %s",
    async (content) => {
      const original = `\`${content}\` after`;
      const expected = `${content}\` after`;
      await using screen = await mountEditor(original);
      const { editor } = screen;
      const value = () => serializeEditorDoc(editor.state.doc).value;
      await focusAt(editor, 1);
      expect(textWithMark(editor, "markdownSource")).toEqual([`\`${content}\``]);
      await userEvent.keyboard("{Delete}");
      expect(value()).toBe(expected);
      await userEvent.keyboard("{End}");
      expect(value()).toBe(expected);
      expect(editor.state.doc.textContent).toBe(expected);
      expect(undoDepth(editor.state)).toBe(1);
      await act(async () => {
        editor.commands.undo();
        editor.commands.setTextSelection(editor.state.doc.content.size - 1);
      });
      expect(value()).toBe(original);
      await act(async () => {
        editor.commands.redo();
        editor.commands.setTextSelection(editor.state.doc.content.size - 1);
      });
      expect(value()).toBe(expected);
      for (const name of ["bold", "italic", "strike", "code"]) {
        expect(textWithMark(editor, name)).toEqual([]);
      }
    },
  );

  describe.each(["", "before "])("pasting at source boundaries after %j", (prefix) => {
    it.each([
      { at: "outside the opener", from: 0, to: 0 },
      { at: "inside the opener", from: 1, to: 1 },
      { at: "after the opener", from: 2, to: 2 },
      { at: "inside the content", from: 4, to: 4 },
      { at: "before the closer", from: 6, to: 6 },
      { at: "inside the closer", from: 7, to: 7 },
      { at: "outside the closer", from: 8, to: 8 },
      { at: "over the opener", from: 0, to: 2 },
      { at: "over the reversed opener", from: 2, to: 0 },
      { at: "over the content", from: 2, to: 6 },
      { at: "over the closer", from: 6, to: 8 },
      { at: "over the reversed closer", from: 8, to: 6 },
      { at: "over the whole source", from: 0, to: 8 },
      { at: "over the closer and following space", from: 6, to: 9 },
    ])("replaces exactly $at and preserves the caret and undo", async ({ from, to }) => {
      const original = `${prefix}**bold** after`;
      const start = prefix.length + Math.min(from, to);
      const end = prefix.length + Math.max(from, to);
      const expected = `${original.slice(0, start)}X${original.slice(end)}`;
      await using screen = await mountEditor(original);
      const { editor } = screen;
      const value = () => serializeEditorDoc(editor.state.doc).value;
      await focusAt(editor, prefix.length + 1);
      await act(async () => {
        editor.commands.setTextSelection({
          from: prefix.length + from + 1,
          to: prefix.length + to + 1,
        });
        const clipboardData = new DataTransfer();
        clipboardData.setData("text/plain", "X");
        editor.view.dom.dispatchEvent(
          new ClipboardEvent("paste", { clipboardData, cancelable: true }),
        );
      });
      expect(value()).toBe(expected);
      const map = serializeEditorDoc(editor.state.doc);
      expect(flatToMarkdown(map, pmToFlat(map, editor.state.selection.from))).toBe(start + 1);
      await userEvent.keyboard("{End}");
      expect(value()).toBe(expected);
      expect(undoDepth(editor.state)).toBe(1);
      await act(async () => editor.commands.undo());
      expect(value()).toBe(original);
      await act(async () => {
        editor.commands.redo();
        editor.commands.setTextSelection(editor.state.doc.content.size - 1);
      });
      expect(value()).toBe(expected);
    });
  });

  it.each(["copy", "cut"])(
    "puts selected opening delimiters on the clipboard on %s",
    async (type) => {
      await using screen = await mountEditor("**bold** after");
      const { editor } = screen;
      await focusAt(editor, 1);
      const clipboardData = new DataTransfer();
      await act(async () => {
        editor.commands.setTextSelection({ from: 1, to: 3 });
        editor.view.dom.dispatchEvent(
          new ClipboardEvent(type, { clipboardData, bubbles: true, cancelable: true }),
        );
      });
      expect(clipboardData.getData("text/plain")).toBe("**");
      expect(serializeEditorDoc(editor.state.doc).value).toBe(
        type === "cut" ? "bold** after" : "**bold** after",
      );
      if (type === "cut") {
        await act(async () => editor.commands.undo());
        expect(serializeEditorDoc(editor.state.doc).value).toBe("**bold** after");
      }
    },
  );

  it.each([0, 1, 2, 4, 7, 8])("restores exact Markdown offset %s on focus", async (cursor) => {
    const editorRef = createRef<ComposerPromptEditorHandle>();
    await using screen = await render(
      <ComposerPromptEditor
        editorRef={editorRef}
        value="**bold** after"
        cursor={cursor}
        richTextEnabled
        contextRecords={new Map()}
        skills={[]}
        disabled={false}
        placeholder=""
        onChange={() => {}}
        onPaste={() => {}}
      />,
    );
    const editor = editorIn(screen.container);
    await act(async () => editorRef.current!.focusAt(cursor));
    expect(editorRef.current!.readSnapshot().expandedCursor).toBe(cursor);
    expect(serializeEditorDoc(editor.state.doc).value).toBe("**bold** after");
    expect(undoDepth(editor.state)).toBe(0);
  });

  it("shows nested formatting as Markdown and restores it when the caret leaves", async () => {
    const value = "**a *b* c** d";
    await using screen = await mountEditor(value);
    const { editor } = screen;
    await focusAt(editor, "a b".length + 1);
    expect(editor.state.doc.textContent).toBe(value);
    expect(textWithMark(editor, "bold")).toEqual([]);
    await userEvent.keyboard("{End}");
    await vi.waitFor(() => expect(editor.state.doc.textContent).toBe("a b c d"));
    expect(textWithMark(editor, "bold")).toEqual(["a ", "b", " c"]);
    expect(textWithMark(editor, "italic")).toEqual(["b"]);
    expect(serializeEditorDoc(editor.state.doc).value).toBe(value);
  });

  it("undoes a marker edit in one step without an extra step for showing markers", async () => {
    await using screen = await mountEditor("**bold** after");
    const { editor } = screen;
    await focusAt(editor, "end");
    await userEvent.keyboard("!");
    await act(async () => {
      editor.commands.setTextSelection(1);
    });
    await userEvent.keyboard("{Delete}{Delete}{End}");
    const value = () => serializeEditorDoc(editor.state.doc).value;
    await vi.waitFor(() => expect(value()).toBe("bold** after!"));
    await act(async () => {
      editor.commands.undo();
    });
    expect(value()).toBe("**bold** after!");
    expect(textWithMark(editor, "markdownSource")).toEqual(["**bold**"]);
    const end = () => editor.state.doc.content.size - 1;
    await act(async () => {
      editor.commands.setTextSelection(end());
    });
    expect(value()).toBe("**bold** after!");
    const hidden = editor.view.dom.querySelectorAll(".composer-rich-marker-hidden");
    expect(Array.from(hidden, (marker) => marker.textContent)).toEqual(["**", "**"]);
    await act(async () => {
      editor.commands.undo();
    });
    expect(value()).toBe("**bold** after");
    await act(async () => {
      editor.commands.setTextSelection(3);
    });
    expect(editor.state.doc.textContent).toBe("**bold** after");
    expect(textWithMark(editor, "markdownSource")).toEqual(["**bold**"]);
    await act(async () => {
      editor.commands.redo();
    });
    expect(value()).toBe("**bold** after!");
    await act(async () => {
      editor.commands.setTextSelection(1);
    });
    await act(async () => {
      editor.commands.redo();
    });
    expect(value()).toBe("bold** after!");
    expect(textWithMark(editor, "bold")).toEqual([]);
    await act(async () => {
      editor.commands.undo();
      editor.commands.undo();
    });
    await act(async () => {
      editor.commands.redo();
    });
    await act(async () => {
      editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    });
    await act(async () => {
      editor.commands.undo();
    });
    expect(editor.state.doc.textContent).toBe("**bold** after");
    await act(async () => {
      editor.commands.setTextSelection(end());
    });
    expect(editor.state.doc.textContent).toBe("bold after");
    expect(textWithMark(editor, "bold")).toEqual(["bold"]);
    await userEvent.keyboard("?");
    await act(async () => {
      editor.commands.undo();
    });
    await act(async () => {
      editor.commands.redo();
    });
    expect(editor.state.doc.textContent).toBe("bold after?");
    await act(async () => {
      editor.commands.setTextSelection(1);
    });
    expect(editor.state.doc.textContent).toBe("**bold** after?");
    expect(textWithMark(editor, "markdownSource")).toEqual(["**bold**"]);
    await act(async () => {
      editor.commands.setTextSelection(end());
    });
    expect(editor.state.doc.textContent).toBe("bold after?");
    expect(textWithMark(editor, "bold")).toEqual(["bold"]);
    await act(async () => {
      editor.commands.setTextSelection(1);
    });
    await userEvent.keyboard("{Delete}");
    expect(value()).toBe("*bold** after?");
    await act(async () => {
      editor.commands.undo();
    });
    expect(value()).toBe("**bold** after?");
    expect(textWithMark(editor, "markdownSource")).toEqual(["**bold**"]);
    await act(async () => {
      editor.commands.setTextSelection(end());
    });
    expect(editor.state.doc.textContent).toBe("bold after?");
    expect(textWithMark(editor, "bold")).toEqual(["bold"]);
  });

  it("keeps bold around a skill pasted inside it", async () => {
    await using screen = await mountEditor("**helloworld** after", true, [babysit]);
    const { editor } = screen;
    await focusAt(editor, "hello".length + 1);
    await act(async () => {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", "$babysit");
      editor.view.dom.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData, cancelable: true }),
      );
    });
    await userEvent.keyboard("{End}");
    await vi.waitFor(() =>
      expect(serializeEditorDoc(editor.state.doc).value).toBe("**hello** $babysit **world** after"),
    );
    expect(textWithMark(editor, "bold")).toEqual(["hello", "world"]);
  });
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

  it("walks back through inline code and its backticks with ArrowRight", async () => {
    const value = "اكتب `sumBy` الان";
    await using screen = await mountEditor(value);
    const { editor } = screen;
    await focusEnd(editor);
    const offset = () => {
      const map = serializeEditorDoc(editor.state.doc);
      return flatToMarkdown(map, pmToFlat(map, editor.state.selection.head));
    };
    const visited = [offset()];
    let sawSource = false;
    while (visited.at(-1)! > "اكتب".length) {
      const before = visited.at(-1)!;
      await userEvent.keyboard("{ArrowRight}");
      await vi.waitFor(() => expect(offset()).toBe(before - 1));
      sawSource ||= editor.state.doc.textContent === value;
      visited.push(offset());
    }
    expect(sawSource).toBe(true);
    expect(textWithMark(editor, "code")).toEqual(["sumBy"]);
  });

  it("shows the backticks on either side of inline code it is editing", async () => {
    await using screen = await mountEditor("اكتب `sumBy` الان");
    const { editor } = screen;
    await act(async () => {
      editor.commands.setTextSelection("اكتب su".length + 1);
    });
    const code = editor.view.dom.querySelector("code")!;
    const text = [...code.childNodes].find((node) => node instanceof Text)!;
    expect(text.data).toBe("`sumBy`");
    const rect = (from: number, to: number) => {
      const range = document.createRange();
      range.setStart(text, from);
      range.setEnd(text, to);
      return range.getBoundingClientRect();
    };
    const [open, word, close] = [rect(0, 1), rect(1, 6), rect(6, 7)];
    expect(open.right).toBeLessThanOrEqual(word.left + 1);
    expect(close.left).toBeGreaterThanOrEqual(word.right - 1);
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

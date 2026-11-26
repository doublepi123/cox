import { afterEach, expect, it, vi } from "vite-plus/test";
import { encodeComposerContextFragment } from "@t3tools/shared/composerContextClipboard";
import { ComposerContextId, EnvironmentId, MessageId } from "@t3tools/contracts";
import {
  readPastedComposerContext,
  rememberCopiedComposerContext,
} from "./composerInlineTokenPaste";

const shell = vi.hoisted(() => ({ platform: "android" }));
vi.mock("../mobile/mobileShellBridge", () => ({ getMobileShellInfo: () => shell }));

afterEach(() => {
  shell.platform = "android";
  rememberCopiedComposerContext("", null);
});

it("recovers a sent image only while the Android clipboard still matches the copied text", () => {
  const text = "Review this image\n ![shot.png](t3-context://v1/image/file_sent-image)";
  const fragment = {
    version: 1,
    source: { environmentId: EnvironmentId.make("source"), messageId: MessageId.make("sent") },
    records: [
      {
        version: 1,
        contextId: ComposerContextId.make("file_sent-image"),
        label: "shot.png",
        kind: "image",
        attachmentId: "stored-image",
        name: "shot.png",
        mimeType: "image/png",
        sizeBytes: 53249,
      },
    ],
  } as const;
  const plain = (value: string) => ({
    getData: (type: string) => (type === "text/plain" ? value : ""),
  });
  rememberCopiedComposerContext(text, encodeComposerContextFragment(fragment));
  expect(readPastedComposerContext(plain(text))).toEqual(fragment);
  shell.platform = "ios";
  expect(readPastedComposerContext(plain(text))).toBeNull();
  shell.platform = "android";
  expect(readPastedComposerContext(plain("different text"))).toBeNull();
  expect(readPastedComposerContext(plain(text))).toBeNull();
});

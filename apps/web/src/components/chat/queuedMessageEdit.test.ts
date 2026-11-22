import { ChatAttachmentId, ComposerContextId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import {
  DraftId,
  useComposerDraftStore,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
} from "../../composerDraftStore";
import { formatInlineContextReference } from "../../lib/composerContextReferences";
import {
  matchRestorableQueuedAttachment,
  prepareQueuedEditAttachments,
  recoverQueuedMessageEdit,
} from "./queuedMessageEdit";

const environmentId = EnvironmentId.make("remote-environment");
const threadTarget = scopeThreadRef(environmentId, ThreadId.make("thread:edit"));
const editTarget = DraftId.make("queued-edit:test");
const file: ComposerFileAttachment = {
  type: "file",
  id: "file:report",
  name: "report.pdf",
  mimeType: "application/pdf",
  sizeBytes: 6,
  file: new File(["report"], "report.pdf", { type: "application/pdf" }),
};
const image: ComposerImageAttachment = {
  type: "image",
  id: "image:screen",
  name: "screen.png",
  mimeType: "image/png",
  sizeBytes: 5,
  file: new File(["image"], "screen.png", { type: "image/png" }),
  previewUrl: "blob:screen",
};
const uploadedFile = {
  type: "file" as const,
  id: "upload:report",
  name: file.name,
  mimeType: file.mimeType,
  sizeBytes: file.sizeBytes,
};

describe("queued message file edits", () => {
  beforeEach(() => {
    useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
  });

  it.each([
    { images: [], label: "file-only" },
    { images: [image], label: "mixed" },
  ])("preserves a generic file in a $label save", async ({ images }) => {
    const attachments = await prepareQueuedEditAttachments({
      existingAttachments: [],
      images,
      files: [file],
      uploadFiles: async () => [uploadedFile],
      readImage: async () => "data:image/png;base64,aW1hZ2U=",
    });
    expect(attachments.at(-1)).toEqual(uploadedFile);
    expect(attachments.length).toBe(images.length + 1);
    if (images.length > 0)
      expect(attachments[0]).toMatchObject({
        type: "image",
        dataUrl: "data:image/png;base64,aW1hZ2U=",
      });
  });

  it("fails a save instead of dropping a file whose upload is missing", async () => {
    await expect(
      prepareQueuedEditAttachments({
        existingAttachments: [],
        images: [image],
        files: [file],
        uploadFiles: async () => [],
        readImage: async () => "image",
      }),
    ).rejects.toThrow("Retry or remove");
  });

  it("keeps file-only edits when another client starts the queued run", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(editTarget, "Original message");
    store.addFiles(editTarget, [file]);
    expect(
      recoverQueuedMessageEdit({ editTarget, threadTarget, originalText: "Original message" }),
    ).toBe("kept");
    expect(store.getComposerDraft(threadTarget)?.prompt).toBe("Original message");
    expect(store.getComposerDraft(threadTarget)?.files).toEqual([file]);
    expect(store.getComposerDraft(editTarget)).toBeNull();
  });

  it("strips existing queued attachment references when recovering an edit into the thread draft", () => {
    const store = useComposerDraftStore.getState();
    const chip = formatInlineContextReference({
      kind: "image",
      contextId: "image_queued-1",
      label: "image.png",
    });
    store.setPrompt(editTarget, `Check ${chip} closely`);
    expect(
      recoverQueuedMessageEdit({
        editTarget,
        threadTarget,
        originalText: `Check ${chip}`,
        existingAttachmentContextIds: ["image_queued-1"],
      }),
    ).toBe("kept");
    expect(store.getComposerDraft(threadTarget)?.prompt).toBe("Check closely");
    expect(store.getComposerDraft(editTarget)).toBeNull();

    store.clearComposerContent(threadTarget);
    store.setPrompt(editTarget, chip);
    expect(
      recoverQueuedMessageEdit({
        editTarget,
        threadTarget,
        originalText: `${chip} note`,
        existingAttachmentContextIds: ["image_queued-1"],
      }),
    ).toBe("discarded");
    expect(store.getComposerDraft(threadTarget)).toBeNull();
  });

  it("matches a removed queued attachment for same-environment paste while rejecting other environments or payloads", () => {
    const fileId = ChatAttachmentId.make("server-file-1");
    const contextId = ComposerContextId.make("file_local-1");
    const removedAttachment = {
      type: "file" as const,
      id: fileId,
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 12,
    };
    const record = {
      version: 1 as const,
      kind: "file" as const,
      contextId,
      label: "notes.txt",
      attachmentId: fileId,
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 12,
    };

    expect(
      matchRestorableQueuedAttachment({
        environmentId,
        sourceEnvironmentId: environmentId,
        record,
        removedQueuedAttachments: [{ attachment: removedAttachment, contextIds: [contextId] }],
      }),
    ).toEqual({ attachment: removedAttachment, contextId });

    expect(
      matchRestorableQueuedAttachment({
        environmentId,
        sourceEnvironmentId: EnvironmentId.make("other-environment"),
        record,
        removedQueuedAttachments: [{ attachment: removedAttachment, contextIds: [contextId] }],
      }),
    ).toBeNull();

    expect(
      matchRestorableQueuedAttachment({
        environmentId,
        sourceEnvironmentId: environmentId,
        record: { ...record, attachmentId: ChatAttachmentId.make("different-file") },
        removedQueuedAttachments: [{ attachment: removedAttachment, contextIds: [contextId] }],
      }),
    ).toBeNull();
  });

  it("does not overwrite a separate draft when the queued run leaves", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(threadTarget, "Separate draft");
    store.addFiles(editTarget, [file]);
    expect(recoverQueuedMessageEdit({ editTarget, threadTarget, originalText: "" })).toBe(
      "discarded",
    );
    expect(store.getComposerDraft(threadTarget)?.prompt).toBe("Separate draft");
    expect(store.getComposerDraft(editTarget)).toBeNull();
  });
});

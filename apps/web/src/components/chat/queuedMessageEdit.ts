import { resolveQueuedEditExit } from "@t3tools/client-runtime/queued-run-edit";
import type {
  ChatAttachment,
  ChatFileAttachment,
  ChatImageAttachment,
  ComposerContextId,
  ComposerContextRecord,
  EnvironmentId,
  ModelSelection,
  OrchestrationMessageContext,
} from "@t3tools/contracts";
import * as Equal from "effect/Equal";
import {
  composerDraftHasUserContent,
  useComposerDraftStore,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type ComposerThreadTarget,
} from "../../composerDraftStore";
import {
  attachmentContextRecord,
  isSameComposerContextPayload,
} from "../../lib/composerContextRecords";
import { removeInlineContextReference } from "../../lib/composerContextReferences";

export function isQueuedImageAttachment(
  attachment: ChatAttachment,
): attachment is ChatImageAttachment {
  return attachment.type === "image";
}

export function isQueuedFileAttachment(
  attachment: ChatAttachment,
): attachment is ChatFileAttachment {
  return attachment.type === "file";
}

export function attachmentContextIdsForRecord(
  context: OrchestrationMessageContext | undefined,
  attachment: Pick<ChatAttachment, "id" | "type">,
): ComposerContextId[] {
  return (context?.records ?? []).flatMap((record) =>
    record.kind === attachment.type &&
    "attachmentId" in record &&
    record.attachmentId === attachment.id
      ? [record.contextId]
      : [],
  );
}

export function matchRestorableQueuedAttachment(input: {
  readonly environmentId: EnvironmentId;
  readonly sourceEnvironmentId: EnvironmentId | null;
  readonly record: Extract<ComposerContextRecord, { kind: "image" | "file" }>;
  readonly removedQueuedAttachments: ReadonlyArray<{
    readonly attachment: ChatAttachment;
    readonly contextIds: ReadonlyArray<ComposerContextId>;
  }>;
}): { readonly attachment: ChatAttachment; readonly contextId: ComposerContextId } | null {
  if (input.sourceEnvironmentId !== input.environmentId) return null;
  const match = input.removedQueuedAttachments.find(
    ({ attachment, contextIds }) =>
      (isQueuedImageAttachment(attachment) || isQueuedFileAttachment(attachment)) &&
      attachment.type === input.record.kind &&
      contextIds.some((contextId) =>
        isSameComposerContextPayload(
          attachmentContextRecord({
            attachment,
            attachmentId: attachment.id,
            contextId,
          }),
          input.record,
        ),
      ),
  );
  if (!match || match.contextIds.length === 0) return null;
  const contextId =
    match.contextIds.find((candidate) => candidate === input.record.contextId) ??
    match.contextIds[0]!;
  return { attachment: match.attachment, contextId };
}

export function recoverQueuedMessageEdit(input: {
  readonly editTarget: ComposerThreadTarget;
  readonly threadTarget: ComposerThreadTarget;
  readonly originalText: string;
  readonly originalModelSelection?: ModelSelection;
  readonly removedExistingAttachment?: boolean;
  readonly existingAttachmentContextIds?: ReadonlyArray<string>;
}): "kept" | "discarded" | "clean" {
  const store = useComposerDraftStore.getState();
  const draft = store.getComposerDraft(input.editTarget);
  const selection = draft?.activeProvider
    ? draft.modelSelectionByProvider[draft.activeProvider]
    : undefined;
  const selectionChanged =
    selection !== undefined && !Equal.equals(selection, input.originalModelSelection);
  const strippedPrompt =
    draft && (input.existingAttachmentContextIds?.length ?? 0) > 0
      ? input.existingAttachmentContextIds!.reduce(
          (prompt, contextId) => removeInlineContextReference(prompt, contextId).prompt,
          draft.prompt,
        )
      : draft?.prompt;
  const recoveredDraft =
    draft && strippedPrompt !== undefined && strippedPrompt !== draft.prompt
      ? { ...draft, prompt: strippedPrompt }
      : draft;
  const recovery = resolveQueuedEditExit({
    editChanged:
      selectionChanged ||
      input.removedExistingAttachment === true ||
      (draft !== null &&
        (draft.prompt !== input.originalText || draft.images.length > 0 || draft.files.length > 0)),
    threadDraftEmpty:
      composerDraftHasUserContent(recoveredDraft) &&
      !composerDraftHasUserContent(store.getComposerDraft(input.threadTarget)),
  });
  if (recovery === "kept") {
    if (draft && strippedPrompt !== undefined && strippedPrompt !== draft.prompt) {
      store.setPrompt(input.editTarget, strippedPrompt);
    }
    store.moveComposerPromptAndImages(input.editTarget, input.threadTarget);
    if (selectionChanged)
      store.setModelSelection(input.threadTarget, selection, {
        explicit: true,
        replaceOptions: true,
      });
  }
  store.clearDraftThread(input.editTarget);
  return recovery;
}

export async function prepareQueuedEditAttachments(input: {
  readonly existingAttachments: ReadonlyArray<ChatAttachment>;
  readonly images: ReadonlyArray<ComposerImageAttachment>;
  readonly files: ReadonlyArray<ComposerFileAttachment>;
  readonly uploadFiles: (
    files: ReadonlyArray<ComposerFileAttachment>,
  ) => Promise<ReadonlyArray<ChatAttachment>>;
  readonly readImage: (file: File) => Promise<string>;
}) {
  const files = input.files.length === 0 ? [] : await input.uploadFiles(input.files);
  if (files.length !== input.files.length)
    throw new Error("Retry or remove failed uploads before saving.");
  const images = await Promise.all(
    input.images.map(async (image) => ({
      type: "image" as const,
      id: image.id,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      dataUrl: await input.readImage(image.file),
      ...(image.source ? { source: image.source } : {}),
    })),
  );
  return [...input.existingAttachments, ...images, ...files];
}

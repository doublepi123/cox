import type { ComposerImageAttachment } from "../../composerDraftStore";

export function standaloneComposerImages(
  images: ReadonlyArray<ComposerImageAttachment>,
  annotations: ReadonlyArray<{ readonly id: string }>,
) {
  const annotationIds = new Set(annotations.map((annotation) => annotation.id));
  return images.filter((image) => !annotationIds.has(image.id));
}

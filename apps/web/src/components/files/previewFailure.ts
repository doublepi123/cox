const messages = {
  "epub-drm": "This EPUB uses unsupported DRM.",
  "password-required": "This file requires a password.",
  "password-incorrect": "Incorrect password. Try again.",
  "encryption-unsupported": "This file uses unsupported encryption.",
  "office-invalid": "This file is damaged, encrypted, or not a valid Office document.",
  "office-not-open-xml": "This file is not an Open XML document.",
  "office-decryption-limit": "This document exceeds the preview decryption limit.",
  "office-too-large-expanded": "The expanded document is too large to preview safely.",
  "xml-invalid": "The document contains invalid XML.",
  "xml-too-deep": "The document XML is nested too deeply.",
  "xml-too-much-content": "The document contains too much XML content.",
  "repeated-content-invalid": "The document contains invalid repeated content.",
  "epub-no-package": "This EPUB has no readable package.",
  "epub-chapter-count": "This EPUB has no chapters or too many chapters to preview.",
  "epub-no-chapters": "This EPUB has no readable chapters or image pages.",
  "rendered-too-large": "The rendered document is too large to preview.",
} as const;

export class PreviewError extends Error {
  readonly code: keyof typeof messages;

  constructor({ code }: { readonly code: keyof typeof messages }) {
    super(messages[code]);
    this.code = code;
  }
}

export const isPreviewError = (cause: unknown): cause is PreviewError =>
  cause instanceof PreviewError;

const messages = {
  "password-required": "This file requires a password.",
  "password-incorrect": "Incorrect password. Try again.",
  "encryption-unsupported": "This file uses unsupported encryption.",
  "archive-path-too-long": "An archive path is too long to preview.",
  "archive-expanded-too-large":
    "The expanded archive exceeds the preview size or compression ratio limit.",
} as const;

export class ZipError extends Error {
  readonly code: keyof typeof messages;
  constructor({ code }: { readonly code: keyof typeof messages }) {
    super(messages[code]);
    this.code = code;
  }
}

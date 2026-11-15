const UPLOAD_TIMEOUT_MS = 5 * 60_000;

export class AttachmentUploadRejectedError extends Error {
  constructor(readonly status: number) {
    super(`Upload rejected (${status}). Retry the attachment.`);
    this.name = "AttachmentUploadRejectedError";
  }

  get tokenExpired(): boolean {
    return this.status === 401 || this.status === 403 || this.status === 410;
  }
}

export function uploadBytes(input: {
  readonly url: string;
  readonly file: File;
  readonly mimeType: string;
  readonly onProgress: (progress: number) => void;
}): { readonly done: Promise<void>; readonly abort: () => void } {
  const xhr = new XMLHttpRequest();
  const done = new Promise<void>((resolve, reject) => {
    xhr.open("POST", input.url, true);
    xhr.timeout = UPLOAD_TIMEOUT_MS;
    xhr.setRequestHeader("Content-Type", input.mimeType);
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable && event.total > 0) {
        input.onProgress(event.loaded / event.total);
      }
    });
    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new AttachmentUploadRejectedError(xhr.status));
      }
    });
    xhr.addEventListener("error", () => reject(new Error("Upload failed. Retry the attachment.")));
    xhr.addEventListener("timeout", () =>
      reject(new Error("Upload timed out. Retry the attachment.")),
    );
    xhr.addEventListener("abort", () => reject(new Error("Upload cancelled")));
    xhr.send(input.file);
  });

  return { done, abort: () => xhr.abort() };
}

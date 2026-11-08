import { translateCurrent } from "../../i18n";

export const ANSWER_IMAGE_WIDTH = 720;
const MAX_CANVAS_EDGE = 16_000;
const MAX_CANVAS_PIXELS = 24_000_000;

class AnswerImageError extends Error {}

export function answerImageErrorMessage(error: unknown): string {
  return error instanceof AnswerImageError
    ? error.message
    : translateCurrent(
        "Some response resources could not be loaded. Check your connection and try again.",
      );
}

function answerImageResourceError(): AnswerImageError {
  return new AnswerImageError(
    translateCurrent(
      "An image in this response could not be loaded. Check image access and try again.",
    ),
  );
}

export function answerImageSize(width: number, height: number) {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    width > MAX_CANVAS_EDGE ||
    height > MAX_CANVAS_EDGE ||
    width * height > MAX_CANVAS_PIXELS
  ) {
    throw new AnswerImageError(
      translateCurrent("This response is too long to export as one image."),
    );
  }
  return {
    width: Math.ceil(width),
    height: Math.ceil(height),
    pixelRatio: Math.min(
      2,
      MAX_CANVAS_EDGE / Math.ceil(width),
      MAX_CANVAS_EDGE / Math.ceil(height),
      Math.sqrt(MAX_CANVAS_PIXELS / (Math.ceil(width) * Math.ceil(height))),
    ),
  };
}

export function answerImageFileName(messageId: string): string {
  const id = messageId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48);
  return `cox-response${id ? `-${id}` : ""}.png`;
}

async function waitForAnswerImage(node: HTMLElement, signal: AbortSignal) {
  await import("./MathTypeset");
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const started = performance.now();
    let changedAt = started;
    const observer = new MutationObserver(() => {
      changedAt = performance.now();
    });
    const finish = (error?: unknown) => {
      clearInterval(timer);
      observer.disconnect();
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish(signal.reason);
    const timer = setInterval(() => {
      for (const image of node.querySelectorAll("img")) {
        if (image.loading !== "eager") image.loading = "eager";
      }
      const pending =
        document.fonts.status === "loading" ||
        node.querySelector('pre.invisible, [role="status"]') !== null ||
        [...node.querySelectorAll("img")].some((image) => !image.complete);
      if (!pending && performance.now() - changedAt >= 250) finish();
      else if (performance.now() - started > 12_000) {
        finish(
          new AnswerImageError(
            translateCurrent("The response is still loading. Please try again."),
          ),
        );
      }
    }, 100);
    observer.observe(node, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    signal.addEventListener("abort", abort, { once: true });
  });
  signal.throwIfAborted();
}

export async function renderAnswerImage(node: HTMLElement, signal: AbortSignal): Promise<Blob> {
  const { toBlob } = await import("html-to-image");
  await waitForAnswerImage(node, signal);
  for (const image of node.querySelectorAll("img")) {
    if (image.naturalWidth === 0 || image.naturalHeight === 0) throw answerImageResourceError();
  }
  for (const math of node.querySelectorAll("[data-markdown-math]")) {
    const viewport = math.firstElementChild;
    const content = viewport?.firstElementChild;
    if (viewport instanceof HTMLElement && content instanceof HTMLElement) {
      const available = Math.max(1, viewport.clientWidth - 8);
      if (content.offsetWidth > available)
        content.style.zoom = String(available / content.offsetWidth);
    }
  }
  const size = answerImageSize(node.scrollWidth, node.scrollHeight);
  const blob = await toBlob(node, {
    ...size,
    preferredFontFormat: "woff2",
    includeQueryParams: true,
    fetchRequestInit: { credentials: "same-origin", signal },
    onImageErrorHandler: () => {
      throw answerImageResourceError();
    },
    filter: (element) => {
      signal.throwIfAborted();
      return (
        !(element instanceof Element) ||
        (!element.classList.contains("sr-only") && getComputedStyle(element).display !== "none")
      );
    },
  });
  signal.throwIfAborted();
  if (!blob || blob.size === 0) {
    throw new AnswerImageError(translateCurrent("Could not generate the response image."));
  }
  return blob;
}

export function saveAnswerImage(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}

export function canCopyAnswerImage(): boolean {
  return Boolean(navigator.clipboard?.write) && typeof ClipboardItem !== "undefined";
}

export function copyAnswerImage(blob: Blob): Promise<void> {
  if (!canCopyAnswerImage()) {
    return Promise.reject(
      new Error(translateCurrent("Image copying is unavailable. Save the PNG instead.")),
    );
  }
  return navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}

export function canShareAnswerImage(file: File): boolean {
  try {
    return (
      typeof navigator.share === "function" && navigator.canShare?.({ files: [file] }) === true
    );
  } catch {
    return false;
  }
}

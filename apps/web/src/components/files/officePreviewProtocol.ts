import type { PreviewPassword, PreviewUnlock } from "./previewUnlock";
import type { OfficePreviewKind } from "@t3tools/shared/filePreview";

export const OFFICE_PREVIEW_MAX_BYTES = 50 * 1024 * 1024;
export const OFFICE_PREVIEW_MAX_ROWS = 250_000;
export const OFFICE_PREVIEW_MAX_COLUMNS = 1024;

export type OfficeWorkerRequest =
  | PreviewUnlock
  | { readonly type: "open"; readonly kind: OfficePreviewKind; readonly bytes: ArrayBuffer }
  | { readonly type: "epub-page"; readonly index: number }
  | { readonly type: "sheet-page"; readonly sheet: number; readonly index: number };

export type NotebookCell = {
  readonly kind: "markdown" | "code" | "raw";
  readonly source: string;
  readonly outputs: { readonly kind: "text" | "image" | "html"; readonly text: string }[];
};

export type EpubLocation = { readonly index: number; readonly anchor?: string };
export type EpubNarrationCue = {
  readonly src: string;
  readonly begin: number;
  readonly end?: number;
  readonly anchor?: string;
};
export type EpubPage = {
  readonly html: string;
  readonly title?: string | undefined;
  readonly styles?: readonly { css: string; media: string }[];
  readonly htmlAttrs?: string | undefined;
  readonly bodyAttrs?: string | undefined;
  readonly fixed?: { width: number; height: number } | undefined;
  readonly imagePage?: boolean;
  readonly narration?: readonly EpubNarrationCue[];
};

export type OfficeWorkerResult =
  | PreviewPassword
  | {
      readonly type: "epub";
      readonly first: number;
      readonly rtl: boolean;
      readonly chapters: readonly { title: string | undefined; linear: boolean }[];
      readonly contents: readonly (EpubLocation & { title: string })[];
    }
  | {
      readonly type: "epub-page";
      readonly index: number;
      readonly result: EpubPage | { readonly message: string };
    }
  | {
      readonly type: "document";
      readonly navigation: "page" | "slide";
      readonly pages: { title: string; html: string }[];
    }
  | { readonly type: "notebook"; readonly language: string; readonly cells: NotebookCell[] }
  | { readonly type: "error"; readonly message: string }
  | {
      readonly type: "docx" | "xlsx" | "pptx";
      readonly bytes: ArrayBuffer;
      readonly truncated: boolean;
    }
  | {
      readonly type: "ods";
      readonly sheets: {
        name: string;
        rows: string[][];
        truncated: boolean;
        rowCount: number;
        columns: number;
      }[];
    }
  | {
      readonly type: "sheet-page";
      readonly sheet: number;
      readonly index: number;
      readonly rows: string[][];
    };

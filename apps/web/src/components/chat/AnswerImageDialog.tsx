import type { ScopedThreadRef, ServerProviderSkill } from "@t3tools/contracts";
import { shouldPreserveAssistantLineBreaks } from "@t3tools/shared/markdownPipeline";
import { CopyIcon, DownloadIcon, Share2Icon } from "lucide-react";
import { useCallback, useState } from "react";
import { createPortal } from "react-dom";

import { useTranslation } from "../../i18n";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import {
  ANSWER_IMAGE_WIDTH,
  answerImageErrorMessage,
  answerImageFileName,
  canCopyAnswerImage,
  canShareAnswerImage,
  copyAnswerImage,
  renderAnswerImage,
  saveAnswerImage,
} from "./answerImage";
import "./answerImage.css";
import { AnswerImageContext } from "./answerImageContext";

export interface AnswerImageSource {
  readonly messageId: string;
  readonly text: string;
  readonly timestamp: string;
  readonly cwd: string | undefined;
  readonly threadRef?: ScopedThreadRef | undefined;
  readonly skills?: ReadonlyArray<ServerProviderSkill> | undefined;
}

type ImageState =
  | { readonly status: "generating" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly url: string; readonly file: File };

function AnswerImagePreview({ source }: { readonly source: AnswerImageSource }) {
  const { t } = useTranslation();
  const [image, setImage] = useState<ImageState>({ status: "generating" });
  const [action, setAction] = useState<"copy" | "share" | null>(null);
  const [notice, setNotice] = useState<{ error: boolean; message: string } | null>(null);

  const cardRef = useCallback(
    (card: HTMLElement | null) => {
      if (!card) return;
      const controller = new AbortController();
      let url: string | undefined;
      void renderAnswerImage(card, controller.signal).then(
        (blob) => {
          if (controller.signal.aborted) return;
          url = URL.createObjectURL(blob);
          setImage({
            status: "ready",
            url,
            file: new File([blob], answerImageFileName(source.messageId), { type: "image/png" }),
          });
        },
        (error: unknown) => {
          if (!controller.signal.aborted) {
            setImage({
              status: "error",
              message: answerImageErrorMessage(error),
            });
          }
        },
      );
      return () => {
        controller.abort();
        if (url) URL.revokeObjectURL(url);
      };
    },
    [source],
  );

  const runAction = async (kind: "copy" | "share", file: File) => {
    setAction(kind);
    setNotice(null);
    try {
      if (kind === "copy") {
        await copyAnswerImage(file);
        setNotice({ error: false, message: t("Image copied") });
      } else {
        await navigator.share({ files: [file] });
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setNotice({
          error: true,
          message: t("Could not share or copy the image. Save the PNG instead."),
        });
      }
    }
    setAction(null);
  };

  return (
    <>
      {createPortal(
        <div className="answer-image-staging" aria-hidden="true" inert>
          <article
            ref={cardRef}
            className="answer-image-card"
            style={{ width: ANSWER_IMAGE_WIDTH }}
          >
            <header className="answer-image-header">
              <span className="font-semibold">Cox</span>
              <span className="text-xs text-muted-foreground">{source.timestamp}</span>
            </header>
            <AnswerImageContext value={true}>
              <ChatMarkdown
                text={source.text}
                cwd={source.cwd}
                threadRef={source.threadRef}
                {...(source.skills ? { skills: source.skills } : {})}
                lineBreaks={shouldPreserveAssistantLineBreaks(source.text)}
              />
            </AnswerImageContext>
            <footer className="answer-image-footer">{t("Shared from Cox")}</footer>
          </article>
        </div>,
        document.body,
      )}
      <div className="min-h-0 flex-1 overflow-auto border-y bg-muted/30 p-4">
        {image.status === "generating" ? (
          <div className="flex min-h-48 items-center justify-center gap-2" role="status">
            <Spinner />
            {t("Generating image…")}
          </div>
        ) : image.status === "error" ? (
          <div role="alert" className="p-6 text-sm text-destructive">
            <p>{t("Could not generate the response image.")}</p>
            <p className="mt-2">{image.message}</p>
          </div>
        ) : (
          <img
            src={image.url}
            alt={t("Response image preview")}
            className="mx-auto block h-auto w-full rounded-lg border shadow-sm"
          />
        )}
      </div>
      {notice ? (
        <p role={notice.error ? "alert" : "status"} className="px-6 pt-3 text-sm">
          {notice.message}
        </p>
      ) : null}
      <DialogFooter variant="bare">
        {image.status === "ready" ? (
          <>
            {canShareAnswerImage(image.file) ? (
              <Button
                variant="outline"
                disabled={action !== null}
                onClick={() => void runAction("share", image.file)}
              >
                <Share2Icon />
                {t("Share image")}
              </Button>
            ) : null}
            <Button
              variant="outline"
              disabled={action !== null || !canCopyAnswerImage()}
              title={
                !canCopyAnswerImage()
                  ? t("Image copying is unavailable. Save the PNG instead.")
                  : undefined
              }
              onClick={() => void runAction("copy", image.file)}
            >
              {action === "copy" ? <Spinner /> : <CopyIcon />}
              {t("Copy image")}
            </Button>
            <Button onClick={() => saveAnswerImage(image.file, image.file.name)}>
              <DownloadIcon />
              {t("Save PNG")}
            </Button>
          </>
        ) : null}
      </DialogFooter>
    </>
  );
}

export default function AnswerImageDialog({
  source,
  onClose,
}: {
  readonly source: AnswerImageSource;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation();
  const [attempt, setAttempt] = useState(0);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{t("Export response as image")}</DialogTitle>
          <DialogDescription>
            {t(
              "Only this response is included. The image is generated locally; nothing is uploaded.",
            )}
          </DialogDescription>
        </DialogHeader>
        <AnswerImagePreview key={attempt} source={source} />
        <div className="px-6 pb-4">
          <Button variant="ghost" size="sm" onClick={() => setAttempt((value) => value + 1)}>
            {t("Regenerate image")}
          </Button>
        </div>
      </DialogPopup>
    </Dialog>
  );
}

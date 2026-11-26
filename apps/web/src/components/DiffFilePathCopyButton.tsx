import { SharedTooltipTrigger } from "./ui/shared-tooltip";
import { useTranslation } from "../i18n";
import { Check, Copy } from "lucide";
import { useRef } from "react";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { cn } from "../lib/utils";
import {
  ANCHORED_COPY_TOAST_TIMEOUT_MS,
  showAnchoredCopyErrorToast,
  showAnchoredCopySuccessToast,
} from "./ui/anchoredCopyToast";
import { Button } from "./ui/button";
import { MorphIcon } from "~/components/MorphIcon";

export function DiffFilePathCopyButton({ filePath }: { filePath: string }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLButtonElement>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({
    onCopy: () => showAnchoredCopySuccessToast(ref),
    onError: (error) => showAnchoredCopyErrorToast(ref, error),
    timeout: ANCHORED_COPY_TOAST_TIMEOUT_MS,
  });

  return (
    <SharedTooltipTrigger
      render={
        <Button
          ref={ref}
          size="icon-micro"
          variant="ghost-muted"
          aria-label="Copy file path"
          onClick={() => copyToClipboard(filePath, undefined)}
        />
      }
      label={
        <>
          <p>{isCopied ? t("Copied") : t("Copy path")}</p>
        </>
      }
    >
      <MorphIcon
        className={cn("size-3", isCopied && "text-success")}
        icon={isCopied ? Check : Copy}
      />
    </SharedTooltipTrigger>
  );
}

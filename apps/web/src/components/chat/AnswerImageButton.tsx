import { ImageDownIcon } from "lucide-react";
import { lazy, Suspense, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { useTranslation } from "../../i18n";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { AnswerImageSource } from "./AnswerImageDialog";

const AnswerImageDialog = lazy(() => import("./AnswerImageDialog"));

export function AnswerImageButton(source: AnswerImageSource) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<AnswerImageSource | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const close = () => {
    flushSync(() => setSnapshot(null));
    buttonRef.current?.focus({ preventScroll: true });
  };
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="xs"
              variant="ghost-muted"
              aria-label={t("Export response as image")}
              ref={buttonRef}
              onClick={() => setSnapshot(source)}
            />
          }
        >
          <ImageDownIcon className="size-3" />
        </TooltipTrigger>
        <TooltipPopup>{t("Export response as image")}</TooltipPopup>
      </Tooltip>
      {snapshot ? (
        <Suspense fallback={<Spinner />}>
          <AnswerImageDialog source={snapshot} onClose={close} />
        </Suspense>
      ) : null}
    </>
  );
}

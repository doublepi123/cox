import { useTranslation } from "../../i18n";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { ArrowLeft, ArrowRight, ExternalLink, PictureInPicture2 } from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useState,
} from "react";

import { Button } from "~/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

interface Props {
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  refreshDisabled: boolean;
  inputDisabled?: boolean | undefined;
  /** Owned by the caller so its shortcut handler can focus the address bar directly. */
  urlInputRef: RefObject<HTMLInputElement | null>;
  onBack: () => void;
  onForward: () => void;
  onRefresh: () => void;
  onSubmit: (url: string) => void;
  onOpenInBrowser?: (() => void) | undefined;
  onPictureInPicture?: (() => void) | undefined;
  pictureInPicture?: boolean | undefined;
  pictureInPictureDisabled?: boolean | undefined;
  trailingActions?: ReactNode;
  leadingActions?: ReactNode;
}

const NOOP = () => {};

export function PreviewChromeRow({
  url,
  loading,
  canGoBack,
  canGoForward,
  refreshDisabled,
  inputDisabled,
  urlInputRef: inputRef,
  onBack,
  onForward,
  onRefresh,
  onSubmit,
  onOpenInBrowser,
  onPictureInPicture,
  pictureInPicture,
  pictureInPictureDisabled,
  trailingActions,
  leadingActions,
}: Props) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(url);
  const [inputFocused, setInputFocused] = useState(false);

  const submit = (event?: FormEvent | KeyboardEvent) => {
    event?.preventDefault();
    const next = draft.trim();
    if (next.length === 0) return;
    onSubmit(next);
    inputRef.current?.blur();
  };

  return (
    <div className="relative">
      <form
        onSubmit={submit}
        className="flex h-10 min-h-10 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-2 max-sm:h-12 max-sm:min-h-12 max-sm:[&_button]:min-h-11 max-sm:[&_button]:min-w-11 in-data-[preview-panel-mode=inline]:mb-3 in-data-[preview-panel-mode=inline]:h-7 in-data-[preview-panel-mode=inline]:min-h-7 in-data-[preview-panel-mode=inline]:border-b-transparent"
        data-surface-subheader
      >
        <div className="flex items-center gap-0.5" role="group" aria-label={t("Navigation")}>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={canGoBack ? onBack : NOOP}
                  disabled={!canGoBack}
                  aria-label={t("Back")}
                  type="button"
                />
              }
            >
              <ArrowLeft />
            </TooltipTrigger>
            <TooltipPopup>{t("Back")}</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={canGoForward ? onForward : NOOP}
                  disabled={!canGoForward}
                  aria-label={t("Forward")}
                  type="button"
                />
              }
            >
              <ArrowRight />
            </TooltipTrigger>
            <TooltipPopup>{t("Forward")}</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={refreshDisabled ? NOOP : onRefresh}
                  disabled={refreshDisabled}
                  aria-label={loading ? t("Stop") : t("Refresh")}
                  type="button"
                />
              }
            >
              <RefreshIcon refreshing={loading} />
            </TooltipTrigger>
            <TooltipPopup>{loading ? t("Loading…") : t("Refresh")}</TooltipPopup>
          </Tooltip>
        </div>

        {leadingActions}

        <div className="min-w-0 group/address h-7 flex-1">
          <InputGroup variant="ghost">
            <Tooltip>
              <TooltipTrigger
                render={
                  <InputGroupInput
                    ref={inputRef}
                    value={inputFocused ? draft : url}
                    onChange={(event) => setDraft(event.target.value)}
                    onFocus={() => {
                      setDraft(url);
                      setInputFocused(true);
                      queueMicrotask(() => inputRef.current?.select());
                    }}
                    onBlur={() => {
                      setInputFocused(false);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") submit(event);
                      if (event.key === "Escape") {
                        event.preventDefault();
                        setDraft(url);
                        inputRef.current?.blur();
                      }
                    }}
                    placeholder={t("Search or enter URL")}
                    aria-label={t("Search or enter URL")}
                    data-workspace-focus-default
                    spellCheck={false}
                    disabled={inputDisabled}
                    data-preview-url-input
                    size="sm"
                  />
                }
              />
            </Tooltip>
            {onOpenInBrowser && !inputFocused ? (
              <InputGroupAddon align="inline-end">
                {}
                <span className="pointer-events-none flex opacity-0 transition-opacity focus-within:pointer-events-auto focus-within:opacity-100 group-hover/address:pointer-events-auto group-hover/address:opacity-100 max-sm:hidden">
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onClick={onOpenInBrowser}
                          aria-label={t("Open in system browser")}
                          type="button"
                        />
                      }
                    >
                      <ExternalLink />
                    </TooltipTrigger>
                    <TooltipPopup>{t("Open in system browser")}</TooltipPopup>
                  </Tooltip>
                </span>
              </InputGroupAddon>
            ) : null}
          </InputGroup>
        </div>

        {onPictureInPicture ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant={pictureInPicture ? "secondary" : "ghost"}
                  size="icon-xs"
                  onClick={onPictureInPicture}
                  aria-label={
                    pictureInPicture ? t("Close floating preview") : t("Float preview over chat")
                  }
                  aria-pressed={pictureInPicture ? "true" : "false"}
                  type="button"
                  disabled={pictureInPictureDisabled}
                />
              }
            >
              <PictureInPicture2 className={cn(pictureInPicture && "text-primary")} />
            </TooltipTrigger>
            <TooltipPopup>
              {pictureInPicture ? t("Close floating preview") : t("Float preview over chat")}
            </TooltipPopup>
          </Tooltip>
        ) : null}
        {trailingActions}
      </form>
      <div
        aria-hidden
        data-loading={loading}
        className="preview-loading-progress pointer-events-none absolute bottom-0 left-0 z-10 h-0.5 w-full origin-left rounded-r-full bg-primary"
        style={{ boxShadow: "0 0 6px 1px var(--color-ring)" }}
      />
    </div>
  );
}

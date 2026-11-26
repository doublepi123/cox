import { useTranslation } from "../i18n";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { XIcon } from "lucide-react";
import { useRouter } from "@tanstack/react-router";
import {
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { useNativeTitlebarHeight } from "../lib/windowControlsOverlay";

import { useCloseAppModal } from "./sidebar/mainAppLocation";
import { Button } from "./ui/button";
import { DialogBackdrop } from "./ui/dialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/**
 * Large modal for the Settings and Usage routes. Esc, the close button, or a press on the
 * backdrop returns to the page that opened it. Keyboard guards that skip dialogs exempt
 * `[data-app-modal]`, because these pages own their shortcuts.
 */
export function AppRouteModal({
  label,
  children,
  actionsRef,
}: {
  label: string;
  children: ReactNode;
  actionsRef?: RefObject<DialogPrimitive.Root.Actions | null> | undefined;
}) {
  const closeAppModal = useCloseAppModal();
  const [open, setOpen] = useState(true);
  // Text selection that ends on the backdrop is not a dismissal.
  const backdropPressRef = useRef(false);
  // Focus the surface, not its first control: no stray focus ring, no phone keyboard.
  // On close, leave focus alone; returning it to the opener paints a focus ring.
  const popupRef = useRef<HTMLDivElement>(null);
  const nativeTitlebarHeight = useNativeTitlebarHeight();
  const router = useRouter();
  // Leaving the page without closing (Navigation: Back) unmounts a focused field during a
  // commit, when React no longer delivers its blur, so commit-on-blur rows would drop what was
  // typed. Blur text fields before the navigation renders; other controls keep their focus.
  // Not onBeforeNavigate: the router skips it while a past redirect is still recorded.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- router listener that blurs a field before navigation unmounts it
  useEffect(
    () =>
      router.subscribe("onBeforeLoad", ({ pathChanged }) => {
        const focused = document.activeElement;
        if (pathChanged && focused?.matches("input, textarea, [contenteditable]")) {
          blurFocusedWithin(popupRef.current);
        }
      }),
    [router],
  );

  return (
    <DialogPrimitive.Root
      open={open}
      actionsRef={actionsRef}
      // Portaled layers outside this tree (toasts and confirm dialogs) are not backdrop presses.
      disablePointerDismissal
      onOpenChange={(nextOpen, eventDetails) => {
        if (nextOpen) return;
        if (eventDetails.reason === "escape-key" && eventDetails.event.repeat) {
          return eventDetails.cancel();
        }
        // Closing unmounts a focused field without a blur, so commit-on-blur rows would
        // drop what was typed. Blur first so they commit.
        blurFocusedWithin(popupRef.current);
        setOpen(false);
      }}
      onOpenChangeComplete={(nextOpen) => {
        if (!nextOpen) void closeAppModal();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogBackdrop />
        <DialogPrimitive.Viewport
          style={
            {
              "--app-modal-titlebar-height": `${nativeTitlebarHeight}px`,
              "--app-modal-top-inset": `max(var(--workspace-safe-top), ${nativeTitlebarHeight}px)`,
              "--app-modal-sm-top": `max(1.5rem, ${nativeTitlebarHeight}px)`,
            } as CSSProperties
          }
          className="fixed inset-0 z-50 flex items-center justify-center sm:p-6 sm:pt-(--app-modal-sm-top) lg:p-10"
          onPointerDown={(event) => {
            backdropPressRef.current = event.target === event.currentTarget;
          }}
          onClick={(event) => {
            if (backdropPressRef.current && event.target === event.currentTarget) setOpen(false);
            backdropPressRef.current = false;
          }}
        >
          <DialogPrimitive.Popup
            ref={popupRef}
            initialFocus={popupRef}
            finalFocus={false}
            aria-label={label}
            data-slot="dialog-popup"
            data-app-modal=""
            className="relative flex size-full min-h-0 min-w-0 flex-col overflow-hidden bg-background max-sm:pr-safe max-sm:pl-safe text-foreground outline-none transition-[opacity,scale] duration-150 ease-out [-webkit-app-region:no-drag] data-ending-style:scale-[0.985] data-ending-style:opacity-0 data-starting-style:scale-[0.985] data-starting-style:opacity-0 sm:max-h-[60rem] sm:max-w-[80rem] sm:rounded-2xl sm:border sm:shadow-2xl/40"
          >
            {}
            <div
              aria-hidden
              className="absolute inset-x-0 top-0 hidden h-(--app-modal-titlebar-height) [-webkit-app-region:drag] max-sm:block"
            />
            {children}
          </DialogPrimitive.Popup>
        </DialogPrimitive.Viewport>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function blurFocusedWithin(container: HTMLElement | null) {
  const focused = document.activeElement;
  if (focused instanceof HTMLElement && container?.contains(focused)) focused.blur();
}

export function AppRouteModalClose({
  size = "icon-sm",
}: {
  size?: ComponentProps<typeof Button>["size"];
}) {
  const { t } = useTranslation();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <DialogPrimitive.Close
            aria-label={t("Close")}
            render={<Button size={size} variant="ghost" />}
          />
        }
      >
        <XIcon />
      </TooltipTrigger>
      <TooltipPopup side="bottom">Close (Esc)</TooltipPopup>
    </Tooltip>
  );
}

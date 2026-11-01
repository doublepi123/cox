import { Drawer } from "@base-ui/react/drawer";
import { type ReactNode, useRef, useSyncExternalStore } from "react";

import { useTranslation } from "../../i18n";
import { Button } from "../ui/button";

function subscribeVisualViewport(callback: () => void) {
  const viewport = window.visualViewport;
  if (!viewport) return () => {};
  viewport.addEventListener("resize", callback);
  viewport.addEventListener("scroll", callback);
  return () => {
    viewport.removeEventListener("resize", callback);
    viewport.removeEventListener("scroll", callback);
  };
}

function visualViewportBox() {
  const viewport = window.visualViewport;
  return viewport ? `${Math.round(viewport.offsetTop)}:${Math.round(viewport.height)}` : "";
}

/**
 * The part of the page the soft keyboard leaves visible. Android resizes the layout viewport
 * already; browsers that overlay the keyboard only shrink the visual viewport.
 */
function useVisualViewportStyle() {
  const box = useSyncExternalStore(subscribeVisualViewport, visualViewportBox, () => "");
  if (!box) return undefined;
  const [top, height] = box.split(":").map(Number);
  return { top, height, bottom: "auto" };
}

/**
 * The phone model picker: a bottom sheet with a drag handle, a header naming the current model,
 * and a Done button. Swiping it down, tapping the scrim or Escape closes it too.
 */
export function ModelPickerSheetPopup(props: {
  /** Receives the sheet element while it is mounted. */
  onPopup: (popup: HTMLDivElement | null) => void;
  summary: ReactNode;
  /** Moves focus after a keyboard close, such as back into the composer. */
  onKeyboardClose?: () => boolean;
  floatingLayerProps?: Record<string, string>;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const viewportStyle = useVisualViewportStyle();
  const sheetRef = useRef<HTMLDivElement>(null);
  return (
    <Drawer.Portal>
      <Drawer.Backdrop
        data-slot="model-picker-sheet-backdrop"
        className="fixed inset-0 z-[120] bg-black/55 opacity-[calc(1-var(--drawer-swipe-progress,0))] transition-opacity duration-300 ease-out data-swiping:duration-0 data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none"
      />
      <Drawer.Viewport
        className="fixed inset-0 z-[120] flex items-end justify-center"
        style={viewportStyle}
      >
        <Drawer.Popup
          {...props.floatingLayerProps}
          ref={(popup) => {
            sheetRef.current = popup;
            props.onPopup(popup);
            return () => {
              sheetRef.current = null;
              props.onPopup(null);
            };
          }}
          // The sheet holds focus, so the soft keyboard stays closed until the search is tapped.
          initialFocus={sheetRef}
          // A touch close returns to the trigger rather than raising the keyboard in the composer.
          finalFocus={(closeType) =>
            closeType === "keyboard" && props.onKeyboardClose ? props.onKeyboardClose() : true
          }
          data-slot="sheet-popup"
          data-model-picker-sheet=""
          className="group/sheet relative flex max-h-[85%] w-full max-w-xl flex-col overflow-hidden rounded-t-[1.375rem] border border-b-0 border-border/70 bg-popover pb-[env(safe-area-inset-bottom)] text-popover-foreground shadow-[0_-18px_48px_-20px_rgb(0_0_0/0.55)] outline-none [transform:translateY(var(--drawer-swipe-movement-y,0px))] transition-transform duration-[420ms] ease-[cubic-bezier(0.32,0.72,0,1)] will-change-transform data-swiping:select-none data-starting-style:[transform:translateY(100%)] data-ending-style:[transform:translateY(100%)] data-ending-style:duration-[calc(var(--drawer-swipe-strength,1)*320ms)] motion-reduce:transition-none [@media(max-height:560px)]:max-h-[calc(100%-0.75rem)]"
        >
          <div aria-hidden="true" className="flex shrink-0 justify-center pt-2 pb-1">
            <div className="h-1 w-10 rounded-full bg-foreground/20" />
          </div>
          <div className="flex shrink-0 items-center gap-3 px-4 pt-0.5 pb-3">
            <div className="min-w-0 flex-1">
              <Drawer.Title className="text-base leading-6 font-semibold">
                {t("Model")}
              </Drawer.Title>
              <Drawer.Description
                render={<div />}
                className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs"
              >
                {props.summary}
              </Drawer.Description>
            </div>
            <Drawer.Close render={<Button variant="secondary" size="sm" />}>
              {t("Done")}
            </Drawer.Close>
          </div>
          {props.children}
        </Drawer.Popup>
      </Drawer.Viewport>
    </Drawer.Portal>
  );
}

export const ModelPickerSheetRoot = Drawer.Root;
export const ModelPickerSheetTrigger = Drawer.Trigger;

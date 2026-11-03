import { type ReactNode, useRef } from "react";

import { useMediaQuery } from "../hooks/useMediaQuery";
import { useHistoryBackDismiss } from "../lib/historyBackDismiss";
import { Sheet, SheetPopup } from "./ui/sheet";

export function RightPanelSheet(props: {
  animationDurationMs: number;
  children: ReactNode;
  open: boolean;
  onClose: () => void;
}) {
  const coarsePointer = useMediaQuery({ pointer: "coarse" });
  const popupRef = useRef<HTMLDivElement>(null);
  useHistoryBackDismiss(coarsePointer && props.open, props.onClose);
  return (
    <Sheet
      open={props.open}
      onOpenChange={(open) => {
        if (!open) {
          props.onClose();
        }
      }}
    >
      <SheetPopup
        ref={popupRef}
        initialFocus={coarsePointer ? () => popupRef.current : undefined}
        transitionDurationMs={props.animationDurationMs}
        side="right"
        showCloseButton={false}
        keepMounted
        className="w-[min(42vw,28rem)] min-w-80 max-w-[28rem] max-[760px]:w-[min(88vw,24rem)] max-[760px]:min-w-0 max-sm:w-full max-sm:max-w-none max-sm:border-s-0 wco:mt-(--workspace-topbar-height) wco:h-[calc(100%-var(--workspace-topbar-height))] wco:max-h-[calc(100%-var(--workspace-topbar-height))]"
      >
        {props.children}
      </SheetPopup>
    </Sheet>
  );
}

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
        variant="right-panel"
      >
        {props.children}
      </SheetPopup>
    </Sheet>
  );
}

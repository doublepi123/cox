import type { DesktopShellBridge } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "../i18n";
import { syncDocumentWindowControlsOverlayClass } from "../lib/windowControlsOverlay";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";

declare global {
  interface Window {
    readonly coxDesktop?: DesktopShellBridge;
  }
}

function windowColor(variable: string): string {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d");
  if (!context) return "#808080";
  context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
  context.fillRect(0, 0, 1, 1);
  return `#${Array.from(context.getImageData(0, 0, 1, 1).data)
    .slice(0, 3)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

export function DesktopShell() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [quitting, setQuitting] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const bridge = window.coxDesktop;
    if (bridge?.platform !== "win32") return;
    document.documentElement.dataset.coxDesktop = "windows";
    const stopOverlay = syncDocumentWindowControlsOverlayClass();
    const unsubscribe = bridge.onQuitRequested(() => {
      setQuitting(false);
      setOpen(true);
    });
    const updateColors = () =>
      bridge.setWindowColors(windowColor("--background"), windowColor("--foreground"));
    const observer = new MutationObserver(updateColors);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme-id"],
    });
    updateColors();
    bridge.ready();
    return () => {
      unsubscribe();
      observer.disconnect();
      stopOverlay();
      delete document.documentElement.dataset.coxDesktop;
    };
  }, []);
  if (window.coxDesktop?.platform !== "win32") return null;
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (quitting) return;
        setOpen(next);
        if (!next) window.coxDesktop?.answerQuit(false);
      }}
    >
      <AlertDialogPopup initialFocus={cancelRef} bottomStickOnMobile={false}>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("Quit Cox?")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t(
              "Quitting stops the local backend and interrupts running agent tasks and terminals.",
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter variant="bare">
          <AlertDialogClose
            render={<Button ref={cancelRef} variant="outline" disabled={quitting} />}
          >
            {t("Cancel")}
          </AlertDialogClose>
          <Button
            variant="destructive"
            disabled={quitting}
            onClick={() => {
              setQuitting(true);
              window.coxDesktop?.answerQuit(true);
            }}
          >
            {quitting ? t("Quitting…") : t("Quit Cox")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

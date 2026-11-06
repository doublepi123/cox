import type { DesktopShellBridge } from "@t3tools/contracts";
import { useEffect, useRef, useState, type ReactNode } from "react";
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
import { DialogSuppressionContext } from "./ui/dialog";
import { useDesktopBackendUpdate } from "../hooks/useDesktopBackendUpdate";

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

export function DesktopShell({ children }: { readonly children?: ReactNode }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [quitting, setQuitting] = useState(false);
  const updates = useDesktopBackendUpdate();
  const [dismissedUpdate, setDismissedUpdate] = useState<string | null>(null);
  const updateState = updates.state;
  const updateKey =
    updateState?.status === "ready"
      ? "ready:" + updateState.latestVersion
      : updateState?.latestVersion &&
          ["available", "installing", "error", "incompatible"].includes(updateState.status) &&
          updateState.latestVersion !== updateState.currentVersion
        ? "update:" + updateState.latestVersion
        : null;
  const updateOpen = updateKey !== null && updateKey !== dismissedUpdate;
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const bridge = window.coxDesktop;
    if (!bridge || !["win32", "darwin"].includes(bridge.platform)) return;
    document.documentElement.dataset.coxDesktop =
      bridge.platform === "darwin" ? "macos" : "windows";
    const stopOverlay = syncDocumentWindowControlsOverlayClass();
    const stopWindowState = bridge.onWindowState((state) => {
      document.documentElement.dataset.desktopFullscreen = String(state.fullscreen);
      document.documentElement.style.setProperty("--desktop-window-zoom", String(state.zoomFactor));
      window.dispatchEvent(new Event("cox:window-controls-changed"));
    });
    window.addEventListener("resize", bridge.syncWindowControls);
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
      stopWindowState();
      window.removeEventListener("resize", bridge.syncWindowControls);
      stopOverlay();
      delete document.documentElement.dataset.coxDesktop;
      delete document.documentElement.dataset.desktopFullscreen;
      document.documentElement.style.removeProperty("--desktop-window-zoom");
      window.dispatchEvent(new Event("cox:window-controls-changed"));
    };
  }, []);
  if (!window.coxDesktop || !["win32", "darwin"].includes(window.coxDesktop.platform))
    return children;
  return (
    <>
      <DialogSuppressionContext value={open || updateOpen}>{children}</DialogSuppressionContext>
      <AlertDialog
        open={updateOpen && !open}
        onOpenChange={(next) => {
          if (!next) setDismissedUpdate(updateKey);
        }}
      >
        <AlertDialogPopup bottomStickOnMobile={false} layer="application">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t(updateState?.status === "ready" ? "Cox update ready" : "Cox backend update")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {updateState?.status === "ready"
                ? t(
                    "Cox is downloaded. It will activate on the next launch without interrupting current tasks.",
                  )
                : updateState?.status === "installing"
                  ? t("Downloading and verifying Cox…")
                  : updateState?.status === "error"
                    ? updateState.message
                    : updateState?.status === "incompatible"
                      ? t("This Cox update requires a newer desktop client.")
                      : t("Cox {version} is available.", {
                          version: updateState?.latestVersion ?? "",
                        })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter variant="bare">
            <AlertDialogClose render={<Button variant="outline" />}>
              {t(updateState?.status === "ready" ? "Done" : "Later")}
            </AlertDialogClose>
            {updateState?.status === "available" && (
              <Button onClick={() => void updates.install()}>{t("Download Cox update")}</Button>
            )}
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          if (quitting) return;
          setOpen(next);
          if (!next) window.coxDesktop?.answerQuit(false);
        }}
      >
        <AlertDialogPopup initialFocus={cancelRef} bottomStickOnMobile={false} layer="application">
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
    </>
  );
}

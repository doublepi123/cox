import { useSyncExternalStore } from "react";

const WCO_CLASS_NAME = "wco";
// macOS has no overlay API; traffic lights stay inside this topbar at every zoom level.
const MACOS_TITLEBAR_HEIGHT = 52;
interface WindowControlsOverlayLike {
  readonly visible: boolean;
  getTitlebarAreaRect(): DOMRect;
  addEventListener(type: "geometrychange", listener: EventListener): void;
  removeEventListener(type: "geometrychange", listener: EventListener): void;
}
interface NavigatorWithWindowControlsOverlay extends Navigator {
  readonly windowControlsOverlay?: WindowControlsOverlayLike;
}
function getWindowControlsOverlay(): WindowControlsOverlayLike | null {
  if (typeof navigator === "undefined") {
    return null;
  }
  return (navigator as NavigatorWithWindowControlsOverlay).windowControlsOverlay ?? null;
}
function macosTitlebarHeight(): number {
  return typeof document !== "undefined" &&
    document.documentElement.dataset.coxDesktop === "macos" &&
    document.documentElement.dataset.desktopFullscreen !== "true"
    ? MACOS_TITLEBAR_HEIGHT
    : 0;
}
/** Height of the native caption strip drawn over the page, or 0 when the window has none. */
export function windowControlsOverlayHeight(): number {
  const overlay = getWindowControlsOverlay();
  return overlay?.visible ? overlay.getTitlebarAreaRect().height : macosTitlebarHeight();
}
export function onWindowControlsOverlayGeometryChange(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const overlay = getWindowControlsOverlay();
  overlay?.addEventListener("geometrychange", listener);
  window.addEventListener("cox:window-controls-changed", listener);
  return () => {
    overlay?.removeEventListener("geometrychange", listener);
    window.removeEventListener("cox:window-controls-changed", listener);
  };
}
export function syncDocumentWindowControlsOverlayClass(): () => void {
  if (typeof document === "undefined") {
    return () => {};
  }
  const overlay = getWindowControlsOverlay();
  const update = () => {
    document.documentElement.classList.toggle(
      WCO_CLASS_NAME,
      Boolean(overlay?.visible || macosTitlebarHeight()),
    );
  };
  update();
  const unsubscribe = onWindowControlsOverlayGeometryChange(update);
  return () => {
    unsubscribe();
    document.documentElement.classList.remove(WCO_CLASS_NAME);
  };
}
function subscribeTitlebarArea(listener: () => void): () => void {
  return onWindowControlsOverlayGeometryChange(listener);
}
function getNativeTitlebarHeight(): number {
  const overlay = getWindowControlsOverlay();
  return overlay?.visible ? overlay.getTitlebarAreaRect().bottom : macosTitlebarHeight();
}
export function useNativeTitlebarHeight(): number {
  return useSyncExternalStore(subscribeTitlebarArea, getNativeTitlebarHeight, () => 0);
}

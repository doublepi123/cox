type VirtualKeyboard = EventTarget & {
  readonly boundingRect: Pick<DOMRectReadOnly, "height">;
  readonly overlaysContent: boolean;
};

type ViewportTarget = EventTarget & Pick<VisualViewport, "width" | "height" | "scale">;
type ViewportStyle = Pick<CSSStyleDeclaration, "setProperty" | "removeProperty">;

type KeyboardWindow = Pick<Window, "innerHeight"> & {
  readonly visualViewport?: ViewportTarget | null;
  readonly navigator: Navigator & { readonly virtualKeyboard?: VirtualKeyboard };
  readonly document?: {
    readonly documentElement: { readonly style: ViewportStyle };
  };
};

const KEYBOARD_THRESHOLD = 150;
const VISUAL_VIEWPORT_HEIGHT_PROPERTY = "--visual-viewport-height";

function viewportSnapshot(viewport: ViewportTarget) {
  return {
    width: Math.round(viewport.width),
    height: Math.round(viewport.height),
    scale: viewport.scale,
  };
}

export function createSoftwareKeyboardStore(win: KeyboardWindow | undefined) {
  const listeners = new Set<() => void>();
  let viewportOpen = false;
  const viewport = win?.visualViewport;
  const keyboard = win?.navigator.virtualKeyboard;
  const viewportStyle = win?.document?.documentElement.style;
  let previous = viewport ? viewportSnapshot(viewport) : undefined;
  let baselineWidth = previous ? Math.round(previous.width * previous.scale) : undefined;
  let baselineHeight =
    previous && win
      ? Math.max(win.innerHeight, Math.round(previous.height * previous.scale))
      : undefined;

  const syncViewportHeight = () => {
    if (!viewport || !viewportStyle) return;
    viewportStyle.setProperty(VISUAL_VIEWPORT_HEIGHT_PROPERTY, `${Math.round(viewport.height)}px`);
  };

  const getSnapshot = () => {
    // Chromium can expose the API while withholding geometry outside overlay mode.
    // Keep the browser's automatic viewport resizing instead of enabling overlays.
    if (keyboard && (keyboard.overlaysContent || keyboard.boundingRect.height > 0)) {
      return keyboard.boundingRect.height > 0;
    }
    return viewportOpen;
  };

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const onViewportResize = () => {
    if (!viewport || !win) return;
    syncViewportHeight();
    const current = viewportSnapshot(viewport);
    const unscaledWidth = Math.round(current.width * current.scale);
    const unscaledHeight = Math.round(current.height * current.scale);
    if (baselineWidth === undefined || Math.abs(unscaledWidth - baselineWidth) > 2) {
      baselineWidth = unscaledWidth;
      baselineHeight = Math.max(win.innerHeight, unscaledHeight);
      viewportOpen = false;
      previous = current;
      notify();
      return;
    }
    baselineHeight = Math.max(baselineHeight ?? 0, win.innerHeight, unscaledHeight);
    // Adapted from Ionic's keyboard assist, MIT, Copyright (c) 2015-present Drifty Co.
    // https://github.com/ionic-team/ionic-framework/blob/main/core/src/utils/keyboard/keyboard.ts
    const scaledHeightDifference = previous
      ? (previous.height - current.height) * current.scale
      : 0;
    if (Math.abs(current.height - baselineHeight / current.scale) <= 1) {
      viewportOpen = false;
    } else if (
      !viewportOpen &&
      previous?.width === current.width &&
      scaledHeightDifference > KEYBOARD_THRESHOLD
    ) {
      viewportOpen = true;
    }
    previous = current;
    notify();
  };

  const onKeyboardGeometryChange = () => {
    syncViewportHeight();
    notify();
  };

  const subscribe = (listener: () => void) => {
    if (!win) return () => {};
    if (listeners.size === 0) {
      if (viewport) {
        previous = viewportSnapshot(viewport);
        baselineWidth = Math.round(previous.width * previous.scale);
        baselineHeight = Math.max(win.innerHeight, Math.round(previous.height * previous.scale));
        // A composer can mount after the keyboard has already opened.
        viewportOpen = baselineHeight - previous.height * previous.scale > KEYBOARD_THRESHOLD;
        viewport.addEventListener("resize", onViewportResize);
        viewport.addEventListener("scroll", syncViewportHeight);
        syncViewportHeight();
      }
      keyboard?.addEventListener("geometrychange", onKeyboardGeometryChange);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        viewport?.removeEventListener("resize", onViewportResize);
        viewport?.removeEventListener("scroll", syncViewportHeight);
        keyboard?.removeEventListener("geometrychange", onKeyboardGeometryChange);
        viewportStyle?.removeProperty(VISUAL_VIEWPORT_HEIGHT_PROPERTY);
      }
    };
  };

  return { getSnapshot, subscribe };
}

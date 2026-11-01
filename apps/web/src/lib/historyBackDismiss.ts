import { useEffect, useEffectEvent } from "react";

/**
 * Lets the system Back gesture close one overlay, such as the phone model sheet, before it
 * leaves the page. While the overlay is open a history entry with the same URL sits on top;
 * Back pops it and closes the overlay, and any other close pops it once.
 *
 * The router never sees these entries: they are pushed through `History.prototype` (TanStack's
 * browser history patches the instance method to learn of pushes), and the pop back to the
 * entry underneath stops at a capture listener before the router's own `popstate` listener.
 */

const ENTRY_KEY = "coxBackDismiss";

type Overlay = { id: string; onBack: () => void };

let active: Overlay | null = null;
/** The entry under ours, so only a pop back to exactly it is swallowed. */
let baseState: unknown = null;
/** Our own `history.back()` is in flight; a push now would race the traversal. */
let popPending = false;
let queued: Overlay | null = null;
let listening = false;
let nextId = 0;

function entryId(state: unknown): string | null {
  return state !== null && typeof state === "object" && ENTRY_KEY in state
    ? String((state as Record<string, unknown>)[ENTRY_KEY])
    : null;
}

function routerKey(state: unknown): unknown {
  return state !== null && typeof state === "object"
    ? ((state as Record<string, unknown>).__TSR_key ?? (state as Record<string, unknown>).key)
    : undefined;
}

function isBaseEntry(state: unknown) {
  if (entryId(state) !== null) return false;
  const key = routerKey(baseState);
  return key === undefined
    ? JSON.stringify(state) === JSON.stringify(baseState)
    : routerKey(state) === key;
}

function push(overlay: Overlay) {
  baseState = window.history.state;
  const state =
    baseState !== null && typeof baseState === "object"
      ? { ...baseState, [ENTRY_KEY]: overlay.id }
      : { [ENTRY_KEY]: overlay.id };
  History.prototype.pushState.call(window.history, state, "");
  active = overlay;
}

function onPopState(event: PopStateEvent) {
  if (popPending) {
    popPending = false;
    if (isBaseEntry(event.state)) event.stopImmediatePropagation();
    const next = queued;
    queued = null;
    if (next) push(next);
    return;
  }
  if (!active || entryId(event.state) === active.id) return;
  const closed = active;
  active = null;
  // Back to the entry under ours is only the overlay closing; further back is real navigation.
  if (isBaseEntry(event.state)) event.stopImmediatePropagation();
  closed.onBack();
}

function listen() {
  if (listening) return;
  listening = true;
  window.addEventListener("popstate", onPopState, { capture: true });
}

function open(overlay: Overlay) {
  listen();
  if (popPending) {
    queued = overlay;
    return;
  }
  push(overlay);
}

function close(id: string) {
  if (queued?.id === id) {
    queued = null;
    return;
  }
  if (active?.id !== id) return;
  active = null;
  // A route change while open already left our entry behind; popping would undo it.
  if (entryId(window.history.state) !== id) return;
  popPending = true;
  window.history.back();
}

function newId(): string {
  nextId += 1;
  return `${Date.now().toString(36)}-${nextId}`;
}

/** While `open`, the system Back gesture calls `onBack` instead of leaving the page. */
export function useHistoryBackDismiss(open_: boolean, onBack: () => void) {
  const handleBack = useEffectEvent(onBack);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors the overlay's open state into a browser history entry and removes it on close or unmount
  useEffect(() => {
    if (!open_) return;
    const id = newId();
    open({ id, onBack: () => handleBack() });
    return () => close(id);
  }, [open_]);
}

import { useRouter, type AnyRouter, type RouterHistory } from "@tanstack/react-router";
import { useEffect, useEffectEvent } from "react";

/**
 * Lets the system Back gesture close overlays, such as the phone sidebar, the right panel sheet
 * or the model sheet, before it leaves the page. Each open overlay keeps a history entry with the
 * same URL on top, innermost last. Back pops the innermost entry and closes its overlay; any other
 * close pops its own entry once, and entries above it that are still wanted are pushed again.
 *
 * The router never sees these entries: they are pushed through `History.prototype` (TanStack's
 * browser history patches the instance method to learn of pushes), and pops back to one of them
 * or to the entry underneath stop at a capture listener before the router's own `popstate`
 * listener. A route change first waits, as a router blocker, for the entries to be popped, so it
 * lands where the first overlay opened and leaves no dead entries behind.
 */

const ENTRY_KEY = "coxBackDismiss";
/** A route change never waits longer than this for our own traversal to land. */
const TRAVERSAL_TIMEOUT_MS = 1000;

type Overlay = { id: string; onBack: () => void };
type Traversal = { keep: number; waiters: Array<() => void> };

/** Open overlays, innermost last. */
let overlays: Overlay[] = [];
/** Ids of the overlays whose entries sit on top of `baseState`, innermost last. */
let entries: string[] = [];
/** The entry under ours, so only a pop back to exactly it is swallowed. */
let baseState: unknown = null;
/** Our own `history.go()` is in flight; a push now would race the traversal. */
let traversal: Traversal | null = null;
/** A route change is landing; an entry pushed now would end up under it. */
let routeChanging = false;
let listening = false;
let nextId = 0;
const guardedHistories = new WeakSet<RouterHistory>();

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

/** -1 for the entry under ours, the index of one of our entries, or null for any other entry. */
function positionOf(state: unknown): number | null {
  const id = entryId(state);
  if (id === null) return isBaseEntry(state) ? -1 : null;
  const index = entries.indexOf(id);
  return index === -1 ? null : index;
}

function pushEntry(id: string) {
  if (entries.length === 0) baseState = window.history.state;
  const state =
    baseState !== null && typeof baseState === "object"
      ? { ...baseState, [ENTRY_KEY]: id }
      : { [ENTRY_KEY]: id };
  History.prototype.pushState.call(window.history, state, "");
  entries = [...entries, id];
}

function popTo(keep: number) {
  traversal = { keep, waiters: [] };
  window.history.go(keep - entries.length);
}

/** Pops the entries of closed overlays, then pushes entries for open ones that lack them. */
function sync() {
  if (traversal || routeChanging) return;
  // A route change while open already left our entries behind; popping would undo it.
  if (entries.length > 0 && entryId(window.history.state) !== entries.at(-1)) entries = [];
  let kept = 0;
  while (kept < entries.length && entries[kept] === overlays[kept]?.id) kept += 1;
  if (kept < entries.length) {
    popTo(kept);
    return;
  }
  for (const overlay of overlays.slice(kept)) pushEntry(overlay.id);
}

/** Closes, innermost first, the overlays whose entries above `keep` were popped. */
function dismiss(keep: number) {
  const popped = new Set(entries.slice(keep));
  entries = entries.slice(0, keep);
  const closed = overlays.filter((overlay) => popped.has(overlay.id));
  overlays = overlays.filter((overlay) => !popped.has(overlay.id));
  for (const overlay of closed.toReversed()) overlay.onBack();
}

function onPopState(event: PopStateEvent) {
  const position = positionOf(event.state);
  const pending = traversal;
  if (pending) {
    traversal = null;
    for (const waiter of pending.waiters) waiter();
    if (position === pending.keep - 1) {
      entries = entries.slice(0, pending.keep);
      event.stopImmediatePropagation();
      sync();
      return;
    }
  }
  if (entries.length === 0) return;
  if (position === null) {
    // Further back than the entry under ours is real navigation, which the router handles.
    dismiss(0);
    window.setTimeout(sync);
    return;
  }
  event.stopImmediatePropagation();
  dismiss(position + 1);
  sync();
}

function listen() {
  if (listening) return;
  listening = true;
  window.addEventListener("popstate", onPopState, { capture: true });
}

if (typeof window !== "undefined") listen();

function settled(): Promise<void> {
  const pending = traversal;
  if (!pending) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      if (traversal === pending) {
        traversal = null;
        entries = [];
      }
      resolve();
    }, TRAVERSAL_TIMEOUT_MS);
    pending.waiters.push(() => {
      window.clearTimeout(timer);
      resolve();
    });
  });
}

/** Pops our entries before the router pushes or replaces, and pushes them again after. */
async function leaveBeforeRouteChange(): Promise<false> {
  if (entries.length === 0 && !traversal) return false;
  routeChanging = true;
  await settled();
  if (entries.length > 0 && entryId(window.history.state) === entries.at(-1)) {
    popTo(0);
    await settled();
  }
  entries = [];
  window.setTimeout(() => {
    routeChanging = false;
    sync();
  });
  return false;
}

function guardRouteChanges(history: RouterHistory) {
  if (guardedHistories.has(history)) return;
  guardedHistories.add(history);
  history.block({
    blockerFn: ({ action }) =>
      action === "PUSH" || action === "REPLACE" ? leaveBeforeRouteChange() : false,
    enableBeforeUnload: false,
  });
}

function open(overlay: Overlay) {
  listen();
  overlays = [...overlays, overlay];
  sync();
}

function close(id: string) {
  if (!overlays.some((overlay) => overlay.id === id)) return;
  overlays = overlays.filter((overlay) => overlay.id !== id);
  sync();
}

function newId(): string {
  nextId += 1;
  return `${Date.now().toString(36)}-${nextId}`;
}

/** While `open`, the system Back gesture calls `onBack` instead of leaving the page. */
export function useHistoryBackDismiss(open_: boolean, onBack: () => void) {
  const router = useRouter({ warn: false }) as AnyRouter | undefined;
  const handleBack = useEffectEvent(onBack);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors the overlay's open state into a browser history entry and removes it on close or unmount
  useEffect(() => {
    if (!open_) return;
    if (router) guardRouteChanges(router.history);
    const id = newId();
    open({ id, onBack: () => handleBack() });
    return () => close(id);
  }, [open_, router]);
}

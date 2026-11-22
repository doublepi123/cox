import type { OrchestrationV2ThreadShell, ScopedThreadRef } from "@t3tools/contracts";
import {
  resolveSideThreadOpenTarget,
  sideThreadKindOf,
  type SideThreadOpenIntent,
} from "@t3tools/client-runtime/side-thread";

import { getClientSettings } from "../hooks/useSettings";

import type { ToolCallDiffTarget } from "../diffPanelStore";
import { rightPanelHostRef, useRightPanelStore } from "../rightPanelStore";

/** Whether an event started in the side chat pane (`data-side-chat-pane`), which the main chat ignores. */
export function isInSideChatPane(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("[data-side-chat-pane]") !== null;
}

/**
 * Opens an embedded side chat's tool diffs in its parent's diff panel and runs its shell commands
 * in the parent's terminal drawer, since the embedded view hides its own. Other panel actions reach
 * the parent through `hostRightPanel`; diff selection and the drawer are not panel state.
 */
export interface SideChatParentPanel {
  readonly openToolDiff: (target: ToolCallDiffTarget) => void;
  readonly runShellCommand: (command: string) => void;
}

export function openRelatedSideThread(input: {
  thread:
    | (Pick<OrchestrationV2ThreadShell, "lineage"> &
        Partial<Pick<OrchestrationV2ThreadShell, "creationSource">>)
    | null;
  threadRef: ScopedThreadRef;
  current: ScopedThreadRef | null;
  intent?: SideThreadOpenIntent;
  navigate: (ref: ScopedThreadRef) => void;
}) {
  const host = input.current ? rightPanelHostRef(input.current) : null;
  const target = resolveSideThreadOpenTarget({
    preference: getClientSettings().sideThreadOpenTarget,
    intent: input.intent ?? "primary",
    panelAvailable:
      sideThreadKindOf(input.thread) !== null &&
      host !== null &&
      host.environmentId === input.threadRef.environmentId &&
      host.threadId !== input.threadRef.threadId,
  });
  if (target === "panel" && host) {
    useRightPanelStore.getState().openSideChat(host, input.threadRef.threadId);
  } else {
    input.navigate(input.threadRef);
  }
}

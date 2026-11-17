import { GitBranchIcon, MenuIcon, PlusIcon, ServerIcon, TerminalIcon } from "lucide-react";
import type { ReactNode } from "react";

import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { useSoftwareKeyboardOpen } from "../../hooks/useSoftwareKeyboardOpen";
import {
  resolveThreadActionProjectRef,
  startNewThreadFromContext,
} from "../../lib/chatThreadActions";
import { cn } from "../../lib/utils";
import {
  openMobileServerSwitcher,
  triggerMobileHapticSelection,
  useIsCompactPhoneViewport,
  useMobileShellInfo,
} from "../../mobile/mobileShellBridge";
import {
  selectActiveRightPanel,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "../../rightPanelStore";
import { useThreadCheckpointSummaries } from "../../state/entities";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../../terminalUiStateStore";
import { useSidebar } from "../ui/sidebar";
import { useMobileWorkspaceLabels } from "./mobileWorkspaceLabels";

const actionClassName =
  "relative flex min-h-11 min-w-0 flex-1 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-md px-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:bg-accent/80 disabled:cursor-default disabled:opacity-40";

function WorkspaceAction({
  icon,
  label,
  onClick,
  badge = 0,
  disabled = false,
  pressed,
  primary = false,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly onClick: () => void;
  readonly badge?: number;
  readonly disabled?: boolean;
  readonly pressed?: boolean;
  readonly primary?: boolean;
}) {
  return (
    <button
      type="button"
      className={cn(actionClassName, primary && "bg-secondary text-secondary-foreground")}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={pressed}
      aria-label={badge > 0 ? `${label} (${badge})` : label}
    >
      {icon}
      <span className="max-w-full truncate">{label}</span>
      {badge > 0 ? (
        <span className="absolute right-1 top-1 min-w-4 rounded-full bg-secondary px-1 text-center text-2xs leading-4 text-secondary-foreground">
          {badge}
        </span>
      ) : null}
    </button>
  );
}

export function MobileWorkspaceBar() {
  const compact = useIsCompactPhoneViewport();
  const keyboardOpen = useSoftwareKeyboardOpen();
  const shellInfo = useMobileShellInfo();
  const labels = useMobileWorkspaceLabels();
  const { openMobile, setOpenMobile, toggleSidebar } = useSidebar();
  const newThreadContext = useHandleNewThread();
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread, routeThreadRef } =
    newThreadContext;
  const checkpoints = useThreadCheckpointSummaries(routeThreadRef);
  const terminalOpen = useTerminalUiStateStore(
    (state) =>
      selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef).terminalOpen,
  );
  const diffOpen = useRightPanelStore(
    (state) =>
      routeThreadRef !== null &&
      selectThreadRightPanelState(state.byThreadKey, routeThreadRef).isOpen &&
      selectActiveRightPanel(state.byThreadKey, routeThreadRef) === "diff",
  );

  if (!compact || keyboardOpen) return null;

  let latestCheckpoint = checkpoints[0];
  for (const checkpoint of checkpoints) {
    if (
      latestCheckpoint === undefined ||
      checkpoint.checkpointTurnCount > latestCheckpoint.checkpointTurnCount ||
      (checkpoint.checkpointTurnCount === latestCheckpoint.checkpointTurnCount &&
        checkpoint.completedAt > latestCheckpoint.completedAt)
    ) {
      latestCheckpoint = checkpoint;
    }
  }
  const changedFileCount =
    latestCheckpoint?.filesTotal?.count ?? latestCheckpoint?.files.length ?? 0;
  const actionContext = {
    activeDraftThread,
    activeThread: activeThread ?? undefined,
    defaultProjectRef,
    handleNewThread,
  };
  const canCreateThread = resolveThreadActionProjectRef(actionContext) !== null;

  return (
    <nav
      data-mobile-workspace-bar=""
      aria-label={labels.workspace}
      className="fixed inset-x-0 bottom-0 z-40 flex items-stretch gap-2 border-t border-border/60 bg-background px-2 pt-2 pb-[env(safe-area-inset-bottom)]"
    >
      <WorkspaceAction
        icon={<MenuIcon className="size-5" aria-hidden />}
        label={labels.threads}
        onClick={toggleSidebar}
        pressed={openMobile}
      />
      <WorkspaceAction
        icon={<PlusIcon className="size-5" aria-hidden />}
        label={labels.newThread}
        primary
        disabled={!canCreateThread}
        onClick={() => {
          setOpenMobile(false);
          void startNewThreadFromContext(actionContext);
        }}
      />
      <WorkspaceAction
        icon={<GitBranchIcon className="size-5" aria-hidden />}
        label={labels.changes}
        badge={changedFileCount}
        pressed={diffOpen}
        disabled={routeThreadRef === null}
        onClick={() => {
          if (routeThreadRef) useRightPanelStore.getState().toggle(routeThreadRef, "diff");
        }}
      />
      <WorkspaceAction
        icon={<TerminalIcon className="size-5" aria-hidden />}
        label={labels.terminal}
        pressed={terminalOpen}
        disabled={routeThreadRef === null}
        onClick={() => {
          if (routeThreadRef) {
            useTerminalUiStateStore.getState().setTerminalOpen(routeThreadRef, !terminalOpen);
          }
        }}
      />
      {shellInfo ? (
        <button
          type="button"
          data-mobile-server-switcher=""
          aria-label={`${labels.servers}: ${shellInfo.activeServerLabel}`}
          className="absolute bottom-full right-2 mb-2 flex min-h-11 max-w-48 cursor-pointer items-center gap-2 rounded-full border border-border/60 bg-popover px-3 text-xs font-medium text-popover-foreground shadow-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-accent/80"
          onClick={() => {
            triggerMobileHapticSelection();
            openMobileServerSwitcher();
          }}
        >
          <ServerIcon className="size-4 shrink-0" aria-hidden />
          <span className="min-w-0 truncate">{shellInfo.activeServerLabel}</span>
          <span className="rounded-full bg-secondary px-1.5 text-center leading-5 text-secondary-foreground">
            {shellInfo.serverCount}
          </span>
        </button>
      ) : null}
    </nav>
  );
}

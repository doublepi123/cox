import { scopedThreadKey } from "@t3tools/client-runtime/environment";

import { previewStreamDownloadUrl } from "@t3tools/client-runtime/preview/server-browser-stream";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_BROWSER_PROFILE_ID,
  FILL_PREVIEW_VIEWPORT,
  type PreviewAnnotationPayload,
  type ScopedThreadRef,
  DEFAULT_PREVIEW_ZOOM_FACTOR,
  PREVIEW_ZOOM_LEVELS,
  type PreviewAdjustInput,
} from "@t3tools/contracts";
import {
  normalizePreviewUrl,
  isPreviewUrlNormalizationError,
  resolveAddressBarInput,
  previewPdfAssetUrl,
  resolveSearchUrlTemplate,
} from "@t3tools/shared/preview";
import { useEffect, useRef, useState } from "react";
import {
  BROWSER_HISTORY_MAX_ENTRIES_PER_PROJECT,
  recordVisitForThread,
  removeUrlForThread,
  useThreadRecentHistory,
} from "~/browserHistoryStore";
import { type ComposerImageAttachment } from "~/composerDraftStore";

import { ensureLocalApi } from "~/localApi";
import { getClientSettings } from "~/hooks/useSettings";
import {
  rememberPreviewUrl,
  updatePreviewServerSnapshot,
  useThreadPreviewState,
} from "~/previewStateStore";

import { useEnvironmentHttpBaseUrl } from "~/state/environments";
import { previewEnvironment } from "~/state/preview";
import { usePreviewStreamAccess } from "~/state/previewStream";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  browserMiniPlayerSource,
  selectThreadPreviewMiniPlayerTabId,
  usePreviewMiniPlayerStore,
} from "~/previewMiniPlayerStore";

import { useRightPanelStore } from "~/rightPanelStore";

import { openPreviewSession } from "./openPreviewSession";
import { showPreviewPopup } from "./showPreviewPopup";
import { PreviewChromeRow } from "./PreviewChromeRow";
import { PreviewEmptyState } from "./PreviewEmptyState";
import { PreviewMoreMenu, type PreviewMoreMenuActions } from "./PreviewMoreMenu";
import { commitBrowserViewportChange } from "~/browser/browserViewportActions";
import { browserResponsiveViewportForToggle, useBrowserDefaults } from "~/browser/browserDefaults";
import { BrowserDeviceToolbar } from "~/browser/BrowserDeviceToolbar";
import { BROWSER_DEVICE_TOOLBAR_HEIGHT } from "~/browser/browserViewportLayout";

import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { BrowserSettingsReadError } from "~/browser/openFileInPreview";
import { PreviewFileNotShown, PreviewUnreachable } from "./PreviewUnreachable";

import { shouldShowPreviewEmptyState } from "./previewEmptyStateLogic";
import { Badge } from "~/components/ui/badge";

import { ServerBrowserSurface, type ServerBrowserHandle } from "~/browser/ServerBrowserSurface";
import { cn } from "~/lib/utils";
import { useBrowserSurfaceStore } from "~/browser/browserSurfaceStore";
import { usePreviewSession } from "./usePreviewSession";

import { subscribePreviewAction } from "./previewActionBus";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { observeResize } from "~/lib/observeResize";
interface Props {
  threadRef: ScopedThreadRef;
  tabId?: string | null;
  configuredUrls?: ReadonlyArray<string> | undefined;
  visible: boolean;
  onSendAnnotation?: (
    annotation: PreviewAnnotationPayload,
    image: ComposerImageAttachment | null,
  ) => void;
}
function previewProfileName(
  profiles: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
  }>,
  profileId: string,
): string {
  return profiles.find((profile) => profile.id === profileId)?.name ?? "Removed profile";
}
const localApi = typeof window === "undefined" ? null : ensureLocalApi();
function ServerTabFileNotShown(props: {
  readonly threadRef: ScopedThreadRef;
  readonly tabId: string;
  readonly url: string;
  readonly download: {
    readonly id: string;
    readonly fileName: string;
  };
}) {
  const access = usePreviewStreamAccess(props.threadRef.environmentId);
  return (
    <PreviewFileNotShown
      url={props.url}
      fileName={props.download.fileName}
      downloadUrl={
        access
          ? previewStreamDownloadUrl(
              { access, threadId: props.threadRef.threadId, tabId: props.tabId },
              props.download.id,
            )
          : null
      }
      onOpen={() => void localApi?.shell.openExternal(props.url).catch(() => undefined)}
    />
  );
}
export function PreviewView({ threadRef, tabId: requestedTabId, configuredUrls, visible }: Props) {
  const urlInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(
    () =>
      subscribePreviewAction((action) => {
        if (!visible || action !== "focus-url") return;
        urlInputRef.current?.focus();
        urlInputRef.current?.select();
      }),
    [visible],
  );
  const previewState = useThreadPreviewState(threadRef);
  const recentHistoryEntries = useThreadRecentHistory(
    threadRef,
    BROWSER_HISTORY_MAX_ENTRIES_PER_PROJECT,
  );
  const miniPlayerTabId = usePreviewMiniPlayerStore((state) =>
    selectThreadPreviewMiniPlayerTabId(state.byThreadKey, threadRef),
  );

  const environmentHttpBaseUrl = useEnvironmentHttpBaseUrl(threadRef.environmentId);
  const open = useAtomCommand(previewEnvironment.open);

  const adjust = useAtomCommand(previewEnvironment.adjust, "preview appearance or zoom");
  usePreviewSession(threadRef);
  const tabId = requestedTabId ?? previewState.activeTabId;
  const runtimeTabId = tabId
    ? previewRuntimeTabId(threadRef, previewState.serverEpoch, tabId)
    : null;

  const snapshot = tabId ? (previewState.sessions[tabId] ?? null) : null;
  const isServerTab = snapshot?.runtime === "server";
  const serverSurfaceRef = useRef<ServerBrowserHandle | null>(null);
  const [serverAspectRatioLocked, setServerAspectRatioLocked] = useState(false);
  const [serverToolbarWidth, setServerToolbarWidth] = useState(0);
  const serverToolbarShown =
    snapshot?.runtime === "server" && (snapshot.viewport ?? FILL_PREVIEW_VIEWPORT)._tag !== "fill";
  const serverBodyRef = useRef<HTMLDivElement | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- ResizeObserver on the server preview body sizes the viewport toolbar
  useEffect(() => {
    const element = serverBodyRef.current;
    if (!element || !serverToolbarShown) return;
    return observeResize(element, ([entry]) =>
      setServerToolbarWidth(Math.max(1, Math.round(entry?.contentRect.width ?? 0))),
    );
  }, [serverToolbarShown]);
  const [serverControlledTabId, setServerControlledTabId] = useState<string | null>(null);
  const serverInputDisabled = isServerTab && serverControlledTabId !== runtimeTabId;
  const [serverFrameTabId, setServerFrameTabId] = useState<string | null>(null);
  const navStatus = snapshot?.navStatus ?? { _tag: "Idle" as const };
  const url = navStatus._tag === "Idle" ? "" : navStatus.url;
  const loading = navStatus._tag === "Loading";
  const canGoBack = snapshot?.canGoBack ?? false;
  const canGoForward = snapshot?.canGoForward ?? false;
  const refreshDisabled = navStatus._tag === "Idle";
  const isUnreachable = navStatus._tag === "LoadFailed";
  const showEmptyState = shouldShowPreviewEmptyState(snapshot);
  const serverStreamPending =
    isServerTab && !showEmptyState && !isUnreachable && serverFrameTabId !== runtimeTabId;
  const viewport = snapshot?.viewport ?? FILL_PREVIEW_VIEWPORT;
  const browserDefaults = useBrowserDefaults();
  // IPC interprets undefined profile ids as all profiles.
  const activeProfileId = snapshot?.profileId ?? DEFAULT_BROWSER_PROFILE_ID;
  const activeProfileName = previewProfileName(browserDefaults.profiles, activeProfileId);
  const panelRect = useBrowserSurfaceStore((state) =>
    runtimeTabId ? (state.byTabId[runtimeTabId]?.rect ?? null) : null,
  );
  const navigateToResolvedUrl = async (resolvedUrl: string) => {
    if (isServerTab && serverSurfaceRef.current) {
      if (serverInputDisabled) return false;
      serverSurfaceRef.current.navigate(resolvedUrl);
      rememberPreviewUrl(threadRef, resolvedUrl);
      return true;
    }
    const result = await openPreviewSession({ openPreview: open, threadRef, url: resolvedUrl });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      if (error instanceof BrowserSettingsReadError) {
        toastManager.add({
          type: "error",
          title: "Unable to open browser",
          description: error.message,
        });
      }
    }
    return result._tag === "Success";
  };
  const handleSubmitUrl = async (next: string) => {
    try {
      const resolved = resolveAddressBarInput(next, resolveSearchUrlTemplate(getClientSettings()));
      if (await navigateToResolvedUrl(resolved)) {
        recordVisitForThread(threadRef, resolved);
      }
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not open this address",
        description: isPreviewUrlNormalizationError(error)
          ? "Enter an http or https URL."
          : error instanceof Error
            ? error.message
            : "An error occurred.",
      });
    }
  };
  const handleOpenServerUrl = async (next: string) => {
    try {
      const resolved = normalizePreviewUrl(next);
      if (await navigateToResolvedUrl(resolved)) {
        recordVisitForThread(threadRef, next);
      }
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not open this address",
        description: isPreviewUrlNormalizationError(error)
          ? "Enter an http or https URL."
          : error instanceof Error
            ? error.message
            : "An error occurred.",
      });
    }
  };
  const handleRefresh = () => {
    if (isServerTab) serverSurfaceRef.current?.reload();
  };
  const adjustServerTab = async (change: Omit<PreviewAdjustInput, "threadId" | "tabId">) => {
    if (!tabId) return;
    const result = await adjust({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, tabId, ...change },
    });
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Unable to change the browser tab",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
      return;
    }
    updatePreviewServerSnapshot(threadRef, result.value);
  };
  const serverZoomFactor = snapshot?.zoomFactor ?? DEFAULT_PREVIEW_ZOOM_FACTOR;
  const stepServerZoom = (direction: -1 | 0 | 1) => {
    const index = PREVIEW_ZOOM_LEVELS.indexOf(serverZoomFactor);
    const next =
      direction === 0
        ? DEFAULT_PREVIEW_ZOOM_FACTOR
        : PREVIEW_ZOOM_LEVELS[
            Math.min(
              Math.max((index < 0 ? 7 : index) + direction, 0),
              PREVIEW_ZOOM_LEVELS.length - 1,
            )
          ]!;
    if (next !== serverZoomFactor) void adjustServerTab({ zoomFactor: next });
  };
  const handleZoomIn = () => {
    if (isServerTab) stepServerZoom(1);
  };
  const handleZoomOut = () => {
    if (isServerTab) stepServerZoom(-1);
  };
  const handleResetZoom = () => {
    if (isServerTab) stepServerZoom(0);
  };
  const handleToggleDeviceToolbar = () => {
    if (!runtimeTabId || !tabId) return;
    const target = { threadRef, tabId, runtimeTabId };
    if (viewport._tag !== "fill") {
      void commitBrowserViewportChange(target, FILL_PREVIEW_VIEWPORT).catch(() => undefined);
      return;
    }
    void commitBrowserViewportChange(
      target,
      browserResponsiveViewportForToggle({
        defaults: browserDefaults,
        panelRect,
        zoomFactor: serverZoomFactor,
      }),
    ).catch(() => undefined);
  };
  const handleBack = () => {
    if (isServerTab) serverSurfaceRef.current?.history(-1);
  };
  const handleForward = () => {
    if (isServerTab) serverSurfaceRef.current?.history(1);
  };
  const handleOpenInBrowser = () => {
    if (!localApi || !url) return;
    void localApi.shell.openExternal(url).catch(() => undefined);
  };
  const handlePictureInPicture = () => {
    if (!tabId) return;
    if (miniPlayerTabId === tabId) {
      usePreviewMiniPlayerStore.getState().close(threadRef);
      return;
    }
    usePreviewMiniPlayerStore.getState().open(threadRef, browserMiniPlayerSource(tabId));
    useRightPanelStore.getState().close(threadRef);
  };
  const moreMenuActions: PreviewMoreMenuActions | null = isServerTab
    ? {
        hardReload: () => void adjustServerTab({ hardReload: true }),
        setColorScheme: (colorScheme) => void adjustServerTab({ colorScheme }),
        zoomIn: handleZoomIn,
        zoomOut: handleZoomOut,
        resetZoom: handleResetZoom,
        clearCookies: () => void adjustServerTab({ clear: "cookies" }),
        clearCache: () => void adjustServerTab({ clear: "cache" }),
      }
    : null;
  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-background"
      data-thread-key={scopedThreadKey(threadRef)}
    >
      <PreviewChromeRow
        url={url}
        loading={loading || serverStreamPending}
        canGoBack={canGoBack && !serverInputDisabled}
        canGoForward={canGoForward && !serverInputDisabled}
        refreshDisabled={refreshDisabled || serverInputDisabled}
        inputDisabled={serverInputDisabled}
        urlInputRef={urlInputRef}
        onBack={handleBack}
        onForward={handleForward}
        onRefresh={handleRefresh}
        onSubmit={(next) => void handleSubmitUrl(next)}
        onOpenInBrowser={tabId ? handleOpenInBrowser : undefined}
        onPictureInPicture={tabId && isServerTab ? handlePictureInPicture : undefined}
        pictureInPicture={miniPlayerTabId === tabId}
        pictureInPictureDisabled={isUnreachable}
        leadingActions={
          activeProfileId !== browserDefaults.profileId ? (
            <Tooltip>
              <span className="inline-flex min-w-0 max-w-28 shrink-0">
                <TooltipTrigger render={<Badge variant="outline" />}>
                  <span className="truncate">{activeProfileName}</span>
                </TooltipTrigger>
              </span>
              <TooltipPopup side="top">{activeProfileName}</TooltipPopup>
            </Tooltip>
          ) : null
        }
        trailingActions={
          moreMenuActions ? (
            <PreviewMoreMenu
              enabled={runtimeTabId !== null && isServerTab}
              actions={moreMenuActions}
              profileName={activeProfileName}
              zoomFactor={serverZoomFactor}
              colorScheme={snapshot?.colorScheme ?? "system"}
              deviceToolbarVisible={viewport._tag !== "fill"}
              onToggleDeviceToolbar={handleToggleDeviceToolbar}
            />
          ) : null
        }
      />

      <div ref={serverBodyRef} className="relative min-h-0 flex-1 overflow-hidden">
        {runtimeTabId && snapshot && isServerTab ? (
          <>
            {viewport._tag !== "fill" && !showEmptyState && !isUnreachable ? (
              <div className="absolute inset-x-0 top-0 z-10">
                <BrowserDeviceToolbar
                  setting={viewport}
                  width={serverToolbarWidth}
                  aspectRatio={serverAspectRatioLocked ? viewport.width / viewport.height : null}
                  onAspectRatioChange={(ratio) => setServerAspectRatioLocked(ratio !== null)}
                  onChange={(setting) =>
                    commitBrowserViewportChange(
                      { threadRef, tabId: snapshot.tabId, runtimeTabId },
                      setting,
                    )
                  }
                />
              </div>
            ) : null}
            <div
              className="absolute inset-x-0 bottom-0"
              style={{ top: viewport._tag !== "fill" ? BROWSER_DEVICE_TOOLBAR_HEIGHT : 0 }}
            >
              <ServerBrowserSurface
                key={runtimeTabId}
                ref={serverSurfaceRef}
                environmentId={threadRef.environmentId}
                threadId={threadRef.threadId}
                tabId={snapshot.tabId}
                pdfUrl={
                  navStatus._tag === "Success"
                    ? previewPdfAssetUrl(url, environmentHttpBaseUrl)
                    : null
                }
                visible={visible}
                onFirstFrame={() => setServerFrameTabId(runtimeTabId)}
                onControl={(control) =>
                  setServerControlledTabId(control?.controller === "you" ? runtimeTabId : null)
                }
                onPopup={(popupTabId) => showPreviewPopup(threadRef, popupTabId, "panel")}
                // Stays connected under the empty state so a URL picked there reaches the page.
                className={cn(
                  "absolute inset-0 h-full w-full",
                  (showEmptyState || isUnreachable) && "invisible",
                )}
              />
            </div>
          </>
        ) : null}
        {showEmptyState ? (
          <PreviewEmptyState
            threadRef={threadRef}
            environmentId={threadRef.environmentId}
            configuredUrls={configuredUrls}
            recentEntries={recentHistoryEntries}
            onRemoveRecent={(url) => removeUrlForThread(threadRef, url)}
            onOpenUrl={(next) => void handleOpenServerUrl(next)}
          />
        ) : null}
        {navStatus._tag === "LoadFailed" && navStatus.download ? (
          <div className="absolute inset-0 z-10 bg-background">
            <ServerTabFileNotShown
              threadRef={threadRef}
              tabId={snapshot?.tabId ?? ""}
              url={navStatus.url}
              download={navStatus.download}
            />
          </div>
        ) : navStatus._tag === "LoadFailed" ? (
          <div className="absolute inset-0 z-10 bg-background">
            <PreviewUnreachable
              url={navStatus.url}
              code={navStatus.code}
              description={navStatus.description}
              onReload={handleRefresh}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

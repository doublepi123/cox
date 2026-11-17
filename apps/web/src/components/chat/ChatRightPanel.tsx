import { XIcon } from "lucide-react";
import { useSyncExternalStore } from "react";
import { usePreviewPanelInlineSize } from "../../hooks/usePreviewPanelInlineSize";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useTranslation } from "../../i18n";
import {
  RIGHT_PANEL_SHEET_CONTAINER_MAX_WIDTH,
  RIGHT_PANEL_SHEET_MEDIA_QUERY,
} from "../../rightPanelLayout";
import { Button } from "../ui/button";
import { RightPanelSheet } from "../RightPanelSheet";
import { RightPanelTabs, type RightPanelTabsProps } from "../RightPanelTabs";

type ChatRightPanelProps = Omit<RightPanelTabsProps, "mode" | "inlineSize" | "maximized"> & {
  readonly sheet: boolean;
  readonly maximized: boolean;
  readonly workspaceLayoutElement: HTMLElement | null;
  readonly widthStorageKey: string;
  readonly sheetAnimationDurationMs: number;
  readonly onCloseSheet: () => void;
};

/**
 * The right panel, inline beside the chat column or as a sheet on narrow
 * layouts. Its width follows a resize drag every frame, so the width state
 * lives here rather than in ChatView.
 */
export function ChatRightPanel(props: ChatRightPanelProps) {
  const { t } = useTranslation();
  const {
    sheet: requestedSheet,
    workspaceLayoutElement,
    widthStorageKey,
    sheetAnimationDurationMs,
    onCloseSheet,
    maximized,
    layoutControls,
    ...tabs
  } = props;
  const viewportSheet = useMediaQuery(RIGHT_PANEL_SHEET_MEDIA_QUERY);
  const containerSheet = useSyncExternalStore(
    (onChange) => {
      if (!workspaceLayoutElement) return () => {};
      const observer = new ResizeObserver(onChange);
      observer.observe(workspaceLayoutElement);
      return () => observer.disconnect();
    },
    () =>
      workspaceLayoutElement !== null &&
      workspaceLayoutElement.clientWidth <= RIGHT_PANEL_SHEET_CONTAINER_MAX_WIDTH,
    () => false,
  );
  const sheet = requestedSheet || viewportSheet || containerSheet;
  const inlineSize = usePreviewPanelInlineSize({
    container: workspaceLayoutElement,
    widthStorageKey,
  });
  const sheetControls = (
    <Button variant="ghost" size="icon-xl" aria-label={t("Close panel")} onClick={onCloseSheet}>
      <XIcon />
    </Button>
  );
  if (!sheet) {
    return (
      <RightPanelTabs
        {...tabs}
        mode="inline"
        maximized={maximized}
        inlineSize={inlineSize}
        layoutControls={layoutControls}
      />
    );
  }
  return (
    <RightPanelSheet
      animationDurationMs={sheetAnimationDurationMs}
      open={tabs.open === true}
      onClose={onCloseSheet}
    >
      <RightPanelTabs
        {...tabs}
        mode="sheet"
        inlineSize={inlineSize}
        layoutControls={sheetControls}
      />
    </RightPanelSheet>
  );
}

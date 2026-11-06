import { useTranslation } from "../../i18n";
import { LanguageSettings } from "./LanguageSettings";
import { NotificationSettings } from "./NotificationSettings";
import { CheckIcon } from "lucide-react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import {
  IDLE_COMPACTION_MODES,
  globalIdleCompaction,
  ProviderDriverKind,
  type ProviderInstanceId,
  type SidebarProjectGroupingMode,
} from "@t3tools/contracts";
import {
  DEFAULT_UNIFIED_SETTINGS,
  type DiffLayout,
  MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  type ResponseStreamingMode,
  type QuitConfirmationMode,
  SidebarProjectSortOrder,
} from "@t3tools/contracts/settings";

import { createModelSelection } from "@t3tools/shared/model";
import * as Equal from "effect/Equal";
import * as Schema from "effect/Schema";
import { APP_VERSION } from "../../branding";
import { AboutVersionTitle } from "./AboutVersionTitle";
import { DesktopBackendUpdates } from "./DesktopBackendUpdates";

import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";

import {
  readAppearanceModePreference,
  readThemeHalves,
  readThemePreference,
  useTheme,
} from "../../hooks/useTheme";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import { useOptionalSettingsScope, useSettingsScope } from "./SettingsScopeContext";
import { scopedIdleCompaction } from "./scopedSettings";
import { ProjectDefaultsSettings } from "./ProjectDefaultsSettings";
import { ThreadTitleInstructionsSettings } from "./ThreadTitleInstructionsSettings";
import { SnoozePresetsRow } from "./SnoozePresetsSettings";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
  selectsPlanAgent,
} from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { ensureLocalApi, readLocalApi } from "../../localApi";
import { isMacPlatform } from "../../lib/utils";
import { useEnvironmentProviders } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { ScopedSwitch } from "./ScopedSwitch";
import { stackedThreadToast, toastManager } from "../ui/toast";

import {
  getChangedBrowserSettingLabels,
  getChangedTypographySettingLabels,
  hasChangedBackgroundActivitySettings,
  isProjectGroupingEnabled,
  projectGroupingModeFromToggle,
  readLastEnabledProjectGroupingMode,
  rememberEnabledProjectGroupingMode,
} from "./SettingsPanels.logic";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { BackgroundActivitySettingsRow } from "./BackgroundActivitySettings";
import { AdvancedSettings } from "./AdvancedSettings";
import { PullRequestLinksOpenInAppSetting } from "./IntegrationsSettings";
import { StorageCleanupSections } from "./StorageSettings";

const RESPONSE_STREAMING_MODE_LABELS: Record<ResponseStreamingMode, string> = {
  turn: "Wait for the full response",
  paragraph: "Show finished paragraphs",
};
const RESPONSE_STREAMING_MODE_DESCRIPTIONS: Record<ResponseStreamingMode, string> = {
  turn: "Text appears once the agent finishes its turn.",
  paragraph: "Each paragraph or code block appears as soon as it is complete.",
};
const SIDEBAR_PROJECT_SORT_ORDER_LABELS: Record<SidebarProjectSortOrder, string> = {
  updated_at: "Last user message",
  created_at: "Created at",
  manual: "Manual",
};
const isSidebarProjectSortOrder = Schema.is(SidebarProjectSortOrder);
const TIMESTAMP_FORMAT_LABELS = {
  locale: "System default",
  "12-hour": "12-hour",
  "24-hour": "24-hour",
} as const;
const DIFF_LAYOUT_LABELS: Record<DiffLayout, string> = {
  stacked: "Stacked",
  split: "Split",
};
const QUIT_CONFIRMATION_MODE_LABELS: Record<QuitConfirmationMode, string> = {
  direct: "Direct",
  hold: "Hold",
  "double-click": "Double press",
};
const DEFAULT_DRIVER_KIND = ProviderDriverKind.make("codex");
function AboutVersionSection() {
  const { t } = useTranslation();
  return (
    <SettingsSection title="Cox">
      <SettingsRow
        title={t("Local coding-agent workspace · {version}", { version: APP_VERSION })}
      />
    </SettingsSection>
  );
}
export function useSettingsRestore(onRestored?: () => void) {
  const { t } = useTranslation();
  const {
    theme,
    setTheme,
    followSystem,
    setFollowSystem,
    setThemeHalf,
    clearThemeHalves,
    themeHalves,
  } = useTheme();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const isTextGenerationModelDirty = !Equal.equals(
    settings.textGenerationModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null,
  );
  const isBackgroundActivityDirty = hasChangedBackgroundActivitySettings(settings);
  const changedSettingLabels = [
    ...(theme !== "system" ? ["Theme"] : []),
    ...(!followSystem ? [t("Follow system")] : []),
    ...(themeHalves !== null ? [t("Theme mix")] : []),
    ...(settings.appearanceContrast !== DEFAULT_UNIFIED_SETTINGS.appearanceContrast
      ? ["Contrast"]
      : []),
    ...(settings.glassOpacity !== DEFAULT_UNIFIED_SETTINGS.glassOpacity
      ? [t("Glass opacity")]
      : []),
    ...(settings.diffColorScheme !== DEFAULT_UNIFIED_SETTINGS.diffColorScheme
      ? [t("Diff colors")]
      : []),
    ...(settings.chatWidth !== DEFAULT_UNIFIED_SETTINGS.chatWidth ? [t("Chat width")] : []),
    ...(settings.effortDisplay !== DEFAULT_UNIFIED_SETTINGS.effortDisplay
      ? [t("Effort display")]
      : []),
    ...(settings.mathRenderingEnabled !== DEFAULT_UNIFIED_SETTINGS.mathRenderingEnabled
      ? [t("Render math")]
      : []),
    ...(settings.panelAnimationDurationMs !== DEFAULT_UNIFIED_SETTINGS.panelAnimationDurationMs
      ? [t("Panel animations")]
      : []),
    ...(settings.environmentIdentificationMode !==
    DEFAULT_UNIFIED_SETTINGS.environmentIdentificationMode
      ? [t("Environment identification")]
      : []),
    ...(settings.timestampFormat !== DEFAULT_UNIFIED_SETTINGS.timestampFormat
      ? [t("Time format")]
      : []),
    ...(settings.notificationMode !== DEFAULT_UNIFIED_SETTINGS.notificationMode
      ? [t("Thread notifications")]
      : []),
    ...(settings.inAppNotificationsEnabled !== DEFAULT_UNIFIED_SETTINGS.inAppNotificationsEnabled
      ? [t("In-app notifications")]
      : []),
    ...(settings.sidebarProjectGroupingMode !== DEFAULT_UNIFIED_SETTINGS.sidebarProjectGroupingMode
      ? [t("Project Grouping")]
      : []),
    ...(settings.sidebarProjectSortOrder !== DEFAULT_UNIFIED_SETTINGS.sidebarProjectSortOrder
      ? [t("Project order")]
      : []),
    ...(settings.sidebarWorkingShelfEnabled !== DEFAULT_UNIFIED_SETTINGS.sidebarWorkingShelfEnabled
      ? [t("Working section")]
      : []),
    ...(settings.sidebarAutoSettleAfterDays !== DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleAfterDays
      ? [t("Auto-settle inactive threads")]
      : []),
    ...(settings.sidebarAutoSettleKeepPullRequests !==
    DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleKeepPullRequests
      ? [t("Keep threads with a PR")]
      : []),
    ...(settings.sidebarAutoSettleOnMerge !== DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleOnMerge
      ? [t("Auto-settle merged threads")]
      : []),
    ...(settings.autoResumeLimitedThreads !== DEFAULT_UNIFIED_SETTINGS.autoResumeLimitedThreads
      ? [t("Resume after usage limits")]
      : []),
    ...(settings.snoozeLimitedThreads !== DEFAULT_UNIFIED_SETTINGS.snoozeLimitedThreads
      ? [t("Snooze until limits reset")]
      : []),
    ...(!Equal.equals(settings.snoozePresets, DEFAULT_UNIFIED_SETTINGS.snoozePresets)
      ? [t("Snooze options")]
      : []),
    ...(settings.wordWrap !== DEFAULT_UNIFIED_SETTINGS.wordWrap ? [t("Word wrap")] : []),
    ...(settings.persistComposerContextStrip !==
    DEFAULT_UNIFIED_SETTINGS.persistComposerContextStrip
      ? [t("Composer context")]
      : []),
    ...getChangedTypographySettingLabels(settings),
    ...(settings.diffFilesCollapsed !== DEFAULT_UNIFIED_SETTINGS.diffFilesCollapsed
      ? [t("Default diff file state")]
      : []),
    ...(settings.diffIgnoreWhitespace !== DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace
      ? [t("Diff whitespace changes")]
      : []),
    ...(settings.diffLayout !== DEFAULT_UNIFIED_SETTINGS.diffLayout ? [t("Diff layout")] : []),
    ...(settings.proactivePanelsEnabled !== DEFAULT_UNIFIED_SETTINGS.proactivePanelsEnabled
      ? [t("Proactive panels")]
      : []),
    ...(settings.showSkillsInSlashMenu !== DEFAULT_UNIFIED_SETTINGS.showSkillsInSlashMenu
      ? [t("Show skills in slash menu")]
      : []),
    ...(settings.composerRichTextEnabled !== DEFAULT_UNIFIED_SETTINGS.composerRichTextEnabled
      ? [t("Rich text composer")]
      : []),
    ...(settings.sendShortcut !== DEFAULT_UNIFIED_SETTINGS.sendShortcut
      ? [t("Send shortcut")]
      : []),
    ...(settings.followUpBehavior !== DEFAULT_UNIFIED_SETTINGS.followUpBehavior
      ? [t("Follow-up behavior")]
      : []),
    ...(settings.contextWindowMeterEnabled !== DEFAULT_UNIFIED_SETTINGS.contextWindowMeterEnabled
      ? [t("Context window indicator")]
      : []),
    ...(settings.responseStreamingMode !== DEFAULT_UNIFIED_SETTINGS.responseStreamingMode
      ? [t("Response streaming")]
      : []),
    ...(settings.enableProviderUpdateChecks !== DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks
      ? [t("Provider update checks")]
      : []),
    ...(settings.continueThreadsAfterServerUpdate !==
    DEFAULT_UNIFIED_SETTINGS.continueThreadsAfterServerUpdate
      ? [t("Continue threads after restarts")]
      : []),
    ...(isBackgroundActivityDirty ? [t("Background activity")] : []),
    ...(settings.defaultThreadEnvMode !== DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode
      ? [t("New thread mode")]
      : []),
    ...(settings.newWorktreesStartFromOrigin !==
    DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin
      ? [t("New worktrees start from remote")]
      : []),
    ...(settings.addProjectBaseDirectory !== DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory
      ? [t("Add project base directory")]
      : []),
    ...(settings.ghqCloneLayout !== DEFAULT_UNIFIED_SETTINGS.ghqCloneLayout
      ? [t("Clone into host folders")]
      : []),
    ...(settings.confirmThreadUnpin !== DEFAULT_UNIFIED_SETTINGS.confirmThreadUnpin
      ? [t("Unpin confirmation")]
      : []),
    ...(settings.confirmThreadArchive !== DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive
      ? [t("Archive confirmation")]
      : []),
    ...(settings.confirmThreadDelete !== DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete
      ? [t("Delete confirmation")]
      : []),
    ...(settings.confirmQuit !== DEFAULT_UNIFIED_SETTINGS.confirmQuit ? [t("Quit shortcut")] : []),
    ...(isTextGenerationModelDirty ? [t("Text generation model")] : []),
    ...(settings.threadTitleInstructions !== DEFAULT_UNIFIED_SETTINGS.threadTitleInstructions
      ? [t("Thread title instructions")]
      : []),
    ...getChangedBrowserSettingLabels(settings),
    ...(settings.enableAgentBrowserAccess !== DEFAULT_UNIFIED_SETTINGS.enableAgentBrowserAccess
      ? [t("Agent browser access")]
      : []),
  ];
  const restoreDefaults = async () => {
    if (changedSettingLabels.length === 0) return;
    const api = readLocalApi();
    const confirmed = await (api ?? ensureLocalApi()).dialogs.confirm(
      [
        t("Restore default settings?"),
        t("This will reset: {settings}.", { settings: changedSettingLabels.join(", ") }),
      ].join("\n"),
      { variant: "destructive" },
    );
    if (!confirmed) return;
    // Reset only dirty theme keys so storage failures cannot block other settings; re-read after confirmation
    // for safe rollback.
    let previousTheme = theme;
    try {
      previousTheme = readThemePreference();
    } catch {}
    const liveHalves = readThemeHalves();
    const needsThemeReset = previousTheme !== "system";
    const needsMixReset = liveHalves !== null;
    const needsFollowSystemReset = readAppearanceModePreference(previousTheme) !== "system";
    const notifyThemeRestoreFailure = () => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: t("Couldn’t restore theme settings"),
          description: t("Try again."),
        }),
      );
    };
    // Restore the base preference before the mix because restoring the base clears the mix.
    const previousHalves = liveHalves;
    const rollbackThemeState = () => {
      if (needsThemeReset) setTheme(previousTheme);
      if (previousHalves?.light) setThemeHalf("light", previousHalves.light);
      if (previousHalves?.dark) setThemeHalf("dark", previousHalves.dark);
    };
    if (needsThemeReset && !setTheme("system")) {
      notifyThemeRestoreFailure();
      return;
    }
    if (needsMixReset && !clearThemeHalves()) {
      rollbackThemeState();
      notifyThemeRestoreFailure();
      return;
    }
    if (needsFollowSystemReset && !setFollowSystem(true)) {
      rollbackThemeState();
      notifyThemeRestoreFailure();
      return;
    }
    updateSettings({
      appearanceContrast: DEFAULT_UNIFIED_SETTINGS.appearanceContrast,
      diffColorScheme: DEFAULT_UNIFIED_SETTINGS.diffColorScheme,
      chatWidth: DEFAULT_UNIFIED_SETTINGS.chatWidth,
      effortDisplay: DEFAULT_UNIFIED_SETTINGS.effortDisplay,
      mathRenderingEnabled: DEFAULT_UNIFIED_SETTINGS.mathRenderingEnabled,
      timestampFormat: DEFAULT_UNIFIED_SETTINGS.timestampFormat,
      notificationMode: DEFAULT_UNIFIED_SETTINGS.notificationMode,
      inAppNotificationsEnabled: DEFAULT_UNIFIED_SETTINGS.inAppNotificationsEnabled,
      wordWrap: DEFAULT_UNIFIED_SETTINGS.wordWrap,
      persistComposerContextStrip: DEFAULT_UNIFIED_SETTINGS.persistComposerContextStrip,
      diffFilesCollapsed: DEFAULT_UNIFIED_SETTINGS.diffFilesCollapsed,
      diffIgnoreWhitespace: DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace,
      diffLayout: DEFAULT_UNIFIED_SETTINGS.diffLayout,
      proactivePanelsEnabled: DEFAULT_UNIFIED_SETTINGS.proactivePanelsEnabled,
      showSkillsInSlashMenu: DEFAULT_UNIFIED_SETTINGS.showSkillsInSlashMenu,
      composerRichTextEnabled: DEFAULT_UNIFIED_SETTINGS.composerRichTextEnabled,
      sendShortcut: DEFAULT_UNIFIED_SETTINGS.sendShortcut,
      followUpBehavior: DEFAULT_UNIFIED_SETTINGS.followUpBehavior,
      contextWindowMeterEnabled: DEFAULT_UNIFIED_SETTINGS.contextWindowMeterEnabled,
      environmentIdentificationMode: DEFAULT_UNIFIED_SETTINGS.environmentIdentificationMode,
      glassOpacity: DEFAULT_UNIFIED_SETTINGS.glassOpacity,
      panelAnimationDurationMs: DEFAULT_UNIFIED_SETTINGS.panelAnimationDurationMs,
      sidebarProjectGroupingMode: DEFAULT_UNIFIED_SETTINGS.sidebarProjectGroupingMode,
      sidebarProjectSortOrder: DEFAULT_UNIFIED_SETTINGS.sidebarProjectSortOrder,
      sidebarWorkingShelfEnabled: DEFAULT_UNIFIED_SETTINGS.sidebarWorkingShelfEnabled,
      sidebarAutoSettleAfterDays: DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleAfterDays,
      sidebarAutoSettleKeepPullRequests: DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleKeepPullRequests,
      sidebarAutoSettleOnMerge: DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleOnMerge,
      autoResumeLimitedThreads: DEFAULT_UNIFIED_SETTINGS.autoResumeLimitedThreads,
      snoozeLimitedThreads: DEFAULT_UNIFIED_SETTINGS.snoozeLimitedThreads,
      snoozePresets: DEFAULT_UNIFIED_SETTINGS.snoozePresets,
      responseStreamingMode: DEFAULT_UNIFIED_SETTINGS.responseStreamingMode,
      enableProviderUpdateChecks: DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks,
      continueThreadsAfterServerUpdate: DEFAULT_UNIFIED_SETTINGS.continueThreadsAfterServerUpdate,
      backgroundActivity: DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
      backgroundActivityProfile: DEFAULT_UNIFIED_SETTINGS.backgroundActivityProfile,
      automaticGitFetchInterval: DEFAULT_UNIFIED_SETTINGS.automaticGitFetchInterval,
      providerHealthRefreshInterval: DEFAULT_UNIFIED_SETTINGS.providerHealthRefreshInterval,
      defaultThreadEnvMode: DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode,
      newWorktreesStartFromOrigin: DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin,
      addProjectBaseDirectory: DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory,
      ghqCloneLayout: DEFAULT_UNIFIED_SETTINGS.ghqCloneLayout,
      confirmThreadArchive: DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive,
      confirmThreadDelete: DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete,
      confirmThreadUnpin: DEFAULT_UNIFIED_SETTINGS.confirmThreadUnpin,
      confirmQuit: DEFAULT_UNIFIED_SETTINGS.confirmQuit,
      textGenerationModelSelection: DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
      threadTitleInstructions: DEFAULT_UNIFIED_SETTINGS.threadTitleInstructions,
      fontFamilySans: DEFAULT_UNIFIED_SETTINGS.fontFamilySans,
      fontFamilyComposer: DEFAULT_UNIFIED_SETTINGS.fontFamilyComposer,
      fontFamilyCode: DEFAULT_UNIFIED_SETTINGS.fontFamilyCode,
      fontFamilyTerminal: DEFAULT_UNIFIED_SETTINGS.fontFamilyTerminal,
      fontSizeInterface: DEFAULT_UNIFIED_SETTINGS.fontSizeInterface,
      fontSizePrompt: DEFAULT_UNIFIED_SETTINGS.fontSizePrompt,
      fontSizeCode: DEFAULT_UNIFIED_SETTINGS.fontSizeCode,
      fontSizeTerminal: DEFAULT_UNIFIED_SETTINGS.fontSizeTerminal,
      browserDefaultViewport: DEFAULT_UNIFIED_SETTINGS.browserDefaultViewport,
      browserDefaultZoomFactor: DEFAULT_UNIFIED_SETTINGS.browserDefaultZoomFactor,
      browserDefaultAppearance: DEFAULT_UNIFIED_SETTINGS.browserDefaultAppearance,
      browserRecordingFrameRate: DEFAULT_UNIFIED_SETTINGS.browserRecordingFrameRate,
      browserRecordingShowKeyPresses: DEFAULT_UNIFIED_SETTINGS.browserRecordingShowKeyPresses,
      browserRecordingShowMousePresses: DEFAULT_UNIFIED_SETTINGS.browserRecordingShowMousePresses,
      browserLinkTarget: DEFAULT_UNIFIED_SETTINGS.browserLinkTarget,
      browserSearchEngine: DEFAULT_UNIFIED_SETTINGS.browserSearchEngine,
      browserCustomSearchUrl: DEFAULT_UNIFIED_SETTINGS.browserCustomSearchUrl,
      browserAutoShowFloatingPreview: DEFAULT_UNIFIED_SETTINGS.browserAutoShowFloatingPreview,
      pullRequestLinksOpenInApp: DEFAULT_UNIFIED_SETTINGS.pullRequestLinksOpenInApp,
      enableAgentBrowserAccess: DEFAULT_UNIFIED_SETTINGS.enableAgentBrowserAccess,
    });
    onRestored?.();
  };
  return {
    changedSettingLabels,
    restoreDefaults,
  };
}
const AUTO_SETTLE_DEFAULT_DAYS = DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleAfterDays ?? 3;
function AutoSettleDaysInput({
  value,
  onCommit,
}: {
  value: number;
  onCommit: (days: number) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(String(value));
  const [draftSource, setDraftSource] = useState(value);
  if (draftSource !== value) {
    setDraftSource(value);
    setDraft(String(value));
  }
  return (
    <Input
      size="sm"
      type="number"
      min={MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS}
      max={MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS}
      className="w-full sm:w-24"
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value);
        const parsed = Number(event.target.value);
        if (
          Number.isInteger(parsed) &&
          parsed >= MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS &&
          parsed <= MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS
        ) {
          onCommit(parsed);
        }
      }}
      onBlur={() => setDraft(String(value))}
      aria-label={t("Days of inactivity before auto-settle")}
    />
  );
}
export function LegacyFeaturesSection() {
  const { t } = useTranslation();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsSection id="legacy-features" title={t("Legacy")}>
      <SettingsRow
        {...searchableSetting("legacy-plan-mode")}
        description={t("Restore Build/Plan, /plan, /default, and Shift+Tab. Off uses build mode.")}
        control={
          <Switch
            checked={settings.planModeEnabled}
            onCheckedChange={(checked) => {
              updateSettings({ planModeEnabled: Boolean(checked) });
            }}
            aria-label={t("Plan mode (legacy)")}
          />
        }
      />
      <SettingsRow
        {...searchableSetting("legacy-context-window-indicator")}
        description={t("Shows context window usage as a circular indicator in the composer.")}
        control={
          <Switch
            checked={settings.contextWindowMeterEnabled}
            onCheckedChange={(checked) =>
              updateSettings({ contextWindowMeterEnabled: Boolean(checked) })
            }
            aria-label={t("Context window indicator (legacy)")}
          />
        }
      />
    </SettingsSection>
  );
}
export function GeneralSettingsPanel() {
  const { t } = useTranslation();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const lastEnabledProjectGroupingMode = useRef<SidebarProjectGroupingMode>(
    readLastEnabledProjectGroupingMode(),
  );
  return (
    <SettingsPageContainer>
      <LanguageSettings />
      <SettingsSection id="notifications" title={t("Notifications")}>
        <NotificationSettings />
        <SettingsRow
          {...searchableSetting("in-app-notifications")}
          description={t(
            "Show a toast when another thread finishes, fails, or needs input or approval while this app has focus.",
          )}
          control={
            <Switch
              checked={settings.inAppNotificationsEnabled}
              onCheckedChange={(checked) => updateSettings({ inAppNotificationsEnabled: checked })}
              aria-label={t("In-app notifications")}
            />
          }
        />
      </SettingsSection>

      <SettingsSection id="sidebar" title={t("Sidebar")}>
        <SettingsRow
          {...searchableSetting("project-grouping")}
          description={t("Combine matching repositories across environments.")}
          resetAction={
            settings.sidebarProjectGroupingMode !==
            DEFAULT_UNIFIED_SETTINGS.sidebarProjectGroupingMode ? (
              <SettingResetButton
                label={t("project grouping")}
                onClick={() =>
                  updateSettings({
                    sidebarProjectGroupingMode: DEFAULT_UNIFIED_SETTINGS.sidebarProjectGroupingMode,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={isProjectGroupingEnabled(settings.sidebarProjectGroupingMode)}
              onCheckedChange={(checked) => {
                if (!checked && settings.sidebarProjectGroupingMode !== "separate") {
                  lastEnabledProjectGroupingMode.current = settings.sidebarProjectGroupingMode;
                  rememberEnabledProjectGroupingMode(settings.sidebarProjectGroupingMode);
                }
                updateSettings({
                  sidebarProjectGroupingMode: projectGroupingModeFromToggle(
                    checked,
                    lastEnabledProjectGroupingMode.current,
                  ),
                });
              }}
              aria-label={t("Project grouping")}
            />
          }
        />
        <SettingsRow
          {...searchableSetting("project-order")}
          description={t("Order of projects in the sidebar project picker and command palette.")}
          resetAction={
            settings.sidebarProjectSortOrder !==
            DEFAULT_UNIFIED_SETTINGS.sidebarProjectSortOrder ? (
              <SettingResetButton
                label={t("project order")}
                onClick={() =>
                  updateSettings({
                    sidebarProjectSortOrder: DEFAULT_UNIFIED_SETTINGS.sidebarProjectSortOrder,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.sidebarProjectSortOrder}
              onValueChange={(value) => {
                if (isSidebarProjectSortOrder(value)) {
                  updateSettings({ sidebarProjectSortOrder: value });
                }
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-44" aria-label={t("Project order")}>
                <SelectValue>
                  {t(SIDEBAR_PROJECT_SORT_ORDER_LABELS[settings.sidebarProjectSortOrder])}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {SidebarProjectSortOrder.literals.map((sortOrder) => (
                  <SelectItem hideIndicator key={sortOrder} value={sortOrder}>
                    {t(SIDEBAR_PROJECT_SORT_ORDER_LABELS[sortOrder])}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          {...searchableSetting("working-shelf")}
          description={t(
            "Fold working and monitoring threads into a Working section. They return to the top of the inbox when they need you. The boring sidebar in Labs has no Working section.",
          )}
          resetAction={
            settings.sidebarWorkingShelfEnabled !==
            DEFAULT_UNIFIED_SETTINGS.sidebarWorkingShelfEnabled ? (
              <SettingResetButton
                label={t("working section")}
                onClick={() =>
                  updateSettings({
                    sidebarWorkingShelfEnabled: DEFAULT_UNIFIED_SETTINGS.sidebarWorkingShelfEnabled,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.sidebarWorkingShelfEnabled}
              onCheckedChange={(checked) =>
                updateSettings({ sidebarWorkingShelfEnabled: Boolean(checked) })
              }
              aria-label={t("Working section")}
            />
          }
        />
      </SettingsSection>

      <SettingsSection id="confirmations" title={t("Confirmations")}>
        <SettingsRow
          {...searchableSetting("unpin-confirmation")}
          description={t("Ask before unpinning a thread from the pinned section.")}
          resetAction={
            settings.confirmThreadUnpin !== DEFAULT_UNIFIED_SETTINGS.confirmThreadUnpin ? (
              <SettingResetButton
                label={t("unpin confirmation")}
                onClick={() =>
                  updateSettings({
                    confirmThreadUnpin: DEFAULT_UNIFIED_SETTINGS.confirmThreadUnpin,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.confirmThreadUnpin}
              onCheckedChange={(checked) =>
                updateSettings({ confirmThreadUnpin: Boolean(checked) })
              }
              aria-label={t("Confirm thread unpinning")}
            />
          }
        />
        <SettingsRow
          {...searchableSetting("archive-confirmation")}
          description={t(
            "Require a second click on the inline archive action before a thread is archived.",
          )}
          resetAction={
            settings.confirmThreadArchive !== DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive ? (
              <SettingResetButton
                label={t("archive confirmation")}
                onClick={() =>
                  updateSettings({
                    confirmThreadArchive: DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.confirmThreadArchive}
              onCheckedChange={(checked) =>
                updateSettings({ confirmThreadArchive: Boolean(checked) })
              }
              aria-label={t("Confirm thread archiving")}
            />
          }
        />
        <SettingsRow
          {...searchableSetting("delete-confirmation")}
          description={t("Ask before deleting a thread and its chat history.")}
          resetAction={
            settings.confirmThreadDelete !== DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete ? (
              <SettingResetButton
                label={t("delete confirmation")}
                onClick={() =>
                  updateSettings({
                    confirmThreadDelete: DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.confirmThreadDelete}
              onCheckedChange={(checked) =>
                updateSettings({ confirmThreadDelete: Boolean(checked) })
              }
              aria-label={t("Confirm thread deletion")}
            />
          }
        />
        {null}
      </SettingsSection>

      <SettingsSection id="display" title={t("Display")}>
        <SettingsRow
          {...searchableSetting("time-format")}
          description={t("System default follows your browser or OS clock preference.")}
          resetAction={
            settings.timestampFormat !== DEFAULT_UNIFIED_SETTINGS.timestampFormat ? (
              <SettingResetButton
                label={t("time format")}
                onClick={() =>
                  updateSettings({
                    timestampFormat: DEFAULT_UNIFIED_SETTINGS.timestampFormat,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.timestampFormat}
              onValueChange={(value) => {
                if (value === "locale" || value === "12-hour" || value === "24-hour") {
                  updateSettings({ timestampFormat: value });
                }
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-full sm:w-40"
                aria-label={t("Timestamp format")}
              >
                <SelectValue>{t(TIMESTAMP_FORMAT_LABELS[settings.timestampFormat])}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="locale">
                  {t(TIMESTAMP_FORMAT_LABELS.locale)}
                </SelectItem>
                <SelectItem hideIndicator value="12-hour">
                  {t(TIMESTAMP_FORMAT_LABELS["12-hour"])}
                </SelectItem>
                <SelectItem hideIndicator value="24-hour">
                  {t(TIMESTAMP_FORMAT_LABELS["24-hour"])}
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
export function ChatSettingsPanel() {
  const { t } = useTranslation();
  const modifierLabel = isMacPlatform(navigator.platform) ? "⌘" : "Ctrl";
  const sendShortcutOptions = [
    { value: "enter", label: "Enter" },
    {
      value: "mod-enter-multiline",
      label: t("{modifier} + Enter for multiline prompts", { modifier: modifierLabel }),
    },
    { value: "mod-enter", label: t("{modifier} + Enter always", { modifier: modifierLabel }) },
  ] as const;
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsPageContainer>
      <SettingsSection id="composer" title={t("Composer")}>
        <SettingsRow
          {...searchableSetting("composer-rich-text")}
          description={t("Show formatted Markdown as you type.")}
          resetAction={
            settings.composerRichTextEnabled !==
            DEFAULT_UNIFIED_SETTINGS.composerRichTextEnabled ? (
              <SettingResetButton
                label={t("rich text composer")}
                onClick={() =>
                  updateSettings({
                    composerRichTextEnabled: DEFAULT_UNIFIED_SETTINGS.composerRichTextEnabled,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.composerRichTextEnabled}
              onCheckedChange={(checked) =>
                updateSettings({ composerRichTextEnabled: Boolean(checked) })
              }
              aria-label={t("Rich text composer")}
            />
          }
        />
        <SettingsRow
          {...searchableSetting("send-shortcut")}
          description={t("Choose when Enter sends a prompt or inserts a new line")}
          resetAction={
            settings.sendShortcut !== DEFAULT_UNIFIED_SETTINGS.sendShortcut ? (
              <SettingResetButton
                label={t("send shortcut")}
                onClick={() =>
                  updateSettings({ sendShortcut: DEFAULT_UNIFIED_SETTINGS.sendShortcut })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.sendShortcut}
              onValueChange={(value) => {
                const option = sendShortcutOptions.find((option) => option.value === value);
                if (option) updateSettings({ sendShortcut: option.value });
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-auto min-w-0 max-w-full"
                aria-label={t("Send shortcut")}
              >
                <SelectValue>
                  {
                    sendShortcutOptions.find((option) => option.value === settings.sendShortcut)
                      ?.label
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {sendShortcutOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    <span className="flex items-center justify-between gap-4">
                      {option.label}
                      {settings.sendShortcut === option.value && <CheckIcon aria-hidden="true" />}
                    </span>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <AdvancedSettings targetIds={[searchableSetting("skills-in-slash-menu").id]}>
          <SettingsRow
            {...searchableSetting("skills-in-slash-menu")}
            description={t(
              "Also include skills in the / command menu. Skills always appear when you type $.",
            )}
            resetAction={
              settings.showSkillsInSlashMenu !== DEFAULT_UNIFIED_SETTINGS.showSkillsInSlashMenu ? (
                <SettingResetButton
                  label={t("skills in slash menu")}
                  onClick={() =>
                    updateSettings({
                      showSkillsInSlashMenu: DEFAULT_UNIFIED_SETTINGS.showSkillsInSlashMenu,
                    })
                  }
                />
              ) : null
            }
            control={
              <Switch
                checked={settings.showSkillsInSlashMenu}
                onCheckedChange={(checked) =>
                  updateSettings({ showSkillsInSlashMenu: Boolean(checked) })
                }
                aria-label={t("Show skills in slash menu")}
              />
            }
          />
        </AdvancedSettings>
      </SettingsSection>

      <SettingsSection id="follow-ups" title={t("Follow-ups")}>
        <SettingsRow
          {...searchableSetting("follow-up-behavior")}
          description={
            "Queue follow-ups while the agent runs or steer the current run. " +
            (settings.sendShortcut === "mod-enter-multiline"
              ? t(
                  "Press {modifier} + Enter for single-line prompts or {multilineModifier} + Shift + Enter for multiline prompts to do the opposite for one message.",
                  { modifier: modifierLabel, multilineModifier: modifierLabel },
                )
              : t("Press {modifier}{shift} + Enter to do the opposite for one message.", {
                  modifier: modifierLabel,
                  shift: settings.sendShortcut === "mod-enter" ? " + Shift" : "",
                }))
          }
          resetAction={
            settings.followUpBehavior !== DEFAULT_UNIFIED_SETTINGS.followUpBehavior ? (
              <SettingResetButton
                label={t("follow-up behavior")}
                onClick={() =>
                  updateSettings({
                    followUpBehavior: DEFAULT_UNIFIED_SETTINGS.followUpBehavior,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.followUpBehavior}
              onValueChange={(value) => {
                if (value === "queue" || value === "steer") {
                  updateSettings({ followUpBehavior: value });
                }
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-auto min-w-0"
                aria-label={t("Follow-up behavior")}
              >
                <SelectValue>
                  {settings.followUpBehavior === "queue" ? "Queue" : t("Steer")}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value="queue">{t("Queue")}</SelectItem>
                <SelectItem value="steer">{t("Steer")}</SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
function DiffColorsSettingsRow() {
  const { t } = useTranslation();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("diff-color-scheme")}
      description={t("Choose colors for additions and deletions, including change counts.")}
      resetAction={
        settings.diffColorScheme !== DEFAULT_UNIFIED_SETTINGS.diffColorScheme ? (
          <SettingResetButton
            label={t("diff colors")}
            onClick={() =>
              updateSettings({ diffColorScheme: DEFAULT_UNIFIED_SETTINGS.diffColorScheme })
            }
          />
        ) : null
      }
      control={
        <div className="w-full sm:w-40">
          <Select
            value={settings.diffColorScheme}
            onValueChange={(value) => {
              if (value === "red-green" || value === "blue-orange")
                updateSettings({ diffColorScheme: value });
            }}
          >
            <SelectTrigger size="sm" className="w-full min-w-0" aria-label={t("Diff colors")}>
              <span
                aria-hidden="true"
                className={
                  settings.diffColorScheme === "blue-orange"
                    ? "flex shrink-0 flex-row-reverse gap-1"
                    : "flex shrink-0 gap-1"
                }
              >
                <span className="size-2 rounded-full bg-diff-deletion" />
                <span className="size-2 rounded-full bg-diff-addition" />
              </span>
              <SelectValue>
                {settings.diffColorScheme === "blue-orange" ? "Blue & orange" : t("Red & green")}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value="red-green">{t("Red & green (default)")}</SelectItem>
              <SelectItem value="blue-orange">{t("Blue & orange")}</SelectItem>
            </SelectPopup>
          </Select>
        </div>
      }
    />
  );
}
export function DiffsSettingsPanel() {
  const { t } = useTranslation();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsPageContainer>
      <SettingsSection id="diffs" title={t("Diffs")}>
        <SettingsRow
          {...searchableSetting("diff-layout")}
          description={t(
            "Show diffs stacked or side by side. The toggle in the diff toolbar changes this too.",
          )}
          resetAction={
            settings.diffLayout !== DEFAULT_UNIFIED_SETTINGS.diffLayout ? (
              <SettingResetButton
                label={t("diff layout")}
                onClick={() => updateSettings({ diffLayout: DEFAULT_UNIFIED_SETTINGS.diffLayout })}
              />
            ) : null
          }
          control={
            <Select
              value={settings.diffLayout}
              onValueChange={(value) => {
                if (value === "stacked" || value === "split") {
                  updateSettings({ diffLayout: value });
                }
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-40" aria-label={t("Diff layout")}>
                <SelectValue>{t(DIFF_LAYOUT_LABELS[settings.diffLayout])}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="stacked">
                  {t(DIFF_LAYOUT_LABELS.stacked)}
                </SelectItem>
                <SelectItem hideIndicator value="split">
                  {t(DIFF_LAYOUT_LABELS.split)}
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          {...searchableSetting("hide-whitespace-changes")}
          description={t("Set whether the diff panel ignores whitespace-only edits by default.")}
          resetAction={
            settings.diffIgnoreWhitespace !== DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace ? (
              <SettingResetButton
                label={t("diff whitespace changes")}
                onClick={() =>
                  updateSettings({
                    diffIgnoreWhitespace: DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.diffIgnoreWhitespace}
              onCheckedChange={(checked) =>
                updateSettings({ diffIgnoreWhitespace: Boolean(checked) })
              }
              aria-label={t("Hide whitespace changes by default")}
            />
          }
        />
        <SettingsRow
          {...searchableSetting("default-diff-file-state")}
          description={t(
            "Start with files expanded or collapsed when opening diffs or a pull request's Code tab.",
          )}
          resetAction={
            settings.diffFilesCollapsed !== DEFAULT_UNIFIED_SETTINGS.diffFilesCollapsed ? (
              <SettingResetButton
                label={t("default diff file state")}
                onClick={() =>
                  updateSettings({
                    diffFilesCollapsed: DEFAULT_UNIFIED_SETTINGS.diffFilesCollapsed,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.diffFilesCollapsed ? "collapsed" : "expanded"}
              onValueChange={(value) => {
                if (value === "expanded" || value === "collapsed") {
                  updateSettings({ diffFilesCollapsed: value === "collapsed" });
                }
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-full sm:w-40"
                aria-label={t("Default diff file state")}
              >
                <SelectValue>
                  {settings.diffFilesCollapsed ? "Collapsed" : t("Expanded")}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="expanded">
                  {t("Expanded")}
                </SelectItem>
                <SelectItem hideIndicator value="collapsed">
                  {t("Collapsed")}
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
        <DiffColorsSettingsRow />
      </SettingsSection>

      <SettingsSection id="pull-requests" title={t("Pull requests")}>
        <SettingsRow
          {...searchableSetting("proactive-panels")}
          description={t(
            "Open linked pull requests first. Otherwise, open Changes for edits to at least 3 files or 50 lines.",
          )}
          resetAction={
            settings.proactivePanelsEnabled !== DEFAULT_UNIFIED_SETTINGS.proactivePanelsEnabled ? (
              <SettingResetButton
                label={t("proactive panels")}
                onClick={() =>
                  updateSettings({
                    proactivePanelsEnabled: DEFAULT_UNIFIED_SETTINGS.proactivePanelsEnabled,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.proactivePanelsEnabled}
              onCheckedChange={(checked) =>
                updateSettings({ proactivePanelsEnabled: Boolean(checked) })
              }
              aria-label={t("Proactive panels")}
            />
          }
        />
        <PullRequestLinksOpenInAppSetting />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
/** The Providers panel can render without a settings scope, as its tests do; this row needs one. */
export function CompactIdleThreadsRow() {
  return useOptionalSettingsScope() === null ? null : <ScopedCompactIdleThreadsRow />;
}
function ScopedCompactIdleThreadsRow() {
  const { t } = useTranslation();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { targets } = useSettingsScope();
  const idleCompaction = scopedIdleCompaction(targets.length > 0 ? targets : [{ settings }]);
  return (
    <SettingsRow
      serverScoped
      settingKeys={["idleCompaction", "compactIdleThreads"]}
      mixed={idleCompaction.mixed}
      {...searchableSetting("compact-idle-threads")}
      description={t(
        "When to compact an idle Claude thread over 200,000 tokens: after you return, just before its prompt cache expires, or never. Each Claude provider can override this.",
      )}
      resetAction={
        globalIdleCompaction(settings) !== globalIdleCompaction(DEFAULT_UNIFIED_SETTINGS) ? (
          <SettingResetButton
            label={t("compact idle threads")}
            onClick={() =>
              updateSettings({ idleCompaction: globalIdleCompaction(DEFAULT_UNIFIED_SETTINGS) })
            }
          />
        ) : null
      }
      control={
        <Select
          value={idleCompaction.mixed ? null : globalIdleCompaction(settings)}
          onValueChange={(value) => {
            const mode = IDLE_COMPACTION_MODES.find((candidate) => candidate.value === value);
            if (mode) updateSettings({ idleCompaction: mode.value });
          }}
        >
          <SelectTrigger
            size="sm"
            className="w-full sm:w-56"
            aria-label={t("Compact idle threads")}
          >
            <SelectValue>
              {(value: string | null) =>
                value === null
                  ? "Mixed"
                  : IDLE_COMPACTION_MODES.find((mode) => mode.value === value)?.label
              }
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {IDLE_COMPACTION_MODES.map((mode) => (
              <SelectItem
                hideIndicator
                key={mode.value}
                value={mode.value}
                // A server from before modes has only the on/off switch, so it cannot store "Never".
                disabled={mode.value === "off" && !idleCompaction.neverAvailable}
              >
                {mode.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
export function ThreadsSettingsPanel() {
  const { t } = useTranslation();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const navigate = useNavigate();
  const { environment, connectedEnvironments, target, scope } = useSettingsScope();
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  const environmentId = environment?.environmentId ?? null;
  const hasServerTargets = connectedEnvironments.length > 0;
  const mixedResponseStreamingMode = useScopedSettingsMixed(["responseStreamingMode"]);
  const providersByEnvironment = useEnvironmentProviders();
  const serverProviders =
    (environment?.serverConfig
      ? providersByEnvironment.get(environment.environmentId)
      : undefined) ?? EMPTY_SERVER_PROVIDERS;
  const supportsAutoSettlementScope = connectedEnvironments.every(
    (target) => target.serverConfig?.environment.capabilities.threadAutoSettlementScope === true,
  );
  const textGenerationProviders = serverProviders.filter(
    (provider) => provider.supportsTextGeneration !== false,
  );
  const textGenerationModelSelection = resolveAppModelSelectionState(
    settings,
    textGenerationProviders,
  );
  const textGenInstanceId = textGenerationModelSelection.instanceId;
  const textGenModel = textGenerationModelSelection.model;
  const textGenModelOptions = textGenerationModelSelection.options;
  const textGenerationModelInstanceEntries = providerInstanceEntriesFor(
    textGenerationProviders,
    settings,
    target?.projectId ?? null,
  );
  const hasTextGenerationProvider = textGenerationModelInstanceEntries.some(
    (entry) => entry.enabled && entry.isAvailable,
  );
  const textGenInstanceEntry = textGenerationModelInstanceEntries.find(
    (entry) => entry.instanceId === textGenInstanceId,
  );
  const textGenProvider: ProviderDriverKind =
    textGenInstanceEntry?.driverKind ?? DEFAULT_DRIVER_KIND;
  const textGenerationModelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    textGenerationProviders,
    textGenInstanceId,
    textGenModel,
  );
  const isTextGenerationModelDirty = !Equal.equals(
    settings.textGenerationModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null,
  );
  const textGenerationModelDisabledReason = useScopedModelDisabledReason(
    settings,
    textGenerationModelInstanceEntries,
  );
  const mixedAddProjectBaseDirectory = useScopedSettingsMixed(["addProjectBaseDirectory"]);
  const mixedTextGenerationModel = useScopedSettingsMixed(["textGenerationModelSelection"]);
  return (
    <SettingsPageContainer>
      <SettingsSection id="new-projects" title={t("New projects")}>
        <SettingsRow
          serverScoped
          settingKeys={["addProjectBaseDirectory"]}
          {...searchableSetting("add-project-starts-in")}
          description={t('Leave empty to use "~/" when the Add Project browser opens.')}
          resetAction={
            settings.addProjectBaseDirectory !==
            DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory ? (
              <SettingResetButton
                label={t("add project base directory")}
                onClick={() =>
                  updateSettings({
                    addProjectBaseDirectory: DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory,
                  })
                }
              />
            ) : null
          }
          control={
            <DraftInput
              size="sm"
              className="w-full sm:w-72"
              value={mixedAddProjectBaseDirectory ? "" : settings.addProjectBaseDirectory}
              onCommit={(next) => updateSettings({ addProjectBaseDirectory: next })}
              placeholder={mixedAddProjectBaseDirectory ? t("Mixed") : "~/"}
              spellCheck={false}
              aria-label={t("Add project base directory")}
            />
          }
        />
        <SettingsRow
          serverScoped
          settingKeys={["ghqCloneLayout"]}
          {...searchableSetting("ghq-clone-layout")}
          description={t("Clone repositories into host/owner/repository folders, like ghq.")}
          resetAction={
            settings.ghqCloneLayout !== DEFAULT_UNIFIED_SETTINGS.ghqCloneLayout ? (
              <SettingResetButton
                label={t("Clone into host folders")}
                onClick={() =>
                  updateSettings({ ghqCloneLayout: DEFAULT_UNIFIED_SETTINGS.ghqCloneLayout })
                }
              />
            ) : null
          }
          control={
            <ScopedSwitch
              settingKeys={["ghqCloneLayout"]}
              checked={settings.ghqCloneLayout}
              onCheckedChange={(checked) => updateSettings({ ghqCloneLayout: Boolean(checked) })}
              aria-label={t("Clone into host folders")}
            />
          }
        />
      </SettingsSection>

      <ProjectDefaultsSettings category="general" />

      {!isProjectScope ? (
        <SettingsSection id="snooze" title={t("Snooze")}>
          <SnoozePresetsRow />
        </SettingsSection>
      ) : null}

      <SettingsSection id="usage-limits" title={t("Usage limits")}>
        <SettingsRow
          serverScoped
          {...searchableSetting("auto-resume-limited-threads")}
          description={t(
            "Resume usage-limit stops at the reported reset time. Each thread can cancel its scheduled continuation.",
          )}
          settingKeys={["autoResumeLimitedThreads"]}
          control={
            <ScopedSwitch
              settingKeys={["autoResumeLimitedThreads"]}
              checked={settings.autoResumeLimitedThreads}
              onCheckedChange={(checked) =>
                updateSettings({ autoResumeLimitedThreads: Boolean(checked) })
              }
              aria-label={t("Resume after usage limits")}
            />
          }
        />
        <SettingsRow
          serverScoped
          {...searchableSetting("snooze-limited-threads")}
          description={t(
            "Snooze usage-limit stops until reset. Pair with resume to continue on wake.",
          )}
          settingKeys={["snoozeLimitedThreads"]}
          control={
            <ScopedSwitch
              settingKeys={["snoozeLimitedThreads"]}
              checked={settings.snoozeLimitedThreads}
              onCheckedChange={(checked) =>
                updateSettings({ snoozeLimitedThreads: Boolean(checked) })
              }
              aria-label={t("Snooze until limits reset")}
            />
          }
        />
      </SettingsSection>

      {hasServerTargets ? (
        <SettingsSection id="auto-settle" title={t("Auto-settle")}>
          <SettingsRow
            serverScoped
            settingKeys={["sidebarAutoSettleOnMerge"]}
            {...searchableSetting("auto-settle-merged-threads")}
            description={t(
              "Settle a thread when its pull request merges. Closed pull requests still settle automatically.",
            )}
            resetAction={
              settings.sidebarAutoSettleOnMerge !==
              DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleOnMerge ? (
                <SettingResetButton
                  label={t("auto-settle on merge")}
                  onClick={() =>
                    updateSettings({
                      sidebarAutoSettleOnMerge: DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleOnMerge,
                    })
                  }
                />
              ) : null
            }
            control={
              <ScopedSwitch
                settingKeys={["sidebarAutoSettleOnMerge"]}
                checked={settings.sidebarAutoSettleOnMerge}
                onCheckedChange={(checked) =>
                  updateSettings({ sidebarAutoSettleOnMerge: Boolean(checked) })
                }
                aria-label={t("Auto-settle merged threads")}
              />
            }
          />

          <SettingsRow
            serverScoped
            settingKeys={["sidebarAutoSettleAfterDays"]}
            {...searchableSetting("auto-settle-inactive-threads")}
            description={t("Sidebar threads with no activity for this long settle automatically.")}
            resetAction={
              settings.sidebarAutoSettleAfterDays !==
              DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleAfterDays ? (
                <SettingResetButton
                  label={t("auto-settle")}
                  onClick={() =>
                    updateSettings({
                      sidebarAutoSettleAfterDays:
                        DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleAfterDays,
                    })
                  }
                />
              ) : null
            }
            control={
              <ScopedSwitch
                settingKeys={["sidebarAutoSettleAfterDays"]}
                checked={settings.sidebarAutoSettleAfterDays !== null}
                onCheckedChange={(checked) =>
                  updateSettings({
                    sidebarAutoSettleAfterDays: checked ? AUTO_SETTLE_DEFAULT_DAYS : null,
                  })
                }
                aria-label={t("Auto-settle inactive threads")}
              />
            }
          />
          {settings.sidebarAutoSettleAfterDays !== null ? (
            <SettingsRow
              serverScoped
              settingKeys={["sidebarAutoSettleAfterDays"]}
              title={searchableSetting("days-before-auto-settle").title}
              description={t("Any new activity un-settles a thread automatically.")}
              control={
                <AutoSettleDaysInput
                  value={settings.sidebarAutoSettleAfterDays}
                  onCommit={(days) => updateSettings({ sidebarAutoSettleAfterDays: days })}
                />
              }
            />
          ) : null}
          {settings.sidebarAutoSettleAfterDays !== null && supportsAutoSettlementScope ? (
            <SettingsRow
              serverScoped
              settingKeys={["sidebarAutoSettleKeepPullRequests"]}
              title={t("Keep threads with a PR")}
              description={t(
                "Inactivity does not settle threads with a pull request. Merge and close still do.",
              )}
              control={
                <ScopedSwitch
                  settingKeys={["sidebarAutoSettleKeepPullRequests"]}
                  checked={settings.sidebarAutoSettleKeepPullRequests}
                  onCheckedChange={(checked) =>
                    updateSettings({ sidebarAutoSettleKeepPullRequests: checked })
                  }
                  aria-label={t("Keep threads with a PR")}
                />
              }
            />
          ) : null}
        </SettingsSection>
      ) : null}

      <SettingsSection id="text-generation" title={t("Text generation")}>
        <SettingsRow
          serverScoped
          settingKeys={["textGenerationModelSelection"]}
          {...searchableSetting("text-generation-model")}
          description={t(
            "Used for thread titles and other generated text on connected devices with this provider. Source control can override it.",
          )}
          resetAction={
            hasServerTargets && isTextGenerationModelDirty ? (
              <SettingResetButton
                label={t("text generation model")}
                onClick={() =>
                  updateSettings({
                    textGenerationModelSelection:
                      DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
                  })
                }
              />
            ) : null
          }
          control={
            !hasServerTargets ? (
              <span className="text-sm text-muted-foreground">
                {t("Connect an environment to choose its text generation model.")}
              </span>
            ) : !hasTextGenerationProvider ? (
              <span className="text-sm text-muted-foreground">
                {t("No text generation providers available.")}
              </span>
            ) : (
              <div className="flex flex-wrap items-center justify-end gap-1.5">
                <ProviderModelPicker
                  environmentId={environmentId}
                  activeInstanceId={textGenInstanceId}
                  model={textGenModel}
                  lockedProvider={null}
                  instanceEntries={textGenerationModelInstanceEntries}
                  modelOptionsByInstance={textGenerationModelOptionsByInstance}
                  triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                  {...(mixedTextGenerationModel ? { triggerLabel: "Mixed" } : {})}
                  getModelDisabledReason={textGenerationModelDisabledReason}
                  {...(environmentId
                    ? {
                        onOpenProviderSetup: (instanceId: ProviderInstanceId) => {
                          void navigate({
                            to: "/settings/providers",
                            search: { environmentId, instanceId },
                          });
                        },
                      }
                    : {})}
                  onInstanceModelChange={(instanceId, model) => {
                    const reason = textGenerationModelDisabledReason(instanceId, model);
                    if (reason) {
                      toastManager.add({
                        type: "error",
                        title: t("Text generation model not saved"),
                        description: reason,
                      });
                      return;
                    }
                    updateSettings({
                      textGenerationModelSelection: resolveAppModelSelectionState(
                        {
                          ...settings,
                          textGenerationModelSelection: createModelSelection(instanceId, model),
                        },
                        textGenerationProviders,
                      ),
                    });
                  }}
                />
                {textGenInstanceEntry ? (
                  <TraitsPicker
                    provider={textGenProvider}
                    models={textGenInstanceEntry?.models ?? []}
                    model={textGenModel}
                    modelOptions={textGenModelOptions}
                    allowPromptInjectedEffort={false}
                    planModeEnabled={
                      settings.planModeEnabled || selectsPlanAgent(textGenModelOptions)
                    }
                    triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                    onModelOptionsChange={(nextOptions) => {
                      updateSettings({
                        textGenerationModelSelection: resolveAppModelSelectionState(
                          {
                            ...settings,
                            textGenerationModelSelection: createModelSelection(
                              textGenInstanceId,
                              textGenModel,
                              nextOptions,
                            ),
                          },
                          textGenerationProviders,
                        ),
                      });
                    }}
                  />
                ) : null}
              </div>
            )
          }
        />
        <AdvancedSettings
          targetIds={[
            searchableSetting("thread-title-instructions").id,
            searchableSetting("response-streaming").id,
          ]}
        >
          <ThreadTitleInstructionsSettings />
          <SettingsRow
            serverScoped
            settingKeys={["responseStreamingMode"]}
            {...searchableSetting("response-streaming")}
            description={
              mixedResponseStreamingMode
                ? t("The selected targets use different streaming modes.")
                : t(RESPONSE_STREAMING_MODE_DESCRIPTIONS[settings.responseStreamingMode])
            }
            resetAction={
              settings.responseStreamingMode !== DEFAULT_UNIFIED_SETTINGS.responseStreamingMode ? (
                <SettingResetButton
                  label={t("response streaming")}
                  onClick={() =>
                    updateSettings({
                      responseStreamingMode: DEFAULT_UNIFIED_SETTINGS.responseStreamingMode,
                    })
                  }
                />
              ) : null
            }
            control={
              <Select
                value={mixedResponseStreamingMode ? null : settings.responseStreamingMode}
                onValueChange={(value) => {
                  if (value === "turn" || value === "paragraph") {
                    updateSettings({ responseStreamingMode: value });
                  }
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-full sm:w-56"
                  aria-label={t("Response streaming")}
                >
                  <SelectValue>
                    {(value: ResponseStreamingMode | null) =>
                      value === null ? "Mixed" : t(RESPONSE_STREAMING_MODE_LABELS[value])
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value="turn">
                    {t(RESPONSE_STREAMING_MODE_LABELS.turn)}
                  </SelectItem>
                  <SelectItem hideIndicator value="paragraph">
                    {t(RESPONSE_STREAMING_MODE_LABELS.paragraph)}
                  </SelectItem>
                </SelectPopup>
              </Select>
            }
          />
        </AdvancedSettings>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
export function MaintenanceSettingsPanel() {
  const { t } = useTranslation();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { scope, environment, connectedEnvironments } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const isEnvironmentScope = scope.environmentIds.length === 1 && environmentId !== null;
  const hasServerTargets = connectedEnvironments.length > 0;
  return (
    <SettingsPageContainer>
      <SettingsSection id="updates" title={t("Updates")}>
        <SettingsRow
          serverScoped
          settingKeys={["enableProviderUpdateChecks"]}
          {...searchableSetting("provider-update-checks")}
          description={t(
            "Check installed provider CLIs for newer available versions and fetch model catalog updates. When off, new models may not appear.",
          )}
          resetAction={
            settings.enableProviderUpdateChecks !==
            DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks ? (
              <SettingResetButton
                label={t("provider update checks")}
                onClick={() =>
                  updateSettings({
                    enableProviderUpdateChecks: DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks,
                  })
                }
              />
            ) : null
          }
          control={
            <ScopedSwitch
              settingKeys={["enableProviderUpdateChecks"]}
              checked={settings.enableProviderUpdateChecks}
              onCheckedChange={(checked) =>
                updateSettings({ enableProviderUpdateChecks: Boolean(checked) })
              }
              aria-label={t("Check provider versions")}
            />
          }
        />
        <SettingsRow
          {...searchableSetting("continue-threads-after-server-update")}
          serverScoped
          settingKeys={["continueThreadsAfterServerUpdate"]}
          description={t(
            "Automatically resume interrupted threads after an update, crash, or machine restart on the selected environments.",
          )}
          status={
            !hasServerTargets
              ? t("All selected connected environments must support restart continuation.")
              : undefined
          }
          resetAction={
            hasServerTargets &&
            settings.continueThreadsAfterServerUpdate !==
              DEFAULT_UNIFIED_SETTINGS.continueThreadsAfterServerUpdate ? (
              <SettingResetButton
                label={t("continue threads after restarts")}
                onClick={() =>
                  updateSettings({
                    continueThreadsAfterServerUpdate:
                      DEFAULT_UNIFIED_SETTINGS.continueThreadsAfterServerUpdate,
                  })
                }
              />
            ) : null
          }
          control={
            <ScopedSwitch
              settingKeys={["continueThreadsAfterServerUpdate"]}
              checked={settings.continueThreadsAfterServerUpdate}
              disabled={!hasServerTargets}
              onCheckedChange={(checked) =>
                updateSettings({ continueThreadsAfterServerUpdate: Boolean(checked) })
              }
              aria-label={t("Continue threads after restarts")}
            />
          }
        />
      </SettingsSection>

      <SettingsSection id="background" title={t("Background activity")}>
        <BackgroundActivitySettingsRow />
      </SettingsSection>

      <StorageCleanupSections />

      <SettingsSection id="diagnostics-section" title={t("Diagnostics")}>
        <SettingsRow
          {...searchableSetting("diagnostics")}
          description={
            isEnvironmentScope
              ? t("Inspect processes, resource use, and logs on this environment.")
              : t("Inspect processes, resource use, and logs on one environment at a time.")
          }
          control={
            <Button
              render={
                <Link to="/settings/diagnostics" search={{ machine: environmentId ?? undefined }} />
              }
              size="sm"
              variant="outline"
            >
              {t("View diagnostics")}
            </Button>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
export function AboutSettingsPanel() {
  const { t: translateUi } = useTranslation();
  return (
    <SettingsPageContainer>
      <SettingsSection id="about" title={translateUi("App")}>
        <SettingsRow
          id={searchableSetting("app-version").id}
          title={<AboutVersionTitle />}
          description={translateUi("Current version of Cox.")}
        />
      </SettingsSection>

      <DesktopBackendUpdates />
      <SettingsSection id="legal" title={translateUi("Legal")}>
        <SettingsRow
          {...searchableSetting("privacy-policy")}
          description={translateUi(
            "Cox keeps your coding workspace on the local server. Provider requests follow the provider account settings.",
          )}
        />
        <SettingsRow
          {...searchableSetting("open-source-licenses")}
          description={translateUi(
            "Notices for dependencies, assets, and optional tools used by Cox.",
          )}
          control={
            <Button
              render={<Link to="/settings/open-source-licenses" />}
              size="sm"
              variant="outline"
            >
              {translateUi("View licenses")}
            </Button>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

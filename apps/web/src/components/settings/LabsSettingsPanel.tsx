import { useTranslation } from "../../i18n";
import { ToolCallVisibility } from "@t3tools/contracts/settings";
import * as Schema from "effect/Schema";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { LegacyFeaturesSection } from "./SettingsPanels";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function LabsSettingsPanel() {
  const { t: translateUi } = useTranslation();
  return (
    <SettingsPageContainer>
      <SettingsSection id="beta" title={translateUi("Beta")}>
        <BoringSidebarRow />
        <BoringSidebarMultilineRow />
        <PromptSuggestionsRow />
        <ToolCallVisibilityRow />
      </SettingsSection>
      <LegacyFeaturesSection />
    </SettingsPageContainer>
  );
}

function PromptSuggestionsRow() {
  const { t } = useTranslation();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("prompt-suggestions-beta")}
      description={t(
        "Show a predicted next message in the empty composer after a Claude or Codex turn. Tab uses it. Each suggestion makes an extra model request. Requires a compatible provider version.",
      )}
      control={
        <Switch
          checked={settings.promptSuggestionsEnabled}
          onCheckedChange={(checked) =>
            updateSettings({ promptSuggestionsEnabled: Boolean(checked) })
          }
          aria-label={t("Suggest next prompt")}
        />
      }
    />
  );
}

const TOOL_CALL_VISIBILITY_LABELS: Record<ToolCallVisibility, string> = {
  showAll: "Show all",
  hideSuccessful: "Hide successful",
  hideAll: "Hide all",
  zen: "Zen",
};
const isToolCallVisibility = Schema.is(ToolCallVisibility);

function ToolCallVisibilityRow() {
  const { t } = useTranslation();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("tool-call-visibility")}
      description={t(
        "Hide tool calls or intermediate messages. Approvals, questions, and errors always remain visible.",
      )}
      control={
        <Select
          value={settings.toolCallVisibility}
          onValueChange={(value) => {
            if (isToolCallVisibility(value)) updateSettings({ toolCallVisibility: value });
          }}
        >
          <SelectTrigger size="sm" aria-label={t("Tool calls in chat")}>
            <SelectValue>{t(TOOL_CALL_VISIBILITY_LABELS[settings.toolCallVisibility])}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {Object.entries(TOOL_CALL_VISIBILITY_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {t(label)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

function BoringSidebarRow() {
  const { t } = useTranslation();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("boring-sidebar")}
      description={t(
        "Group sidebar threads into project folders. Pinned threads stay on top, and Snoozed and Settled stay below the folders.",
      )}
      control={
        <Switch
          checked={settings.boringSidebarEnabled || settings.legacySidebarEnabled}
          // Turning it off also clears the opt-in of the removed legacy sidebar.
          onCheckedChange={(checked) =>
            updateSettings({ boringSidebarEnabled: Boolean(checked), legacySidebarEnabled: false })
          }
          aria-label={t("Boring sidebar (group by project)")}
        />
      }
    />
  );
}

function BoringSidebarMultilineRow() {
  const { t } = useTranslation();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("boring-sidebar-multiline")}
      description={t(
        "In the boring sidebar, show folder threads on two lines: the title, then the branch, pull request, and agent.",
      )}
      control={
        <Switch
          checked={settings.boringSidebarMultilineRows}
          onCheckedChange={(checked) =>
            updateSettings({ boringSidebarMultilineRows: Boolean(checked) })
          }
          aria-label={t("Two-line folder rows")}
        />
      }
    />
  );
}

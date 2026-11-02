import { useTranslation } from "../../i18n";
import { parseLanguagePreference } from "../../i18n/language";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function LanguageSettings() {
  const { t, languagePreference, setLanguagePreference } = useTranslation();
  return (
    <SettingsSection id="language" title={t("Language")}>
      <SettingsRow
        title={t("Interface language")}
        description={t(
          "Choose the interface language. Your messages, code, and agent responses are never translated.",
        )}
        control={
          <select
            aria-label={t("Interface language")}
            className="rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
            value={languagePreference}
            onChange={(event) => setLanguagePreference(parseLanguagePreference(event.target.value))}
          >
            <option value="system">{t("Follow device language")}</option>
            <option value="en">{t("English")}</option>
            <option value="zh">简体中文</option>
          </select>
        }
      />
    </SettingsSection>
  );
}

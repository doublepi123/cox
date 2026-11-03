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
            className="min-h-11 w-full min-w-0 rounded-md border border-input bg-background px-3 py-2 text-base text-foreground sm:min-h-9 sm:text-sm @min-[32rem]/settings-row:w-auto"
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

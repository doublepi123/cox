import { useTranslation } from "../../i18n";
import { usePrimarySessionState } from "../../environments/primary";
import { Button } from "../ui/button";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

export function ConnectionsSettings() {
  const { t } = useTranslation();
  const session = usePrimarySessionState();
  return (
    <SettingsPageContainer>
      <SettingsSection title={t("Local access")}>
        <SettingsRow
          title={t(
            "Cox connects only to the server that serves this page. Local authentication and browser origin checks protect this connection.",
          )}
        />
        <SettingsRow
          title={
            session.error ??
            (session.data?.authenticated
              ? t("This browser is authenticated with the local server.")
              : t("No authenticated local session."))
          }
          control={
            <Button size="sm" variant="outline" onClick={session.refresh}>
              {t("Refresh")}
            </Button>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

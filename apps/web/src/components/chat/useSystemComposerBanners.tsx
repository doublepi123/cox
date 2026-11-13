import type { EnvironmentId } from "@t3tools/contracts";
import type { EnvironmentConnectionPresentation } from "@t3tools/client-runtime/connection";
import type { EnvironmentPresentation } from "../../state/environments";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { environmentCatalog } from "../../connection/catalog";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { useTranslation } from "../../i18n";

export type EnvironmentUnavailableState = {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connection: EnvironmentConnectionPresentation;
};

interface SystemComposerBannersInput {
  readonly activeEnvironment: EnvironmentPresentation | null;
  readonly activeEnvironmentUnavailable: boolean;
  readonly activeEnvironmentUnavailableState: EnvironmentUnavailableState | null;
  readonly activeThreadEnvironmentId: EnvironmentId | null;
  readonly serverConfig: EnvironmentPresentation["serverConfig"] | null;
  readonly hasMultipleRegisteredEnvironments: boolean;
}

export function useSystemComposerBanners(input: SystemComposerBannersInput) {
  const { t } = useTranslation();
  const retry = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });
  const banners: ComposerBannerStackItem[] = [];
  if (input.activeEnvironmentUnavailable && input.activeThreadEnvironmentId) {
    const environmentId = input.activeThreadEnvironmentId;
    const connection =
      input.activeEnvironmentUnavailableState?.connection ?? input.activeEnvironment?.connection;
    if (connection?.phase === "connected") return banners;
    const connecting = connection?.phase === "connecting";
    const reconnecting = connection?.phase === "reconnecting";
    const message = connecting
      ? "Connecting to the server..."
      : reconnecting
        ? "Connection interrupted. Reconnecting automatically..."
        : connection?.phase === "offline"
          ? "Connection paused while the browser reports offline."
          : connection?.phase === "unsupported"
            ? "The client and server are not compatible. Reload or update Cox."
            : "Unable to connect to the server. Check that Cox is running.";
    banners.push({
      id: "local-connection",
      variant: connecting ? "info" : "warning",
      group: "environment",
      icon: null,
      title: (
        <>
          <span>{t(message)}</span>{" "}
          {!connecting && (
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                void retry(environmentId);
              }}
            >
              {t("Reconnect")}
            </Button>
          )}
        </>
      ),
      description: connection?.error ?? undefined,
    });
  }
  return banners;
}

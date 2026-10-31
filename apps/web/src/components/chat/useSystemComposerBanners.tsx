import type { EnvironmentId } from "@t3tools/contracts";
import type { EnvironmentConnectionPresentation } from "@t3tools/client-runtime/connection";
import type { EnvironmentPresentation } from "../../state/environments";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { environmentCatalog } from "../../connection/catalog";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";

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
  const retry = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });
  const banners: ComposerBannerStackItem[] = [];
  if (input.activeEnvironmentUnavailable && input.activeThreadEnvironmentId) {
    const environmentId = input.activeThreadEnvironmentId;
    banners.push({
      id: "local-connection",
      variant: "warning",
      icon: null,
      title: (
        <>
          The local server is unavailable.{" "}
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              void retry(environmentId);
            }}
          >
            Reconnect
          </Button>
        </>
      ),
    });
  }
  return banners;
}

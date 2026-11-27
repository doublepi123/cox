import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AuthFilesystemReadScope, type EnvironmentId } from "@t3tools/contracts";
import { useTranslation } from "~/i18n";

import { resolveAssetUrl } from "~/assets/assetUrls";

import { assetEnvironment } from "~/state/assets";
import { readPreparedConnection, useEnvironmentScope } from "~/state/session";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

import { downloadMedia } from "../media/mediaContent";
import { toastManager } from "../ui/toast";

export function useFileDownload(environmentId: EnvironmentId | null) {
  const { t } = useTranslation();
  const canReadFiles = useEnvironmentScope(environmentId, AuthFilesystemReadScope);
  const createUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  if (!canReadFiles || environmentId === null) return null;
  return (cwd: string, filePath: string | Promise<string>) =>
    void (async () => {
      const path = await filePath;
      const httpBaseUrl = readPreparedConnection(environmentId)?.httpBaseUrl;
      if (!httpBaseUrl) throw new Error(t("Reconnect to the environment and try again."));
      const result = await createUrl({
        environmentId,
        input: { resource: { _tag: "draft-workspace-file", cwd, path, disposition: "attachment" } },
      });
      if (isAtomCommandInterrupted(result)) return;
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      const url = resolveAssetUrl(httpBaseUrl, result.value.relativeUrl);
      if (!url) throw new Error(t("The file could not be loaded. Try again."));
      await downloadMedia(url, path.split(/[\\/]/).at(-1) || path);
    })().catch((cause: unknown) =>
      toastManager.add({
        type: "error",
        title: t("Could not download file"),
        description: cause instanceof Error ? cause.message : t("Please try again."),
      }),
    );
}

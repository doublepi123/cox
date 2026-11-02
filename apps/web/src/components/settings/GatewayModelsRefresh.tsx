import { useRef, useState } from "react";
import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { useTranslation } from "../../i18n";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";

export function GatewayModelsRefresh({
  environmentId,
  instanceId,
  disabled,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly disabled: boolean;
}) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const refresh = useAtomCommand(
    serverEnvironment.refreshProviders,
    t("Refresh models from gateway"),
  );
  const run = async () => {
    if (inFlight.current || disabled) return;
    inFlight.current = true;
    setPending(true);
    await refresh({ environmentId, input: { instanceId, refreshModels: true } }).finally(() => {
      inFlight.current = false;
      setPending(false);
    });
  };
  return (
    <div className="mb-3 space-y-2">
      <Button size="sm" variant="outline" disabled={disabled || pending} onClick={() => void run()}>
        {t(pending ? "Refreshing gateway models…" : "Refresh models from gateway")}
      </Button>
      <p className="text-xs text-muted-foreground">
        {t(
          "Save the API URL and key first. Uses only the model-list endpoint; no paid inference probes. Codex gateways must support the Responses API; Claude gateways must support the Anthropic Messages API.",
        )}
      </p>
    </div>
  );
}

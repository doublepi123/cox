import { SharedTooltipTrigger } from "../ui/shared-tooltip";
import { useTranslation } from "../../i18n";
import type { ServerProcessSignal } from "@t3tools/contracts";

import { InlineButton } from "../ui/button";

export function ProcessSignalActions({
  disabled,
  onSignal,
}: {
  disabled: boolean;
  onSignal: (signal: ServerProcessSignal) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-end gap-1.5">
      <SharedTooltipTrigger
        render={
          <InlineButton
            disabled={disabled}
            aria-label={t("Send SIGINT")}
            tone="muted"
            onClick={() => onSignal("SIGINT")}
          >
            INT
          </InlineButton>
        }
        side="top"
        label={t("Send SIGINT")}
      />
      <SharedTooltipTrigger
        render={
          <InlineButton
            disabled={disabled}
            aria-label={t("Send SIGKILL")}
            tone="destructive"
            onClick={() => onSignal("SIGKILL")}
          >
            KILL
          </InlineButton>
        }
        side="top"
        label={t("Send SIGKILL")}
      />
    </div>
  );
}

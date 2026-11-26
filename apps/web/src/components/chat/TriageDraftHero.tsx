import { SharedTooltipTrigger } from "../ui/shared-tooltip";
import { useTranslation } from "../../i18n";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { TRIAGE_CLI_COMMAND } from "~/hooks/useStartTriage";

import { InlineButton } from "../ui/button";

/**
 * The empty-draft hero for a triage session, in place of "What should we work on?".
 * Keeps the regular hero's heading-plus-one-line rhythm above the composer.
 */
export function TriageDraftHero(props: {
  readonly machineLabel: string | null;
  readonly serverVersion: string | null;
}) {
  const { t } = useTranslation();
  const { copyToClipboard, isCopied } = useCopyToClipboard({ timeout: 1500, target: "command" });
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col items-center">
      <h1 className="w-full text-center font-normal text-2xl text-foreground tracking-tight sm:text-3xl">
        {t("What went wrong?")}
      </h1>
      <p className="mt-2 flex h-6 w-full items-center justify-center gap-1.5 text-sm">
        <SharedTooltipTrigger
          render={<span tabIndex={0} className="min-w-0 truncate font-medium text-foreground" />}
          side="bottom"
          label={
            <>
              {t(
                "The agent reads Cox's logs and source here, and asks before it applies a fix or posts anything.",
              )}
            </>
          }
        >
          {props.machineLabel ?? "This machine"}
          {props.serverVersion === null ? null : (
            <span className="ml-1.5 font-normal text-muted-foreground">v{props.serverVersion}</span>
          )}
        </SharedTooltipTrigger>
        <span aria-hidden className="text-muted-foreground">
          ·
        </span>
        <SharedTooltipTrigger
          render={
            <InlineButton
              tone="muted"
              interactive
              onClick={() => copyToClipboard(TRIAGE_CLI_COMMAND, undefined)}
            />
          }
          side="bottom"
          label={t("Copy command, for a terminal")}
        >
          {isCopied ? t("Copied") : "or run"}
          {isCopied ? null : <code className="ml-1 font-mono text-xs">{TRIAGE_CLI_COMMAND}</code>}
        </SharedTooltipTrigger>
      </p>
    </div>
  );
}

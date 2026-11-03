import type { EnvironmentId, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import { useRef, useState } from "react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { useTranslation } from "../../i18n";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { SettingsRow } from "./settingsLayout";

export function ClaudeSetupSection(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider | undefined;
  readonly enabled: boolean;
  readonly readOnly: boolean;
  readonly onEnable: () => void;
}) {
  const { t } = useTranslation();
  if (props.readOnly)
    return <SettingsRow title="Claude Code" description={t("Provider setup is read-only.")} />;
  if (!props.provider?.setup)
    return <SettingsRow title="Claude Code" description={t("Preparing Claude Code setup…")} />;
  return (
    <ClaudeSetupActions
      key={`${props.environmentId}:${props.instanceId}`}
      {...props}
      provider={props.provider}
    />
  );
}

function ClaudeSetupActions({
  environmentId,
  instanceId,
  provider,
  enabled,
  onEnable,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider;
  readonly enabled: boolean;
  readonly onEnable: () => void;
}) {
  const { t } = useTranslation();
  const target = { environmentId, input: { instanceId } };
  const query = useEnvironmentQuery(serverEnvironment.providerInstallState(target));
  const installation = query.data;
  const commands = { reportFailure: false, reportDefect: false };
  const start = useAtomCommand(serverEnvironment.startProviderInstall, commands);
  const cancel = useAtomCommand(serverEnvironment.cancelProviderInstall, commands);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const installing =
    installation?.phase === "downloading" ||
    installation?.phase === "extracting" ||
    installation?.phase === "verifying";
  const installed = provider.installed || installation?.installedVersion != null;
  const retry = installation?.phase === "failed" || installation?.phase === "cancelled";
  const canUpdate =
    installation?.source === "managed" && provider.versionAdvisory?.status === "behind_latest";
  const version = installation?.installedVersion ?? provider.version;
  async function run(command: () => Promise<AtomCommandResult<unknown, unknown>>) {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await command();
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setError(
          failure instanceof Error ? failure.message : t("Provider setup failed. Try again."),
        );
      }
    } catch {
      setError(t("Provider setup failed. Try again."));
    }
    pendingRef.current = false;
    setPending(false);
  }
  return (
    <section aria-label={t("Claude Code setup")} className="divide-y divide-border/50 text-xs">
      <SettingsRow
        title={t("Claude Code CLI")}
        description={
          <span role="status">
            {installing
              ? t(
                  installation?.phase === "verifying"
                    ? "Checking the downloaded runtime."
                    : "Installing Claude Code…",
                )
              : installed
                ? t("Claude Code {version} is installed.", { version: version ?? "" })
                : t("Install the official Claude Code CLI.")}
          </span>
        }
        status={
          error || query.error || installation?.phase === "failed" ? (
            <p role="alert" className="[overflow-wrap:anywhere]">
              {error ??
                (query.error
                  ? t("Provider setup failed. Try again.")
                  : t(installation?.message ?? "Provider setup failed. Try again."))}
            </p>
          ) : undefined
        }
        control={
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            {!enabled ? (
              <Button
                size="sm"
                variant="outline"
                disabled={pending || installing}
                onClick={onEnable}
              >
                {t("Enable Claude Code")}
              </Button>
            ) : null}
            {installing && installation?.operationId ? (
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() =>
                  void run(() =>
                    cancel({
                      environmentId,
                      input: { instanceId, operationId: installation.operationId! },
                    }),
                  )
                }
              >
                {t("Cancel installation")}
              </Button>
            ) : provider.setup?.canInstall && (!installed || retry || canUpdate) ? (
              <Button
                size="sm"
                variant="outline"
                disabled={pending || query.error !== null}
                onClick={() => void run(() => start(target))}
              >
                {t(
                  retry
                    ? "Retry installation"
                    : installed
                      ? "Update Claude Code"
                      : "Install Claude Code",
                )}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost-muted"
              render={
                <a href="https://code.claude.com/docs/en/setup" target="_blank" rel="noreferrer" />
              }
            >
              {t("Open docs")}
            </Button>
          </div>
        }
      >
        <p className="text-muted-foreground [overflow-wrap:anywhere]">
          {t(
            provider.setup?.canInstall === false
              ? "Uses the custom Claude Code binary path below."
              : installation?.source === "local"
                ? "Using your existing Claude Code CLI."
                : "Cox installs Claude Code in its own tools directory.",
          )}
        </p>
        {installation?.executablePath ? (
          <p className="select-all break-all font-mono text-muted-foreground">
            {installation.executablePath}
          </p>
        ) : null}
      </SettingsRow>
      <SettingsRow
        title={t("Claude Code credentials")}
        description={t(
          "Use a model service or API key below. For subscription sign-in, run the executable shown above with auth login using the same configuration directory.",
        )}
      />
    </section>
  );
}

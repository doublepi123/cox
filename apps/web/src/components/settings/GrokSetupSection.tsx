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
import { ProviderAuthenticationSection } from "./ProviderAuthenticationSection";
import { SettingsRow } from "./settingsLayout";

export function GrokSetupSection(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider | undefined;
  readonly enabled: boolean;
  readonly readOnly: boolean;
  readonly onEnable: () => void;
}) {
  const { t } = useTranslation();
  if (props.readOnly)
    return <SettingsRow title="Grok Build" description={t("Provider setup is read-only.")} />;
  if (!props.provider?.setup)
    return <SettingsRow title="Grok Build" description={t("Preparing Grok setup…")} />;
  return (
    <GrokSetupActions
      key={`${props.environmentId}:${props.instanceId}`}
      {...props}
      provider={props.provider}
    />
  );
}

function GrokSetupActions({
  environmentId,
  environmentLabel,
  instanceId,
  provider,
  enabled,
  onEnable,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider;
  readonly enabled: boolean;
  readonly onEnable: () => void;
}) {
  const { t } = useTranslation();
  const target = { environmentId, input: { instanceId } };
  const installationQuery = useEnvironmentQuery(serverEnvironment.providerInstallState(target));
  const authQuery = useEnvironmentQuery(serverEnvironment.providerAuthState(target));
  const installation = installationQuery.data;
  const auth = authQuery.data;
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
  const authenticating =
    auth?.phase === "starting" || auth?.phase === "waiting" || auth?.phase === "verifying";
  const installed = provider.installed || installation?.installedVersion != null;
  const retryInstallation = installation?.phase === "failed" || installation?.phase === "cancelled";
  const canUpdate =
    installation?.source === "managed" && provider.versionAdvisory?.status === "behind_latest";
  const version = provider.version ?? installation?.installedVersion;
  const description = installing
    ? installation?.phase === "verifying"
      ? t("Checking the downloaded runtime.")
      : t("Installing Grok…")
    : installed
      ? t("Grok {version} is installed.", { version: version ?? "" })
      : t("Install the official Grok CLI to use Grok Build.");
  const queryError = installationQuery.error ?? authQuery.error;
  const disabled = pending || queryError !== null || authenticating;
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
    <section aria-label={t("Grok Build setup")} className="divide-y divide-border/50 text-xs">
      <SettingsRow
        title={t("Grok CLI")}
        description={<span role="status">{description}</span>}
        status={
          error || queryError || installation?.phase === "failed" ? (
            <p role="alert" className="[overflow-wrap:anywhere]">
              {error ??
                (queryError
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
                disabled={pending || installing || authenticating}
                onClick={onEnable}
              >
                {t("Enable Grok")}
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
            ) : provider.setup?.canInstall && (!installed || retryInstallation || canUpdate) ? (
              <Button
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() => void run(() => start(target))}
              >
                {t(
                  retryInstallation
                    ? "Retry installation"
                    : installed
                      ? "Update Grok"
                      : "Install Grok",
                )}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost-muted"
              render={
                <a href="https://docs.x.ai/build/overview" target="_blank" rel="noreferrer" />
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
              ? "Uses the custom Grok binary path below."
              : installation?.source === "local"
                ? "Using your existing Grok CLI."
                : "Cox installs Grok in its own tools directory.",
          )}
        </p>
        {installation?.executablePath ? (
          <p className="select-all break-all font-mono text-muted-foreground">
            {installation.executablePath}
          </p>
        ) : null}
      </SettingsRow>
      {provider.setup?.canAuthenticate ? (
        <ProviderAuthenticationSection
          environmentId={environmentId}
          environmentLabel={environmentLabel}
          instanceId={instanceId}
          provider={{ ...provider, enabled, installed }}
          readOnly={installing || pending}
        />
      ) : (
        <SettingsRow
          title={t("Grok account")}
          description={t(
            "This instance uses XAI_API_KEY. Remove it from the provider environment to sign in with a Grok account.",
          )}
        />
      )}
    </section>
  );
}

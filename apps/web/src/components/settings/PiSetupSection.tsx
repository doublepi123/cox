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

export function PiSetupSection(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider | undefined;
  readonly enabled: boolean;
  readonly readOnly: boolean;
  readonly onEnable: () => void;
  readonly runtime?: "pi" | "omo";
}) {
  const { t } = useTranslation();
  const title = props.runtime === "omo" ? "OMO Native" : "Pi";
  if (props.readOnly)
    return <SettingsRow title={title} description={t("Provider setup is read-only.")} />;
  if (!props.provider?.setup)
    return (
      <SettingsRow
        title={title}
        description={t(props.runtime === "omo" ? "Preparing OMO setup…" : "Preparing Pi setup…")}
      />
    );
  return (
    <PiSetupActions
      key={`${props.environmentId}:${props.instanceId}`}
      {...props}
      provider={props.provider}
    />
  );
}

export function OmoSetupSection(props: Parameters<typeof PiSetupSection>[0]) {
  return <PiSetupSection {...props} runtime="omo" />;
}

function PiSetupActions({
  environmentId,
  instanceId,
  provider,
  enabled,
  onEnable,
  runtime = "pi",
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider;
  readonly enabled: boolean;
  readonly onEnable: () => void;
  readonly runtime?: "pi" | "omo";
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
    <section
      aria-label={t(runtime === "omo" ? "OMO setup" : "Pi setup")}
      className="divide-y divide-border/50 text-xs"
    >
      <SettingsRow
        title={runtime === "omo" ? "OMO Native" : t("Pi CLI")}
        description={
          <span role="status">
            {installing
              ? t(
                  installation?.phase === "verifying"
                    ? "Checking the downloaded runtime."
                    : runtime === "omo"
                      ? "Installing OMO Native…"
                      : "Installing Pi…",
                )
              : installed
                ? t(
                    runtime === "omo"
                      ? "OMO Native {version} is installed."
                      : "Pi {version} is installed.",
                    { version: version ?? "" },
                  )
                : t(
                    runtime === "omo"
                      ? "Install the tested OMO Native runtime (omo-ai 5.1.69)."
                      : "Install the official Pi coding agent.",
                  )}
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
                {t(runtime === "omo" ? "Enable OMO Native" : "Enable Pi")}
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
                      ? runtime === "omo"
                        ? "Update OMO Native"
                        : "Update Pi"
                      : runtime === "omo"
                        ? "Install OMO Native"
                        : "Install Pi",
                )}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost-muted"
              render={
                <a
                  href={
                    runtime === "omo"
                      ? "https://github.com/doublepi123/cox#omo-native"
                      : "https://pi.dev"
                  }
                  target="_blank"
                  rel="noreferrer"
                />
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
              ? runtime === "omo"
                ? "Uses the custom OMO binary path below."
                : "Uses the custom Pi binary path below."
              : installation?.source === "local"
                ? runtime === "omo"
                  ? "Using your existing OMO CLI."
                  : "Using your existing Pi CLI."
                : runtime === "omo"
                  ? "Cox installs OMO Native in its own tools directory."
                  : "Cox installs Pi in its own tools directory.",
          )}
        </p>
        {installation?.executablePath ? (
          <p className="select-all break-all font-mono text-muted-foreground">
            {installation.executablePath}
          </p>
        ) : null}
      </SettingsRow>
      <SettingsRow
        title={t(runtime === "omo" ? "OMO model access" : "Pi credentials")}
        description={t(
          runtime === "omo"
            ? "Bind a model service above, or configure independent OMO credentials below. Installing does not start an agent turn."
            : "Configure a model provider and API key below, or keep using your existing Pi login. To sign in with a subscription, run /login in Pi using the same configuration directory.",
        )}
      />
    </section>
  );
}

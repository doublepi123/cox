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

const SETUP_COPY = {
  pi: {
    title: "Pi",
    preparing: "Preparing Pi setup…",
    region: "Pi setup",
    runtime: "Pi CLI",
    installing: "Installing Pi…",
    installed: "Pi {version} is installed.",
    description: "Install the official Pi coding agent.",
    enable: "Enable Pi",
    update: "Update Pi",
    install: "Install Pi",
    docs: "https://pi.dev",
    custom: "Uses the custom Pi binary path below.",
    local: "Using your existing Pi CLI.",
    managed: "Cox installs Pi in its own tools directory.",
    credentials: "Pi credentials",
    access:
      "Configure a model provider and API key below, or keep using your existing Pi login. To sign in with a subscription, run /login in Pi using the same configuration directory.",
  },
  omo: {
    title: "OMO Native",
    preparing: "Preparing OMO setup…",
    region: "OMO setup",
    runtime: "OMO Native",
    installing: "Installing OMO Native…",
    installed: "OMO Native {version} is installed.",
    description: "Install the tested OMO Native runtime (omo-ai 5.1.69 or newer).",
    enable: "Enable OMO Native",
    update: "Update OMO Native",
    install: "Install OMO Native",
    docs: "https://github.com/doublepi123/cox#omo-native",
    custom: "Uses the custom OMO binary path below.",
    local: "Using your existing OMO CLI.",
    managed: "Cox installs OMO Native in its own tools directory.",
    credentials: "OMO model access",
    access:
      "Bind a model service above, or configure independent OMO credentials below. Installing does not start an agent turn.",
  },
  omp: {
    title: "Oh My Pi",
    preparing: "Preparing Oh My Pi setup…",
    region: "Oh My Pi setup",
    runtime: "Oh My Pi",
    installing: "Installing Oh My Pi…",
    installed: "Oh My Pi {version} is installed.",
    description: "Install Oh My Pi and its required Bun runtime in Cox's tools directory.",
    enable: "Enable Oh My Pi",
    update: "Update Oh My Pi",
    install: "Install Oh My Pi",
    docs: "https://omp.sh",
    custom: "Uses the custom omp binary path below.",
    local: "Using your existing omp CLI.",
    managed: "Cox installs Oh My Pi and Bun in its own tools directory.",
    credentials: "Oh My Pi model access",
    access:
      "Bind a model service above, or configure independent Oh My Pi credentials below. Installing does not start an agent turn.",
  },
  dsh: {
    title: "DeepSeek Harness",
    preparing: "Preparing DeepSeek Harness setup…",
    region: "DeepSeek Harness setup",
    runtime: "DeepSeek Harness",
    installing: "Installing DeepSeek Harness…",
    installed: "DeepSeek Harness {version} is installed.",
    description:
      "Install DeepSeek Harness with the dsh-acp-plus bridge for plans, commands, modes, forks and forms.",
    enable: "Enable DeepSeek Harness",
    update: "Update DeepSeek Harness",
    install: "Install DeepSeek Harness",
    docs: "https://github.com/deepseek-ai/deepseek-harness",
    custom: "Uses the custom DeepSeek Harness runtime below.",
    local: "Using your existing DeepSeek Harness.",
    managed: "Cox installs DeepSeek Harness and its ACP bridge in its own tools directory.",
    credentials: "DeepSeek Harness model access",
    access:
      "Set DEEPSEEK_API_KEY below, or keep the models and keys saved in your DeepSeek Harness home. Installing does not start an agent turn.",
  },
} as const;

export function PiSetupSection(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider | undefined;
  readonly enabled: boolean;
  readonly readOnly: boolean;
  readonly onEnable: () => void;
  readonly runtime?: keyof typeof SETUP_COPY;
}) {
  const { t } = useTranslation();
  const copy = SETUP_COPY[props.runtime ?? "pi"];
  if (props.readOnly)
    return <SettingsRow title={copy.title} description={t("Provider setup is read-only.")} />;
  if (!props.provider?.setup)
    return <SettingsRow title={copy.title} description={t(copy.preparing)} />;
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
  readonly runtime?: keyof typeof SETUP_COPY;
}) {
  const { t } = useTranslation();
  const copy = SETUP_COPY[runtime];
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
    <section aria-label={t(copy.region)} className="divide-y divide-border/50 text-xs">
      <SettingsRow
        title={t(copy.runtime)}
        description={
          <span role="status">
            {installing
              ? t(
                  installation?.phase === "verifying"
                    ? "Checking the downloaded runtime."
                    : copy.installing,
                )
              : installed
                ? t(copy.installed, { version: version ?? "" })
                : t(copy.description)}
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
                {t(copy.enable)}
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
                {t(retry ? "Retry installation" : installed ? copy.update : copy.install)}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost-muted"
              render={<a href={copy.docs} target="_blank" rel="noreferrer" />}
            >
              {t("Open docs")}
            </Button>
          </div>
        }
      >
        <p className="text-muted-foreground [overflow-wrap:anywhere]">
          {t(
            provider.setup?.canInstall === false
              ? copy.custom
              : installation?.source === "local"
                ? copy.local
                : copy.managed,
          )}
        </p>
        {installation?.executablePath ? (
          <p className="select-all break-all font-mono text-muted-foreground">
            {installation.executablePath}
          </p>
        ) : null}
      </SettingsRow>
      <SettingsRow title={t(copy.credentials)} description={t(copy.access)} />
    </section>
  );
}

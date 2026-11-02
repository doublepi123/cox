import { useTranslation } from "../../i18n";
import { ProviderAuthenticationSection } from "./ProviderAuthenticationSection";
import { AuthProvidersManageScope } from "@t3tools/contracts";
import { useEnvironmentScope } from "../../state/session";

import type { EnvironmentId, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";

import { CheckIcon, ChevronRightIcon } from "lucide-react";
import { Children, useState, type ReactNode } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

import { Button } from "../ui/button";
import { ChatGptConnectionButton } from "./ChatGptConnectionButton";

import { Input } from "../ui/input";
import { OpenAI } from "../Icons";
import { RedactedSensitiveText } from "./RedactedSensitiveText";
import { SettingsRow } from "./settingsLayout";
import { AddCodexAccountDialog } from "./AddCodexAccountDialog";
import { getOnboardingProviderState } from "../../onboarding/providerReadiness.logic";
import { getProviderSummary } from "./providerStatus";

const noop = () => undefined;
interface CodexSetupSectionProps {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider | undefined;
  readonly mode: "managed" | "existing";
  readonly enabled: boolean;
  readonly readOnly?: boolean;
  readonly presentation?: "settings" | "onboarding";
  readonly onModeChange: (mode: "managed" | "existing") => void;
  readonly autoStart?: boolean;
  readonly displayName?: string | undefined;
  readonly onAutoStartConsumed?: () => void;
  readonly onSignInCancelled?: (() => void) | undefined;
}
export function CodexSetupSection(props: CodexSetupSectionProps) {
  const { t, language } = useTranslation();
  const [requested, setRequested] = useState(false);
  const existingState = getOnboardingProviderState(props.provider);
  const existingReady = props.enabled && existingState === "ready";
  const existingAuthenticated = props.provider?.auth.status === "authenticated";
  const existingChecking = existingState === "checking";
  const existingSummary = getProviderSummary(props.provider, language);
  const content =
    props.mode === "existing" && props.presentation === "onboarding" ? (
      <CodexWelcomeCard
        title={props.displayName || props.provider?.displayName || "Codex"}
        description={
          existingReady ? (
            props.provider?.auth.email?.trim() ? (
              <>
                {t("Signed in as")}{" "}
                <RedactedSensitiveText
                  value={props.provider.auth.email.trim()}
                  ariaLabel={t("Toggle account email visibility")}
                  revealTooltip="Click to reveal email"
                  hideTooltip="Click to hide email"
                  className="break-all"
                />
                .
              </>
            ) : (
              t("Connected with your Codex CLI.")
            )
          ) : existingChecking ? (
            t("Checking your Codex CLI...")
          ) : props.provider?.installed ? (
            existingSummary.headline
          ) : (
            t("Code with your ChatGPT subscription.")
          )
        }
        control={
          existingReady ? (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success-foreground">
              <CheckIcon className="size-3.5" />
              {t("Ready")}
            </span>
          ) : existingChecking ? (
            <span className="text-xs text-muted-foreground">{t("Checking...")}</span>
          ) : existingAuthenticated ? (
            <span className="text-xs text-muted-foreground">{existingSummary.headline}</span>
          ) : (
            <ChatGptConnectionButton
              size="sm"
              disabled={props.readOnly}
              onClick={() => {
                setRequested(true);
                props.onModeChange("managed");
              }}
            >
              {t("Continue with ChatGPT")}
            </ChatGptConnectionButton>
          )
        }
        secondaryControl={
          !existingAuthenticated && !existingReady && !existingChecking ? (
            <Button size="sm" variant="ghost-muted" onClick={() => props.onModeChange("existing")}>
              {t("Use existing CLI")}
            </Button>
          ) : null
        }
      />
    ) : props.mode === "existing" ? null : !props.provider?.setup?.canAuthenticate ? (
      props.presentation === "onboarding" ? (
        <CodexWelcomeCard
          title={props.displayName || props.provider?.displayName || "Codex"}
          description={<CodexSignInDescription />}
          control={
            <Button size="sm" variant="outline" className="min-w-44" disabled>
              {t("Open sign-in page")}
            </Button>
          }
          secondaryControl={
            <Button size="sm" variant="ghost-muted" disabled>
              {t("Cancel")}
            </Button>
          }
        />
      ) : (
        <SettingsRow title={t("ChatGPT account")} description={t("Preparing sign-in.")} />
      )
    ) : (
      <ManagedCodexSetup
        key={`${props.environmentId}:${props.instanceId}`}
        {...props}
        autoStart={requested || props.autoStart === true}
        onAutoStartConsumed={() => {
          setRequested(false);
          props.onAutoStartConsumed?.();
        }}
      />
    );
  return content;
}
export function AddManagedCodexAccountDialog({
  environmentId,
  onClose,
  onAccountCreated,
}: {
  readonly environmentId: EnvironmentId;
  readonly onClose: () => void;
  readonly onAccountCreated?:
    | ((instanceId: ProviderInstanceId, displayName: string) => void)
    | undefined;
}) {
  const canManageProviders = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  return (
    <AddCodexAccountDialog
      environmentId={environmentId}
      onClose={onClose}
      onAccountCreated={onAccountCreated}
      renderSetup={(instanceId, provider) => (
        <ManagedCodexSetup
          key={instanceId}
          environmentId={environmentId}
          instanceId={instanceId}
          provider={provider}
          mode="managed"
          enabled
          readOnly={!canManageProviders}
          autoStart
          onAutoStartConsumed={noop}
          onModeChange={noop}
          onSignInCancelled={onClose}
          allowExistingCli={false}
        />
      )}
    />
  );
}
function ManagedCodexSetup({
  environmentId,
  instanceId,
  provider,
  readOnly,
  onModeChange,
  allowExistingCli = true,
}: CodexSetupSectionProps & {
  readonly autoStart: boolean;
  readonly onAutoStartConsumed: () => void;
  readonly allowExistingCli?: boolean;
}) {
  const { t } = useTranslation();
  const target = { environmentId, input: { instanceId } };
  const installation = useEnvironmentQuery(serverEnvironment.providerInstallState(target));
  const startInstall = useAtomCommand(serverEnvironment.startProviderInstall, "install Codex");
  const cancelInstall = useAtomCommand(
    serverEnvironment.cancelProviderInstall,
    "cancel Codex installation",
  );
  const refresh = useAtomCommand(serverEnvironment.refreshProviders, "refresh Codex");
  const [pending, setPending] = useState(false);
  const state = installation.data;
  const installing =
    state?.phase === "downloading" || state?.phase === "extracting" || state?.phase === "verifying";
  const installed = state?.installedVersion != null || provider?.installed === true;
  const install = async () => {
    setPending(true);
    const result = await startInstall(target);
    if (result._tag === "Success") await refresh(target);
    setPending(false);
  };
  return (
    <section className="space-y-2">
      <SettingsRow
        title={t("Codex runtime")}
        description={t(
          state?.message ??
            (installed
              ? "Codex is installed on this computer."
              : "Cox downloads and manages the local Codex CLI."),
        )}
        control={
          <div className="flex flex-wrap gap-2">
            {!installed && (
              <Button
                size="sm"
                disabled={readOnly || pending || installing || !provider?.setup?.canInstall}
                onClick={() => void install()}
              >
                {t(installing || pending ? "Installing…" : "Install Codex")}
              </Button>
            )}
            {installing && state?.operationId && (
              <Button
                size="sm"
                variant="outline"
                disabled={readOnly}
                onClick={() =>
                  void cancelInstall({
                    environmentId,
                    input: { instanceId, operationId: state.operationId! },
                  })
                }
              >
                {t("Cancel")}
              </Button>
            )}
            {allowExistingCli && (
              <Button
                size="sm"
                variant="ghost"
                disabled={readOnly || installing}
                onClick={() => onModeChange("existing")}
              >
                {t("Use existing CLI")}
              </Button>
            )}
          </div>
        }
      />
      {installed && provider && (
        <ProviderAuthenticationSection
          environmentId={environmentId}
          environmentLabel="this computer"
          instanceId={instanceId}
          provider={provider}
          readOnly={readOnly === true}
        />
      )}
      {installation.error && (
        <p role="alert" className="px-3 text-sm text-destructive">
          {t("Could not read local Codex installation status.")}
        </p>
      )}
    </section>
  );
}
export function CodexManagedRuntimeFields({
  environmentId,
  instanceId,
  provider,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider | undefined;
}) {
  const { t } = useTranslation();
  const installation = useEnvironmentQuery(
    serverEnvironment.providerInstallState({
      environmentId,
      input: { instanceId },
    }),
  );
  const executablePath = installation.data?.executablePath ?? "";
  return (
    <>
      <SettingsRow
        title={t("Binary path")}
        description={t("Selected by Cox.")}
        control={
          <div className="w-full sm:w-80">
            <Input
              aria-label={t("Codex binary path")}
              value={executablePath}
              title={executablePath}
              placeholder={installation.error ? "Could not read runtime path" : t("Not installed")}
              disabled
            />
          </div>
        }
      />
      <SettingsRow
        title={t("CODEX_HOME path")}
        description={t("Shared Codex config, sessions, and state.")}
        control={
          <div className="w-full sm:w-80">
            <Input
              aria-label={t("Codex home path")}
              value={provider?.runtimePaths?.homePath ?? ""}
              title={provider?.runtimePaths?.homePath}
              placeholder={t("Unavailable")}
              disabled
            />
          </div>
        }
      />
      <SettingsRow
        title={t("Shadow home path")}
        description={
          provider?.runtimePaths?.shadowHomePath
            ? "Account-specific home sharing the Codex state above."
            : "This instance uses the shared Codex home directly."
        }
        control={
          <div className="w-full sm:w-80">
            <Input
              aria-label={t("Codex shadow home path")}
              value={provider?.runtimePaths?.shadowHomePath ?? ""}
              title={provider?.runtimePaths?.shadowHomePath ?? undefined}
              placeholder={provider?.runtimePaths ? "Not used" : t("Unavailable")}
              disabled
            />
          </div>
        }
      />
    </>
  );
}
function CodexSignInDescription({
  label = "Complete sign-in in your browser.",
  expanded = false,
  controls,
  onToggle,
}: {
  readonly label?: string;
  readonly expanded?: boolean;
  readonly controls?: string;
  readonly onToggle?: () => void;
}) {
  const { t: translateUi } = useTranslation();
  if (!onToggle) return <div className="leading-relaxed">{label}</div>;
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1.5 rounded-sm text-left leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      aria-label={translateUi("Having trouble signing in?")}
      aria-expanded={expanded}
      aria-controls={controls}
      onClick={onToggle}
    >
      {label}
      <ChevronRightIcon aria-hidden className={`size-3 shrink-0 ${expanded ? "rotate-90" : ""}`} />
    </button>
  );
}
function CodexWelcomeCard({
  title,
  description,
  control,
  secondaryControl,
  children,
}: {
  readonly title: string;
  readonly description: ReactNode;
  readonly control?: ReactNode;
  readonly secondaryControl?: ReactNode;
  readonly children?: ReactNode;
}) {
  const footer = Children.toArray(children);
  return (
    <div className="rounded-lg border border-border bg-background px-4 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <OpenAI className="size-5 shrink-0 fill-foreground" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium">{title}</h3>
          <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</div>
        </div>
        {control || secondaryControl ? (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 has-[button]:w-full has-[button]:flex-col-reverse has-[button]:items-end sm:has-[button]:w-auto sm:has-[button]:flex-row sm:has-[button]:items-center">
            {secondaryControl}
            {control}
          </div>
        ) : null}
      </div>
      {footer.length > 0 ? (
        <div className="ml-8 mt-2 flex flex-wrap items-center gap-2">{footer}</div>
      ) : null}
    </div>
  );
}

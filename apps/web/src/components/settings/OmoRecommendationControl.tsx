import {
  MAX_OMO_RECOMMENDATION_PROMPT_LENGTH,
  type EnvironmentId,
  type ModelServiceBinding,
  type ModelServiceRecommendOmoModelsResult,
} from "@t3tools/contracts";
import { DEFAULT_OMO_RECOMMENDATION_PROMPT } from "@t3tools/shared/omoRecommendations";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "../../i18n";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { LoaderCircleIcon } from "lucide-react";
import { ExpandableText } from "./ExpandableText";
import { Textarea } from "../ui/textarea";

export function OmoOfficialRecommendations({
  dirty,
  disabled,
  onApply,
}: {
  readonly dirty: boolean;
  readonly disabled: boolean;
  readonly onApply: () => readonly string[];
}) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const [unmatched, setUnmatched] = useState<readonly string[] | undefined>(undefined);
  const apply = () => {
    setConfirming(false);
    setUnmatched(onApply());
  };
  return (
    <div className="min-w-0 space-y-2">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => {
            if (dirty) setConfirming(true);
            else apply();
          }}
        >
          {t("Apply official recommendations")}
        </Button>
        <p className="min-w-0 flex-1 basis-60 text-xs text-muted-foreground">
          {t(
            "Fills each role with OMO's official model for this service. Free and offline; nothing is saved until you apply OMO models.",
          )}
        </p>
      </div>
      {confirming && !disabled ? (
        <div className="space-y-2 rounded-md border border-border p-3">
          <p className="text-xs">
            {t(
              "Official recommendations will replace the model and thinking strength of every role that has a match. Saved settings stay unchanged until you apply.",
            )}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={apply}>
              {t("Replace with official recommendations")}
            </Button>
            <Button size="sm" variant="ghost-muted" onClick={() => setConfirming(false)}>
              {t("Keep current draft")}
            </Button>
          </div>
        </div>
      ) : null}
      {unmatched ? (
        <p aria-live="polite" className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {unmatched.length > 0
            ? t(
                "Official recommendations added to the draft. Left unchanged, no official match in this service: {roles}",
                {
                  roles: unmatched.join(", "),
                },
              )
            : t("Official recommendations added to the draft.")}
        </p>
      ) : null}
    </div>
  );
}

export function OmoRecommendationControl({
  environmentId,
  binding,
  revision,
  models,
  agents,
  categories,
  draftKey,
  configurationVersion,
  prompt,
  onPromptChange,
  readOnly,
  onGenerated,
  onBusyChange,
  dirty,
  saving,
  serviceEnabled,
  serviceName,
}: {
  readonly environmentId: EnvironmentId;
  readonly binding: ModelServiceBinding;
  readonly revision: number;
  readonly models: readonly { readonly slug: string; readonly name: string }[];
  readonly agents: readonly string[];
  readonly categories: readonly string[];
  readonly draftKey: string;
  readonly configurationVersion: string;
  readonly prompt: string;
  readonly onPromptChange: (prompt: string) => void;
  readonly readOnly: boolean;
  readonly onBusyChange: (busy: boolean) => void;
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly serviceEnabled: boolean;
  readonly serviceName: string | undefined;
  readonly onGenerated: (result: ModelServiceRecommendOmoModelsResult) => void;
}) {
  const { t } = useTranslation();
  const generate = useAtomCommand(serverEnvironment.recommendOmoModels, { reportFailure: false });
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [generatedDraft, setGeneratedDraft] = useState("");
  const scope = JSON.stringify([
    environmentId,
    binding,
    revision,
    models,
    [...agents].sort(),
    [...categories].sort(),
    serviceEnabled,
    configurationVersion,
    prompt,
  ]);
  const context = JSON.stringify([scope, draftKey, readOnly]);
  const [messageScope, setMessageScope] = useState("");
  const hasMessage = Boolean(message) && messageScope === scope;
  const latest = useRef(context);
  useLayoutEffect(() => {
    latest.current = context;
  }, [context]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    onBusyChange(busy);
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);
  const model = models.some((candidate) => candidate.slug === selected)
    ? selected
    : (models.find((candidate) => candidate.slug === `cox/${binding.defaultModel}`)?.slug ??
      models[0]?.slug ??
      "");
  const blocked = readOnly || saving || busy || !model || !serviceEnabled;
  const run = async () => {
    setConfirmation("");
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await generate({
        environmentId,
        input: {
          serviceId: binding.serviceId,
          revision,
          modelId: model.slice(4),
          binding,
          agents: [...agents],
          categories: [...categories],
          prompt: prompt.trim() ? prompt : DEFAULT_OMO_RECOMMENDATION_PROMPT,
        },
      });
      if (mounted.current && latest.current !== context) {
        setError(
          t("The configuration changed during generation. Generate again for the current draft."),
        );
      } else if (mounted.current && result._tag !== "Success") {
        const failure = squashAtomCommandFailure(result);
        setError(
          failure instanceof Error
            ? failure.message
            : t("Recommendation generation failed. Try again."),
        );
      } else if (mounted.current && result._tag === "Success") {
        onGenerated(result.value);
        setMessage(result.value.explanation);
        setMessageScope(scope);
        setGeneratedDraft(
          JSON.stringify([
            result.value.agentModels,
            result.value.categoryModels,
            result.value.agentReasoning,
            result.value.categoryReasoning,
          ]),
        );
      }
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error
            ? cause.message
            : t("Recommendation generation failed. Try again."),
        );
    }
    if (mounted.current) setBusy(false);
  };
  return (
    <div
      className="@container min-w-0 space-y-3 rounded-lg border border-border/60 bg-muted/10 p-3"
      aria-busy={busy}
    >
      <div className="space-y-1">
        <p className="text-sm font-medium">{t("AI recommendation")}</p>
        <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {t("Assign only from {count} available models in {service}.", {
            count: models.length,
            service: serviceName ?? binding.serviceId,
          })}
        </p>
      </div>
      <label className="grid gap-1.5 text-sm">
        <span>{t("Recommendation model")}</span>
        <select
          className="min-h-11 w-full rounded-md border border-input bg-background px-2"
          value={model}
          disabled={readOnly || saving || busy || models.length === 0 || !serviceEnabled}
          onChange={(event) => setSelected(event.target.value)}
        >
          {models.map((candidate) => (
            <option key={candidate.slug} value={candidate.slug}>
              {candidate.name}
            </option>
          ))}
        </select>
      </label>
      <p className="text-xs text-muted-foreground">
        {t(
          "Use this model to recommend agent and category assignments from the current model service. This sends a model request and may incur usage costs. Review and edit the draft before applying.",
        )}
      </p>
      <label className="grid gap-1.5 text-sm">
        <span>{t("Recommendation prompt")}</span>
        <Textarea
          value={prompt}
          rows={8}
          maxLength={MAX_OMO_RECOMMENDATION_PROMPT_LENGTH}
          disabled={readOnly || saving}
          onChange={(event) => onPromptChange(event.target.value)}
          onBlur={() => {
            if (!prompt.trim()) onPromptChange(DEFAULT_OMO_RECOMMENDATION_PROMPT);
          }}
        />
      </label>
      <p className="text-xs text-muted-foreground">
        {t(
          "Customize how models are assigned to roles. Save with Apply OMO models. Clear the prompt to restore the default. Available models, role descriptions and the required output format are added automatically.",
        )}
      </p>
      {!serviceEnabled ? (
        <p className="text-xs text-muted-foreground">
          {t("This model service is disabled. Enable it before generating recommendations.")}
        </p>
      ) : !models.length ? (
        <p className="text-xs text-muted-foreground">
          {t("This binding has no available models. Select models first.")}
        </p>
      ) : null}
      <Button
        size="sm"
        variant="outline"
        disabled={blocked}
        onClick={() => {
          if (dirty || hasMessage) setConfirmation(context);
          else void run();
        }}
      >
        {busy ? <LoaderCircleIcon aria-hidden className="size-4 animate-spin" /> : null}
        {busy ? t("Generating recommendations…") : t("Generate recommendation draft")}
      </Button>
      {confirmation === context && !blocked ? (
        <div className="space-y-2 rounded-md border border-border p-3">
          <p className="text-xs">
            {t(
              "Generating will replace all agent and category assignments in the current draft. Saved settings stay unchanged until you apply.",
            )}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={() => {
                void run();
              }}
            >
              {t("Generate and replace current draft")}
            </Button>
            <Button size="sm" variant="ghost-muted" onClick={() => setConfirmation("")}>
              {t("Keep current draft")}
            </Button>
          </div>
        </div>
      ) : null}
      {busy ? (
        <p role="status" className="text-xs text-muted-foreground">
          {t(
            "Generating may take a while. You can still edit the draft below; edits will be kept.",
          )}
        </p>
      ) : null}
      {hasMessage ? (
        <div className="min-w-0 space-y-1">
          <p role="status" className="text-xs font-medium">
            {dirty
              ? generatedDraft === draftKey
                ? t("AI recommendation draft · not saved")
                : t("Recommendation draft edited · not saved")
              : t("Recommendation generated")}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("Original recommendation explanation")}
          </p>
          <ExpandableText
            text={message}
            className="text-xs text-muted-foreground [overflow-wrap:anywhere]"
            expandLabel={t("Show recommendation explanation")}
          />
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive [overflow-wrap:anywhere]">
          {error}
        </p>
      ) : null}
    </div>
  );
}

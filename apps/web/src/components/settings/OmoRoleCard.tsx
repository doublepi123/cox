import type { OmoReasoningLevel } from "@t3tools/contracts";
import type { OmoOfficialAssignment, OmoRoleInfo } from "@t3tools/shared/omoRoles";
import { ChevronRightIcon } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "../../i18n";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";

export type OmoRoleModel = {
  readonly slug: string;
  readonly name: string;
  readonly reasoningLevels?: ReadonlyArray<OmoReasoningLevel>;
};

export type OmoLegacyRole = {
  readonly name: string;
  readonly summary: string;
  readonly error: string | undefined;
};

const selectClassName =
  "min-h-11 w-full min-w-0 max-w-full truncate rounded-md border border-input bg-background px-2";

export function OmoRoleCard({
  id,
  role,
  info,
  slug,
  level,
  levels,
  models,
  managed,
  readOnly,
  inheritedModel,
  official,
  onModelChange,
  onReasoningChange,
  onUseOfficial,
}: {
  readonly id: string;
  readonly role: string;
  readonly info: OmoRoleInfo | undefined;
  readonly slug: string;
  readonly level: string;
  readonly levels: ReadonlyArray<OmoReasoningLevel>;
  readonly models: readonly OmoRoleModel[];
  readonly managed: boolean;
  readonly readOnly: boolean;
  readonly inheritedModel: string | undefined;
  readonly official: OmoOfficialAssignment | undefined;
  readonly onModelChange: (selected: string) => void;
  readonly onReasoningChange: (selected: string) => void;
  readonly onUseOfficial: () => void;
}) {
  const { t } = useTranslation();
  const [adviceOpen, setAdviceOpen] = useState(false);
  const unavailable = managed && Boolean(slug) && !models.some((model) => model.slug === slug);
  const unsupported = Boolean(level) && !levels.some((candidate) => candidate === level);
  const officialName = official
    ? (models.find((model) => model.slug === official.model)?.name ?? official.model)
    : "";
  const officialDiffers =
    official !== undefined && (slug !== official.model || level !== official.reasoning);
  return (
    <div
      role="group"
      aria-labelledby={info ? `${id}-title ${id}-role` : `${id}-role`}
      className="@container grid min-w-0 gap-3 rounded-lg border border-border bg-muted/40 p-3 text-sm"
    >
      <div className="grid min-w-0 gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {info ? (
            <span id={`${id}-title`} className="font-medium text-foreground">
              {t(info.title)}
            </span>
          ) : null}
          <span
            id={`${id}-role`}
            className={
              info
                ? "min-w-0 text-xs text-muted-foreground [overflow-wrap:anywhere]"
                : "min-w-0 font-medium text-foreground [overflow-wrap:anywhere]"
            }
          >
            {role}
          </span>
          {info?.usage === "frequent" ? <Badge variant="secondary">{t("Runs often")}</Badge> : null}
        </div>
        {info ? <p className="text-xs text-muted-foreground">{t(info.summary)}</p> : null}
        {info ? (
          <Collapsible open={adviceOpen} onOpenChange={setAdviceOpen}>
            <CollapsibleTrigger variant="omo-roles">
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <ChevronRightIcon
                  aria-hidden
                  className={`size-3.5 shrink-0 transition-transform motion-reduce:transition-none ${adviceOpen ? "rotate-90" : ""}`}
                />
                {t("Model advice")}
              </span>
            </CollapsibleTrigger>
            <CollapsiblePanel>
              <p className="pb-1 text-xs text-muted-foreground">{t(info.modelGuidance)}</p>
            </CollapsiblePanel>
          </Collapsible>
        ) : null}
      </div>
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-start gap-3 @min-[36rem]:grid-cols-[minmax(0,1fr)_minmax(0,12rem)]">
        <div className="grid min-w-0 gap-1.5">
          <label htmlFor={id} className="text-xs text-muted-foreground">
            {t("Model")}
          </label>
          {managed ? (
            <select
              id={id}
              aria-label={role}
              className={selectClassName}
              aria-invalid={unavailable || undefined}
              aria-describedby={unavailable ? `${id}-error` : undefined}
              value={slug}
              onChange={(event) => onModelChange(event.target.value)}
            >
              <option value="">
                {inheritedModel
                  ? t("Inherit main model ({model})", { model: inheritedModel })
                  : t("Inherit main model")}
              </option>
              {unavailable ? (
                <option value={slug} disabled>
                  {t("Unavailable model: {model}", { model: slug })}
                </option>
              ) : null}
              {models.map((model) => (
                <option key={model.slug} value={model.slug}>
                  {model.name}
                </option>
              ))}
            </select>
          ) : (
            <label htmlFor={id} className="flex min-h-11 min-w-0 items-center">
              <Input
                size="lg"
                id={id}
                aria-label={role}
                value={slug}
                placeholder={t("Inherit main model")}
                onChange={(event) => onModelChange(event.target.value)}
              />
            </label>
          )}
          {unavailable ? (
            <span
              id={`${id}-error`}
              className="block text-xs text-destructive [overflow-wrap:anywhere]"
            >
              {t("Unavailable model: {model}", { model: slug })}
            </span>
          ) : null}
        </div>
        <div className="grid min-w-0 gap-1.5">
          <label htmlFor={`${id}-reasoning`} className="text-xs text-muted-foreground">
            {t("Thinking strength")}
          </label>
          <select
            id={`${id}-reasoning`}
            aria-label={t("{role} thinking strength", { role })}
            className={selectClassName}
            aria-invalid={unsupported || undefined}
            aria-describedby={unsupported ? `${id}-reasoning-error` : undefined}
            value={level}
            disabled={levels.length === 0 && !level}
            onChange={(event) => onReasoningChange(event.target.value)}
          >
            <option value="">{t("Default thinking strength")}</option>
            {unsupported ? (
              <option value={level} disabled>
                {t("Unavailable thinking strength: {level}", { level })}
              </option>
            ) : null}
            {levels.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
          {unsupported ? (
            <span
              id={`${id}-reasoning-error`}
              className="text-xs text-destructive [overflow-wrap:anywhere]"
            >
              {t("This thinking strength is not supported by the selected model.")}
            </span>
          ) : null}
        </div>
      </div>
      {managed && info ? (
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="min-w-0 [overflow-wrap:anywhere]">
            {official
              ? official.reasoning
                ? t("Recommended: {model} · {level}", {
                    model: officialName,
                    level: official.reasoning,
                  })
                : t("Recommended: {model}", { model: officialName })
              : t("No official match in this service")}
          </span>
          {officialDiffers && !readOnly ? (
            <Button
              size="sm"
              variant="outline"
              aria-label={t("Use recommended model for {role}", { role })}
              onClick={onUseOfficial}
            >
              {t("Use")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function OmoLegacyRoles({
  roles,
  readOnly,
  onRemove,
}: {
  readonly roles: readonly OmoLegacyRole[];
  readonly readOnly: boolean;
  readonly onRemove: (name: string) => void;
}) {
  const { t } = useTranslation();
  const headingId = useId();
  return (
    <div
      role="group"
      aria-labelledby={headingId}
      className="min-w-0 space-y-2 border-b border-border/60 pb-3"
    >
      <p id={headingId} className="text-sm font-medium text-muted-foreground">
        {t("Not used by OMO Native")}
      </p>
      <p className="text-xs text-muted-foreground">
        {t(
          "OMO Native has no agents with these names, so these settings have no effect. Remove them when you no longer need them.",
        )}
      </p>
      <ul className="grid min-w-0 gap-2">
        {roles.map((role) => (
          <li
            key={role.name}
            className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg border border-border/60 px-3 py-2 text-sm"
          >
            <div className="grid min-w-0 flex-1 gap-0.5">
              <span className="text-muted-foreground [overflow-wrap:anywhere]">{role.name}</span>
              <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                {role.summary}
              </span>
              {role.error ? (
                <span className="text-xs text-destructive [overflow-wrap:anywhere]">
                  {role.error}
                </span>
              ) : null}
            </div>
            {!readOnly ? (
              <Button
                size="sm"
                variant="ghost-muted"
                aria-label={t("Remove {name}", { name: role.name })}
                onClick={() => onRemove(role.name)}
              >
                {t("Remove")}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

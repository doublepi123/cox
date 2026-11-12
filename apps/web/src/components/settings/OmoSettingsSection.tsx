import {
  OMO_REASONING_LEVELS,
  type OmoReasoningLevel,
  type ModelServiceModel,
  type EnvironmentId,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import { OmoRoleName } from "@t3tools/provider-omo/settings";
import {
  DEFAULT_OMO_RECOMMENDATION_PROMPT,
  omoModelReasoningLevels,
} from "@t3tools/shared/omoRecommendations";
import * as Schema from "effect/Schema";
import { useId, useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import { useTranslation } from "../../i18n";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow } from "./settingsLayout";
import { OmoRecommendationControl } from "./OmoRecommendationControl";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";

const AGENTS = [
  "sisyphus",
  "hephaestus",
  "oracle",
  "librarian",
  "explore",
  "prometheus",
  "metis",
  "momus",
  "atlas",
  "multimodal-looker",
];
const CATEGORIES = [
  "visual-engineering",
  "ultrabrain",
  "deep",
  "artistry",
  "quick",
  "unspecified-low",
  "unspecified-high",
  "writing",
];
const isOmoRoleName = Schema.is(OmoRoleName);
type RoleModel = {
  readonly slug: string;
  readonly name: string;
  readonly reasoningLevels?: ReadonlyArray<OmoReasoningLevel>;
};

function reasoningLevelsForRole(
  models: readonly RoleModel[],
  managed: boolean,
  slug: string | undefined,
): ReadonlyArray<OmoReasoningLevel> {
  return managed
    ? (models.find((model) => model.slug === slug)?.reasoningLevels ?? [])
    : OMO_REASONING_LEVELS;
}

function roleModels(config: unknown, key: string): Record<string, string> {
  if (!config || typeof config !== "object") return {};
  const value: unknown = Reflect.get(config, key);
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(
        Object.entries(value).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      )
    : {};
}

function configurationKey(
  instance: ProviderInstanceConfig,
  agents: Record<string, string>,
  categories: Record<string, string>,
  prompt = recommendationPrompt(instance.config),
  agentReasoning = roleModels(instance.config, "agentReasoning"),
  categoryReasoning = roleModels(instance.config, "categoryReasoning"),
) {
  return JSON.stringify([
    instance.modelService ?? null,
    Object.entries(agents).sort(),
    Object.entries(categories).sort(),
    prompt.trim() && prompt !== DEFAULT_OMO_RECOMMENDATION_PROMPT ? prompt : "",
    Object.entries(agentReasoning).sort(),
    Object.entries(categoryReasoning).sort(),
  ]);
}

function recommendationPrompt(config: unknown): string {
  const prompt: unknown =
    config && typeof config === "object" ? Reflect.get(config, "recommendationPrompt") : undefined;
  return typeof prompt === "string" && prompt.trim() ? prompt : DEFAULT_OMO_RECOMMENDATION_PROMPT;
}

function RoleModelFields({
  title,
  defaults,
  value,
  reasoning,
  models,
  managed,
  readOnly,
  onChange,
  onReasoningChange,
  inheritedModel,
  inheritedSlug,
  expandVersion,
}: {
  readonly title: string;
  readonly defaults: readonly string[];
  readonly value: Record<string, string>;
  readonly reasoning: Record<string, string>;
  readonly models: readonly RoleModel[];
  readonly managed: boolean;
  readonly readOnly: boolean;
  readonly onChange: (next: Record<string, string>) => void;
  readonly onReasoningChange: (next: Record<string, string>) => void;
  readonly inheritedModel: string | undefined;
  readonly inheritedSlug: string | undefined;
  readonly expandVersion: number;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [name, setName] = useState("");
  const [search, setSearch] = useState("");
  const roles = [...new Set([...defaults, ...Object.keys(value), ...Object.keys(reasoning)])];
  const invalidCount = roles.filter(
    (role) =>
      (managed && value[role] && !models.some((model) => model.slug === value[role])) ||
      (reasoning[role] &&
        !reasoningLevelsForRole(models, managed, value[role] || inheritedSlug).some(
          (level) => level === reasoning[role],
        )),
  ).length;
  const [disclosure, setDisclosure] = useState({
    open: defaults === AGENTS || Object.keys(value).length > 0 || invalidCount > 0,
    version: expandVersion,
    invalidCount,
  });
  if (disclosure.version !== expandVersion || disclosure.invalidCount !== invalidCount) {
    setDisclosure({
      open: disclosure.open || expandVersion !== disclosure.version || invalidCount > 0,
      version: expandVersion,
      invalidCount,
    });
  }
  const open = disclosure.open;
  const validName = isOmoRoleName(name) && !defaults.includes(name) && !Object.hasOwn(value, name);
  return (
    <div className="min-w-0 border-b border-border/60 pb-3">
      <Collapsible
        open={open}
        onOpenChange={(next) => setDisclosure({ ...disclosure, open: next })}
      >
        <CollapsibleTrigger variant="omo-roles">
          <ChevronRightIcon
            aria-hidden
            className={`size-4 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
          />
          <span className="text-sm font-medium">{title}</span>
          <span className="ml-auto text-xs text-muted-foreground">
            {t("{count} roles · {assigned} assigned", {
              count: roles.length,
              assigned: Object.values(value).filter(Boolean).length,
            })}
          </span>
          {invalidCount > 0 ? (
            <span className="text-xs text-destructive">
              {t("{count} unavailable", { count: invalidCount })}
            </span>
          ) : null}
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <fieldset className="@container min-w-0 space-y-2 pt-2" disabled={readOnly}>
            <legend className="sr-only">{title}</legend>
            <label className="flex min-h-11 min-w-0 items-center">
              <Input
                size="lg"
                aria-label={t("Search {group}", { group: title })}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t("Search roles")}
              />
            </label>
            <div className="grid min-w-0 gap-3">
              <div
                aria-hidden="true"
                className="hidden min-w-0 grid-cols-[minmax(0,10rem)_minmax(0,1fr)_minmax(0,12rem)] gap-3 border border-transparent px-3 py-2 text-xs font-medium text-muted-foreground @min-[36rem]:grid"
              >
                <span>{t("Role")}</span>
                <span>{t("Model")}</span>
                <span>{t("Thinking strength")}</span>
              </div>
              {roles
                .filter((role) => role.toLowerCase().includes(search.toLowerCase()))
                .map((role, index) => {
                  const slug = value[role] ?? "";
                  const unavailable =
                    managed && Boolean(slug) && !models.some((model) => model.slug === slug);
                  const levels = reasoningLevelsForRole(models, managed, slug || inheritedSlug);
                  const level = reasoning[role] ?? "";
                  const unsupported =
                    Boolean(level) && !levels.some((candidate) => candidate === level);
                  return (
                    <div
                      key={role}
                      role="group"
                      aria-labelledby={`${id}-${index}-role`}
                      className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-start gap-3 rounded-lg border border-border bg-muted/40 p-3 text-sm @min-[36rem]:grid-cols-[minmax(0,10rem)_minmax(0,1fr)_minmax(0,12rem)]"
                    >
                      <span
                        id={`${id}-${index}-role`}
                        className="col-span-2 min-w-0 border-b border-border/60 pb-2 font-semibold text-foreground [overflow-wrap:anywhere] @min-[36rem]:col-span-1 @min-[36rem]:border-0 @min-[36rem]:pt-3 @min-[36rem]:pb-0"
                      >
                        {role}
                      </span>
                      <div className="grid min-w-0 gap-1.5">
                        <label
                          htmlFor={`${id}-${index}`}
                          className="text-xs text-muted-foreground @min-[36rem]:sr-only"
                        >
                          {t("Model")}
                        </label>
                        {managed ? (
                          <select
                            id={`${id}-${index}`}
                            aria-label={role}
                            className="min-h-11 w-full min-w-0 max-w-full truncate rounded-md border border-input bg-background px-2"
                            aria-invalid={unavailable || undefined}
                            aria-describedby={unavailable ? `${id}-${index}-error` : undefined}
                            value={slug}
                            onChange={(event) => onChange({ ...value, [role]: event.target.value })}
                          >
                            <option value="">
                              {inheritedModel
                                ? t("Inherit main model ({model})", { model: inheritedModel })
                                : t("Inherit main model")}
                            </option>
                            {slug && !models.some((model) => model.slug === slug) ? (
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
                          <label
                            htmlFor={`${id}-${index}`}
                            className="flex min-h-11 min-w-0 items-center"
                          >
                            <Input
                              size="lg"
                              id={`${id}-${index}`}
                              aria-label={role}
                              value={slug}
                              placeholder={t("Inherit main model")}
                              onChange={(event) =>
                                onChange({ ...value, [role]: event.target.value })
                              }
                            />
                          </label>
                        )}
                        {unavailable ? (
                          <span
                            id={`${id}-${index}-error`}
                            className="block text-xs text-destructive [overflow-wrap:anywhere]"
                          >
                            {t("Unavailable model: {model}", { model: slug })}
                          </span>
                        ) : null}
                      </div>
                      <div className="grid min-w-0 gap-1.5">
                        <label
                          htmlFor={`${id}-${index}-reasoning`}
                          className="text-xs text-muted-foreground @min-[36rem]:sr-only"
                        >
                          {t("Thinking strength")}
                        </label>
                        <select
                          id={`${id}-${index}-reasoning`}
                          aria-label={t("{role} thinking strength", { role })}
                          className="min-h-11 w-full min-w-0 max-w-full truncate rounded-md border border-input bg-background px-2"
                          aria-invalid={unsupported || undefined}
                          aria-describedby={
                            unsupported ? `${id}-${index}-reasoning-error` : undefined
                          }
                          value={level}
                          disabled={levels.length === 0 && !level}
                          onChange={(event) =>
                            onReasoningChange({ ...reasoning, [role]: event.target.value })
                          }
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
                            id={`${id}-${index}-reasoning-error`}
                            className="text-xs text-destructive [overflow-wrap:anywhere]"
                          >
                            {t("This thinking strength is not supported by the selected model.")}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
            </div>
            {roles.every((role) => !role.toLowerCase().includes(search.toLowerCase())) ? (
              <p className="text-xs text-muted-foreground">{t("No matching roles")}</p>
            ) : null}
            {!readOnly ? (
              <div className="flex min-w-0 gap-2">
                <label className="flex min-h-11 min-w-0 flex-1 items-center">
                  <Input
                    size="lg"
                    aria-label={t("{group} role name", { group: title })}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder={t("Custom role name")}
                  />
                </label>
                <Button
                  size="xl"
                  variant="outline"
                  disabled={!validName}
                  onClick={() => {
                    onChange({ ...value, [name]: "" });
                    setName("");
                  }}
                >
                  {t("Add role")}
                </Button>
              </div>
            ) : null}
            {name && !validName ? (
              <p role="alert" className="text-xs text-destructive">
                {t(
                  "Use a unique role name starting with a letter, followed by letters, digits, underscores or hyphens (up to 64 characters).",
                )}
              </p>
            ) : null}
          </fieldset>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}

export function OmoSettingsSection({
  instance,
  environmentId,
  serviceRevision,
  serviceName,
  serviceEnabled = true,
  savedInstance = instance,
  onReset,
  onSavingChange,
  models,
  readOnly,
  canSave = true,
  onUpdate,
}: {
  readonly instance: ProviderInstanceConfig;
  readonly environmentId?: EnvironmentId;
  readonly serviceRevision?: number | undefined;
  readonly serviceName?: string | undefined;
  readonly serviceEnabled?: boolean;
  readonly savedInstance?: ProviderInstanceConfig;
  readonly onReset?: () => void;
  readonly onSavingChange?: (saving: boolean) => void;
  readonly models: readonly RoleModel[];
  readonly readOnly: boolean;
  readonly canSave?: boolean;
  readonly onUpdate: (next: ProviderInstanceConfig) => Promise<boolean> | void;
}) {
  const { t } = useTranslation();
  const [agentModels, setAgentModels] = useState(() => roleModels(instance.config, "agentModels"));
  const [categoryModels, setCategoryModels] = useState(() =>
    roleModels(instance.config, "categoryModels"),
  );
  const [prompt, setPrompt] = useState(() => recommendationPrompt(instance.config));
  const [agentReasoning, setAgentReasoning] = useState(() =>
    roleModels(instance.config, "agentReasoning"),
  );
  const [categoryReasoning, setCategoryReasoning] = useState(() =>
    roleModels(instance.config, "categoryReasoning"),
  );
  const managed = instance.modelService !== undefined;
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saved" | "failed">("idle");
  const [conflict, setConflict] = useState(false);
  const [expandVersion, setExpandVersion] = useState(0);
  const sourceKey = configurationKey(
    savedInstance,
    roleModels(savedInstance.config, "agentModels"),
    roleModels(savedInstance.config, "categoryModels"),
  );
  const [baseline, setBaseline] = useState(sourceKey);
  const [source, setSource] = useState(sourceKey);
  const [snapshot, setSnapshot] = useState(savedInstance);
  const currentKey = configurationKey(
    instance,
    agentModels,
    categoryModels,
    prompt,
    agentReasoning,
    categoryReasoning,
  );
  const dirty = currentKey !== baseline;
  if (source !== sourceKey) {
    setSource(sourceKey);
    setSnapshot(savedInstance);
    setBaseline(sourceKey);
    if (dirty && !saving && sourceKey !== currentKey) setConflict(true);
    if (!dirty) {
      setAgentModels(roleModels(savedInstance.config, "agentModels"));
      setCategoryModels(roleModels(savedInstance.config, "categoryModels"));
      setPrompt(recommendationPrompt(savedInstance.config));
      setAgentReasoning(roleModels(savedInstance.config, "agentReasoning"));
      setCategoryReasoning(roleModels(savedInstance.config, "categoryReasoning"));
    }
  }
  const independentModel: unknown =
    instance.config && typeof instance.config === "object"
      ? Reflect.get(instance.config, "model")
      : undefined;
  const inheritedModel = managed
    ? instance.modelService?.defaultModel
      ? models.find((model) => model.slug === `cox/${instance.modelService?.defaultModel}`)?.name
      : models[0]?.name
    : typeof independentModel === "string" && independentModel.trim()
      ? independentModel
      : undefined;
  const inheritedSlug = managed
    ? instance.modelService?.defaultModel
      ? models.find((model) => model.slug === `cox/${instance.modelService?.defaultModel}`)?.slug
      : models[0]?.slug
    : undefined;
  const invalid =
    managed &&
    [...Object.values(agentModels), ...Object.values(categoryModels)].some(
      (slug) => slug !== "" && !models.some((model) => model.slug === slug),
    );
  const invalidReasoning = (
    [
      [agentModels, agentReasoning],
      [categoryModels, categoryReasoning],
    ] as const
  ).some(([assignments, reasoning]) =>
    Object.entries(reasoning).some(
      ([role, level]) =>
        level &&
        !reasoningLevelsForRole(models, managed, assignments[role] || inheritedSlug).some(
          (candidate) => candidate === level,
        ),
    ),
  );
  return (
    <SettingsRow
      title={t("OMO native roles")}
      description={t(
        "Assign models to native agents and categories. Empty assignments inherit the main model.",
      )}
    >
      <div className="min-w-0 space-y-4">
        {environmentId && instance.modelService && serviceRevision !== undefined ? (
          <OmoRecommendationControl
            environmentId={environmentId}
            binding={instance.modelService}
            revision={serviceRevision}
            models={models}
            agents={[
              ...new Set([...AGENTS, ...Object.keys(agentModels), ...Object.keys(agentReasoning)]),
            ]}
            categories={[
              ...new Set([
                ...CATEGORIES,
                ...Object.keys(categoryModels),
                ...Object.keys(categoryReasoning),
              ]),
            ]}
            draftKey={JSON.stringify([
              agentModels,
              categoryModels,
              agentReasoning,
              categoryReasoning,
            ])}
            configurationVersion={sourceKey}
            prompt={prompt}
            onPromptChange={(next) => {
              setPrompt(next);
              setSaveStatus("idle");
            }}
            readOnly={readOnly}
            serviceName={serviceName}
            serviceEnabled={serviceEnabled}
            dirty={dirty}
            saving={saving}
            onBusyChange={setGenerating}
            onGenerated={(result) => {
              setAgentModels({ ...result.agentModels });
              setCategoryModels({ ...result.categoryModels });
              setAgentReasoning({ ...result.agentReasoning });
              setCategoryReasoning({ ...result.categoryReasoning });
              setExpandVersion((version) => version + 1);
              setSaveStatus("idle");
            }}
          />
        ) : (
          <p className="text-xs text-muted-foreground">
            {t("Bind a model service to use AI recommendations.")}
          </p>
        )}
        {readOnly ? (
          <p className="text-xs text-muted-foreground">{t("These settings are read-only.")}</p>
        ) : null}
        <RoleModelFields
          title={t("Agents")}
          defaults={AGENTS}
          value={agentModels}
          reasoning={agentReasoning}
          models={models}
          managed={managed}
          readOnly={readOnly || saving}
          onChange={(next) => {
            setAgentModels(next);
            setSaveStatus("idle");
          }}
          inheritedModel={inheritedModel}
          inheritedSlug={inheritedSlug}
          onReasoningChange={(next) => {
            setAgentReasoning(next);
            setSaveStatus("idle");
          }}
          expandVersion={expandVersion}
        />
        <RoleModelFields
          title={t("Categories")}
          defaults={CATEGORIES}
          value={categoryModels}
          reasoning={categoryReasoning}
          models={models}
          managed={managed}
          readOnly={readOnly || saving}
          onChange={(next) => {
            setCategoryModels(next);
            setSaveStatus("idle");
          }}
          inheritedModel={inheritedModel}
          inheritedSlug={inheritedSlug}
          onReasoningChange={(next) => {
            setCategoryReasoning(next);
            setSaveStatus("idle");
          }}
          expandVersion={expandVersion}
        />
        {invalid ? (
          <p role="alert" className="text-xs text-destructive">
            {t("Clear or reassign unavailable role models before saving.")}
          </p>
        ) : null}
        {invalidReasoning ? (
          <p role="alert" className="text-xs text-destructive">
            {t("Clear or reassign unsupported thinking strengths before saving.")}
          </p>
        ) : null}
        {!readOnly ? (
          <div className="space-y-3 border-t border-border/60 pt-3" aria-busy={saving}>
            <p role="status" className="text-xs text-muted-foreground">
              {saving
                ? t("Saving configuration…")
                : saveStatus === "saved" && !dirty
                  ? t("Configuration saved")
                  : dirty
                    ? t(
                        "Unapplied changes · service binding, main model, roles and recommendation prompt save together.",
                      )
                    : t(
                        "Service binding, main model, roles and recommendation prompt save together.",
                      )}
            </p>
            {saveStatus === "failed" ? (
              <p role="alert" className="text-xs text-destructive">
                {t("Configuration was not saved. Your draft is preserved.")}
              </p>
            ) : null}
            {conflict ? (
              <div className="space-y-2">
                <p role="alert" className="text-xs text-destructive">
                  {t(
                    "Saved OMO configuration changed elsewhere. Discard to load it, or keep this draft and apply it explicitly.",
                  )}
                </p>
                <Button
                  size="xl"
                  variant="outline"
                  disabled={saving || generating}
                  onClick={() => {
                    setConflict(false);
                    setSaveStatus("idle");
                  }}
                >
                  {t("Keep my draft for review")}
                </Button>
              </div>
            ) : null}
            <div className="flex flex-wrap justify-between gap-2">
              <Button
                size="xl"
                variant="ghost-muted"
                disabled={!dirty || saving || generating}
                onClick={() => {
                  setAgentModels(roleModels(snapshot.config, "agentModels"));
                  setCategoryModels(roleModels(snapshot.config, "categoryModels"));
                  setPrompt(recommendationPrompt(snapshot.config));
                  setAgentReasoning(roleModels(snapshot.config, "agentReasoning"));
                  setCategoryReasoning(roleModels(snapshot.config, "categoryReasoning"));
                  setSaveStatus("idle");
                  setConflict(false);
                  onReset?.();
                }}
              >
                {t("Discard changes")}
              </Button>
              <Button
                size="xl"
                disabled={
                  invalid ||
                  invalidReasoning ||
                  !canSave ||
                  saving ||
                  generating ||
                  !dirty ||
                  conflict
                }
                onClick={async () => {
                  setSaving(true);
                  onSavingChange?.(true);
                  setSaveStatus("idle");
                  const next = {
                    ...instance,
                    config: {
                      ...(instance.config && typeof instance.config === "object"
                        ? instance.config
                        : {}),
                      agentModels,
                      categoryModels,
                      agentReasoning,
                      categoryReasoning,
                      recommendationPrompt:
                        prompt.trim() && prompt !== DEFAULT_OMO_RECOMMENDATION_PROMPT ? prompt : "",
                    },
                  };
                  try {
                    const saved = await onUpdate(next);
                    if (saved === true) {
                      setSnapshot(next);
                      setBaseline(currentKey);
                      setSaveStatus("saved");
                    } else if (saved === false) setSaveStatus("failed");
                  } catch {
                    setSaveStatus("failed");
                  }
                  setSaving(false);
                  onSavingChange?.(false);
                }}
              >
                {saving
                  ? t("Saving configuration…")
                  : saveStatus === "failed"
                    ? t("Retry saving")
                    : t("Apply OMO models")}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </SettingsRow>
  );
}

export function omoBoundRoleModels(models: readonly ModelServiceModel[]) {
  return models
    .filter((model) => model.available !== false)
    .map((model) => ({
      slug: `cox/${model.id}`,
      name: model.name ?? model.id,
      reasoningLevels: omoModelReasoningLevels(model),
    }));
}

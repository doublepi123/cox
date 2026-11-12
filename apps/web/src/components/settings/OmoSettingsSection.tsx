import type {
  ModelServiceModel,
  EnvironmentId,
  ProviderInstanceConfig,
  ServerProviderModel,
} from "@t3tools/contracts";
import { OmoRoleName } from "@t3tools/provider-omo/settings";
import { DEFAULT_OMO_RECOMMENDATION_PROMPT } from "@t3tools/shared/omoRecommendations";
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
) {
  return JSON.stringify([
    instance.modelService ?? null,
    Object.entries(agents).sort(),
    Object.entries(categories).sort(),
    prompt.trim() && prompt !== DEFAULT_OMO_RECOMMENDATION_PROMPT ? prompt : "",
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
  models,
  managed,
  readOnly,
  onChange,
  inheritedModel,
  expandVersion,
}: {
  readonly title: string;
  readonly defaults: readonly string[];
  readonly value: Record<string, string>;
  readonly models: readonly { readonly slug: string; readonly name: string }[];
  readonly managed: boolean;
  readonly readOnly: boolean;
  readonly onChange: (next: Record<string, string>) => void;
  readonly inheritedModel: string | undefined;
  readonly expandVersion: number;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [name, setName] = useState("");
  const [search, setSearch] = useState("");
  const roles = [...new Set([...defaults, ...Object.keys(value)])];
  const invalidCount = managed
    ? Object.values(value).filter((slug) => slug && !models.some((model) => model.slug === slug))
        .length
    : 0;
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
            <Input
              aria-label={t("Search {group}", { group: title })}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("Search roles")}
            />
            {roles
              .filter((role) => role.toLowerCase().includes(search.toLowerCase()))
              .map((role, index) => {
                const slug = value[role] ?? "";
                const unavailable =
                  managed && Boolean(slug) && !models.some((model) => model.slug === slug);
                return (
                  <label
                    key={role}
                    className="grid min-w-0 gap-1.5 text-sm @min-[32rem]:grid-cols-[minmax(0,1fr)_minmax(12rem,55%)] @min-[32rem]:items-center"
                    htmlFor={`${id}-${index}`}
                  >
                    <span className="[overflow-wrap:anywhere]">{role}</span>
                    <span className="min-w-0">
                      {managed ? (
                        <select
                          id={`${id}-${index}`}
                          aria-label={role}
                          className="min-h-11 w-full min-w-0 max-w-full rounded-md border border-input bg-background px-2"
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
                        <Input
                          id={`${id}-${index}`}
                          aria-label={role}
                          value={slug}
                          placeholder={t("Inherit main model")}
                          onChange={(event) => onChange({ ...value, [role]: event.target.value })}
                        />
                      )}
                      {unavailable ? (
                        <span
                          id={`${id}-${index}-error`}
                          className="block text-xs text-destructive [overflow-wrap:anywhere]"
                        >
                          {t("Unavailable model: {model}", { model: slug })}
                        </span>
                      ) : null}
                    </span>
                  </label>
                );
              })}
            {roles.every((role) => !role.toLowerCase().includes(search.toLowerCase())) ? (
              <p className="text-xs text-muted-foreground">{t("No matching roles")}</p>
            ) : null}
            {!readOnly ? (
              <div className="flex gap-2">
                <Input
                  aria-label={t("{group} role name", { group: title })}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={t("Custom role name")}
                />
                <Button
                  size="sm"
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
  readonly models: readonly Pick<ServerProviderModel, "slug" | "name">[];
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
  const currentKey = configurationKey(instance, agentModels, categoryModels, prompt);
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
  const invalid =
    managed &&
    [...Object.values(agentModels), ...Object.values(categoryModels)].some(
      (slug) => slug !== "" && !models.some((model) => model.slug === slug),
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
            agents={[...new Set([...AGENTS, ...Object.keys(agentModels)])]}
            categories={[...new Set([...CATEGORIES, ...Object.keys(categoryModels)])]}
            draftKey={JSON.stringify([agentModels, categoryModels])}
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
          models={models}
          managed={managed}
          readOnly={readOnly || saving}
          onChange={(next) => {
            setAgentModels(next);
            setSaveStatus("idle");
          }}
          inheritedModel={inheritedModel}
          expandVersion={expandVersion}
        />
        <RoleModelFields
          title={t("Categories")}
          defaults={CATEGORIES}
          value={categoryModels}
          models={models}
          managed={managed}
          readOnly={readOnly || saving}
          onChange={(next) => {
            setCategoryModels(next);
            setSaveStatus("idle");
          }}
          inheritedModel={inheritedModel}
          expandVersion={expandVersion}
        />
        {invalid ? (
          <p role="alert" className="text-xs text-destructive">
            {t("Clear or reassign unavailable role models before saving.")}
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
                  size="sm"
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
                size="sm"
                variant="ghost-muted"
                disabled={!dirty || saving || generating}
                onClick={() => {
                  setAgentModels(roleModels(snapshot.config, "agentModels"));
                  setCategoryModels(roleModels(snapshot.config, "categoryModels"));
                  setPrompt(recommendationPrompt(snapshot.config));
                  setSaveStatus("idle");
                  setConflict(false);
                  onReset?.();
                }}
              >
                {t("Discard changes")}
              </Button>
              <Button
                size="sm"
                disabled={invalid || !canSave || saving || generating || !dirty || conflict}
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
    .map((model) => ({ slug: `cox/${model.id}`, name: model.name ?? model.id }));
}

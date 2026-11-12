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
import {
  OMO_LEGACY_AGENT_NAMES,
  OMO_NATIVE_AGENT_ROLES,
  OMO_NATIVE_CATEGORY_ROLES,
  officialOmoAssignment,
  omoRoleInfo,
  type OmoRoleKind,
} from "@t3tools/shared/omoRoles";
import * as Schema from "effect/Schema";
import { useId, useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import { useTranslation } from "../../i18n";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow } from "./settingsLayout";
import { OmoOfficialRecommendations, OmoRecommendationControl } from "./OmoRecommendationControl";
import { OmoLegacyRoles, OmoRoleCard, type OmoRoleModel } from "./OmoRoleCard";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";

const AGENT_ROLES = OMO_NATIVE_AGENT_ROLES.map((role) => role.name);
const CATEGORY_ROLES = OMO_NATIVE_CATEGORY_ROLES.map((role) => role.name);
const isOmoRoleName = Schema.is(OmoRoleName);
type RoleModel = OmoRoleModel;

function categoryAssignments(value: Record<string, string>): Record<string, string> {
  return Object.hasOwn(value, "deep-low")
    ? { ...value, deep: value["deep-low"]! }
    : Object.hasOwn(value, "deep")
      ? { ...value, "deep-low": value.deep! }
      : value;
}

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

function hiddenRoleNames(kind: OmoRoleKind): ReadonlyArray<string> {
  return kind === "agent" ? OMO_LEGACY_AGENT_NAMES : ["deep"];
}

function visibleRoles(
  kind: OmoRoleKind,
  value: Record<string, string>,
  reasoning: Record<string, string>,
): string[] {
  const hidden = hiddenRoleNames(kind);
  return [
    ...new Set([
      ...(kind === "agent" ? AGENT_ROLES : CATEGORY_ROLES),
      ...Object.keys(value),
      ...Object.keys(reasoning),
    ]),
  ].filter((role) => !hidden.includes(role));
}

function updateAssignment(
  kind: OmoRoleKind,
  assignments: Record<string, string>,
  role: string,
  selected: string,
): Record<string, string> {
  const next = { ...assignments, [role]: selected };
  if (kind === "category" && ["deep", "deep-low"].includes(role)) {
    const alias = role === "deep" ? "deep-low" : "deep";
    if (Object.hasOwn(assignments, alias)) next[alias] = selected;
  }
  return next;
}

function legacyRoleNames(
  value: Record<string, string>,
  reasoning: Record<string, string>,
): string[] {
  return OMO_LEGACY_AGENT_NAMES.filter(
    (name) => Object.hasOwn(value, name) || Object.hasOwn(reasoning, name),
  );
}

function withoutRole(assignments: Record<string, string>, role: string): Record<string, string> {
  return Object.fromEntries(Object.entries(assignments).filter(([name]) => name !== role));
}

function RoleModelFields({
  title,
  kind,
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
  readonly kind: OmoRoleKind;
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
  const effectiveValue = kind === "category" ? categoryAssignments(value) : value;
  const effectiveReasoning = kind === "category" ? categoryAssignments(reasoning) : reasoning;
  const roles = visibleRoles(kind, value, reasoning);
  const invalidCount = roles.filter(
    (role) =>
      (managed &&
        effectiveValue[role] &&
        !models.some((model) => model.slug === effectiveValue[role])) ||
      (effectiveReasoning[role] &&
        !reasoningLevelsForRole(models, managed, effectiveValue[role] || inheritedSlug).some(
          (level) => level === effectiveReasoning[role],
        )),
  ).length;
  const [disclosure, setDisclosure] = useState({
    open: kind === "agent" || Object.keys(value).length > 0 || invalidCount > 0,
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
  const query = search.trim().toLowerCase();
  const matchingRoles = roles.filter((role) => {
    const info = omoRoleInfo(kind, role);
    return [role, ...(info ? [t(info.title), t(info.summary)] : [])].some((text) =>
      text.toLowerCase().includes(query),
    );
  });
  const validName =
    isOmoRoleName(name) &&
    !roles.includes(name) &&
    !hiddenRoleNames(kind).includes(name) &&
    !Object.hasOwn(value, name);
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
              assigned: roles.filter((role) => effectiveValue[role]).length,
            })}
          </span>
          {invalidCount > 0 ? (
            <span className="text-xs text-destructive">
              {t("{count} unavailable", { count: invalidCount })}
            </span>
          ) : null}
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <fieldset className="min-w-0 space-y-2 pt-2" disabled={readOnly}>
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
              {matchingRoles.map((role) => {
                const info = omoRoleInfo(kind, role);
                const slug = effectiveValue[role] ?? "";
                const official = managed && info ? officialOmoAssignment(info, models) : undefined;
                return (
                  <OmoRoleCard
                    key={role}
                    id={`${id}-${role}`}
                    role={role}
                    info={info}
                    slug={slug}
                    level={effectiveReasoning[role] ?? ""}
                    levels={reasoningLevelsForRole(models, managed, slug || inheritedSlug)}
                    models={models}
                    managed={managed}
                    readOnly={readOnly}
                    inheritedModel={inheritedModel}
                    official={official}
                    onModelChange={(selected) =>
                      onChange(updateAssignment(kind, value, role, selected))
                    }
                    onReasoningChange={(selected) =>
                      onReasoningChange(updateAssignment(kind, reasoning, role, selected))
                    }
                    onUseOfficial={() => {
                      if (!official) return;
                      onChange(updateAssignment(kind, value, role, official.model));
                      onReasoningChange(
                        updateAssignment(kind, reasoning, role, official.reasoning),
                      );
                    }}
                  />
                );
              })}
            </div>
            {matchingRoles.length === 0 ? (
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
      [categoryAssignments(categoryModels), categoryAssignments(categoryReasoning)],
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
            agents={visibleRoles("agent", agentModels, agentReasoning)}
            categories={[
              ...new Set([
                ...CATEGORY_ROLES,
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
        {managed && !readOnly ? (
          <OmoOfficialRecommendations
            dirty={dirty}
            disabled={saving || generating || models.length === 0}
            onApply={() => {
              const unmatched: string[] = [];
              let nextAgents = agentModels;
              let nextAgentReasoning = agentReasoning;
              let nextCategories = categoryModels;
              let nextCategoryReasoning = categoryReasoning;
              for (const info of [...OMO_NATIVE_AGENT_ROLES, ...OMO_NATIVE_CATEGORY_ROLES]) {
                const official = officialOmoAssignment(info, models);
                if (!official) {
                  unmatched.push(info.name);
                } else if (info.kind === "agent") {
                  nextAgents = updateAssignment("agent", nextAgents, info.name, official.model);
                  nextAgentReasoning = updateAssignment(
                    "agent",
                    nextAgentReasoning,
                    info.name,
                    official.reasoning,
                  );
                } else {
                  nextCategories = updateAssignment(
                    "category",
                    nextCategories,
                    info.name,
                    official.model,
                  );
                  nextCategoryReasoning = updateAssignment(
                    "category",
                    nextCategoryReasoning,
                    info.name,
                    official.reasoning,
                  );
                }
              }
              setAgentModels(nextAgents);
              setAgentReasoning(nextAgentReasoning);
              setCategoryModels(nextCategories);
              setCategoryReasoning(nextCategoryReasoning);
              setExpandVersion((version) => version + 1);
              setSaveStatus("idle");
              return unmatched;
            }}
          />
        ) : null}
        <RoleModelFields
          title={t("Agents")}
          kind="agent"
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
          kind="category"
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
        {legacyRoleNames(agentModels, agentReasoning).length > 0 ? (
          <OmoLegacyRoles
            readOnly={readOnly || saving}
            roles={legacyRoleNames(agentModels, agentReasoning).map((name) => {
              const slug = agentModels[name] ?? "";
              const level = agentReasoning[name] ?? "";
              return {
                name,
                summary: [slug || t("Inherit main model"), level].filter(Boolean).join(" · "),
                error:
                  managed && slug && !models.some((model) => model.slug === slug)
                    ? t("Unavailable model: {model}", { model: slug })
                    : level &&
                        !reasoningLevelsForRole(models, managed, slug || inheritedSlug).some(
                          (candidate) => candidate === level,
                        )
                      ? t("This thinking strength is not supported by the selected model.")
                      : undefined,
              };
            })}
            onRemove={(name) => {
              setAgentModels(withoutRole(agentModels, name));
              setAgentReasoning(withoutRole(agentReasoning, name));
              setSaveStatus("idle");
            }}
          />
        ) : null}
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

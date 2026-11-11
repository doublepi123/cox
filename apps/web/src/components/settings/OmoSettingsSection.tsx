import type {
  ModelServiceModel,
  ProviderInstanceConfig,
  ServerProviderModel,
} from "@t3tools/contracts";
import { OmoRoleName } from "@t3tools/provider-omo/settings";
import * as Schema from "effect/Schema";
import { useId, useState } from "react";
import { useTranslation } from "../../i18n";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow } from "./settingsLayout";

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

function RoleModelFields({
  title,
  defaults,
  value,
  models,
  managed,
  readOnly,
  onChange,
}: {
  readonly title: string;
  readonly defaults: readonly string[];
  readonly value: Record<string, string>;
  readonly models: readonly { readonly slug: string; readonly name: string }[];
  readonly managed: boolean;
  readonly readOnly: boolean;
  readonly onChange: (next: Record<string, string>) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [name, setName] = useState("");
  const validName = isOmoRoleName(name) && !defaults.includes(name) && !Object.hasOwn(value, name);
  return (
    <fieldset className="space-y-2" disabled={readOnly}>
      <legend className="mb-2 text-sm font-medium">{title}</legend>
      {[...new Set([...defaults, ...Object.keys(value)])].map((role, index) => {
        const slug = value[role] ?? "";
        return (
          <label key={role} className="grid gap-1.5 text-sm" htmlFor={`${id}-${index}`}>
            <span>{role}</span>
            {managed ? (
              <select
                id={`${id}-${index}`}
                className="min-h-11 w-full rounded-md border border-input bg-background px-2"
                value={slug}
                onChange={(event) => onChange({ ...value, [role]: event.target.value })}
              >
                <option value="">{t("Inherit main model")}</option>
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
                value={slug}
                placeholder={t("Inherit main model")}
                onChange={(event) => onChange({ ...value, [role]: event.target.value })}
              />
            )}
          </label>
        );
      })}
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
      {name && !validName ? (
        <p role="alert" className="text-xs text-destructive">
          {t(
            "Use a unique role name starting with a letter, followed by letters, digits, underscores or hyphens (up to 64 characters).",
          )}
        </p>
      ) : null}
    </fieldset>
  );
}

export function OmoSettingsSection({
  instance,
  models,
  readOnly,
  canSave = true,
  onUpdate,
}: {
  readonly instance: ProviderInstanceConfig;
  readonly models: readonly Pick<ServerProviderModel, "slug" | "name">[];
  readonly readOnly: boolean;
  readonly canSave?: boolean;
  readonly onUpdate: (next: ProviderInstanceConfig) => void;
}) {
  const { t } = useTranslation();
  const [agentModels, setAgentModels] = useState(() => roleModels(instance.config, "agentModels"));
  const [categoryModels, setCategoryModels] = useState(() =>
    roleModels(instance.config, "categoryModels"),
  );
  const managed = instance.modelService !== undefined;
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
      <div className="space-y-5">
        <RoleModelFields
          title={t("Agents")}
          defaults={AGENTS}
          value={agentModels}
          models={models}
          managed={managed}
          readOnly={readOnly}
          onChange={setAgentModels}
        />
        <RoleModelFields
          title={t("Categories")}
          defaults={CATEGORIES}
          value={categoryModels}
          models={models}
          managed={managed}
          readOnly={readOnly}
          onChange={setCategoryModels}
        />
        {invalid ? (
          <p role="alert" className="text-xs text-destructive">
            {t("Clear or reassign unavailable role models before saving.")}
          </p>
        ) : null}
        {!readOnly ? (
          <Button
            size="sm"
            variant="outline"
            disabled={invalid || !canSave}
            onClick={() =>
              onUpdate({
                ...instance,
                config: {
                  ...(instance.config && typeof instance.config === "object"
                    ? instance.config
                    : {}),
                  agentModels,
                  categoryModels,
                },
              })
            }
          >
            {t("Apply OMO models")}
          </Button>
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

import { useTranslation } from "../../i18n";
import { PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";
import type { ProviderDriverKind, ServerProviderModel } from "@t3tools/contracts";
import type { CustomModelDefinition } from "@t3tools/shared/model";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import {
  DESCRIPTOR_PRESETS_BY_KIND,
  type CustomModelDraft,
  type EditorChoice,
  type EditorDescriptor,
  choiceFromPreset,
  definitionFromDraft,
  descriptorFromPreset,
  descriptorsFromCapabilities,
  draftFromDefinition,
  emptyEditorChoice,
  emptyEditorDescriptor,
  validateDraft,
} from "./customModelEditor.logic";

const CUSTOM_ID_VALUE = "__custom__";
const START_FROM_NONE = "__none__";

interface CustomModelEditorProps {
  readonly instanceId: string;
  readonly driverKind: ProviderDriverKind | null;
  readonly entry: CustomModelDefinition;
  readonly builtInModels: ReadonlyArray<ServerProviderModel>;
  readonly onSave: (next: CustomModelDefinition) => void;
  readonly onCancel: () => void;
}

export function CustomModelEditor({
  instanceId,
  driverKind,
  entry,
  builtInModels,
  onSave,
  onCancel,
}: CustomModelEditorProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<CustomModelDraft>(() => draftFromDefinition(entry));
  const [error, setError] = useState<string | null>(null);
  const presets = driverKind ? (DESCRIPTOR_PRESETS_BY_KIND[driverKind] ?? []) : [];
  const startFromCandidates = builtInModels.filter((model) => model.capabilities !== null);
  const domId = (suffix: string) => `provider-instance-${instanceId}-custom-model-${suffix}`;

  const updateDescriptor = (key: string, patch: Partial<EditorDescriptor>) => {
    setError(null);
    setDraft((current) => ({
      ...current,
      descriptors: current.descriptors.map((descriptor) =>
        descriptor.key === key ? { ...descriptor, ...patch } : descriptor,
      ),
    }));
  };

  const updateChoice = (descriptorKey: string, choiceKey: string, patch: Partial<EditorChoice>) => {
    setError(null);
    setDraft((current) => ({
      ...current,
      descriptors: current.descriptors.map((descriptor) => {
        if (descriptor.key !== descriptorKey) return descriptor;
        return {
          ...descriptor,
          choices: descriptor.choices.map((choice) => {
            if (choice.key === choiceKey) return { ...choice, ...patch };
            return patch.isDefault ? { ...choice, isDefault: false } : choice;
          }),
        };
      }),
    }));
  };

  const removeDescriptor = (key: string) => {
    setError(null);
    setDraft((current) => ({
      ...current,
      descriptors: current.descriptors.filter((descriptor) => descriptor.key !== key),
    }));
  };

  const addDescriptor = (descriptor: EditorDescriptor) => {
    setError(null);
    setDraft((current) => ({ ...current, descriptors: [...current.descriptors, descriptor] }));
  };

  const applyPresetId = (descriptor: EditorDescriptor, value: string | null) => {
    if (value === null) return;
    if (value === CUSTOM_ID_VALUE) {
      updateDescriptor(descriptor.key, { id: "" });
      return;
    }
    const preset = presets.find((candidate) => candidate.id === value);
    if (!preset) return;
    updateDescriptor(descriptor.key, {
      id: preset.id,
      label: preset.label,
      type: preset.type,
      choices: (preset.choices ?? []).map(choiceFromPreset),
      currentBooleanValue: undefined,
      description: undefined,
    });
  };

  const handleStartFrom = (slug: string | null) => {
    if (slug === null || slug === START_FROM_NONE) return;
    const model = startFromCandidates.find((candidate) => candidate.slug === slug);
    if (!model) return;
    setError(null);
    setDraft((current) => ({
      ...current,
      contextWindow: model.capabilities?.contextWindow?.toString() ?? "",
      supportsImages:
        model.capabilities?.supportsImages === undefined
          ? "unknown"
          : model.capabilities.supportsImages
            ? "yes"
            : "no",
      descriptors: descriptorsFromCapabilities(model.capabilities, driverKind),
    }));
  };

  const handleSave = () => {
    const problem = validateDraft(draft, t);
    if (problem) {
      setError(t(problem));
      return;
    }
    onSave(definitionFromDraft(draft));
  };

  const idSelectValue = (descriptor: EditorDescriptor) =>
    presets.some((preset) => preset.id === descriptor.id) ? descriptor.id : CUSTOM_ID_VALUE;

  const renderChoice = (descriptor: EditorDescriptor, choice: EditorChoice) => (
    <div key={choice.key} className="flex items-center gap-2">
      <div className="min-w-0 w-28">
        <Input
          size="compact"
          value={choice.id}
          onChange={(event) => updateChoice(descriptor.key, choice.key, { id: event.target.value })}
          placeholder={t("Value")}
          font="mono"
          spellCheck={false}
          aria-label={t("Choice value")}
        />
      </div>
      <div className="min-w-0 flex-1">
        <Input
          size="compact"
          value={choice.label}
          onChange={(event) =>
            updateChoice(descriptor.key, choice.key, { label: event.target.value })
          }
          placeholder={t("Label")}
          aria-label={t("Choice label")}
        />
      </div>
      <label className="flex shrink-0 items-center gap-1.5 text-2xs text-muted-foreground">
        <Switch
          size="sm"
          checked={choice.isDefault}
          onCheckedChange={(checked) =>
            updateChoice(descriptor.key, choice.key, { isDefault: checked })
          }
          aria-label={t("Default choice")}
        />
        {t("Default")}
      </label>
      <Button
        size="icon-micro"
        variant="ghost-muted"
        aria-label={t("Remove choice")}
        onClick={() =>
          updateDescriptor(descriptor.key, {
            choices: descriptor.choices.filter((candidate) => candidate.key !== choice.key),
          })
        }
      >
        <XIcon className="size-3" />
      </Button>
    </div>
  );

  const renderDescriptor = (descriptor: EditorDescriptor, index: number) => (
    <div
      key={descriptor.key}
      className="flex flex-col gap-2 rounded-md border border-border/60 bg-background/40 p-2.5"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-14 shrink-0 text-2xs text-muted-foreground">
          {t("Option")} {index + 1}
        </span>
        {presets.length > 0 ? (
          <Select
            value={idSelectValue(descriptor)}
            onValueChange={(value) => applyPresetId(descriptor, value)}
          >
            <div className="min-w-0 w-40">
              <SelectTrigger fill size="compact" aria-label={t("Option id")}>
                <SelectValue>
                  {idSelectValue(descriptor) === CUSTOM_ID_VALUE ? t("Custom…") : descriptor.id}
                </SelectValue>
              </SelectTrigger>
            </div>
            <SelectPopup align="start" alignItemWithTrigger={false}>
              {presets.map((preset) => (
                <SelectItem key={preset.id} value={preset.id}>
                  <span className="flex items-baseline gap-2">
                    <code className="font-mono text-xs">{preset.id}</code>
                    <span className="text-muted-foreground">{t(preset.label)}</span>
                  </span>
                </SelectItem>
              ))}
              <SelectItem value={CUSTOM_ID_VALUE}>{t("Custom…")}</SelectItem>
            </SelectPopup>
          </Select>
        ) : null}
        {idSelectValue(descriptor) === CUSTOM_ID_VALUE ? (
          <div className="min-w-0 w-36">
            <Input
              size="compact"
              value={descriptor.id}
              onChange={(event) => updateDescriptor(descriptor.key, { id: event.target.value })}
              placeholder="optionId"
              font="mono"
              spellCheck={false}
              aria-label={t("Option id")}
            />
          </div>
        ) : null}
        <div className="min-w-0 flex-1">
          <Input
            size="compact"
            value={descriptor.label}
            onChange={(event) => updateDescriptor(descriptor.key, { label: event.target.value })}
            placeholder={t("Label")}
            aria-label={t("Option label")}
          />
        </div>
        <Select
          value={descriptor.type}
          onValueChange={(value) =>
            updateDescriptor(descriptor.key, { type: value === "boolean" ? "boolean" : "select" })
          }
        >
          <div className="min-w-0 w-24">
            <SelectTrigger fill size="compact" aria-label={t("Option type")}>
              <SelectValue>{t(descriptor.type === "boolean" ? "Toggle" : "Choices")}</SelectValue>
            </SelectTrigger>
          </div>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem value="select">{t("Choices")}</SelectItem>
            <SelectItem value="boolean">{t("Toggle")}</SelectItem>
          </SelectPopup>
        </Select>
        <Button
          size="icon-micro"
          variant="ghost-muted"
          aria-label={t("Remove option {index}", { index: index + 1 })}
          onClick={() => removeDescriptor(descriptor.key)}
        >
          <XIcon className="size-3" />
        </Button>
      </div>
      {descriptor.type === "select" ? (
        <div className="flex flex-col gap-1.5 pl-16">
          {descriptor.choices.map((choice) => renderChoice(descriptor, choice))}
          <span className="inline-flex min-w-0 -ml-2 self-start">
            <Button
              type="button"
              size="xs"
              variant="ghost-muted"
              onClick={() =>
                updateDescriptor(descriptor.key, {
                  choices: [...descriptor.choices, emptyEditorChoice()],
                })
              }
            >
              <PlusIcon className="size-3" />
              {t("Add choice")}
            </Button>
          </span>
        </div>
      ) : null}
    </div>
  );

  return (
    <div
      className="mx-2 mt-1 mb-2 flex flex-col gap-3 rounded-md border border-border bg-muted/20 p-3"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      <div className="flex flex-col gap-1">
        <label htmlFor={domId("name")} className="text-xs text-muted-foreground">
          {t("Display name")}
        </label>
        <div className="min-w-0 sm:w-72">
          <Input
            id={domId("name")}
            size="sm"
            autoFocus
            value={draft.name}
            onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
            placeholder={draft.slug}
            spellCheck={false}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={domId("context")} className="text-xs text-muted-foreground">
          {t("Context window (tokens)")}
        </label>
        <Input
          id={domId("context")}
          size="sm"
          inputMode="numeric"
          value={draft.contextWindow ?? ""}
          placeholder={t("Unknown / provider default")}
          onChange={(event) =>
            setDraft((current) => ({ ...current, contextWindow: event.target.value }))
          }
        />
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">{t("Image input (multimodal)")}</span>
        <Select
          value={draft.supportsImages ?? "unknown"}
          onValueChange={(value) =>
            setDraft((current) => ({
              ...current,
              supportsImages: value === "yes" ? "yes" : value === "no" ? "no" : "unknown",
            }))
          }
        >
          <SelectTrigger size="compact" aria-label={t("Image input (multimodal)")}>
            <SelectValue>
              {t(
                draft.supportsImages === "yes"
                  ? "Supported"
                  : draft.supportsImages === "no"
                    ? "Not supported"
                    : "Unknown / provider default",
              )}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="unknown">{t("Unknown / provider default")}</SelectItem>
            <SelectItem value="yes">{t("Supported")}</SelectItem>
            <SelectItem value="no">{t("Not supported")}</SelectItem>
          </SelectPopup>
        </Select>
      </div>
      <p className="text-xs text-muted-foreground">
        {t(
          "Reported gateway capabilities are prefilled. Unknown values are not guessed; saved changes override discovery.",
        )}
      </p>

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {t("Options shown in the composer")}
          </span>
          {startFromCandidates.length > 0 ? (
            <Select value={START_FROM_NONE} onValueChange={handleStartFrom}>
              <div className="min-w-0 w-44">
                <SelectTrigger
                  fill
                  size="compact"
                  aria-label={t("Copy options from a built-in model")}
                >
                  <SelectValue>{t("Copy from…")}</SelectValue>
                </SelectTrigger>
              </div>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {startFromCandidates.map((model) => (
                  <SelectItem key={model.slug} value={model.slug}>
                    {model.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          ) : null}
        </div>
        {draft.descriptors.length === 0 ? (
          <p className="text-xs text-muted-foreground/70">
            {t("No custom options. The composer uses the provider's default options.")}
          </p>
        ) : null}
        {draft.descriptors.map(renderDescriptor)}
        <div className="flex flex-wrap gap-1">
          {presets
            .filter(
              (preset) => !draft.descriptors.some((descriptor) => descriptor.id === preset.id),
            )
            .map((preset) => (
              <span key={preset.id} className={cn("inline-flex min-w-0", cn("-ml-2 first:ml-0"))}>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost-muted"
                  onClick={() => addDescriptor(descriptorFromPreset(preset))}
                >
                  <PlusIcon className="size-3" />
                  {t(preset.label)}
                </Button>
              </span>
            ))}
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            onClick={() => addDescriptor(emptyEditorDescriptor())}
          >
            <PlusIcon className="size-3" />
            {t("Custom option")}
          </Button>
        </div>
      </div>

      {error ? <p className="text-xs text-destructive">{error}</p> : null}

      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={handleSave}>
          {t("Save")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t("Cancel")}
        </Button>
      </div>
    </div>
  );
}

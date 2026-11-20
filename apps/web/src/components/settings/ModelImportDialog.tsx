import type { ModelServiceDiscoveryResult, ModelServiceModel } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { useTranslation } from "../../i18n";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";

export function ModelImportDialog({
  preview,
  existingModels,
  serviceName,
  unlistedCount,
  busy,
  error,
  revisionChanged,
  onCancel,
  onImport,
}: {
  readonly preview: ModelServiceDiscoveryResult;
  readonly existingModels: readonly ModelServiceModel[];
  readonly serviceName: string;
  readonly unlistedCount: number;
  readonly busy: boolean;
  readonly error: string | null;
  readonly revisionChanged: boolean;
  readonly onCancel: () => void;
  readonly onImport: (modelIds: readonly string[]) => void;
}) {
  const { t } = useTranslation();
  const searchInput = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const existingIds = new Set(existingModels.map((model) => model.id));
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleModels = preview.models.filter((model) =>
    `${model.name ?? ""} ${model.id}`.toLocaleLowerCase().includes(normalizedQuery),
  );

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onCancel();
      }}
    >
      <AlertDialogPopup initialFocus={searchInput} reducedMotion="opacity">
        <AlertDialogHeader shrink={false}>
          <AlertDialogTitle>{t("Import models")}</AlertDialogTitle>
          <AlertDialogDescription scrollable={false}>
            <span className="block">
              {t("Select models from {service} to add or update.", {
                service: serviceName,
              })}
            </span>
            <span className="block">{t("Only checked models are imported.")}</span>
            <span className="block">{t("Unlisted models are kept unavailable.")}</span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="grid shrink-0 gap-3 px-6 pb-4">
          <label className="grid gap-2 text-sm font-medium">
            {t("Search models")}
            <div className="[&_[data-slot=input-control]]:h-11 [&_[data-slot=input-control]]:items-center [&_input]:h-11 [&_[data-slot=input-control]]:sm:h-9 [&_input]:sm:h-8">
              <Input
                ref={searchInput}
                type="search"
                value={query}
                disabled={busy}
                placeholder={t("Search by name or model ID")}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
          </label>
          <div className="flex flex-wrap items-center gap-2 max-sm:[&_button]:min-h-11">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={
                busy ||
                !visibleModels.length ||
                visibleModels.every((model) => selected.has(model.id))
              }
              onClick={() => {
                const next = new Set(selected);
                for (const model of visibleModels) next.add(model.id);
                setSelected(next);
              }}
            >
              {t(normalizedQuery ? "Select matching" : "Select all")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || selected.size === 0}
              onClick={() => setSelected(new Set())}
            >
              {t("Clear")}
            </Button>
            <p aria-live="polite" className="ml-auto text-xs text-muted-foreground">
              {t("{selected} of {total} models selected", {
                selected: selected.size,
                total: preview.models.length,
              })}
            </p>
          </div>
        </div>
        <ul
          data-model-import-list
          aria-label={t("Models available for import")}
          className="mx-6 h-[min(24rem,45dvh)] min-h-0 flex-auto divide-y divide-border overflow-y-auto overscroll-contain rounded-md border border-border/60"
        >
          {visibleModels.map((model) => (
            <li key={model.id}>
              <label className="flex min-h-14 cursor-pointer items-start gap-3 px-4 py-3 transition-colors hover:bg-muted/40">
                <span className="mt-0.5 inline-flex [&_[data-slot=checkbox]]:border-muted-foreground">
                  <Checkbox
                    checked={selected.has(model.id)}
                    disabled={busy}
                    aria-label={t("Import model {model}", { model: model.name ?? model.id })}
                    onCheckedChange={(checked) => {
                      const next = new Set(selected);
                      if (checked === true) next.add(model.id);
                      else next.delete(model.id);
                      setSelected(next);
                    }}
                  />
                </span>
                <span className="min-w-0 flex-1 space-y-1">
                  <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span className="min-w-0 break-all text-sm font-medium">
                      {model.name ?? model.id}
                    </span>
                    {existingIds.has(model.id) ? (
                      <span className="text-xs text-muted-foreground">{t("Already imported")}</span>
                    ) : null}
                  </span>
                  <span className="block break-all font-mono text-xs text-muted-foreground">
                    {model.id}
                  </span>
                </span>
              </label>
            </li>
          ))}
          {!visibleModels.length ? (
            <li className="px-4 py-6 text-center text-sm text-muted-foreground">
              {t(
                preview.models.length
                  ? "No models match your search."
                  : "The service returned no models.",
              )}
            </li>
          ) : null}
        </ul>
        {busy ? (
          <p role="status" className="shrink-0 px-6 py-3 text-sm text-muted-foreground">
            {t("Saving model selection…")}
          </p>
        ) : null}
        {revisionChanged || error ? (
          <p
            role="alert"
            className="shrink-0 px-6 py-3 text-sm text-destructive [overflow-wrap:anywhere]"
          >
            {error ?? t("The model service changed. Close this dialog and fetch the models again.")}
          </p>
        ) : null}
        <AlertDialogFooter shrink={false}>
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end [@media(max-height:600px)]:flex-row [@media(max-height:600px)]:[&>button]:flex-1">
            <AlertDialogClose render={<Button size="touch" variant="outline" disabled={busy} />}>
              {t("Cancel")}
            </AlertDialogClose>
            <Button
              size="touch"
              disabled={busy || revisionChanged || (selected.size === 0 && unlistedCount === 0)}
              onClick={() => onImport([...selected])}
            >
              {busy
                ? t("Working…")
                : selected.size === 0 && unlistedCount > 0
                  ? t("Mark models unavailable ({count})", { count: unlistedCount })
                  : t("Import selected models ({count})", { count: selected.size })}
            </Button>
          </div>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

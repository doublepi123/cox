import {
  ModelServiceId,
  type ModelServiceBinding,
  type ModelServiceConfig,
  type ModelServiceSource,
} from "@t3tools/contracts";
import { useId } from "react";
import {
  isModelServiceTargetAvailable,
  modelServiceAgentProtocol,
  modelServiceDefaultRuntimeId,
  modelServiceProtocols,
  modelServiceSources,
  modelServiceTargetName,
  modelServiceTargets,
  modelServiceUpstreamProtocol,
  multiSourceModelServiceBinding,
} from "@t3tools/shared/modelServices";
import { useTranslation } from "../../i18n";
import { Button } from "../ui/button";

const selectClass = "min-h-11 min-w-0 w-full rounded-md border border-input bg-background px-2";

export function ModelServiceBindingFields({
  driver,
  services,
  binding,
  readOnly = false,
  onChange,
}: {
  readonly driver: string;
  readonly services: Readonly<Record<ModelServiceId, ModelServiceConfig>>;
  readonly binding: ModelServiceBinding | undefined;
  readonly readOnly?: boolean;
  readonly onChange: (binding: ModelServiceBinding | undefined) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const sources = binding ? modelServiceSources(binding) : [];
  const targets = binding ? modelServiceTargets(services, binding) : [];
  const defaultId = binding ? modelServiceDefaultRuntimeId(binding) : undefined;
  const setSources = ([first, ...rest]: ReadonlyArray<ModelServiceSource>) => {
    if (!first) {
      onChange(undefined);
    } else if (binding?.serviceId === first.serviceId && !rest.length) {
      onChange({ ...binding, modelIds: first.modelIds });
    } else {
      const next = binding && multiSourceModelServiceBinding(binding, services);
      onChange({ ...next, modelIds: [], sources: [first, ...rest] });
    }
  };
  const choices = Object.entries(services).filter(
    ([serviceId, service]) =>
      service.enabled &&
      new Set(modelServiceProtocols(service)).size === 1 &&
      !sources.some((source) => source.serviceId === serviceId),
  );
  return (
    <div className="space-y-3">
      {sources.map((source) => {
        const service = services[source.serviceId];
        const sourceName = service?.name ?? source.serviceId;
        const allModels = source.modelIds.length === 0;
        const sourceTargets = modelServiceTargets(services, {
          serviceId: source.serviceId,
          modelIds: [],
        }).filter(
          (target) =>
            isModelServiceTargetAvailable(target) || source.modelIds.includes(target.ref.modelId),
        );
        const setIds = (modelIds: ReadonlyArray<string>) =>
          setSources(sources.map((entry) => (entry === source ? { ...entry, modelIds } : entry)));
        return (
          <fieldset
            key={source.serviceId}
            disabled={readOnly}
            className="space-y-2 rounded-md border border-border px-3 pb-2"
          >
            <legend className="px-1 text-sm font-medium">{sourceName}</legend>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={allModels}
                  disabled={!sourceTargets.length}
                  onChange={(event) =>
                    setIds(
                      event.target.checked ? [] : sourceTargets.map((target) => target.ref.modelId),
                    )
                  }
                />
                {t("Use all compatible models")}
              </label>
              <Button
                size="sm"
                variant="ghost-muted"
                aria-label={t("Remove model source {name}", { name: sourceName })}
                onClick={() => setSources(sources.filter((entry) => entry !== source))}
              >
                {t("Remove")}
              </Button>
            </div>
            {!allModels ? (
              <div className="max-h-64 overflow-y-auto">
                {sourceTargets.map((target) => {
                  const modelId = target.ref.modelId;
                  const checked = source.modelIds.includes(modelId);
                  const native =
                    (driver !== "codex" && driver !== "claudeAgent") ||
                    modelServiceUpstreamProtocol(target.service, target.model) ===
                      modelServiceAgentProtocol(driver, target.service);
                  return (
                    <label
                      key={modelId}
                      className="flex min-h-11 items-center justify-between gap-3 text-sm"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={checked && source.modelIds.length === 1}
                          onChange={(event) =>
                            setIds(
                              event.target.checked
                                ? [...source.modelIds, modelId]
                                : source.modelIds.filter((entry) => entry !== modelId),
                            )
                          }
                        />
                        <span className="break-all">{modelServiceTargetName(target, false)}</span>
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {t(
                          !isModelServiceTargetAvailable(target)
                            ? "Unavailable"
                            : native
                              ? "Native protocol"
                              : "Protocol conversion",
                        )}
                      </span>
                    </label>
                  );
                })}
              </div>
            ) : null}
          </fieldset>
        );
      })}
      <label className="grid gap-1.5 text-sm" htmlFor={`${id}-connection`}>
        {t(sources.length ? "Add model source" : "Connection")}
        <select
          id={`${id}-connection`}
          className={selectClass}
          value=""
          disabled={readOnly || choices.length === 0}
          onChange={(event) => {
            if (!event.target.value) return;
            setSources([
              ...sources,
              { serviceId: ModelServiceId.make(event.target.value), modelIds: [] },
            ]);
          }}
        >
          <option value="">
            {t(sources.length ? "Select a model service" : "Use independent agent configuration")}
          </option>
          {choices.map(([serviceId, service]) => (
            <option key={serviceId} value={serviceId}>
              {service.name}
            </option>
          ))}
        </select>
      </label>
      {binding ? (
        <label className="grid gap-1.5 text-sm" htmlFor={`${id}-default-model`}>
          {t("Default model")}
          <select
            id={`${id}-default-model`}
            className={selectClass}
            value={defaultId ?? ""}
            disabled={readOnly}
            onChange={(event) => {
              const model = targets.find((target) => target.id === event.target.value);
              const { defaultModel: _legacy, defaultModelRef: _previous, ...rest } = binding;
              onChange(
                !model
                  ? rest
                  : binding.sources
                    ? { ...rest, defaultModelRef: model.ref }
                    : { ...rest, defaultModel: model.ref.modelId },
              );
            }}
          >
            <option value="">{t("First available model")}</option>
            {defaultId && !targets.some((target) => target.id === defaultId) ? (
              <option value={defaultId} disabled>
                {t("Unavailable")}
              </option>
            ) : null}
            {sources.map((source) => (
              <optgroup
                key={source.serviceId}
                label={services[source.serviceId]?.name ?? source.serviceId}
              >
                {targets
                  .filter((target) => target.ref.serviceId === source.serviceId)
                  .filter(
                    (target) => target.id === defaultId || isModelServiceTargetAvailable(target),
                  )
                  .map((target) => (
                    <option
                      key={target.id}
                      value={target.id}
                      disabled={!isModelServiceTargetAvailable(target)}
                    >
                      {modelServiceTargetName(target, false)}
                      {isModelServiceTargetAvailable(target) ? "" : ` (${t("Unavailable")})`}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  );
}

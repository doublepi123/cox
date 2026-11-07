import {
  ModelServiceId,
  type ModelServiceBinding,
  type ModelServiceConfig,
} from "@t3tools/contracts";
import { useId } from "react";
import { boundModelServiceModels, modelServiceAgentProtocol } from "@t3tools/shared/modelServices";
import { useTranslation } from "../../i18n";

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
  const serviceId = binding?.serviceId ?? "";
  const allModels = !binding?.modelIds.length;
  const service = serviceId ? services[ModelServiceId.make(serviceId)] : undefined;
  const compatible = service
    ? boundModelServiceModels(service, {
        serviceId: ModelServiceId.make(serviceId),
        modelIds: [],
      }).filter((model) => model.available !== false)
    : [];
  const selected = binding?.modelIds ?? [];
  const models = compatible.filter((model) => allModels || selected.includes(model.id));
  const effectiveDefault = models.some((model) => model.id === binding?.defaultModel)
    ? binding!.defaultModel!
    : (models[0]?.id ?? "");
  const target = service ? modelServiceAgentProtocol(driver, service) : null;
  const update = (nextServiceId: string, modelIds: ReadonlyArray<string>, defaultModel: string) => {
    if (!nextServiceId) {
      onChange(undefined);
      return;
    }
    const nextService = services[ModelServiceId.make(nextServiceId)];
    const nextCompatible = nextService
      ? boundModelServiceModels(nextService, {
          serviceId: ModelServiceId.make(nextServiceId),
          modelIds: [],
        }).filter((model) => model.available !== false)
      : [];
    const nextModels = nextCompatible.filter(
      (model) => modelIds.length === 0 || modelIds.includes(model.id),
    );
    const nextDefault = nextModels.some((model) => model.id === defaultModel)
      ? defaultModel
      : (nextModels[0]?.id ?? "");
    onChange({
      serviceId: ModelServiceId.make(nextServiceId),
      modelIds,
      ...(nextDefault ? { defaultModel: nextDefault } : {}),
    });
  };
  return (
    <div className="space-y-3">
      <label className="grid gap-1.5 text-sm" htmlFor={`${id}-connection`}>
        {t("Connection")}
        <select
          id={`${id}-connection`}
          className="min-h-11 w-full rounded-md border border-input bg-background px-2"
          value={serviceId}
          disabled={readOnly}
          onChange={(event) => update(event.target.value, [], "")}
        >
          <option value="">{t("Use independent agent configuration")}</option>
          {Object.entries(services).map(([id, entry]) => (
            <option key={id} value={id}>
              {entry.name}
              {entry.enabled ? "" : ` (${t("Disabled")})`}
            </option>
          ))}
        </select>
      </label>
      {service ? (
        <>
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={allModels}
              disabled={readOnly}
              onChange={(event) =>
                update(
                  serviceId,
                  event.target.checked ? [] : compatible.map((model) => model.id),
                  effectiveDefault,
                )
              }
            />
            {t("Use all compatible models")}
          </label>
          {!allModels ? (
            <div className="max-h-64 overflow-y-auto">
              {compatible.map((model) => (
                <label
                  key={model.id}
                  className="flex min-h-11 items-center justify-between gap-3 text-sm"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <input
                      type="checkbox"
                      disabled={readOnly}
                      checked={selected.includes(model.id)}
                      onChange={(event) =>
                        update(
                          serviceId,
                          event.target.checked
                            ? [...selected, model.id]
                            : selected.filter((id) => id !== model.id),
                          effectiveDefault,
                        )
                      }
                    />
                    <span className="break-all">{model.name ?? model.id}</span>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {t(
                      (model.protocols ?? service.protocols).includes(target!)
                        ? "Native protocol"
                        : "Protocol conversion",
                    )}
                  </span>
                </label>
              ))}
            </div>
          ) : null}
          <label className="grid gap-1.5 text-sm" htmlFor={`${id}-default-model`}>
            {t("Default model")}
            <select
              id={`${id}-default-model`}
              className="min-h-11 w-full rounded-md border border-input bg-background px-2"
              value={effectiveDefault}
              disabled={readOnly || !models.length}
              onChange={(event) => update(serviceId, selected, event.target.value)}
            >
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name ?? model.id}
                </option>
              ))}
            </select>
          </label>
          {!compatible.length ? (
            <p className="text-xs text-muted-foreground">
              {t("Fetch or add models with tool-calling support before binding this agent.")}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              {t("{count} compatible models. Protocol conversion is applied when required.", {
                count: models.length,
              })}
            </p>
          )}
        </>
      ) : null}
    </div>
  );
}

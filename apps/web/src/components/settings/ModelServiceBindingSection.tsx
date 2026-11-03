import {
  ModelServiceId,
  type EnvironmentId,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  MODEL_SERVICE_AGENT_DRIVERS,
  boundModelServiceModels,
  modelServiceAgentProtocol,
} from "@t3tools/shared/modelServices";
import { useTranslation } from "../../i18n";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { SettingsRow } from "./settingsLayout";

export function ModelServiceBindingSection({
  environmentId,
  instance,
  readOnly,
  onUpdate,
}: {
  readonly environmentId: EnvironmentId;
  readonly instance: ProviderInstanceConfig;
  readonly readOnly: boolean;
  readonly onUpdate: (next: ProviderInstanceConfig) => void;
}) {
  const { t } = useTranslation();
  const services = useEnvironmentSettings(environmentId, (settings) => settings.modelServices);
  const [serviceId, setServiceId] = useState(instance.modelService?.serviceId ?? "");
  const [allModels, setAllModels] = useState(!instance.modelService?.modelIds.length);
  const [selected, setSelected] = useState<ReadonlyArray<string>>(
    instance.modelService?.modelIds ?? [],
  );
  const [defaultModel, setDefaultModel] = useState(instance.modelService?.defaultModel ?? "");
  if (!(MODEL_SERVICE_AGENT_DRIVERS as ReadonlyArray<string>).includes(instance.driver))
    return null;
  const service = serviceId ? services[ModelServiceId.make(serviceId)] : undefined;
  const compatible = service
    ? boundModelServiceModels(service, {
        serviceId: ModelServiceId.make(serviceId),
        modelIds: [],
      }).filter((model) => model.available !== false)
    : [];
  const models = compatible.filter((model) => allModels || selected.includes(model.id));
  const effectiveDefault = models.some((model) => model.id === defaultModel)
    ? defaultModel
    : (models[0]?.id ?? "");
  const target = service ? modelServiceAgentProtocol(instance.driver, service) : null;
  return (
    <SettingsRow
      title={t("Model service")}
      description={t("Share a centrally managed API connection and model catalog with this agent.")}
      control={
        <Button size="sm" variant="ghost-muted" render={<Link to="/settings/model-services" />}>
          {t("Manage model services")}
        </Button>
      }
    >
      <div className="space-y-3">
        <label className="grid gap-1.5 text-sm">
          {t("Connection")}
          <select
            className="min-h-11 w-full rounded-md border border-input bg-background px-2"
            value={serviceId}
            disabled={readOnly}
            onChange={(event) => {
              const id = event.target.value;
              setServiceId(id);
              setAllModels(true);
              setSelected([]);
              setDefaultModel("");
            }}
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
                onChange={(event) => {
                  setAllModels(event.target.checked);
                  if (!event.target.checked) setSelected(compatible.map((model) => model.id));
                }}
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
                          setSelected(
                            event.target.checked
                              ? [...selected, model.id]
                              : selected.filter((id) => id !== model.id),
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
            <label className="grid gap-1.5 text-sm">
              {t("Default model")}
              <select
                className="min-h-11 w-full rounded-md border border-input bg-background px-2"
                value={effectiveDefault}
                disabled={readOnly || !models.length}
                onChange={(event) => setDefaultModel(event.target.value)}
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
        {!readOnly ? (
          <Button
            size="sm"
            variant="outline"
            disabled={Boolean(serviceId) && (!service || models.length === 0)}
            onClick={() => {
              const { modelService: _previous, ...rest } = instance;
              onUpdate(
                serviceId
                  ? {
                      ...rest,
                      modelService: {
                        serviceId: ModelServiceId.make(serviceId),
                        modelIds: allModels ? [] : selected,
                        ...(effectiveDefault ? { defaultModel: effectiveDefault } : {}),
                      },
                    }
                  : rest,
              );
            }}
          >
            {t("Apply model service")}
          </Button>
        ) : null}
      </div>
    </SettingsRow>
  );
}

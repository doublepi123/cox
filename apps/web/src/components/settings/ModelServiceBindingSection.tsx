import {
  type EnvironmentId,
  type ModelServiceBinding,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  boundModelServiceModels,
  MODEL_SERVICE_AGENT_DRIVERS,
} from "@t3tools/shared/modelServices";
import { useTranslation } from "../../i18n";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { SettingsRow } from "./settingsLayout";
import { ModelServiceBindingFields } from "./ModelServiceBindingFields";
import { OmoSettingsSection, omoBoundRoleModels } from "./OmoSettingsSection";

export function ModelServiceBindingSection({
  environmentId,
  instance,
  readOnly,
  onUpdate,
}: {
  readonly environmentId: EnvironmentId;
  readonly instance: ProviderInstanceConfig;
  readonly readOnly: boolean;
  readonly onUpdate: (next: ProviderInstanceConfig) => Promise<boolean> | void;
}) {
  const { t } = useTranslation();
  const services = useEnvironmentSettings(environmentId, (settings) => settings.modelServices);
  const [binding, setBinding] = useState<ModelServiceBinding | undefined>(instance.modelService);
  const savedBindingKey = JSON.stringify(instance.modelService ?? null);
  const [previousSavedBindingKey, setPreviousSavedBindingKey] = useState(savedBindingKey);
  if (previousSavedBindingKey !== savedBindingKey) {
    setPreviousSavedBindingKey(savedBindingKey);
    if (JSON.stringify(binding ?? null) === previousSavedBindingKey)
      setBinding(instance.modelService);
  }
  const [saving, setSaving] = useState(false);
  if (!(MODEL_SERVICE_AGENT_DRIVERS as ReadonlyArray<string>).includes(instance.driver))
    return null;
  const service = binding ? services[binding.serviceId] : undefined;
  const models = service
    ? boundModelServiceModels(service, binding!).filter((model) => model.available !== false)
    : [];
  const hasModels = models.length > 0;
  const { modelService: _previous, ...independent } = instance;
  const candidate = binding ? { ...independent, modelService: binding } : independent;
  return (
    <>
      <SettingsRow
        title={t("Model service")}
        description={t(
          "Share a centrally managed API connection and model catalog with this agent.",
        )}
        control={
          <Button size="sm" variant="ghost-muted" render={<Link to="/settings/model-services" />}>
            {t("Manage model services")}
          </Button>
        }
      >
        <ModelServiceBindingFields
          driver={instance.driver}
          services={services}
          binding={binding}
          readOnly={readOnly || saving}
          onChange={setBinding}
        />
        {!readOnly && instance.driver !== "omo" ? (
          <div className="mt-3">
            <Button
              size="sm"
              variant="outline"
              disabled={Boolean(binding?.serviceId) && !hasModels}
              onClick={() => {
                const { modelService: _previous, ...rest } = instance;
                onUpdate(binding ? { ...rest, modelService: binding } : rest);
              }}
            >
              {t("Apply model service")}
            </Button>
          </div>
        ) : null}
      </SettingsRow>
      {instance.driver === "omo" ? (
        <OmoSettingsSection
          savedInstance={instance}
          onSavingChange={setSaving}
          onReset={() => setBinding(instance.modelService)}
          instance={candidate}
          models={omoBoundRoleModels(models)}
          canSave={
            !binding ||
            (hasModels &&
              (!binding.defaultModel || models.some((model) => model.id === binding.defaultModel)))
          }
          readOnly={readOnly}
          onUpdate={onUpdate}
        />
      ) : null}
    </>
  );
}

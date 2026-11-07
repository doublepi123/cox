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
  const [binding, setBinding] = useState<ModelServiceBinding | undefined>(instance.modelService);
  if (!(MODEL_SERVICE_AGENT_DRIVERS as ReadonlyArray<string>).includes(instance.driver))
    return null;
  const service = binding ? services[binding.serviceId] : undefined;
  const hasModels = service
    ? boundModelServiceModels(service, binding!).some((model) => model.available !== false)
    : false;
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
      <ModelServiceBindingFields
        driver={instance.driver}
        services={services}
        binding={binding}
        readOnly={readOnly}
        onChange={setBinding}
      />
      {!readOnly ? (
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
  );
}

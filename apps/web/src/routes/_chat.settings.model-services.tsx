import { createFileRoute } from "@tanstack/react-router";
import { ModelServicesSettingsPanel } from "../components/settings/ModelServicesSettingsPanel";

export const Route = createFileRoute("/_chat/settings/model-services")({
  component: ModelServicesSettingsPanel,
});

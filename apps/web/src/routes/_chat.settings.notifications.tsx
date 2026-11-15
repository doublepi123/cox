import { createFileRoute } from "@tanstack/react-router";

import { NotificationsSettingsPanel } from "../components/settings/NotificationsSettingsPanel";

export const Route = createFileRoute("/_chat/settings/notifications")({
  component: NotificationsSettingsPanel,
});

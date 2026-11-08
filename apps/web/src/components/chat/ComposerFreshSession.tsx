import { EraserIcon } from "lucide-react";

import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { translateCurrent } from "../../i18n";

export function freshSessionBannerItem(onUndo: () => void): ComposerBannerStackItem {
  return {
    id: "fresh-session",
    variant: "info",
    icon: <EraserIcon />,
    title: translateCurrent("Your next message starts a fresh session"),
    description: translateCurrent("The agent won't see earlier messages in this thread."),
    dismissLabel: translateCurrent("Keep the current session"),
    onDismiss: onUndo,
  };
}

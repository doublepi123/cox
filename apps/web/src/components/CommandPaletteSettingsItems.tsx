import { useLocation, useNavigate } from "@tanstack/react-router";
import { SettingsIcon } from "lucide-react";
import { useTranslation } from "../i18n";
import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "./CommandPalette.logic";
import { settingsForThisPlatform, SETTINGS_SECTION_LABELS } from "./settings/settingsSearch";
import { useAvailableSettingsSearchItems } from "./settings/useAvailableSettingsSearchItems";

const NO_SETTINGS_ITEMS: ReadonlyArray<CommandPaletteActionItem> = [];

export function useCommandPaletteSettingsItems(
  searching: boolean,
): ReadonlyArray<CommandPaletteActionItem> {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const availableSettingsSearchItems = useAvailableSettingsSearchItems();
  if (!searching) return NO_SETTINGS_ITEMS;
  return settingsForThisPlatform(availableSettingsSearchItems).map((item) => ({
    kind: "action",
    value: `setting:${item.id}`,
    searchTerms: [
      item.title,
      SETTINGS_SECTION_LABELS[item.to],
      ...(item.searchTerms ?? []),
    ].flatMap((label) => [label, t(label)]),
    title: t(item.title),
    description: `${t("Settings")} · ${t(SETTINGS_SECTION_LABELS[item.to])}`,
    ...(item.secondary ? { secondary: true } : {}),
    icon: <SettingsIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      await navigate({
        to: item.to,
        hash: item.targetId ?? item.id,
        replace: pathname === item.to,
        hashScrollIntoView: false,
      });
    },
  }));
}

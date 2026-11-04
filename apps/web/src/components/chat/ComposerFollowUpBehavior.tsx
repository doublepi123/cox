import { ChevronDownIcon, CornerUpRightIcon, ListPlusIcon } from "lucide-react";

import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { useTranslation } from "../../i18n";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl, type ComposerControlSize } from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";
import { useComposerMenuState } from "./useComposerMenuState";

export function ComposerFollowUpBehavior({
  size = "sm",
  hidden = false,
}: {
  size?: ComposerControlSize;
  hidden?: boolean;
}) {
  const { t } = useTranslation();
  const behavior = useClientSettings((settings) => settings.followUpBehavior);
  const menuProps = useComposerMenuProps();
  const [open, setOpen] = useComposerMenuState(hidden);
  const label = t(behavior === "queue" ? "Queue" : "Steer");
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <ComposerControl
                  size={size}
                  className={size === "sm" ? "max-sm:min-h-11" : undefined}
                  aria-label={t("Follow-up behavior: {behavior}", { behavior: label })}
                />
              }
            />
          }
        >
          <span data-composer-control-label>{label}</span>
          <ChevronDownIcon aria-hidden="true" className="size-3" />
        </TooltipTrigger>
        <TooltipPopup>
          {t("Choose how follow-up messages are sent while the agent runs.")}
        </TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" side="top" {...menuProps}>
        <MenuGroup>
          <MenuGroupLabel>{t("Follow-up behavior")}</MenuGroupLabel>
          <MenuRadioGroup
            value={behavior}
            onValueChange={(value) => {
              if (value === "queue" || value === "steer") {
                void updateClientSettings({ followUpBehavior: value });
              }
            }}
          >
            {(
              [
                {
                  value: "queue",
                  label: "Queue",
                  description: "Wait for the current run to finish.",
                  icon: ListPlusIcon,
                },
                {
                  value: "steer",
                  label: "Steer",
                  description: "Send feedback to the current run immediately.",
                  icon: CornerUpRightIcon,
                },
              ] as const
            ).map((option) => (
              <MenuRadioItem
                key={option.value}
                value={option.value}
                closeOnClick
                aria-label={t(option.label)}
              >
                <div className="flex min-h-11 w-60 max-w-[calc(100vw-4rem)] items-center gap-2 py-1">
                  <option.icon aria-hidden="true" className="size-4 shrink-0" />
                  <div className="grid min-w-0 flex-1 gap-0.5">
                    <span>{t(option.label)}</span>
                    <span className="text-xs text-muted-foreground">{t(option.description)}</span>
                  </div>
                  <MenuRadioItemIndicator />
                </div>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

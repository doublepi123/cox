import { useTranslation } from "../i18n";
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import { type ComponentProps, type ReactNode, type RefObject } from "react";

import { Command, CommandFooter, CommandInput, CommandPanel } from "./ui/command";
import { Kbd, KbdGroup } from "./ui/kbd";

/**
 * A view replacing another inside an open dialog mounts with focus on the body,
 * left there by the removed input. Claim it so typing cannot reach the composer
 * behind the modal. On first open the dialog's own initial focus handles it.
 */
function claimFocusInOpenDialog(input: HTMLInputElement | null) {
  if (!input || window.matchMedia("(pointer: coarse)").matches) return;
  const active = input.ownerDocument.activeElement;
  if (
    active === null ||
    active === input.ownerDocument.body ||
    input.closest('[role="dialog"]')?.contains(active)
  ) {
    input.focus();
  }
}

export interface PendingInputSelection {
  readonly value: string;
  readonly start: number | null;
  readonly end: number | null;
  readonly direction: "forward" | "backward" | "none" | null;
}

function restorePendingSelection(
  input: HTMLInputElement,
  pendingSelectionRef: RefObject<PendingInputSelection | null> | undefined,
) {
  const selection = pendingSelectionRef?.current;
  if (!pendingSelectionRef || !selection) return;
  pendingSelectionRef.current = null;
  if (input.value !== selection.value) return;
  input.setSelectionRange(selection.start, selection.end, selection.direction ?? undefined);
}

type CommandPaletteContentProps = Omit<ComponentProps<typeof Command>, "children"> & {
  readonly children: ReactNode;
  readonly escapeLabel?: ReactNode;
  readonly footerActionLabel?: ReactNode;
  readonly footerTrailing?: ReactNode;
  readonly inputAccessory?: ReactNode;
  readonly inputProps: ComponentProps<typeof CommandInput>;
  readonly pendingSelectionRef?: RefObject<PendingInputSelection | null>;
  readonly panelSize?: "list" | "tall-list" | "fill";
  readonly showBackHint?: boolean;
  readonly testId?: string;
};

export function CommandPaletteContent({
  children,
  escapeLabel = "Close",
  footerActionLabel,
  footerTrailing,
  inputAccessory,
  inputProps,
  pendingSelectionRef,
  panelSize = "list",
  showBackHint,
  testId,
  ...commandProps
}: CommandPaletteContentProps) {
  const { t } = useTranslation();
  return (
    <div className="contents" data-testid={testId}>
      <Command {...commandProps}>
        <div className="relative">
          <CommandInput
            autoFocus={false}
            {...inputProps}
            ref={(input) => {
              if (!input) return;
              restorePendingSelection(input, pendingSelectionRef);
              claimFocusInOpenDialog(input);
            }}
          />
          {inputAccessory}
        </div>
        <CommandPanel sizing={panelSize === "list" ? "default" : panelSize}>
          {children}
        </CommandPanel>
        <CommandFooter mobileStack>
          <div className="flex items-center gap-3 pointer-coarse:hidden">
            <KbdGroup>
              <Kbd>
                <ArrowUpIcon />
              </Kbd>
              <Kbd>
                <ArrowDownIcon />
              </Kbd>
              <span>{t("Navigate")}</span>
            </KbdGroup>
            {footerActionLabel !== undefined ? (
              <KbdGroup>
                <Kbd>Enter</Kbd>
                <span>{footerActionLabel}</span>
              </KbdGroup>
            ) : null}
            {showBackHint ? (
              <KbdGroup>
                <Kbd>Backspace</Kbd>
                <span>{t("Back")}</span>
              </KbdGroup>
            ) : null}
            <KbdGroup>
              <Kbd>Esc</Kbd>
              <span>{escapeLabel}</span>
            </KbdGroup>
          </div>
          {footerTrailing}
        </CommandFooter>
      </Command>
    </div>
  );
}

import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  type LucideIcon,
} from "lucide-react";

import { useTranslation } from "../../i18n";
import type { TerminalKeyPress } from "~/terminal/ghostty/surface";

export interface TerminalTouchKey {
  readonly id: string;
  readonly label: string;
  readonly text?: string;
  readonly icon?: LucideIcon;
  readonly press: TerminalKeyPress;
}

export const TERMINAL_TOUCH_KEYS: ReadonlyArray<TerminalTouchKey> = [
  { id: "escape", label: "Send Escape", text: "Esc", press: { key: "Escape", code: "Escape" } },
  { id: "tab", label: "Send Tab", text: "Tab", press: { key: "Tab", code: "Tab" } },
  {
    id: "interrupt",
    label: "Send Ctrl+C",
    text: "^C",
    press: { key: "c", code: "KeyC", ctrlKey: true },
  },
  {
    id: "up",
    label: "Send Up arrow",
    icon: ArrowUpIcon,
    press: { key: "ArrowUp", code: "ArrowUp" },
  },
  {
    id: "down",
    label: "Send Down arrow",
    icon: ArrowDownIcon,
    press: { key: "ArrowDown", code: "ArrowDown" },
  },
  {
    id: "left",
    label: "Send Left arrow",
    icon: ArrowLeftIcon,
    press: { key: "ArrowLeft", code: "ArrowLeft" },
  },
  {
    id: "right",
    label: "Send Right arrow",
    icon: ArrowRightIcon,
    press: { key: "ArrowRight", code: "ArrowRight" },
  },
];

export function TerminalTouchKeys({ onPress }: { onPress: (press: TerminalKeyPress) => void }) {
  const { t } = useTranslation();
  return (
    <div
      role="toolbar"
      aria-label={t("Terminal keys")}
      data-terminal-touch-keys
      className="box-content flex h-12 shrink-0 items-center gap-1 overflow-x-auto border-t border-border/70 bg-background px-1.5 pb-safe [scrollbar-width:none]"
    >
      {TERMINAL_TOUCH_KEYS.map(({ id, label, text, icon: Icon, press }) => (
        <button
          key={id}
          type="button"
          aria-label={t(label)}
          data-terminal-touch-key={id}
          className="flex h-10 min-w-10 max-w-16 flex-1 shrink-0 cursor-pointer touch-manipulation select-none items-center justify-center rounded-lg border border-border/70 bg-muted/40 px-2 font-mono text-sm text-foreground active:bg-accent"
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => onPress(press)}
        >
          {Icon ? <Icon aria-hidden className="size-4" /> : text}
        </button>
      ))}
    </div>
  );
}

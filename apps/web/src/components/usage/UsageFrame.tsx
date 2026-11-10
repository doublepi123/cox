import { useEffect, type ReactNode } from "react";
import { useTranslation } from "../../i18n";
import { AppRouteModal, AppRouteModalClose } from "../AppRouteModal";
import { Button } from "../ui/button";
import { XIcon } from "lucide-react";

export function UsageFrame({ children }: { children: ReactNode }) {
  const standalone = window.coxDesktop?.windowKind === "usage";
  useEffect(() => {
    if (!standalone) return;
    const close = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        event.isComposing ||
        document.querySelector('[role="dialog"], [role="alertdialog"], [data-popup-open]')
      )
        return;
      event.preventDefault();
      window.coxDesktop?.closeUsage?.();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [standalone]);
  const { t } = useTranslation();
  return standalone ? (
    <main className="flex h-dvh min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
      {children}
    </main>
  ) : (
    <AppRouteModal label={t("Usage")}>{children}</AppRouteModal>
  );
}

export function UsageWindowClose() {
  const { t } = useTranslation();
  return window.coxDesktop?.windowKind === "usage" ? (
    <Button
      size="icon-sm"
      variant="ghost"
      aria-label={t("Close")}
      onClick={() => window.coxDesktop?.closeUsage?.()}
    >
      <XIcon />
    </Button>
  ) : (
    <AppRouteModalClose />
  );
}

import { useTranslation } from "../i18n";
import { workspaceAreaProps } from "../lib/workspaceFocus";
import { MessageSquareDashedIcon, PlusIcon } from "lucide-react";
import { openCommandPalette } from "../commandPaletteBus";

import { useScratchProject } from "../hooks/useScratchProject";
import { usePrimaryEnvironmentId } from "../state/environments";
import { Button } from "./ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { SidebarInset } from "./ui/sidebar";

export function NoProjectsHero() {
  const { t } = useTranslation();
  const contentArea = workspaceAreaProps("home", 1, "Home");
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { scratchEnvironmentId, startScratchThread } = useScratchProject();
  const scratchTargetEnvironmentId = scratchEnvironmentId(primaryEnvironmentId);
  return (
    <SidebarInset {...contentArea} role="main" viewport="dynamic">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <Empty size="hero">
          <div className="w-full max-w-lg px-8 py-12">
            <EmptyHeader unconstrained>
              <EmptyTitle>{t("What should we work on?")}</EmptyTitle>
              <EmptyDescription>
                {scratchTargetEnvironmentId === null
                  ? t("Add a project to start your first thread.")
                  : t("Add a project, or start without one.")}
              </EmptyDescription>
              <div className="mt-6 flex justify-center gap-2">
                <Button size="sm" onClick={() => openCommandPalette({ open: "add-project" })}>
                  <PlusIcon className="size-4" />
                  {t("Add project")}
                </Button>
                {scratchTargetEnvironmentId === null ? null : (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void startScratchThread(scratchTargetEnvironmentId)}
                  >
                    <MessageSquareDashedIcon className="size-4" />
                    {t("Start without a project")}
                  </Button>
                )}
              </div>
            </EmptyHeader>
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}

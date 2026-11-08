import { useTranslation } from "../i18n";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { SidebarInset } from "./ui/sidebar";

import { WorkspacePageHeader } from "./WorkspacePageHeader";
export function NoActiveThreadState() {
  const { t: translateUi } = useTranslation();
  return (
    <SidebarInset viewport="dynamic">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader className="border-b border-border">
          {
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-foreground md:text-muted-foreground/60">
                {translateUi("No active thread")}
              </span>
            </div>
          }
        </WorkspacePageHeader>

        <Empty>
          <div className="w-full max-w-lg px-8 py-12">
            <EmptyHeader unconstrained>
              <EmptyTitle>{translateUi("Pick a thread to continue")}</EmptyTitle>
              <EmptyDescription>
                {translateUi("Select an existing thread or create a new one to get started.")}
              </EmptyDescription>
            </EmptyHeader>
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}

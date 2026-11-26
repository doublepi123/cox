import { SharedTooltipTrigger } from "~/components/ui/shared-tooltip";

import { cn } from "~/lib/utils";

export function StartTruncatedPath({ path, className }: { path: string; className?: string }) {
  return (
    <SharedTooltipTrigger
      render={
        <span
          className={cn(
            "min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-left",
            className,
          )}
          dir="rtl"
        />
      }
      side="top"
      variant="code"
      label={<>{path}</>}
    >
      <bdi>{path}</bdi>
    </SharedTooltipTrigger>
  );
}

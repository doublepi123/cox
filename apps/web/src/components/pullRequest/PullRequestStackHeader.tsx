import { SharedTooltipTrigger } from "../ui/shared-tooltip";
import { MenuGroupLabel } from "../ui/menu";

export function PullRequestStackHeader({
  number,
  notice,
  stale = false,
}: {
  number: number;
  notice?: string | null | undefined;
  stale?: boolean;
}) {
  return (
    <MenuGroupLabel>
      <div className="flex items-center justify-between gap-2">
        <span>Stack #{number}</span>
        {notice ? (
          <SharedTooltipTrigger
            render={<span role="status" className="text-xs font-normal" />}
            label={notice}
          >
            {stale ? "May be stale" : "Refreshing…"}
          </SharedTooltipTrigger>
        ) : null}
      </div>
    </MenuGroupLabel>
  );
}

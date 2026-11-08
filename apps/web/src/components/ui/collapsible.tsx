import { Collapsible as CollapsiblePrimitive } from "@base-ui/react/collapsible";

import { cn } from "~/lib/utils";

function Collapsible({ ...props }: CollapsiblePrimitive.Root.Props) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />;
}

const collapsibleTriggerVariants = {
  default: "",
  "import-row": "group flex min-w-0 flex-1 items-center gap-1.5 text-left",
  advanced:
    "group flex min-h-10 w-full items-center gap-1.5 rounded-b-xl px-3 text-left text-xs font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-panel-open:rounded-none sm:px-4",
  markdown:
    "flex w-full items-center gap-2 py-2 text-left text-sm font-medium text-foreground data-panel-open:[&_svg]:rotate-90",
  "review-orphans":
    "flex w-full items-center gap-1.5 px-4 py-2 text-left text-xs text-muted-foreground",
  "review-file":
    "group flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-xs outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
  "event-group":
    "flex w-full min-w-0 items-center gap-2.5 py-2 pr-3.25 text-left transition-opacity hover:opacity-100",
  "review-thread":
    "flex w-full min-w-0 items-center gap-3 py-2 text-left transition-opacity hover:opacity-100",
  license:
    "group flex min-h-10 min-w-0 flex-1 items-center gap-2.5 px-3 text-left sm:min-h-9 sm:px-4",
  "review-summary":
    "flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground",
  "review-preview":
    "mt-2 block w-full truncate text-left text-xs text-muted-foreground hover:text-foreground",
  "review-heading":
    "flex min-w-0 flex-1 items-center gap-1.5 px-4 py-3 text-left text-xs font-medium text-muted-foreground hover:text-foreground",
  "settings-outside":
    "flex min-h-7 items-center gap-2 rounded-md text-sm font-normal text-foreground/70 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
  "settings-inside":
    "flex min-h-11 min-w-0 flex-1 items-center gap-2 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring rounded-md",
} as const;

function CollapsibleTrigger({
  className,
  variant = "default",
  emphasized = false,
  ...props
}: CollapsiblePrimitive.Trigger.Props & {
  variant?: keyof typeof collapsibleTriggerVariants;
  emphasized?: boolean;
}) {
  return (
    <CollapsiblePrimitive.Trigger
      className={cn(
        "cursor-pointer",
        collapsibleTriggerVariants[variant],
        (variant === "event-group" || variant === "review-thread") &&
          (emphasized ? "text-foreground opacity-100" : "text-muted-foreground opacity-55"),
        className,
      )}
      data-slot="collapsible-trigger"
      {...props}
    />
  );
}

function CollapsiblePanel({
  className,
  animate = true,
  ...props
}: CollapsiblePrimitive.Panel.Props & { animate?: boolean }) {
  return (
    <CollapsiblePrimitive.Panel
      className={cn(
        "overflow-hidden",
        animate &&
          "h-(--collapsible-panel-height) transition-[height] duration-200 motion-reduce:transition-none data-ending-style:h-0 data-starting-style:h-0 data-open:data-ending-style:[height:var(--collapsible-panel-height)]",
        className,
      )}
      data-slot="collapsible-panel"
      {...props}
    />
  );
}

export {
  Collapsible,
  CollapsibleTrigger,
  CollapsiblePanel,
  CollapsiblePanel as CollapsibleContent,
};

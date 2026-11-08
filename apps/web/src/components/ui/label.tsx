import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";

import { cn } from "~/lib/utils";

function Label({
  className,
  render,
  layout = "inline",
  ...props
}: useRender.ComponentProps<"label"> & { layout?: "inline" | "stacked" | "spread" }) {
  const defaultProps = {
    className: cn(
      "inline-flex items-center gap-2 text-base/4.5 sm:text-sm/4 font-medium text-foreground",
      layout === "stacked" && "min-w-0 flex-col items-stretch",
      layout === "spread" && "w-full items-baseline justify-between",
      className,
    ),
    "data-slot": "label",
  };

  return useRender({
    defaultTagName: "label",
    props: mergeProps<"label">(defaultProps, props),
    render,
  });
}

export { Label };

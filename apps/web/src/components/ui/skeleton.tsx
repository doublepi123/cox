import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "~/lib/utils";

const skeletonVariants = cva("bg-muted-foreground/15 motion-safe:animate-skeleton", {
  variants: {
    shape: {
      block: "rounded-sm",
      card: "rounded-lg",
      pill: "rounded-full",
    },
  },
  defaultVariants: { shape: "block" },
});

function Skeleton({
  className,
  shape,
  width,
  height,
  style,
  ...props
}: React.ComponentProps<"div"> &
  VariantProps<typeof skeletonVariants> & {
    width?: React.CSSProperties["width"];
    height?: React.CSSProperties["height"];
  }) {
  return (
    <div
      className={cn(skeletonVariants({ shape }), width !== undefined && "shrink-0", className)}
      style={{ width, height, ...style }}
      data-slot="skeleton"
      {...props}
    />
  );
}

export { Skeleton };

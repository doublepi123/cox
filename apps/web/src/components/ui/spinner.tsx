import { useTranslation } from "../../i18n";
import { LoaderCircleIcon } from "lucide-react";
import { cva, type VariantProps } from "class-variance-authority";
import { observeVisibleAnimation } from "~/lib/visibleAnimation";
import { cn } from "~/lib/utils";

// No default size: inside a Button the parent's svg rule sizes the glyph.
const spinnerVariants = cva("motion-safe:visible-animate-spin", {
  variants: {
    size: {
      xs: "size-3",
      sm: "size-3.5",
      md: "size-4",
      lg: "size-5",
    },
    tone: {
      current: "",
      muted: "text-muted-foreground",
    },
  },
  defaultVariants: { tone: "current" },
});

function Spinner({
  className,
  size,
  tone,
  placement,
  ...props
}: React.ComponentPropsWithoutRef<typeof LoaderCircleIcon> &
  VariantProps<typeof spinnerVariants> & { placement?: "menu-search" }) {
  const { t } = useTranslation();
  return (
    <LoaderCircleIcon
      aria-label={t("Loading")}
      ref={observeVisibleAnimation}
      className={cn(
        spinnerVariants({ size, tone }),
        "shrink-0",
        placement === "menu-search" && "pointer-events-none absolute top-1.5 left-0",
        className,
      )}
      role="status"
      {...props}
    />
  );
}

export { Spinner };

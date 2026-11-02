import { cn } from "../lib/utils";

export function CoxBrand({ className }: { readonly className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 font-semibold tracking-tight",
        className,
      )}
    >
      <img src="/cox.svg" alt="" className="size-5 shrink-0" />
      <span>Cox</span>
    </span>
  );
}

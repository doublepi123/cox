import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import { ChevronsUpDownIcon, SearchIcon, XIcon } from "lucide-react";
import * as React from "react";

import { cn } from "~/lib/utils";
import { Input } from "~/components/ui/input";
import { ScrollArea } from "~/components/ui/scroll-area";

const ComboboxContext = React.createContext<{
  chipsRef: React.RefObject<Element | null> | null;
  multiple: boolean;
}>({
  chipsRef: null,
  multiple: false,
});

function Combobox<Value, Multiple extends boolean | undefined = false>(
  props: ComboboxPrimitive.Root.Props<Value, Multiple>,
) {
  const chipsRef = React.useRef<Element | null>(null);
  const value = { chipsRef, multiple: !!props.multiple };
  return (
    <ComboboxContext value={value}>
      <ComboboxPrimitive.Root {...props} />
    </ComboboxContext>
  );
}

function ComboboxInput({
  className,
  showTrigger = true,
  showClear = false,
  startAddon,
  size,
  unstyled = false,
  search = false,
  ...props
}: Omit<ComboboxPrimitive.Input.Props, "size"> & {
  showTrigger?: boolean;
  showClear?: boolean;
  startAddon?: React.ReactNode;
  size?: "sm" | "default" | "lg" | number;
  unstyled?: boolean;
  search?: boolean;
  ref?: React.Ref<HTMLInputElement>;
}) {
  const sizeValue = (size ?? "default") as "sm" | "default" | "lg" | number;

  return (
    <div className="relative not-has-[>*.w-full]:w-fit w-full text-foreground has-disabled:opacity-64">
      {startAddon && (
        <div
          aria-hidden="true"
          className="[&_svg]:-mx-0.5 pointer-events-none absolute inset-y-0 start-px z-10 flex items-center ps-[calc(--spacing(3)-1px)] opacity-80 has-[+[data-size=sm]]:ps-[calc(--spacing(2.5)-1px)] [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4"
          data-slot="combobox-start-addon"
        >
          {startAddon}
        </div>
      )}
      <ComboboxPrimitive.Input
        className={className}
        data-slot="combobox-input"
        render={
          <Input
            variant={search ? "menu-search" : unstyled ? "combobox-search" : "combobox"}
            adornment="combobox"
            hasStartAddon={!!startAddon}
            hasEndAddon={showTrigger || showClear}
            nativeInput
            size={sizeValue}
            unstyled={unstyled}
          />
        }
        {...props}
      />
      {showTrigger && (
        <ComboboxTrigger variant="input" compact={sizeValue === "sm"}>
          <ComboboxPrimitive.Icon data-slot="combobox-icon">
            <ChevronsUpDownIcon />
          </ComboboxPrimitive.Icon>
        </ComboboxTrigger>
      )}
      {showClear && (
        <ComboboxClear variant="input" compact={sizeValue === "sm"}>
          <XIcon />
        </ComboboxClear>
      )}
    </div>
  );
}

function ComboboxSearchInput({
  variant = "line",
  ...props
}: React.ComponentProps<typeof ComboboxInput> & { variant?: "line" | "filled" }) {
  if (variant === "filled") {
    return (
      <div className="min-w-0 shrink-0 px-3 pb-2">
        <div className="relative rounded-xl bg-input/48 transition-shadow focus-within:ring-2 focus-within:ring-ring/48 dark:bg-input/40 [&_input]:h-10 [&_input]:ps-9 [&_input]:pe-3 [&_input]:font-sans [&_input]:text-base [&_input]:leading-10">
          <SearchIcon
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 size-4 shrink-0 -translate-y-1/2 text-muted-foreground/70"
          />
          <ComboboxInput {...props} showTrigger={false} unstyled />
        </div>
      </div>
    );
  }
  return (
    <div className="min-w-0 shrink-0 px-3 pt-2.5">
      <div className="relative -translate-y-px border-b border-border/70 pb-1.5 transition-colors focus-within:border-ring [&_input]:flex [&_input]:w-full">
        <SearchIcon
          aria-hidden="true"
          className="pointer-events-none absolute top-1.5 left-0 size-4 shrink-0 text-muted-foreground/55"
        />
        <ComboboxInput {...props} search showTrigger={false} size="sm" unstyled />
      </div>
    </div>
  );
}

function ComboboxTrigger({
  className,
  variant = "default",
  compact = false,
  children,
  ...props
}: ComboboxPrimitive.Trigger.Props & { variant?: "default" | "input"; compact?: boolean }) {
  return (
    <ComboboxPrimitive.Trigger
      className={cn(
        variant === "input" &&
          "-translate-y-1/2 absolute top-1/2 inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md border border-transparent opacity-80 outline-none transition-opacity pointer-coarse:after:absolute pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 hover:opacity-100 has-[+[data-slot=combobox-clear]]:hidden sm:size-7 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        variant === "input" && (compact ? "end-0" : "end-0.5"),
        className,
      )}
      data-slot="combobox-trigger"
      {...props}
    >
      {children}
    </ComboboxPrimitive.Trigger>
  );
}

function ComboboxPopup({
  className,
  children,
  side = "bottom",
  sideOffset = 4,
  alignOffset,
  align = "start",
  anchor: anchorProp,
  width,
  column = false,
  ...props
}: ComboboxPrimitive.Popup.Props & {
  align?: ComboboxPrimitive.Positioner.Props["align"];
  sideOffset?: ComboboxPrimitive.Positioner.Props["sideOffset"];
  alignOffset?: ComboboxPrimitive.Positioner.Props["alignOffset"];
  side?: ComboboxPrimitive.Positioner.Props["side"];
  anchor?: ComboboxPrimitive.Positioner.Props["anchor"];
  width?: "sm" | "md" | "lg" | "diff" | "sidebar";
  column?: boolean;
}) {
  const { chipsRef, multiple } = React.use(ComboboxContext);
  const anchor = anchorProp ?? (multiple ? chipsRef : undefined);

  return (
    <ComboboxPrimitive.Portal>
      <ComboboxPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        anchor={anchor}
        className="z-[130] select-none"
        data-slot="combobox-positioner"
        side={side}
        sideOffset={sideOffset}
      >
        <span
          className={cn(
            "dropdown-glass relative flex max-h-full min-w-(--anchor-width) max-w-(--available-width) origin-(--transform-origin) rounded-lg shadow-[0_16px_40px_-18px_rgb(0_0_0/55%)] transition-[scale,opacity] dark:shadow-[0_18px_44px_-18px_rgb(0_0_0/80%)]",
            width === "sm" && "w-56",
            width === "md" && "w-72 overflow-hidden",
            width === "lg" && "w-80",
            width === "diff" && "w-72 min-w-0 max-w-[calc(100vw-1rem)] overflow-hidden",
            width === "sidebar" && "max-w-[min(18rem,var(--available-width))] overflow-hidden",
            column && "flex flex-col",
            className,
          )}
        >
          <ComboboxPrimitive.Popup
            className="flex min-w-0 max-h-[min(var(--available-height),23rem)] flex-1 flex-col overflow-hidden text-foreground"
            data-slot="combobox-popup"
            {...props}
          >
            {children}
          </ComboboxPrimitive.Popup>
        </span>
      </ComboboxPrimitive.Positioner>
    </ComboboxPrimitive.Portal>
  );
}

function ComboboxItem({
  className,
  children,
  hideIndicator: _hideIndicator = false,
  selectedFill = true,
  density = "default",
  layout = "default",
  disabledHover = false,
  ...props
}: ComboboxPrimitive.Item.Props & {
  hideIndicator?: boolean;
  /** Off for rows that mark selection themselves, so a fill only means hover or highlight. */
  selectedFill?: boolean;
  /** `comfortable` is a 48px touch row with a tinted selection, for phone sheets. */
  density?: "default" | "comfortable";
  layout?: "default" | "model" | "branch";
  disabledHover?: boolean;
}) {
  return (
    <ComboboxPrimitive.Item
      className={cn(
        "flex min-h-8 in-data-[side=none]:min-w-[calc(var(--anchor-width)+1.25rem)] cursor-pointer items-center rounded-sm px-2 py-1 text-base outline-none not-data-disabled:hover:bg-foreground/[0.09] data-disabled:pointer-events-none data-disabled:cursor-not-allowed data-selected:text-foreground data-highlighted:bg-foreground/[0.09] data-highlighted:text-accent-foreground [&[data-highlighted][data-selected]]:bg-foreground/[0.09] [&[data-highlighted][data-selected]]:text-accent-foreground data-disabled:opacity-64 sm:min-h-7 sm:text-sm [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        selectedFill && "data-selected:bg-foreground/[0.06]",
        layout === "model" && "group relative w-full !min-w-0 max-w-full cursor-pointer",
        layout === "branch" && "w-full min-w-0 grid-cols-[1rem_minmax(0,1fr)]",
        disabledHover && "data-disabled:pointer-events-auto data-disabled:cursor-not-allowed",
        density === "comfortable" &&
          "min-h-12 gap-3 rounded-lg px-3 sm:min-h-12 data-selected:bg-primary/10 [&[data-highlighted][data-selected]]:bg-primary/14",
        className,
      )}
      data-slot="combobox-item"
      {...props}
    >
      <div
        className="flex min-w-0 flex-1 items-center gap-2 [&_svg:not([class*='text-'])]:text-muted-foreground"
        data-slot="combobox-item-content"
      >
        {children}
      </div>
    </ComboboxPrimitive.Item>
  );
}

function ComboboxEmpty({
  className,
  collapseEmpty = false,
  ...props
}: ComboboxPrimitive.Empty.Props & { collapseEmpty?: boolean }) {
  return (
    <ComboboxPrimitive.Empty
      className={cn(
        "not-empty:p-2 text-center text-base text-muted-foreground sm:text-sm",
        collapseEmpty && "empty:h-0",
        className,
      )}
      data-slot="combobox-empty"
      {...props}
    />
  );
}

function ComboboxList({
  className,
  limit,
  ...props
}: ComboboxPrimitive.List.Props & { limit?: "compact" | "candidates" }) {
  return (
    <ScrollArea scrollbarGutter scrollFade>
      <ComboboxPrimitive.List
        className={cn(
          "not-empty:scroll-py-1 not-empty:px-1 not-empty:py-1",
          limit === "compact" && "max-h-64 min-w-0 overflow-x-hidden",
          limit === "candidates" && "max-h-72",
          className,
        )}
        data-slot="combobox-list"
        {...props}
      />
    </ScrollArea>
  );
}

/** Omits ScrollArea when an external virtualizer owns scrolling. */
function ComboboxListVirtualized({
  className,
  column = false,
  ...props
}: ComboboxPrimitive.List.Props & { column?: boolean }) {
  return (
    <ComboboxPrimitive.List
      className={cn(
        "size-full min-w-0 not-empty:px-1 not-empty:py-1",
        column && "flex min-h-0 flex-col",
        className,
      )}
      data-slot="combobox-list"
      {...props}
    />
  );
}

function ComboboxClear({
  className,
  variant = "default",
  compact = false,
  ...props
}: ComboboxPrimitive.Clear.Props & { variant?: "default" | "input"; compact?: boolean }) {
  return (
    <ComboboxPrimitive.Clear
      className={cn(
        variant === "input" &&
          "-translate-y-1/2 absolute top-1/2 inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md border border-transparent opacity-80 outline-none transition-opacity pointer-coarse:after:absolute pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 hover:opacity-100 has-[+[data-slot=combobox-clear]]:hidden sm:size-7 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        variant === "input" && (compact ? "end-0" : "end-0.5"),
        className,
      )}
      data-slot="combobox-clear"
      {...props}
    />
  );
}

function ComboboxStatus({ className, ...props }: ComboboxPrimitive.Status.Props) {
  return (
    <ComboboxPrimitive.Status
      className={cn(
        "px-3 py-2 font-medium text-muted-foreground text-xs empty:m-0 empty:p-0",
        className,
      )}
      data-slot="combobox-status"
      {...props}
    />
  );
}

const useComboboxFilter = ComboboxPrimitive.useFilter;

export {
  Combobox,
  ComboboxInput,
  ComboboxSearchInput,
  ComboboxTrigger,
  ComboboxPopup,
  ComboboxItem,
  ComboboxEmpty,
  ComboboxList,
  ComboboxListVirtualized,
  ComboboxClear,
  ComboboxStatus,
  useComboboxFilter,
};

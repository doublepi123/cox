import { Dialog as CommandDialogPrimitive } from "@base-ui/react/dialog";
import { SearchIcon } from "lucide-react";
import { useRef } from "react";
import type * as React from "react";
import { cn } from "~/lib/utils";
import { useNativeTitlebarHeight } from "~/lib/windowControlsOverlay";
import {
  Autocomplete,
  AutocompleteCollection,
  AutocompleteGroup,
  AutocompleteGroupLabel,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompleteListHeading,
  AutocompleteListVirtualized,
} from "~/components/ui/autocomplete";
import { DIALOG_BACKDROP_CLASS, DIALOG_POPUP_CLASS } from "~/components/ui/dialog-styles";
import { Button } from "~/components/ui/button";
import { useMediaQuery } from "~/hooks/useMediaQuery";

const CommandDialog = CommandDialogPrimitive.Root;

const CommandDialogPortal = CommandDialogPrimitive.Portal;

function CommandDialogTrigger(props: CommandDialogPrimitive.Trigger.Props) {
  return <CommandDialogPrimitive.Trigger data-slot="command-dialog-trigger" {...props} />;
}

function CommandDialogBackdrop({ className, ...props }: CommandDialogPrimitive.Backdrop.Props) {
  return (
    <CommandDialogPrimitive.Backdrop
      className={cn(DIALOG_BACKDROP_CLASS, className)}
      data-slot="command-dialog-backdrop"
      {...props}
    />
  );
}

function CommandDialogViewport({ className, ...props }: CommandDialogPrimitive.Viewport.Props) {
  const nativeTitlebarHeight = useNativeTitlebarHeight();
  const titlebarStyle = {
    "--command-titlebar-height": `${nativeTitlebarHeight}px`,
  } as React.CSSProperties;
  return (
    <CommandDialogPrimitive.Viewport
      className={cn(
        "pointer-events-none fixed inset-0 z-50 flex flex-col items-center px-4 pt-[max(--spacing(4),4vh,calc(var(--command-titlebar-height)+--spacing(2)))] pb-[max(--spacing(4),4vh)] sm:pt-[max(10vh,calc(var(--command-titlebar-height)+--spacing(2)))] sm:pb-[10vh]",
        className,
      )}
      data-slot="command-dialog-viewport"
      style={titlebarStyle}
      {...props}
    />
  );
}

function CommandDialogPopup({
  className,
  children,
  onBackdropPointerDown,
  panel = "default",
  ...props
}: CommandDialogPrimitive.Popup.Props & {
  onBackdropPointerDown?: React.PointerEventHandler<HTMLDivElement>;
  panel?: "default" | "palette" | "clipped";
}) {
  const popupRef = useRef<HTMLDivElement>(null);
  const coarsePointer = useMediaQuery({ pointer: "coarse" });
  return (
    <CommandDialogPortal>
      <CommandDialogBackdrop onPointerDown={onBackdropPointerDown} />
      <CommandDialogViewport>
        <CommandDialogPrimitive.Popup
          // The first tabbable can be an input addon, such as a submenu's Back button.
          initialFocus={() =>
            coarsePointer ? popupRef.current : (popupRef.current?.querySelector("input") ?? true)
          }
          ref={popupRef}
          className={cn(
            DIALOG_POPUP_CLASS,
            "pointer-events-auto max-h-105 max-w-xl text-foreground",
            panel === "palette" && "h-105 overflow-hidden",
            panel === "clipped" && "overflow-hidden",
            className,
          )}
          data-slot="command-dialog-popup"
          {...props}
        >
          {children}
        </CommandDialogPrimitive.Popup>
      </CommandDialogViewport>
    </CommandDialogPortal>
  );
}

function Command({
  autoHighlight = "always",
  keepHighlight = true,
  ...props
}: React.ComponentProps<typeof Autocomplete>) {
  return (
    <Autocomplete
      autoHighlight={autoHighlight}
      inline
      keepHighlight={keepHighlight}
      open
      {...props}
    />
  );
}

function CommandInput({
  className,
  placeholder,
  ...props
}: React.ComponentProps<typeof AutocompleteInput>) {
  const coarsePointer = useMediaQuery({ pointer: "coarse" });
  return (
    <div className="px-[var(--command-shell-inset)] py-1.5 [&_[data-slot=autocomplete-start-addon]]:ps-[calc(var(--command-shell-inset)+0.0625rem)]">
      <AutocompleteInput
        autoFocus={!coarsePointer}
        variant="command"
        className={className}
        placeholder={placeholder}
        size="lg"
        startAddon={<SearchIcon className="translate-x-0.5 text-icon-muted" />}
        {...props}
      />
    </div>
  );
}

function CommandList({ className, ...props }: React.ComponentProps<typeof AutocompleteList>) {
  return (
    <AutocompleteList spacing="command" className={className} data-slot="command-list" {...props} />
  );
}

function CommandListVirtualized({
  className,
  ...props
}: React.ComponentProps<typeof AutocompleteListVirtualized>) {
  return (
    <AutocompleteListVirtualized column className={className} data-slot="command-list" {...props} />
  );
}

function CommandListHeading({
  className,
  ...props
}: React.ComponentProps<typeof AutocompleteListHeading>) {
  return (
    <AutocompleteListHeading className={className} data-slot="command-group-label" {...props} />
  );
}

function CommandPanel({
  className,
  sizing,
  ...props
}: React.ComponentProps<"div"> & { sizing?: "fill" | "tall-list" | "default" }) {
  return (
    <div
      className={cn(
        "relative min-h-0 overflow-hidden rounded-t-xl not-has-[+[data-slot=command-footer]]:rounded-b-2xl bg-transparent **:data-[slot=scroll-area-scrollbar]:mt-2 [touch-action:pan-y]",
        sizing === "fill" && "flex min-h-0 flex-1 flex-col",
        sizing === "tall-list" && "max-h-[min(34rem,76vh)]",
        sizing === "default" && "flex max-h-[min(28rem,70vh)] min-h-0 flex-col",
        className,
      )}
      {...props}
    />
  );
}

function CommandGroup({ className, ...props }: React.ComponentProps<typeof AutocompleteGroup>) {
  return <AutocompleteGroup className={className} data-slot="command-group" {...props} />;
}

function CommandGroupLabel({
  className,
  ...props
}: React.ComponentProps<typeof AutocompleteGroupLabel>) {
  return (
    <AutocompleteGroupLabel className={className} data-slot="command-group-label" {...props} />
  );
}

function CommandCollection({ ...props }: React.ComponentProps<typeof AutocompleteCollection>) {
  return <AutocompleteCollection data-slot="command-collection" {...props} />;
}

// Pass active to override primitive hover/keyboard highlights when the palette tracks its own row.
function CommandItem({
  className,
  active,
  ...props
}: React.ComponentProps<typeof AutocompleteItem> & { active?: boolean }) {
  return (
    <AutocompleteItem
      variant="command"
      {...(active === undefined ? {} : { active })}
      className={className}
      data-active={active || undefined}
      data-slot="command-item"
      {...props}
    />
  );
}

function CommandShortcut({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "ms-auto font-medium font-sans text-secondary-label text-xs tracking-widest",
        className,
      )}
      data-slot="command-shortcut"
      {...props}
    />
  );
}

function CommandFooter({
  className,
  mobileStack = false,
  ...props
}: React.ComponentProps<"div"> & { mobileStack?: boolean }) {
  return (
    <div
      className={cn(
        "relative flex items-center justify-between gap-2 rounded-b-[calc(var(--radius-2xl)-1px)] border-t border-foreground/[0.07] bg-foreground/[0.025] px-[var(--command-content-inset)] py-2.5 font-medium text-sm text-muted-foreground [&_[data-slot=kbd-group]]:font-sans [&_[data-slot=kbd]]:bg-foreground/[0.08] [&_[data-slot=kbd]]:text-foreground [&_[data-slot=kbd]]:ring-0",
        mobileStack && "max-sm:flex-col max-sm:items-start",
        className,
      )}
      data-slot="command-footer"
      {...props}
    />
  );
}

function CommandFooterAction({
  className,
  ...props
}: Omit<React.ComponentProps<typeof Button>, "size" | "variant">) {
  return <Button {...props} variant="command-hint" size="command-hint" className={className} />;
}

export {
  Command,
  CommandCollection,
  CommandDialog,
  CommandDialogPopup,
  CommandDialogTrigger,
  CommandFooter,
  CommandFooterAction,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandListHeading,
  CommandListVirtualized,
  CommandPanel,
  CommandShortcut,
};

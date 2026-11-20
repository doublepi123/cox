import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";
import { use } from "react";

import { cn } from "~/lib/utils";
import {
  DIALOG_BACKDROP_CLASS,
  DIALOG_MOBILE_SHEET_CLASS,
  DIALOG_POPUP_CLASS,
  DIALOG_REDUCED_MOTION_CLASS,
} from "~/components/ui/dialog-styles";
import {
  ControlledOpenContext,
  DialogSuppressionContext,
  renderRetainedPopup,
} from "~/components/ui/dialog";

function AlertDialog<Payload>(props: AlertDialogPrimitive.Root.Props<Payload>) {
  const suppressed = use(DialogSuppressionContext);
  return (
    <ControlledOpenContext value={suppressed ? false : props.open}>
      <AlertDialogPrimitive.Root {...props} {...(suppressed ? { open: false } : {})} />
    </ControlledOpenContext>
  );
}

const AlertDialogPortal = AlertDialogPrimitive.Portal;

function AlertDialogBackdrop({ className, ...props }: AlertDialogPrimitive.Backdrop.Props) {
  return (
    <AlertDialogPrimitive.Backdrop
      forceRender
      className={cn(DIALOG_BACKDROP_CLASS, className)}
      data-slot="alert-dialog-backdrop"
      {...props}
    />
  );
}

function AlertDialogViewport({
  className,
  bottomStickOnMobile = false,
  ...props
}: AlertDialogPrimitive.Viewport.Props & { bottomStickOnMobile?: boolean }) {
  return (
    <AlertDialogPrimitive.Viewport
      className={cn(
        "fixed inset-0 z-50 grid grid-rows-[1fr_auto_1fr] justify-items-center p-4",
        bottomStickOnMobile &&
          "max-sm:grid-rows-[1fr_auto] max-sm:px-0 max-sm:pt-[max(3rem,var(--workspace-safe-top))]! max-sm:pb-safe!",
        className,
      )}
      data-slot="alert-dialog-viewport"
      {...props}
    />
  );
}

function AlertDialogPopup({
  className,
  bottomStickOnMobile = true,
  portalContainer,
  layer = "default",
  reducedMotion = "default",
  ...props
}: AlertDialogPrimitive.Popup.Props & {
  bottomStickOnMobile?: boolean;
  reducedMotion?: "default" | "opacity";
  portalContainer?: AlertDialogPrimitive.Portal.Props["container"];
  layer?: "default" | "application";
}) {
  return (
    <AlertDialogPrimitive.Portal
      container={portalContainer}
      className={layer === "application" ? "relative z-[150]" : undefined}
    >
      <AlertDialogBackdrop />
      <AlertDialogViewport bottomStickOnMobile={bottomStickOnMobile}>
        <AlertDialogPrimitive.Popup
          className={cn(
            DIALOG_POPUP_CLASS,
            "row-start-2 max-h-full max-w-lg text-popover-foreground",
            reducedMotion === "opacity" && DIALOG_REDUCED_MOTION_CLASS,
            bottomStickOnMobile && DIALOG_MOBILE_SHEET_CLASS,
            className,
          )}
          data-slot="alert-dialog-popup"
          render={renderRetainedPopup}
          {...props}
        />
      </AlertDialogViewport>
    </AlertDialogPrimitive.Portal>
  );
}

function AlertDialogHeader({
  className,
  shrink = true,
  ...props
}: React.ComponentProps<"div"> & { shrink?: boolean }) {
  return (
    <div
      className={cn(
        "flex min-h-0 flex-col gap-2 p-6 text-center max-sm:pb-4 sm:text-left",
        !shrink && "shrink-0",
        className,
      )}
      data-slot="alert-dialog-header"
      {...props}
    />
  );
}

function AlertDialogFooter({
  className,
  variant = "default",
  shrink = true,
  ...props
}: React.ComponentProps<"div"> & {
  variant?: "default" | "bare";
  shrink?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col-reverse gap-2 px-6 sm:flex-row sm:justify-end sm:rounded-b-[calc(var(--radius-2xl)-1px)]",
        !shrink && "shrink-0",
        variant === "default" && "border-t bg-muted/72 py-4",
        variant === "bare" && "pb-6",
        className,
      )}
      data-slot="alert-dialog-footer"
      {...props}
    />
  );
}

function AlertDialogTitle({ className, ...props }: AlertDialogPrimitive.Title.Props) {
  return (
    <AlertDialogPrimitive.Title
      className={cn("wrap-anywhere shrink-0 font-semibold text-xl leading-snug", className)}
      data-slot="alert-dialog-title"
      {...props}
    />
  );
}

function AlertDialogDescription({
  className,
  visuallyHidden = false,
  preserveLines = false,
  scrollable = true,
  ...props
}: AlertDialogPrimitive.Description.Props & {
  visuallyHidden?: boolean;
  preserveLines?: boolean;
  scrollable?: boolean;
}) {
  return (
    <AlertDialogPrimitive.Description
      className={cn(
        "wrap-anywhere min-h-0 text-muted-foreground text-sm select-text",
        scrollable && "max-h-[min(24rem,60dvh)] overflow-y-auto overscroll-contain",
        visuallyHidden && "sr-only",
        preserveLines && "whitespace-pre-line",
        className,
      )}
      data-slot="alert-dialog-description"
      {...props}
    />
  );
}

function AlertDialogClose(props: AlertDialogPrimitive.Close.Props) {
  return <AlertDialogPrimitive.Close data-slot="alert-dialog-close" {...props} />;
}

export {
  AlertDialog,
  AlertDialogPortal,
  AlertDialogBackdrop,
  AlertDialogBackdrop as AlertDialogOverlay,
  AlertDialogPopup,
  AlertDialogPopup as AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogClose,
  AlertDialogViewport,
};

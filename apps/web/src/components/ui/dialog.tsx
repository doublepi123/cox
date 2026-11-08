import { useTranslation } from "../../i18n";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { XIcon } from "lucide-react";
import { type ComponentProps, createContext, type ReactNode, use, useState } from "react";
import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import {
  DIALOG_BACKDROP_CLASS,
  DIALOG_MEDIA_BACKDROP_CLASS,
  DIALOG_MEDIA_POPUP_CLASS,
  DIALOG_MOBILE_SHEET_CLASS,
  DIALOG_POPUP_CLASS,
} from "~/components/ui/dialog-styles";
import { ScrollArea } from "~/components/ui/scroll-area";

const ControlledOpenContext = createContext<boolean | undefined>(undefined);
const DialogSuppressionContext = createContext(false);

function RetainedWhileClosed({ open, children }: { open: boolean; children: ReactNode }) {
  const controlledOpen = use(ControlledOpenContext);
  const isOpen = open && controlledOpen !== false;
  const [retained, setRetained] = useState(children);
  if (isOpen && retained !== children) {
    setRetained(children);
  }
  return isOpen ? children : retained;
}

function renderRetainedPopup(props: ComponentProps<"div">, state: { open: boolean }) {
  return (
    <div {...props}>
      <RetainedWhileClosed open={state.open}>{props.children}</RetainedWhileClosed>
    </div>
  );
}

function Dialog<Payload>(props: DialogPrimitive.Root.Props<Payload>) {
  const suppressed = use(DialogSuppressionContext);
  return (
    <ControlledOpenContext value={suppressed ? false : props.open}>
      <DialogPrimitive.Root {...props} {...(suppressed ? { open: false } : {})} />
    </ControlledOpenContext>
  );
}

const DialogPortal = DialogPrimitive.Portal;

function DialogTrigger(props: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogClose(props: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogBackdrop({
  className,
  variant = "default",
  elevated = false,
  ...props
}: DialogPrimitive.Backdrop.Props & { variant?: "default" | "media"; elevated?: boolean }) {
  return (
    <DialogPrimitive.Backdrop
      forceRender
      className={cn(
        variant === "media" ? DIALOG_MEDIA_BACKDROP_CLASS : DIALOG_BACKDROP_CLASS,
        elevated && "z-[60]",
        className,
      )}
      data-slot="dialog-backdrop"
      {...props}
    />
  );
}

function DialogViewport({
  className,
  media = false,
  bottomStickOnMobile = false,
  ...props
}: DialogPrimitive.Viewport.Props & { media?: boolean; bottomStickOnMobile?: boolean }) {
  return (
    <DialogPrimitive.Viewport
      className={cn(
        "fixed inset-0 z-50 grid grid-rows-[1fr_auto_1fr] justify-items-center p-4",
        bottomStickOnMobile && "max-sm:grid-rows-[1fr_auto] max-sm:p-0 max-sm:pt-12",
        media &&
          "z-[60] grid-rows-1 place-items-center px-4 pb-6 pt-[calc(var(--native-titlebar-height,0px)+1.5rem)] [-webkit-app-region:no-drag]",
        className,
      )}
      data-slot="dialog-viewport"
      {...props}
    />
  );
}

function DialogPopup({
  className,
  children,
  showCloseButton = true,
  bottomStickOnMobile = true,
  variant = "default",
  width = "default",
  surface = "default",
  clipped = false,
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean;
  bottomStickOnMobile?: boolean;
  variant?: "default" | "media";
  width?: "default" | "sm" | "md" | "lg" | "xl" | "2xl" | "3xl" | "4xl" | "icon-picker";
  surface?: "default" | "attachment" | "image" | "preview";
  clipped?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <DialogPortal>
      {/* Media opens from inside other overlays (a composer chip, a popover), so it sits above them. */}
      <DialogBackdrop elevated={variant === "media"} variant={variant} />
      <DialogViewport media={variant === "media"} bottomStickOnMobile={bottomStickOnMobile}>
        <DialogPrimitive.Popup
          className={cn(
            variant === "media" ? DIALOG_MEDIA_POPUP_CLASS : DIALOG_POPUP_CLASS,
            "row-start-2 text-popover-foreground",
            variant === "default" && "max-h-full max-w-lg",
            {
              default: "",
              sm: "sm:max-w-sm",
              md: "max-w-md",
              lg: "max-w-lg",
              xl: "max-w-xl",
              "2xl": "max-w-2xl",
              "3xl": "max-w-3xl",
              "4xl": "max-w-4xl",
              "icon-picker": "w-full sm:w-[32rem]",
            }[width],
            surface === "attachment" && "h-[min(85vh,52rem)] overflow-hidden",
            surface === "image" &&
              "row-start-1 h-full w-[92vw] max-h-[92vh] max-w-[92vw] items-center justify-center overflow-visible [--media-width:92vw] sm:[--media-width:calc(92vw-96px)] [--media-height:min(calc((100vh-var(--native-titlebar-height,0px))*0.86),calc(100vh-var(--native-titlebar-height,0px)-160px))]",
            surface === "preview" && "row-start-1",
            clipped && "overflow-hidden",
            bottomStickOnMobile && DIALOG_MOBILE_SHEET_CLASS,
            className,
          )}
          data-slot="dialog-popup"
          render={renderRetainedPopup}
          {...props}
        >
          {children}
          {showCloseButton && (
            <div className="absolute end-2 top-2">
              <DialogPrimitive.Close
                aria-label={t("Close")}
                render={<Button size="icon" variant="ghost" />}
              >
                <XIcon />
              </DialogPrimitive.Close>
            </div>
          )}
        </DialogPrimitive.Popup>
      </DialogViewport>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 p-6 in-[[data-slot=dialog-popup]:has([data-slot=dialog-panel])]:pb-3 max-sm:pb-4",
        className,
      )}
      data-slot="dialog-header"
      {...props}
    />
  );
}

function DialogFooter({
  className,
  variant = "default",
  layout = "default",
  ...props
}: React.ComponentProps<"div"> & {
  variant?: "default" | "bare";
  layout?: "default" | "between" | "centered-between" | "wrap";
}) {
  return (
    <div
      className={cn(
        "flex flex-col-reverse gap-2 px-6 sm:flex-row sm:justify-end sm:rounded-b-[calc(var(--radius-2xl)-1px)]",
        variant === "default" && "border-t bg-muted/72 py-4",
        variant === "bare" && "py-4",
        layout === "between" && "sm:justify-between",
        layout === "centered-between" && "items-center sm:justify-between",
        layout === "wrap" && "sm:flex-wrap sm:items-center",
        className,
      )}
      data-slot="dialog-footer"
      {...props}
    />
  );
}

function DialogTitle({
  className,
  visuallyHidden = false,
  withIcon = false,
  ...props
}: DialogPrimitive.Title.Props & { visuallyHidden?: boolean; withIcon?: boolean }) {
  return (
    <DialogPrimitive.Title
      className={cn(
        "wrap-anywhere font-semibold text-xl leading-none",
        visuallyHidden && "sr-only",
        withIcon && "flex items-center",
        className,
      )}
      data-slot="dialog-title"
      {...props}
    />
  );
}

function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      className={cn("text-muted-foreground text-sm", className)}
      data-slot="dialog-description"
      {...props}
    />
  );
}

function DialogPanel({
  className,
  scrollFade = true,
  flex = false,
  ...props
}: React.ComponentProps<"div"> & { scrollFade?: boolean; flex?: boolean }) {
  return (
    <ScrollArea scrollFade={scrollFade}>
      <div
        className={cn(
          "space-y-4 p-6 in-[[data-slot=dialog-popup]:has([data-slot=dialog-header])]:pt-1 in-[[data-slot=dialog-popup]:has([data-slot=dialog-footer]:not(.border-t))]:pb-1",
          flex && "flex min-h-0 flex-col",
          className,
        )}
        data-slot="dialog-panel"
        {...props}
      />
    </ScrollArea>
  );
}

export {
  ControlledOpenContext,
  DialogSuppressionContext,
  renderRetainedPopup,
  Dialog,
  DialogTrigger,
  DialogPortal,
  DialogClose,
  DialogBackdrop,
  DialogBackdrop as DialogOverlay,
  DialogPopup,
  DialogPopup as DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogViewport,
};

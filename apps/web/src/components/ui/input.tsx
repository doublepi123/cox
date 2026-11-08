import { Input as InputPrimitive } from "@base-ui/react/input";
import type * as React from "react";

import { cn } from "~/lib/utils";

type InputProps = Omit<InputPrimitive.Props & React.RefAttributes<HTMLInputElement>, "size"> & {
  size?: "sm" | "compact" | "default" | "lg" | "touch" | number;
  font?: "default" | "mono";
  unstyled?: boolean;
  variant?: "default" | "sidebar" | "menu-search" | "combobox" | "combobox-search" | "command";
  nativeInput?: boolean;
  adornment?: "autocomplete" | "combobox";
  hasStartAddon?: boolean;
  hasEndAddon?: boolean;
};

function Input({
  className,
  size = "default",
  font = "default",
  unstyled = false,
  variant = "default",
  nativeInput = false,
  adornment,
  hasStartAddon = false,
  hasEndAddon = false,
  ...props
}: InputProps) {
  const isUnstyled = unstyled || ["sidebar", "menu-search", "combobox-search"].includes(variant);
  const inputClassName = cn(
    "h-8.5 w-full min-w-0 rounded-[inherit] px-[calc(--spacing(3)-1px)] leading-8.5 outline-none placeholder:text-placeholder sm:h-7.5 sm:leading-7.5 [transition:background-color_5000000s_ease-in-out_0s]",
    size === "compact" && "h-7 px-[calc(--spacing(2.5)-1px)] text-xs leading-7 sm:h-7 sm:leading-7",
    size === "sm" && "h-7.5 px-[calc(--spacing(2.5)-1px)] leading-7.5 sm:h-6.5 sm:leading-6.5",
    size === "lg" && "h-9.5 leading-9.5 sm:h-8.5 sm:leading-8.5",
    variant === "menu-search" && "h-6.5 ps-5 font-sans leading-6.5 sm:h-6.5 sm:leading-6.5",
    variant === "sidebar" &&
      "h-auto p-0 font-medium text-base leading-normal text-sidebar-foreground placeholder:text-sidebar-muted-foreground md:text-sm sm:h-auto sm:leading-normal",
    adornment &&
      hasStartAddon &&
      (size === "sm"
        ? "ps-[calc(--spacing(7.5)-1px)] sm:ps-[calc(--spacing(7)-1px)]"
        : "ps-[calc(--spacing(8.5)-1px)] sm:ps-[calc(--spacing(8)-1px)]"),
    hasEndAddon && (size === "sm" ? "pe-6.5" : "pe-7"),
    variant === "command" && "ps-9! sm:ps-[calc(var(--command-shell-inset)+1.5rem)]!",
    props.type === "search" &&
      "[&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none [&::-webkit-search-results-button]:appearance-none [&::-webkit-search-results-decoration]:appearance-none",
    props.type === "number" &&
      "[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none",
    props.type === "file" &&
      "text-muted-foreground file:me-3 file:bg-transparent file:font-medium file:text-foreground file:text-sm",
  );
  let inputElement: React.ReactElement;

  if (nativeInput) {
    const { style, onValueChange: _onValueChange, ...nativeInputProps } = props;
    const nativeStyle = typeof style === "function" ? undefined : style;

    inputElement = (
      <input
        className={inputClassName}
        data-slot="input"
        size={typeof size === "number" ? size : undefined}
        style={nativeStyle}
        {...(nativeInputProps as React.ComponentProps<"input">)}
      />
    );
  } else {
    inputElement = (
      <InputPrimitive
        className={inputClassName}
        data-slot="input"
        size={typeof size === "number" ? size : undefined}
        {...props}
      />
    );
  }

  return (
    <span
      className={
        cn(
          !isUnstyled &&
            "relative inline-flex w-full rounded-lg border border-input bg-background not-dark:bg-clip-padding text-base text-foreground shadow-xs/5 ring-ring/24 transition-shadow before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] not-has-disabled:not-has-focus-visible:not-has-aria-invalid:before:shadow-[0_1px_--theme(--color-black/4%)] has-focus-visible:has-aria-invalid:border-destructive/64 has-focus-visible:has-aria-invalid:ring-destructive/16 has-aria-invalid:border-destructive/36 has-focus-visible:border-ring has-autofill:bg-foreground/4 has-disabled:opacity-64 has-[:disabled,:focus-visible,[aria-invalid]]:shadow-none has-focus-visible:ring-[3px] has-focus-visible:ring-inset sm:text-sm dark:bg-input/32 dark:has-autofill:bg-foreground/8 dark:has-aria-invalid:ring-destructive/24 dark:not-has-disabled:not-has-focus-visible:not-has-aria-invalid:before:shadow-[0_-1px_--theme(--color-white/6%)]",
          !isUnstyled &&
            size === "compact" &&
            "rounded-md before:rounded-[calc(var(--radius-md)-1px)]",
          font === "mono" && "font-mono tabular-nums",
          size === "touch" && "h-9 sm:h-8",
          variant === "sidebar" && "min-w-0 flex-1",
          variant === "combobox" && "has-disabled:opacity-100",
          variant === "combobox-search" &&
            "rounded-none bg-transparent text-sm has-disabled:opacity-100",
          variant === "menu-search" && "rounded-none bg-transparent text-sm",
          variant === "command" &&
            "border-transparent! bg-transparent! shadow-none before:hidden has-focus-visible:ring-0 placeholder:text-placeholder",
          className,
        ) || undefined
      }
      data-size={size}
      data-slot="input-control"
    >
      {inputElement}
    </span>
  );
}

export { Input, type InputProps };

import type { KeyboardEvent } from "react";

export function commitNumberFieldOnEnter(event: KeyboardEvent<HTMLInputElement>) {
  if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229) return;
  const input = event.currentTarget;
  input.blur();
  input.focus();
}

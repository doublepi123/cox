import * as Schema from "effect/Schema";
import { useLocalStorage } from "../../hooks/useLocalStorage";

export const TERMINAL_TOUCH_FONT_SIZE_KEY = "cox:terminal-touch-font-size";
const FontSize = Schema.NullOr(Schema.Number);

export function useTouchTerminalFontSize(defaultSize: number) {
  const [stored, setStored] = useLocalStorage(TERMINAL_TOUCH_FONT_SIZE_KEY, null, FontSize);
  const size = stored === null ? defaultSize : Math.max(10, Math.min(20, Math.round(stored)));
  return [size, (next: number) => setStored(Math.max(10, Math.min(20, next)))] as const;
}

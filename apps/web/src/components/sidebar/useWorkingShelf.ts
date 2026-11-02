import * as Schema from "effect/Schema";
import { useLocalStorage } from "../../hooks/useLocalStorage";

export const WORKING_SHELF_EXPANDED_KEY = "cox:sidebar:working-expanded";

export function useWorkingShelf<Thread>(threads: readonly Thread[]) {
  const [expanded, setExpanded] = useLocalStorage(WORKING_SHELF_EXPANDED_KEY, true, Schema.Boolean);
  return {
    expanded,
    toggle: () => setExpanded((value) => !value),
    visibleThreads: expanded ? threads : [],
  };
}

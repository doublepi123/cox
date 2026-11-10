import type { EnvironmentId, RunId } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import type { Thread } from "../../types";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useServerConfigs } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";

let dismissedKeys: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();
const subscribeDismissed = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const readDismissed = () => dismissedKeys;
const dismissKey = (environmentId: EnvironmentId, runId: RunId) => `${environmentId}\u0000${runId}`;

export function usePromptSuggestion(
  environmentId: EnvironmentId,
  thread: Thread | undefined,
): { readonly suggestion: string | null; readonly dismiss: () => void } {
  const enabled = useServerConfigs().get(environmentId)?.settings.promptSuggestionsEnabled === true;
  const hasFinePointer = useMediaQuery("(any-pointer: fine)");
  const { data } = useEnvironmentQuery(
    enabled && hasFinePointer && thread?.latestRun
      ? orchestrationEnvironment.v2.promptSuggestion({
          environmentId,
          input: { threadId: thread.id },
        })
      : null,
  );
  const dismissed = useSyncExternalStore(subscribeDismissed, readDismissed);
  const latestRun = thread?.latestRun;
  const offered =
    data && latestRun?.runId === data.runId && latestRun.status === "completed" ? data : null;
  return {
    suggestion:
      offered && !dismissed.has(dismissKey(environmentId, offered.runId)) ? offered.text : null,
    dismiss: () => {
      if (offered === null) return;
      dismissedKeys = new Set(dismissedKeys).add(dismissKey(environmentId, offered.runId));
      for (const listener of listeners) listener();
    },
  };
}

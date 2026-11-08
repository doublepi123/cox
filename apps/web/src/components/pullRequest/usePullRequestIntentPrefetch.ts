import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useRef, useState } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";

import { pullRequestPanelReference } from "./usePullRequestDetail";

const INTENT_DELAY_MS = 150;

interface PullRequestIntentTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly host: string;
  readonly repository: string;
  readonly number: number;
}

export function usePullRequestIntentPrefetch(
  isListed: (target: PullRequestIntentTarget) => boolean,
) {
  const [target, setTarget] = useState<PullRequestIntentTarget | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const listed = target !== null && isListed(target);
  if (target !== null && !listed) setTarget(null);
  useEnvironmentQuery(
    target === null || !listed
      ? null
      : pullRequestEnvironment.detail({
          environmentId: target.environmentId,
          input: {
            ...pullRequestPanelReference({ ...target, host: target.host.toLowerCase() }),
            allowStale: false,
          },
        }),
  );
  return useStableCallback((next: PullRequestIntentTarget | null) => {
    clearTimeout(timer.current);
    if (next === null) {
      setTarget(null);
      return;
    }
    timer.current = setTimeout(() => setTarget(next), INTENT_DELAY_MS);
  });
}

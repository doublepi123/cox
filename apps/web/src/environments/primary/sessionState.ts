import { useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useRef } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { fetchSessionState } from "./auth";

const primarySessionStateAtom = Atom.make(
  Effect.suspend(() => Effect.promise(fetchSessionState)),
).pipe(
  Atom.swr({ staleTime: 5_000, revalidateOnMount: true }),
  Atom.setIdleTTL(5 * 60_000),
  Atom.withLabel("primary-environment:session"),
);

const primaryConnectionPhaseAtom = Atom.make((get) => {
  const environmentId = get(primaryEnvironmentIdAtom);
  if (environmentId === null) return null;
  return (
    AsyncResult.getOrElse(get(environmentCatalog.stateAtom(environmentId)), () => null)?.phase ??
    null
  );
});

function refreshPrimarySessionState(): void {
  appAtomRegistry.refresh(primarySessionStateAtom);
}

export function usePrimarySessionState() {
  const result = useAtomValue(primarySessionStateAtom);
  const connectionPhase = useAtomValue(primaryConnectionPhaseAtom);
  const previousConnectionPhaseRef = useRef(connectionPhase);
  useEffect(() => {
    if (previousConnectionPhaseRef.current === connectionPhase) return;
    previousConnectionPhaseRef.current = connectionPhase;
    refreshPrimarySessionState();
  }, [connectionPhase]);
  let error: string | null = null;
  if (result._tag === "Failure") {
    const cause = Cause.squash(result.cause);
    error = cause instanceof Error ? cause.message : "Could not read environment session.";
  }
  return {
    data: AsyncResult.getOrElse(result, () => null),
    error,
    isPending: result.waiting,
    refresh: refreshPrimarySessionState,
  };
}

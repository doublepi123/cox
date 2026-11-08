import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../../rpc/atomRegistry";

const freshSessionArmsAtom = Atom.make<Readonly<Record<string, number>>>({}).pipe(Atom.keepAlive);
let lastArm = 0;

export function armFreshSession(threadKey: string): void {
  lastArm = Math.max(lastArm + 1, Date.now());
  appAtomRegistry.set(freshSessionArmsAtom, {
    ...appAtomRegistry.get(freshSessionArmsAtom),
    [threadKey]: lastArm,
  });
}

export function disarmFreshSession(threadKey: string, arm?: number): void {
  const current = appAtomRegistry.get(freshSessionArmsAtom);
  if (current[threadKey] === undefined || (arm !== undefined && current[threadKey] !== arm)) return;
  const { [threadKey]: _removed, ...rest } = current;
  appAtomRegistry.set(freshSessionArmsAtom, rest);
}

export function readFreshSessionArm(threadKey: string): number | undefined {
  return appAtomRegistry.get(freshSessionArmsAtom)[threadKey];
}

export function useFreshSessionArmed(threadKey: string): boolean {
  return useAtomValue(freshSessionArmsAtom)[threadKey] !== undefined;
}

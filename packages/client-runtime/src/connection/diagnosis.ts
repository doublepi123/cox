import type { ConnectionHop, SupervisorConnectionState } from "./model.ts";

export type ConnectionHopResult = "ok" | "failed" | "unchecked";

export interface ConnectionDiagnosisHop {
  readonly hop: ConnectionHop;
  readonly label: string;
  readonly result: ConnectionHopResult;
}

export interface ConnectionDiagnosis {
  /** Names the part that failed, e.g. "Mac mini's tunnel is offline". */
  readonly headline: string;
  readonly hops: ReadonlyArray<ConnectionDiagnosisHop>;
  readonly steps: ReadonlyArray<string>;
  readonly facts: ReadonlyArray<readonly [label: string, value: string]>;
  /** The troubleshooting guide section for this failure. Null for direct routes. */
  readonly moreInfoUrl: string | null;
}

export interface ConnectionDiagnosisInput {
  readonly hostLabel: string;
  readonly state: SupervisorConnectionState;
  readonly via?: "direct";
  readonly clientVersion?: string;
  readonly serverVersion?: string | null;
}

export function presentConnectionDiagnosis(
  input: ConnectionDiagnosisInput,
): ConnectionDiagnosis | null {
  if (input.state.phase === "connected") return null;
  return {
    headline: input.state.lastFailure?.message ?? "The local server is not connected.",
    hops: [{ hop: "server", label: "Local server", result: "failed" }],
    steps: [
      "Check that the Cox server is running, then reconnect.",
      "Reload this page if the server was restarted.",
    ],
    facts: [],
    moreInfoUrl: null,
  };
}

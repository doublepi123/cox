import type { PiRpcRecord } from "@t3tools/provider-pi/server";

const terminalStates = new Set(["done", "failed", "cancelled"]);
const syntheticHumanKinds = new Set(["goal_blocked", "goal_paused", "stalled", "interrupted_run"]);
const syntheticQuestionRequestId = /^question:[^:\s]+:[1-9]\d*$/;

function record(value: unknown): PiRpcRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as PiRpcRecord)
    : {};
}

function omoSyntheticHumanWait(value: unknown): boolean {
  const wait = record(value);
  if (typeof wait.kind !== "string") return false;
  if (syntheticHumanKinds.has(wait.kind)) return true;
  return (
    wait.kind === "question" &&
    typeof wait.requestId === "string" &&
    syntheticQuestionRequestId.test(wait.requestId)
  );
}

function omoIdleUiClear(state: PiRpcRecord): boolean {
  return (
    (!Array.isArray(state.pendingDialogs) || state.pendingDialogs.length === 0) &&
    (!Array.isArray(state.pendingQuestions) || state.pendingQuestions.length === 0)
  );
}

function omoIdleWait(value: unknown): boolean {
  const lifecycle = record(value);
  const waits = record(lifecycle.waitingOn);
  return (
    (lifecycle.state === "waiting_human" || lifecycle.state === "waiting_background") &&
    lifecycle.runActive !== true &&
    lifecycle.runPaused !== true &&
    lifecycle.activity === undefined &&
    Array.isArray(lifecycle.holds) &&
    lifecycle.holds.length === 0 &&
    waits.children === 0 &&
    Array.isArray(waits.background) &&
    waits.background.every((wait) => {
      const source = record(wait).source;
      return typeof source === "string" && source.length > 0 && !source.startsWith("delivery:");
    }) &&
    Array.isArray(waits.human) &&
    waits.human.every(omoSyntheticHumanWait) &&
    waits.human.length + waits.background.length > 0
  );
}

const omoWaitLabels: Readonly<Record<string, string>> = {
  "terminal-monitors": "terminal monitors",
  "terminal-background-sessions": "background terminal sessions",
};

export const OMO_WAIT_STATUS_KEY = "cox-omo-wait";

function omoWaitStatusText(value: unknown): string | undefined {
  const background = record(record(value).waitingOn).background;
  if (!Array.isArray(background)) return undefined;
  const labels = [
    ...new Set(
      background.flatMap((value) => {
        const source = record(value).source;
        if (typeof source !== "string" || /memory/.test(source) || source.startsWith("delivery:"))
          return [];
        return [omoWaitLabels[source] ?? source];
      }),
    ),
  ];
  return labels.length === 0
    ? undefined
    : `Waiting for background work: ${labels.join(", ")}. Not generating; send a message to continue now.`;
}

export class OmoLifecycle {
  private readonly ephemeral: boolean;

  constructor(ephemeral = false) {
    this.ephemeral = ephemeral;
  }
  private sessionId: string | undefined;
  private sequence = -1;
  private runId: string | undefined;
  private idle = false;
  private latest: PiRpcRecord | undefined;
  private waitStatus: string | undefined;
  private idleSettledRun: string | undefined;
  private readonly completions = new Set<string>();

  reset() {
    this.sessionId = undefined;
    this.sequence = -1;
    this.runId = undefined;
    this.idle = false;
    this.latest = undefined;
    this.waitStatus = undefined;
    this.idleSettledRun = undefined;
    this.completions.clear();
  }

  private showWait(text: string | undefined): ReadonlyArray<PiRpcRecord> {
    if (text === this.waitStatus) return [];
    this.waitStatus = text;
    return [
      {
        type: "extension_ui_request",
        method: "setStatus",
        statusKey: OMO_WAIT_STATUS_KEY,
        ...(text === undefined ? {} : { statusText: text }),
      },
    ];
  }

  bind(value: unknown) {
    const state = record(value);
    if (typeof state.sessionId !== "string") return;
    if (this.sessionId !== undefined && this.sessionId !== state.sessionId) this.reset();
    this.sessionId = state.sessionId;
  }

  observe(event: PiRpcRecord): ReadonlyArray<PiRpcRecord> {
    if (event.type === "agent_start") {
      this.runId = typeof event.runId === "string" ? event.runId : undefined;
      this.idle = false;
      this.idleSettledRun = undefined;
      if (this.runId !== undefined) this.completions.delete(`turn:${this.runId}`);
      return [...this.showWait(undefined), event];
    }
    if (event.type === "auto_retry_start") this.idle = false;
    if (event.type === "agent_idle") {
      this.idle = true;
      return this.latest === undefined ? [] : this.settle(this.latest);
    }
    if (event.type === "agent_settled") return [];
    if (event.type !== "session_lifecycle") return [event];
    const lifecycle = record(event.lifecycle);
    if (lifecycle.role === "child") return [];
    if (typeof lifecycle.seq !== "number" || typeof lifecycle.state !== "string") return [];
    const sessionId = typeof event.sessionId === "string" ? event.sessionId : undefined;
    if (this.sessionId !== undefined && sessionId !== undefined && sessionId !== this.sessionId)
      return [];
    if (sessionId !== undefined) this.sessionId = sessionId;
    if (lifecycle.seq < this.sequence) return [];
    const advanced = lifecycle.seq > this.sequence;
    this.sequence = lifecycle.seq;
    this.latest = lifecycle;
    const waiting =
      this.waitStatus === undefined
        ? []
        : this.showWait(omoIdleWait(lifecycle) ? omoWaitStatusText(lifecycle) : undefined);
    if (!advanced && !omoIdleWait(lifecycle)) return waiting;
    return [...waiting, ...this.settle(lifecycle)];
  }

  private settle(lifecycle: PiRpcRecord): ReadonlyArray<PiRpcRecord> {
    const idleWait = this.idle && omoIdleWait(lifecycle);
    if (typeof lifecycle.state !== "string" || (!terminalStates.has(lifecycle.state) && !idleWait))
      return [];
    if (lifecycle.restoring === true || (lifecycle.persisted !== true && !this.ephemeral))
      return [];
    if (
      this.runId !== undefined &&
      typeof lifecycle.runId === "string" &&
      lifecycle.runId !== this.runId
    )
      return [];
    const completionId = idleWait
      ? typeof lifecycle.runId === "string"
        ? `turn:${lifecycle.runId}`
        : undefined
      : lifecycle.completionId;
    if (typeof completionId !== "string" || this.completions.has(completionId)) return [];
    this.completions.add(completionId);
    if (this.completions.size > 128) {
      const oldest = this.completions.values().next().value;
      if (oldest !== undefined) this.completions.delete(oldest);
    }
    if (!idleWait && lifecycle.runId !== undefined && lifecycle.runId === this.idleSettledRun)
      return [];
    if (idleWait && typeof lifecycle.runId === "string") this.idleSettledRun = lifecycle.runId;
    return [
      ...(idleWait ? this.showWait(omoWaitStatusText(lifecycle)) : []),
      ...(lifecycle.state === "failed" ||
      (idleWait && lifecycle.failure !== undefined && lifecycle.failure !== null)
        ? [
            {
              type: "message_end",
              message: {
                role: "assistant",
                content: [],
                stopReason: "error",
                errorMessage: "OMO Native reported that the task failed.",
              },
            },
          ]
        : []),
      { type: "agent_settled", aborted: lifecycle.state === "cancelled" },
    ];
  }
}

export function omoSessionState(value: unknown, ephemeral = false): unknown {
  const state = record(value);
  const lifecycle = record(state.lifecycle);
  if (typeof lifecycle.state !== "string")
    throw new Error("OMO Native did not expose the required session lifecycle.");
  return (terminalStates.has(lifecycle.state) ||
    (omoIdleWait(lifecycle) && state.isStreaming === false && omoIdleUiClear(state))) &&
    lifecycle.restoring !== true &&
    (lifecycle.persisted === true || ephemeral || lifecycle.epoch === 0)
    ? state
    : { ...state, isStreaming: true };
}

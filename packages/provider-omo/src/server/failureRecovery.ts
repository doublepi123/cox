import type { PiRpcRecord } from "@t3tools/provider-pi/server";

function record(value: unknown): PiRpcRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as PiRpcRecord)
    : {};
}

export class OmoFailureRecovery {
  private runId: string | undefined;
  private failed = false;
  private idle = false;

  reset() {
    this.runId = undefined;
    this.failed = false;
    this.idle = false;
  }

  observe(event: PiRpcRecord): boolean {
    if (event.type === "agent_start") {
      this.reset();
      this.runId = typeof event.runId === "string" ? event.runId : undefined;
    }
    if (event.type === "message_end" && record(event.message).role === "assistant")
      this.failed = record(event.message).stopReason === "error";
    if (event.type === "auto_retry_start") this.idle = false;
    if (event.type === "agent_idle") this.idle = true;
    return (
      this.failed &&
      this.idle &&
      (event.type === "agent_idle" || event.type === "session_lifecycle")
    );
  }

  stranded(value: unknown): boolean {
    return (
      this.failed &&
      this.idle &&
      this.runId !== undefined &&
      record(record(value).lifecycle).runId === this.runId &&
      omoStrandedFailure(value)
    );
  }
}

function omoStrandedFailure(value: unknown): boolean {
  const state = record(value);
  const lifecycle = record(state.lifecycle);
  const waits = record(lifecycle.waitingOn);
  const background = Array.isArray(waits.background) ? waits.background : undefined;
  const queuedDeliveries =
    lifecycle.runActive !== true &&
    background !== undefined &&
    background.length > 0 &&
    background.every((value) => {
      const source = record(value).source;
      return typeof source === "string" && source.startsWith("delivery:") && source !== "delivery:";
    });
  return (
    lifecycle.role === "root" &&
    (lifecycle.state === "running" ||
      (lifecycle.state === "waiting_background" && queuedDeliveries)) &&
    lifecycle.restoring === false &&
    lifecycle.persisted === true &&
    typeof lifecycle.runId === "string" &&
    lifecycle.activity === undefined &&
    Array.isArray(lifecycle.holds) &&
    lifecycle.holds.length === 0 &&
    waits.children === 0 &&
    background !== undefined &&
    (background.length === 0 || queuedDeliveries) &&
    Array.isArray(waits.human) &&
    waits.human.length === 0 &&
    state.isStreaming === false &&
    state.isCompacting === false &&
    state.isBashRunning === false &&
    state.retryAttempt === 0 &&
    typeof state.pendingMessageCount === "number" &&
    (state.pendingMessageCount > 0 || queuedDeliveries)
  );
}

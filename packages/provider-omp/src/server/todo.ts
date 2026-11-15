import type { OrchestrationV2PlanStep } from "@t3tools/contracts";
import type { PiTodoSnapshot, PiRpcRecord } from "@t3tools/provider-pi/server";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const Snapshot = Schema.Struct({
  sessionFile: Schema.String.check(Schema.isMinLength(1)),
  generation: Schema.String.check(Schema.isMinLength(1)),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  todoPhases: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      tasks: Schema.Array(
        Schema.Struct({
          content: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8192)),
          status: Schema.Literals(["pending", "in_progress", "completed", "abandoned"]),
        }),
      ).check(Schema.isMaxLength(256)),
    }),
  ).check(Schema.isMaxLength(256)),
});
const decode = Schema.decodeUnknownOption(Snapshot);

export function ompTodoSnapshot(value: unknown): PiTodoSnapshot | undefined {
  const parsed = decode(value);
  if (Option.isNone(parsed)) return undefined;
  const snapshot = parsed.value;
  const occurrences = new Map<string, number>();
  const steps: OrchestrationV2PlanStep[] = [];
  let characters = 0;
  let tasks = 0;
  for (const phase of snapshot.todoPhases) {
    for (const task of phase.tasks) {
      characters += phase.name.length + task.content.length;
      if (++tasks > 256 || characters > 65_536) return undefined;
      const key = JSON.stringify([phase.name, task.content]);
      const occurrence = occurrences.get(key) ?? 0;
      occurrences.set(key, occurrence + 1);
      switch (task.status) {
        case "abandoned":
          break;
        case "pending":
        case "completed":
        case "in_progress":
          steps.push({
            id: JSON.stringify([phase.name, task.content, occurrence]),
            text: phase.name ? `${phase.name}: ${task.content}` : task.content,
            status: task.status === "in_progress" ? "running" : task.status,
          });
          break;
        default:
          task.status satisfies never;
      }
    }
  }
  return {
    nativeThreadId: snapshot.sessionFile,
    generation: snapshot.generation,
    revision: snapshot.revision,
    hasList: snapshot.todoPhases.length > 0,
    steps,
  };
}

export class OmpTodoUpdates {
  private epoch = 0;
  private state: PiRpcRecord = {};
  private revision = 0;
  private signature = "";

  get generation(): number {
    return this.epoch;
  }

  get nativeThreadId(): unknown {
    return this.state.sessionFile;
  }

  matches(state: PiRpcRecord): boolean {
    return state.sessionFile === this.state.sessionFile && state.sessionId === this.state.sessionId;
  }

  reset() {
    this.epoch++;
    this.state = {};
    this.revision = 0;
    this.signature = "";
  }

  bind(
    state: PiRpcRecord,
  ): PiRpcRecord & { readonly generation: string; readonly revision: number } {
    this.state = state;
    const signature = JSON.stringify(state.todoPhases);
    if (signature !== this.signature) {
      this.signature = signature;
      this.revision++;
    }
    const queued =
      typeof state.queuedMessageCount === "number" && state.queuedMessageCount >= 0
        ? state.queuedMessageCount
        : 1;
    return {
      ...state,
      generation: String(this.epoch),
      revision: this.revision,
      pendingMessageCount:
        queued + (state.hasPendingAsyncWork !== false || state.isSettled !== true ? 1 : 0),
    };
  }
}

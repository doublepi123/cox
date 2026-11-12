import { type OrchestrationV2PlanStep, TrimmedNonEmptyString } from "@t3tools/contracts";
import type { PiTodoSnapshot } from "@t3tools/provider-pi/server";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const TodoSnapshot = Schema.Struct({
  sessionFile: TrimmedNonEmptyString,
  generation: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  hasList: Schema.Boolean,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  phases: Schema.Array(
    Schema.Struct({
      name: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
      tasks: Schema.Array(
        Schema.Struct({
          content: TrimmedNonEmptyString.check(Schema.isMaxLength(8192)),
          status: Schema.Literals([
            "pending",
            "in_progress",
            "completed",
            "abandoned",
            "cancelled",
          ]),
        }),
      ).check(Schema.isMaxLength(256)),
    }),
  ).check(Schema.isMaxLength(256)),
});
const decodeSnapshot = Schema.decodeUnknownOption(TodoSnapshot);
const encodeIdentity = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(Schema.Union([Schema.String, Schema.Number]))),
);

export function omoTodoSnapshot(value: unknown): PiTodoSnapshot | undefined {
  const decoded = decodeSnapshot(value);
  if (Option.isNone(decoded)) return undefined;
  let total = 0;
  let length = 0;
  const occurrences = new Map<string, number>();
  const steps: Array<OrchestrationV2PlanStep> = [];
  for (const phase of decoded.value.phases) {
    for (const task of phase.tasks) {
      length += phase.name.length + task.content.length;
      if (++total > 256 || length > 65_536) return undefined;
      if (task.status === "abandoned" || task.status === "cancelled") continue;
      const key = encodeIdentity([phase.name, task.content]);
      const occurrence = occurrences.get(key) ?? 0;
      occurrences.set(key, occurrence + 1);
      steps.push({
        id: encodeIdentity([phase.name, task.content, occurrence]),
        text: `${phase.name}: ${task.content}`,
        status: task.status === "in_progress" ? "running" : task.status,
      });
    }
  }
  return {
    nativeThreadId: decoded.value.sessionFile,
    generation: decoded.value.generation,
    hasList: decoded.value.hasList,
    revision: decoded.value.revision,
    steps,
  };
}

export const OMO_TODO_BRIDGE_SOURCE = `
  const todoSnapshots = new Map();
  const todoGeneration = crypto.randomUUID();
  const todoContexts = new Map();
  const validPhases = phases => Array.isArray(phases) && phases.every(phase =>
    phase && typeof phase.name === "string" && Array.isArray(phase.tasks) && phase.tasks.every(task =>
      task && typeof task.content === "string" && ["pending", "in_progress", "completed", "abandoned", "cancelled"].includes(task.status)));
  const readTodos = ctx => {
    const manager = ctx?.sessionManager;
    const sessionFile = manager?.getSessionFile();
    if (!sessionFile) return;
    let phases = [];
    let hasList = false;
    for (const entry of manager.getBranch()) {
      const message = entry.type === "message" ? entry.message : undefined;
      const payload = entry.type === "custom" && entry.customType === "senpi.todo-state" ? entry.data :
        message?.role === "toolResult" && ["todo", "todowrite"].includes(message.toolName) && !message.isError ? message.details : undefined;
      if (!payload || typeof payload !== "object") continue;
      if (validPhases(payload.phases)) { phases = payload.phases; hasList = true; }
      else if (Array.isArray(payload.todos) && payload.todos.every(task => task && typeof task.content === "string")) {
        phases = [{ name: "Tasks", tasks: payload.todos.map(task => ({ content: task.content,
          status: ["pending", "in_progress", "completed", "abandoned", "cancelled"].includes(task.status) ? task.status : "pending" })) }];
        hasList = true;
      }
    }
    const signature = JSON.stringify([hasList, phases]);
    const previous = todoSnapshots.get(sessionFile);
    const snapshot = { sessionFile, generation: todoGeneration, hasList, phases, revision: previous ? previous.revision + (previous.signature === signature ? 0 : 1) : 0 };
    todoSnapshots.set(sessionFile, { signature, revision: snapshot.revision });
    if (todoSnapshots.size > 64) todoSnapshots.delete(todoSnapshots.keys().next().value);
    return snapshot;
  };
  const publishTodos = ctx => {
    const snapshot = readTodos(ctx);
    if (snapshot) {
      todoContexts.set(snapshot.sessionFile, ctx);
      if (todoContexts.size > 64) todoContexts.delete(todoContexts.keys().next().value);
      pi.rpc.emit("cox.omo.todo.updated", snapshot);
    }
  };
  const todoHooks = { runs: "brain" };
  pi.on("session_start", (_event, ctx) => publishTodos(ctx), todoHooks);
  pi.on("session_tree", (_event, ctx) => publishTodos(ctx), todoHooks);
  pi.on("session_compact", (event, ctx) => { if (event.accepted !== false) publishTodos(ctx); }, todoHooks);
  pi.on("before_agent_start", (_event, ctx) => publishTodos(ctx), todoHooks);
  pi.on("agent_end", (_event, ctx) => publishTodos(ctx), todoHooks);
  pi.on("tool_result", (event, ctx) => {
    if (["todo", "todowrite"].includes(event.toolName) && !event.isError) publishTodos(ctx);
  }, todoHooks);
  pi.on("message_end", (event, ctx) => {
    if (event.message?.role === "toolResult" && ["todo", "todowrite"].includes(event.message.toolName) && !event.message.isError) publishTodos(ctx);
  }, todoHooks);
  pi.rpc.handle("cox.omo.todo", data => {
    const ctx = todoContexts.get(data?.nativeThreadId);
    return ctx?.sessionManager.getSessionFile() === data?.nativeThreadId ? readTodos(ctx) : undefined;
  });
`;

import { type PiRpcConnection, type PiRpcRecord } from "@t3tools/provider-pi/server";
import type { ProviderNativeSubagentTranscript } from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ompRecord } from "./framing.ts";

const RecordSchema = Schema.Record(Schema.String, Schema.Unknown);
const Agent = Schema.Struct({
  id: Schema.String,
  agent: Schema.String,
  status: Schema.Literals(["pending", "running", "completed", "failed", "aborted"]),
  sessionFile: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  task: Schema.optional(Schema.String),
  parentToolCallId: Schema.optional(Schema.String),
  lastUpdate: Schema.optional(Schema.Number),
  progress: Schema.optional(RecordSchema),
});
const decodeAgents = Schema.decodeUnknownSync(Schema.Struct({ subagents: Schema.Array(Agent) }));
const decodeAgent = Schema.decodeUnknownOption(Agent);
const Page = Schema.Struct({
  sessionFile: Schema.String,
  fromByte: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  nextByte: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  reset: Schema.Boolean,
  messages: Schema.Array(RecordSchema),
});
const decodePage = Schema.decodeUnknownSync(Page);

function messageText(message: PiRpcRecord): string {
  if (message.stopReason === "error" && typeof message.errorMessage === "string")
    return message.errorMessage;
  if (typeof message.content === "string") return message.content;
  return Array.isArray(message.content)
    ? message.content
        .map((part) => ompRecord(part).text)
        .filter((value): value is string => typeof value === "string")
        .join("\n")
    : "";
}

export class OmpSubagents {
  private generation = 0;
  private readonly agents = new Map<string, typeof Agent.Type>();
  private readonly transcripts = new Map<
    string,
    {
      readonly entries: ProviderNativeSubagentTranscript["entries"][number][];
      nextByte: number;
      truncated: boolean;
    }
  >();

  reset() {
    this.generation++;
    this.agents.clear();
    this.transcripts.clear();
  }

  observe(event: PiRpcRecord, updatedAt: number) {
    const payload = ompRecord(event.payload);
    const progress = ompRecord(payload.progress);
    const id = event.type === "subagent_progress" ? progress.id : payload.id;
    if (typeof id !== "string") return;
    const previous = this.agents.get(id);
    if (previous === undefined && payload.status !== "started") return;
    if (event.type === "subagent_event" && previous !== undefined) {
      const native = ompRecord(payload.event);
      const message = ompRecord(native.message);
      if (native.type === "message_end" && message.role === "assistant") {
        this.agents.set(id, {
          ...previous,
          lastUpdate: updatedAt,
          progress: {
            ...previous.progress,
            recentOutput: [messageText(message)],
          },
        });
      }
      return;
    }
    if (
      previous?.sessionFile !== undefined &&
      payload.sessionFile !== undefined &&
      previous.sessionFile !== payload.sessionFile
    )
      return;
    const parsed = decodeAgent({
      ...previous,
      ...payload,
      ...progress,
      id,
      status: payload.status === "started" ? "running" : (progress.status ?? payload.status),
      lastUpdate: updatedAt,
    });
    if (parsed._tag === "Some") this.agents.set(id, parsed.value);
    while (this.agents.size > 256) {
      const oldest = this.agents.keys().next();
      if (oldest.done) break;
      this.agents.delete(oldest.value);
      this.transcripts.delete(oldest.value);
    }
  }

  snapshot(nativeThreadId: string): PiRpcRecord {
    return {
      type: "t3.native_subagents",
      nativeThreadId,
      details: {
        results: [...this.agents.values()].map((agent) => {
          const finished = !["pending", "running"].includes(agent.status);
          const progress = agent.progress ?? {};
          const transcript = this.transcripts.get(agent.id);
          return {
            nativeTaskId: `${nativeThreadId}/${agent.id}`,
            taskRef: agent.id,
            childSessionId: agent.sessionFile,
            agent: agent.agent,
            task: agent.task ?? agent.description ?? agent.id,
            status: agent.status === "aborted" ? "cancelled" : agent.status,
            finished,
            stopReason:
              agent.status === "aborted" ? "aborted" : agent.status === "failed" ? "error" : "stop",
            updatedAt: agent.lastUpdate,
            model: progress.resolvedModelIdentity ?? progress.resolvedModel,
            messages: [
              {
                role: "assistant",
                content: [
                  {
                    type: "text",
                    text: Array.isArray(progress.recentOutput)
                      ? progress.recentOutput
                          .filter((v): v is string => typeof v === "string")
                          .join("\n")
                      : "",
                  },
                ],
              },
            ],
            ...(transcript === undefined
              ? {}
              : { transcript: { entries: transcript.entries, truncated: transcript.truncated } }),
          };
        }),
      },
    };
  }

  refresh = Effect.fnUntraced(function* (this: OmpSubagents, request: PiRpcConnection["request"]) {
    const generation = this.generation;
    const roster = decodeAgents(yield* request({ type: "get_subagents" }));
    if (generation !== this.generation) return;
    for (const agent of roster.subagents) this.agents.set(agent.id, agent);
    for (const agent of [...this.agents.values()].slice(-32)) {
      if (agent.sessionFile === undefined) continue;
      const transcript = this.transcripts.get(agent.id) ?? {
        entries: [],
        nextByte: 0,
        truncated: false,
      };
      if (transcript.truncated) continue;
      for (let pageIndex = 0; pageIndex < 16; pageIndex++) {
        const page = decodePage(
          yield* request({
            type: "get_subagent_messages",
            subagentId: agent.id,
            fromByte: transcript.nextByte,
          }),
        );
        if (generation !== this.generation) return;
        if (page.sessionFile !== agent.sessionFile) break;
        if (page.reset) {
          transcript.entries.length = 0;
          transcript.nextByte = 0;
        }
        if (page.fromByte !== transcript.nextByte || page.nextByte < page.fromByte) break;
        let characters = transcript.entries.reduce(
          (sum, entry) => sum + entry.text.length + (entry.toolName?.length ?? 0),
          0,
        );
        for (const message of page.messages) {
          const text = messageText(message);
          const toolName =
            typeof message.toolName === "string" ? message.toolName.slice(0, 256) : undefined;
          if (message.role !== "assistant" && message.role !== "toolResult") continue;
          if (message.role === "toolResult" && !toolName?.trim()) continue;
          characters += text.length + (toolName?.length ?? 0);
          if (transcript.entries.length >= 200 || characters > 48_000) {
            transcript.truncated = true;
            break;
          }
          transcript.entries.push({
            index: transcript.entries.length,
            kind:
              message.role === "toolResult"
                ? "tool"
                : message.stopReason === "error"
                  ? "error"
                  : "assistant",
            text,
            ...(toolName === undefined ? {} : { toolName, isError: message.isError === true }),
          });
        }
        const previous = transcript.nextByte;
        transcript.nextByte = page.nextByte;
        if (transcript.truncated || previous === page.nextByte) break;
        if (pageIndex === 15) transcript.truncated = true;
      }
      this.transcripts.set(agent.id, transcript);
    }
  });
}

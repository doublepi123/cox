import { ProviderNativeSubagentTranscript } from "@t3tools/provider-core/server/ProviderAdapter";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeTranscript = Schema.decodeUnknownOption(ProviderNativeSubagentTranscript);

export function omoTaskTranscript(value: unknown): ProviderNativeSubagentTranscript | undefined {
  const parsed = decodeTranscript(value);
  if (Option.isNone(parsed)) return undefined;
  let characters = 0;
  let previous = -1;
  for (const entry of parsed.value.entries) {
    characters += entry.text.length + (entry.toolName?.length ?? 0);
    if (
      characters > 48_000 ||
      entry.index <= previous ||
      (entry.kind === "tool" && !entry.toolName?.trim())
    )
      return undefined;
    previous = entry.index;
  }
  return parsed.value;
}

export const OMO_SUBAGENT_TRANSCRIPT_SOURCE = `
  const transcriptStore = typeof tasks.createTaskRecordStore === "function" && typeof tasks.defaultTranscriptReader === "function"
    ? tasks.createTaskRecordStore({ project_dir: pi.cwd, task: { state_dir: config.task?.state_dir } }) : undefined;
  let transcriptContext;
  pi.on("session_start", (_event, ctx) => { transcriptContext = ctx; });
  pi.on("session_before_switch", () => { transcriptContext = undefined; });
  pi.on("session_shutdown", () => { transcriptContext = undefined; });
  pi.rpc.handle("cox.omo.task-transcripts", data => {
    const manager = transcriptContext?.sessionManager;
    if (!transcriptStore || !manager || manager.getSessionFile() !== data?.nativeThreadId || !Array.isArray(data?.taskIds) || data.taskIds.length > 32)
      return undefined;
    const parent = manager.getSessionId();
    if (typeof parent !== "string") return undefined;
    let remaining = 512_000;
    const transcripts = [];
    for (const taskId of [...new Set(data.taskIds)]) {
      if (typeof taskId !== "string" || !/^st_[0-9a-f]{8}$/.test(taskId)) continue;
      const record = transcriptStore.load(taskId);
      if (!record || record.parent_session_id !== parent) continue;
      const read = tasks.defaultTranscriptReader({ taskId, stateDir: transcriptStore.stateDir });
      if (!Array.isArray(read?.entries)) continue;
      let characters = 0;
      let truncated = read.truncated === true;
      const entries = [];
      for (const [index, entry] of read.entries.entries()) {
        const kind = entry?.kind;
        const toolName = kind === "tool" && typeof entry.tool === "string" ? entry.tool.slice(0, 256) : undefined;
        const text = kind === "assistant" ? entry.text : kind === "error" ? entry.message : kind === "tool" ? toolName : undefined;
        if (typeof text !== "string" || !["assistant", "error", "tool"].includes(kind) || (kind === "tool" && !toolName?.trim())) continue;
        const size = text.length + (toolName?.length || 0);
        if (entries.length >= 200 || characters + size > 48_000 || remaining - size < 0) { truncated = true; break; }
        characters += size;
        remaining -= size;
        entries.push({ index, kind, text, ...(toolName === undefined ? {} : { toolName, isError: entry.is_error === true }) });
      }
      transcripts.push({ taskId, childSessionId: record.child_session_id, entries, truncated });
    }
    return { nativeThreadId: data.nativeThreadId, transcripts };
  });
`;

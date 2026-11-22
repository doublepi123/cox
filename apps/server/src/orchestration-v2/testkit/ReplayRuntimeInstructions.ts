import type { ProviderDriverKind, ProviderReplayTranscript } from "@t3tools/contracts";

import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";

export function materializeReplayTranscriptRuntimeInstructions(
  transcript: ProviderReplayTranscript,
  runtime: { readonly driver: ProviderDriverKind; readonly model: string },
): ProviderReplayTranscript {
  const harness =
    runtime.driver === "cursor"
      ? "Cursor"
      : runtime.driver === "grok"
        ? "Grok"
        : runtime.driver === "acpRegistry"
          ? "acpRegistry"
          : runtime.driver === "fx"
            ? "fx"
            : undefined;
  if (harness === undefined) return transcript;
  const instructions = buildRuntimeInstructions({ harness, model: runtime.model });
  let deliveredCursorNotes: string | undefined;
  let cursorAgentId: string | undefined;
  let interruptedCursorNotes:
    | {
        readonly agentId: string | undefined;
        readonly notes: string;
      }
    | undefined;
  let pendingCursorRun:
    | {
        readonly notes: string | undefined;
        readonly compact: boolean;
        compacted: boolean;
      }
    | undefined;

  return {
    ...transcript,
    entries: transcript.entries.map((entry) => {
      if (entry.type === "emit_inbound") {
        const frame = asFrame(entry.frame);
        if (runtime.driver === "cursor") {
          if (
            (frame?.type === "agent.opened" || frame?.type === "run.started") &&
            typeof frame.agentId === "string"
          ) {
            cursorAgentId = frame.agentId;
          }
          const cursorUpdate =
            frame?.type === "interaction.update" && isRecord(frame.update)
              ? frame.update
              : undefined;
          if (cursorUpdate?.type === "summary-completed" && cursorUpdate.failed !== true) {
            deliveredCursorNotes = undefined;
            if (interruptedCursorNotes?.agentId === cursorAgentId) {
              interruptedCursorNotes = undefined;
            }
            if (pendingCursorRun !== undefined) pendingCursorRun.compacted = true;
          }
          if (frame?.type === "run.completed" && pendingCursorRun !== undefined) {
            const status = isRecord(frame.result) ? frame.result.status : undefined;
            if (pendingCursorRun.compact) {
              deliveredCursorNotes = undefined;
            } else if (
              status === "finished" &&
              !pendingCursorRun.compacted &&
              pendingCursorRun.notes !== undefined
            ) {
              deliveredCursorNotes = pendingCursorRun.notes;
              interruptedCursorNotes = undefined;
            } else if (status !== "finished") {
              if (pendingCursorRun.notes !== undefined) {
                deliveredCursorNotes = undefined;
              }
              interruptedCursorNotes =
                status === "cancelled" &&
                !pendingCursorRun.compacted &&
                pendingCursorRun.notes !== undefined
                  ? { agentId: cursorAgentId, notes: pendingCursorRun.notes }
                  : undefined;
            }
            pendingCursorRun = undefined;
          }
          return entry;
        }
        return entry;
      }
      if (entry.type !== "expect_outbound") return entry;
      const frame = entry.frame;
      if (typeof frame !== "object" || frame === null) return entry;
      if (runtime.driver === "cursor" && "type" in frame) {
        if (frame.type === "agent.close") {
          deliveredCursorNotes = undefined;
          cursorAgentId = undefined;
          interruptedCursorNotes = undefined;
          pendingCursorRun = undefined;
          return entry;
        }
        if (frame.type === "run.resume") {
          pendingCursorRun = {
            notes:
              interruptedCursorNotes !== undefined &&
              interruptedCursorNotes.agentId === cursorAgentId
                ? interruptedCursorNotes.notes
                : undefined,
            compact: false,
            compacted: false,
          };
          return entry;
        }
        if (frame.type === "run.start") {
          if (
            ("summarize" in frame && frame.summarize === true) ||
            ("message" in frame &&
              typeof frame.message === "string" &&
              frame.message.trim() === "/compress")
          ) {
            deliveredCursorNotes = undefined;
            pendingCursorRun = { notes: undefined, compact: true, compacted: false };
            return entry;
          }
          if ("message" in frame && typeof frame.message === "string") {
            const options =
              "options" in frame && isRecord(frame.options) ? frame.options : undefined;
            const model =
              isRecord(options?.model) && typeof options.model.id === "string"
                ? options.model.id
                : runtime.model;
            const expected =
              model === runtime.model ? instructions : buildRuntimeInstructions({ harness, model });
            const recorded = frame.message.endsWith(expected);
            const resend = !recorded && deliveredCursorNotes !== expected;
            interruptedCursorNotes = undefined;
            pendingCursorRun = {
              notes: recorded || resend ? expected : undefined,
              compact: false,
              compacted: false,
            };
            if (!resend) return entry;
            return {
              ...entry,
              frame: {
                ...frame,
                message: frame.message.length === 0 ? expected : `${frame.message}\n\n${expected}`,
              },
            };
          }
        }
        return entry;
      }
      if (
        "method" in frame &&
        frame.method === "session/prompt" &&
        "params" in frame &&
        typeof frame.params === "object" &&
        frame.params !== null &&
        "prompt" in frame.params &&
        Array.isArray(frame.params.prompt)
      ) {
        const prompt: ReadonlyArray<unknown> = frame.params.prompt;
        const first = prompt[0];
        if (
          isRecord(first) &&
          first.type === "text" &&
          typeof first.text === "string" &&
          first.text.trimStart().startsWith("/")
        )
          return entry;
        const lastPart = prompt.at(-1);
        if (
          typeof lastPart === "object" &&
          lastPart !== null &&
          "type" in lastPart &&
          lastPart.type === "text" &&
          "text" in lastPart &&
          lastPart.text === instructions
        ) {
          return entry;
        }
        return {
          ...entry,
          frame: {
            ...frame,
            params: { ...frame.params, prompt: [...prompt, { type: "text", text: instructions }] },
          },
        };
      }
      return entry;
    }),
  };
}

type ReplayFrame = {
  readonly type?: unknown;
  readonly agentId?: unknown;
  readonly update?: unknown;
  readonly result?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asFrame(value: unknown): ReplayFrame | undefined {
  return isRecord(value) ? value : undefined;
}

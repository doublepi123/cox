import type { AcpAdapterV2SubagentUpdate } from "@t3tools/provider-acp/server/adapter";
import type { AcpToolCallState } from "@t3tools/provider-acp/server/runtimeModel";

const STARTED = /^started subagent \S+$/;

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

function toolOutputText(toolCall: AcpToolCallState): string | null {
  const content = toolCall.data.content;
  if (!Array.isArray(content)) return null;
  return text(
    content
      .flatMap((entry: unknown) => {
        if (typeof entry !== "object" || entry === null || !("content" in entry)) return [];
        const block = entry.content;
        return typeof block === "object" && block !== null && "text" in block ? [block.text] : [];
      })
      .filter((value): value is string => typeof value === "string")
      .join("\n"),
  );
}

export function extractDshSubagentUpdate(
  toolCall: AcpToolCallState,
): AcpAdapterV2SubagentUpdate | undefined {
  if (toolCall.title !== "subagent") return undefined;
  const input = toolCall.data.rawInput;
  const field = (key: string) =>
    typeof input === "object" && input !== null && key in input
      ? text((input as Record<string, unknown>)[key])
      : null;
  const output = toolOutputText(toolCall);
  const started = output !== null && STARTED.test(output);
  return {
    nativeTaskId: toolCall.toolCallId,
    prompt: field("prompt") ?? "",
    title: field("description"),
    model: null,
    status:
      toolCall.status === "failed"
        ? "failed"
        : toolCall.status === "completed" && !started
          ? "completed"
          : "running",
    childSessionId: null,
    result: started ? null : output,
    suppressNormalTool: true,
  };
}

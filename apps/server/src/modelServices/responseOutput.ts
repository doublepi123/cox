const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const tokens = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

export function makeChatOutputTracker() {
  const choices = new Map<number, string | null>();
  let textCharacters = 0;
  let reasoningCharacters = 0;
  let refusalCharacters = 0;
  let toolCallFragments = 0;
  let otherOutput = false;
  let outputTokens: number | undefined;
  let reasoningTokens: number | undefined;
  let ambiguous = false;
  const characters = (value: unknown) => {
    if (typeof value === "string") return value.length;
    if (value != null) otherOutput = true;
    return 0;
  };
  return {
    observe: (value: unknown) => {
      const event = record(value);
      const usage = record(event.usage);
      const completion = tokens(usage.completion_tokens);
      const output = tokens(usage.output_tokens);
      for (const name of ["completion_tokens", "output_tokens"])
        if (usage[name] != null && tokens(usage[name]) === undefined) ambiguous = true;
      const generated = completion ?? output;
      if (completion !== undefined && output !== undefined && completion !== output)
        ambiguous = true;
      if (generated !== undefined) {
        if (outputTokens !== undefined && outputTokens !== generated) ambiguous = true;
        outputTokens = generated;
      }
      const reasoningValues = [
        record(usage.completion_tokens_details).reasoning_tokens,
        record(usage.output_tokens_details).reasoning_tokens,
      ];
      if (reasoningValues.some((value) => value != null && tokens(value) === undefined))
        ambiguous = true;
      const reasoning = Math.max(...reasoningValues.map((value) => tokens(value) ?? 0));
      if (reasoningValues.some((value) => tokens(value) !== undefined))
        reasoningTokens = Math.max(reasoningTokens ?? 0, reasoning);
      for (const raw of Array.isArray(event.choices) ? event.choices : []) {
        const choice = record(raw);
        const index = choice.index ?? 0;
        if (
          typeof index !== "number" ||
          !Number.isSafeInteger(index) ||
          index < 0 ||
          index >= 128
        ) {
          ambiguous = true;
          continue;
        }
        const reason = choice.finish_reason;
        if (typeof reason === "string" && reason) {
          const next = reason === "stop" ? "stop" : "other";
          if (choices.get(index) != null && choices.get(index) !== next) ambiguous = true;
          choices.set(index, next);
        } else if (!choices.has(index)) choices.set(index, null);
        const delta = record(choice.delta ?? choice.message);
        textCharacters += characters(delta.content);
        reasoningCharacters += characters(delta.reasoning_content) + characters(delta.reasoning);
        refusalCharacters += characters(delta.refusal);
        if (Array.isArray(delta.tool_calls)) toolCallFragments += delta.tool_calls.length;
        else if (delta.tool_calls != null) otherOutput = true;
        if (delta.function_call != null) toolCallFragments++;
        for (const field of Object.keys(delta))
          if (
            ![
              "role",
              "content",
              "reasoning_content",
              "reasoning",
              "refusal",
              "tool_calls",
              "function_call",
            ].includes(field) &&
            delta[field] != null
          )
            otherOutput = true;
      }
    },
    snapshot: () => ({
      textCharacters,
      reasoningCharacters,
      refusalCharacters,
      toolCallFragments,
      otherOutput,
      outputTokens,
      reasoningTokens,
      choiceCount: choices.size,
      classificationAmbiguous: ambiguous,
    }),
    isZeroTokenStop: () =>
      !ambiguous &&
      outputTokens === 0 &&
      (reasoningTokens ?? 0) === 0 &&
      choices.size > 0 &&
      [...choices.values()].every((reason) => reason === "stop") &&
      textCharacters === 0 &&
      reasoningCharacters === 0 &&
      refusalCharacters === 0 &&
      toolCallFragments === 0 &&
      !otherOutput,
  };
}

export function chatResponseOutput(value: unknown) {
  const tracker = makeChatOutputTracker();
  tracker.observe(value);
  return { ...tracker.snapshot(), zeroTokenStop: tracker.isZeroTokenStop() };
}

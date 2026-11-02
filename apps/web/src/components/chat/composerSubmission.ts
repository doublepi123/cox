import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@t3tools/contracts";
import { expandAssistantCitationsForProvider } from "@t3tools/shared/assistantCitations";

type ComposerSubmitEvent = { preventDefault: () => void };

type ComposerSubmissionInput = {
  prompt: string;
  providerInput?: string;
  submissionTarget: "provider-turn" | "pending-user-input";
  supportsImages?: boolean | undefined;
  imageCount?: number | undefined;
};

export function getComposerPromptLengthValidationMessage(prompt: string): string | null {
  const normalizedPrompt = prompt.trim();
  const inputLength = Math.max(
    normalizedPrompt.length,
    expandAssistantCitationsForProvider(normalizedPrompt).length,
  );
  const excessCharacters = inputLength - PROVIDER_SEND_TURN_MAX_INPUT_CHARS;
  if (excessCharacters <= 0) return null;

  const characterLabel = excessCharacters === 1 ? "character" : "characters";
  return `Prompt is ${excessCharacters.toLocaleString("en-US")} ${characterLabel} over the ${PROVIDER_SEND_TURN_MAX_INPUT_CHARS.toLocaleString("en-US")}-character limit. Shorten or split it before sending.`;
}

export function getComposerSubmissionValidationMessage(
  options: ComposerSubmissionInput,
): string | null {
  if (
    options.submissionTarget === "provider-turn" &&
    options.supportsImages === false &&
    (options.imageCount ?? 0) > 0
  ) {
    return "This model does not support image input. Remove images or choose another model.";
  }
  return options.submissionTarget === "provider-turn"
    ? getComposerPromptLengthValidationMessage(options.providerInput ?? options.prompt)
    : null;
}

export function submitComposerDraft(
  options: ComposerSubmissionInput & {
    event: ComposerSubmitEvent | undefined;
    onSend: (event?: ComposerSubmitEvent) => boolean | void;
  },
): { validationMessage: string | null; didDispatch: boolean } {
  const validationMessage = getComposerSubmissionValidationMessage(options);
  if (validationMessage) {
    options.event?.preventDefault();
    return { validationMessage, didDispatch: false };
  }

  if (options.onSend(options.event) === false) {
    options.event?.preventDefault();
    return { validationMessage: null, didDispatch: false };
  }
  return { validationMessage: null, didDispatch: true };
}

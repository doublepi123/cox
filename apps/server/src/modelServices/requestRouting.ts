import type { ModelServiceProtocol } from "@t3tools/contracts";

export function modelServiceRequestRouting(input: {
  readonly incoming: ModelServiceProtocol;
  readonly body: Readonly<Record<string, unknown>>;
  readonly candidates: ReadonlyArray<ModelServiceProtocol>;
  readonly countTokens: boolean;
}) {
  const statefulResponses =
    input.incoming === "openai-responses" &&
    ["previous_response_id", "conversation", "background"].some((key) =>
      Object.hasOwn(input.body, key),
    );
  const nativeProtocol = input.countTokens
    ? "anthropic-messages"
    : statefulResponses
      ? "openai-responses"
      : undefined;
  const protocols =
    nativeProtocol === undefined
      ? input.candidates
      : input.candidates.filter((protocol) => protocol === nativeProtocol);
  const error =
    protocols.length > 0
      ? undefined
      : input.countTokens
        ? {
            status: 501,
            message: "Token counting requires an allowed native Anthropic protocol for this model.",
          }
        : statefulResponses
          ? {
              status: 422,
              code: "native_responses_required",
              message:
                "State-bearing requests require an allowed native Responses protocol for this model.",
            }
          : {
              status: 422,
              message: "No compatible upstream protocol is configured for this model.",
            };
  return { protocols, statefulResponses, error };
}

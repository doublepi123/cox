const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const codes = new Set([
  "invalid_encrypted_content",
  "unsupported_parameter",
  "unsupported_value",
  "invalid_request_error",
  "incompatible_tool_choice_thinking",
  "unsupported_forced_tool_choice",
  "invalid_parameter",
  "context_length_exceeded",
  "no_available_channel",
  "no_available_channels",
  "channel_unavailable",
  "upstream_timeout",
  "overloaded_error",
  "server_error",
  "rate_limit_error",
  "insufficient_quota",
  "insufficient_user_quota",
  "billing_hard_limit_reached",
  "invalid_api_key",
  "authentication_error",
  "permission_error",
  "model_not_found",
  "max_output_tokens",
  "content_filter",
]);

export function parseUpstreamError(value: unknown): Record<string, unknown> {
  let current = value;
  const parsed: Record<string, unknown> = {};
  for (let depth = 0; depth < 8; depth++) {
    if (typeof current === "string") {
      if (current.length > 16384) break;
      try {
        current = JSON.parse(current);
      } catch {
        break;
      }
      continue;
    }
    const item = record(current);
    for (const key of [
      "code",
      "type",
      "reason",
      "message",
      "param",
      "status",
      "request_id",
      "requestId",
    ])
      if (Object.hasOwn(item, key)) parsed[key] = item[key];
    if (item.error !== undefined && item.error !== null) current = item.error;
    else if (typeof item.message === "string" && item.message.trimStart().startsWith("{"))
      current = item.message;
    else break;
  }
  return parsed;
}

export function upstreamErrorDetails(
  error: Readonly<Record<string, unknown>>,
  requestId?: string,
  secrets: ReadonlyArray<string> = [],
) {
  const candidates = [error.code, error.type, error.reason];
  const embeddedEncryptedError =
    typeof error.message === "string" &&
    error.message.length <= 16384 &&
    /^code:\s*invalid_encrypted_content\s*;\s*message:\s*The encrypted content(?: for item [A-Za-z0-9_-]+)? could not be verified\.\s*Reason:\s*Encrypted content could not be decrypted or parsed\.(?:\s*\(request id: [A-Za-z0-9_-]+\))?\s*$/.test(
      error.message,
    );
  const code =
    candidates.includes("invalid_encrypted_content") || embeddedEncryptedError
      ? "invalid_encrypted_content"
      : candidates.find((value): value is string => typeof value === "string" && codes.has(value));
  const encrypted = code === "invalid_encrypted_content";
  const forcedToolThinking =
    typeof error.message === "string" &&
    /^tool_choice 'specified' is incompatible with thinking enabled(?:\s*\(request id: [A-Za-z0-9_-]+\))?\s*$/.test(
      error.message,
    );
  const unsupportedForcedToolChoice =
    typeof error.message === "string" &&
    /^(?:(?:[A-Za-z0-9._:/-]+ )?does not support (?:forced|this|the) tool_choice(?:;\s*use auto or none)?|thinking may not be enabled when tool_choice forces tool use|tool_choice cannot force tool use)\.?(\s*\(request id: [A-Za-z0-9_-]+\))?\s*$/i.test(
      error.message,
    );
  const unsupportedUltra =
    typeof error.message === "string" &&
    /^Invalid value: 'ultra'\. Supported values are: 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', and 'max'\.(?: \(request id: [A-Za-z0-9_-]+\))?$/.test(
      error.message,
    );
  const parameter = unsupportedUltra
    ? "reasoning_effort"
    : typeof error.param === "string"
      ? /^(model|max_tokens|max_completion_tokens|reasoning_effort|service_tier|thinking|output_config|tools|messages|input)(?:\.|\[|$)/.exec(
          error.param,
        )?.[1]
      : undefined;
  const messageRequestId =
    typeof error.message === "string"
      ? /\(request id: ([A-Za-z0-9_-]+)\)\s*$/i.exec(error.message)?.[1]
      : undefined;
  const upstreamRequestId = [requestId, error.request_id, error.requestId, messageRequestId].find(
    (value): value is string =>
      typeof value === "string" &&
      (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value) ||
        /^req_[A-Za-z0-9_-]{1,96}$/.test(value)) &&
      !secrets.some(
        (secret) =>
          secret &&
          (value.includes(secret) || value.includes(secret.replace(/^(?:Bearer|Basic)\s+/i, ""))),
      ),
  );
  const details = [
    parameter ? `parameter: ${parameter}` : undefined,
    code ? `code: ${code}` : undefined,
    unsupportedUltra ? "unsupported effort; allowed maximum: max" : undefined,
    forcedToolThinking ? "Forced tool choice is incompatible with enabled thinking." : undefined,
    unsupportedForcedToolChoice ? "Forced tool choice is not supported by this model." : undefined,
    encrypted
      ? "Encrypted reasoning content could not be verified, decrypted or parsed."
      : undefined,
    upstreamRequestId ? `request ID: ${upstreamRequestId}` : undefined,
  ].filter(Boolean);
  return {
    code: forcedToolThinking
      ? "incompatible_tool_choice_thinking"
      : unsupportedForcedToolChoice
        ? "unsupported_forced_tool_choice"
        : code,
    requestId: upstreamRequestId,
    detail: details.length ? ` Rejected request (${details.join(", ")}).` : "",
  };
}

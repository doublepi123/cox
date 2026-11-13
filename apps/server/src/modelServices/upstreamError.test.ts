import { describe, expect, it } from "vite-plus/test";
import {
  parseUpstreamError,
  upstreamContextOverflow,
  upstreamErrorDetails,
} from "./upstreamError.ts";

const error = {
  code: "invalid_encrypted_content",
  type: "invalid_request_error",
  param: "input[2].encrypted_content",
  message:
    "The encrypted content for item rs_private could not be verified. Reason: Encrypted content could not be decrypted or parsed. private-upstream-key",
};
const requestId = "4171489b-838f-4e4c-9366-18cf20dadc55";

describe("upstream model error diagnostics", () => {
  it.each(["", "status_code=400, "])(
    "recognizes unsupported forced choice without exposing model text: %s",
    (prefix) => {
      const result = upstreamErrorDetails({
        type: "invalid_request_error",
        message: prefix + "private-model does not support forced tool_choice; use auto or none",
      });
      expect(result.code).toBe("unsupported_forced_tool_choice");
      expect(result.detail).toContain("use auto or none");
      expect(result.detail).not.toContain("private-model");
    },
  );
  it.each([
    "User said: claude-opus-5-5 does not support forced tool_choice; use auto or none",
    "claude-opus-5-5 does not support forced tool_choice; use auto or none secret-token",
    "claude-opus-5-5 does not support forced tool_choice",
  ])("does not infer forced choice rejection from unrelated prose: %s", (message) => {
    const result = upstreamErrorDetails({ type: "invalid_request_error", message });
    expect(result.code).toBe("invalid_request_error");
    expect(result.detail).not.toContain(message);
  });
  it("classifies the exact forced-tool/thinking conflict without exposing arbitrary messages", () => {
    const safe = upstreamErrorDetails({
      type: "invalid_request_error",
      message: "tool_choice 'specified' is incompatible with thinking enabled",
    });
    expect(safe.code).toBe("incompatible_tool_choice_thinking");
    expect(safe.detail).toContain("Forced tool choice is incompatible with enabled thinking");
    const unsafe = upstreamErrorDetails({
      type: "invalid_request_error",
      message: "tool_choice 'specified' is incompatible with thinking enabled private-upstream-key",
    });
    expect(unsafe.code).toBe("invalid_request_error");
    expect(unsafe.detail).not.toContain("private-upstream-key");
  });
  const embedded =
    "code: invalid_encrypted_content; message: The encrypted content could not be verified. Reason: Encrypted content could not be decrypted or parsed.";
  it.each([
    { error: { code: "-4003", type: "invalid_request_error", message: embedded } },
    {
      message: JSON.stringify({
        error: { code: "-4003", type: "invalid_request_error", message: embedded },
      }),
    },
    {
      error: {
        code: "-4003",
        message: JSON.stringify({
          error: { code: "-4003", type: "invalid_request_error", message: embedded },
        }),
      },
    },
  ])(
    "normalizes explicit embedded encrypted-content failures without leaking upstream message: %j",
    (value) => {
      const safe = upstreamErrorDetails(parseUpstreamError(value));
      expect(safe.code).toBe("invalid_encrypted_content");
      expect(safe.detail).toContain("could not be verified, decrypted or parsed");
      expect(safe.detail).not.toContain("-4003");
    },
  );
  it.each([
    { code: "-4003", type: "invalid_request_error", message: "Other invalid request" },
    {
      type: "invalid_request_error",
      message:
        "User quoted code: invalid_encrypted_content; message: The encrypted content could not be verified. Reason: Encrypted content could not be decrypted or parsed.",
    },
    { type: "invalid_request_error", message: 'The user said "code: invalid_encrypted_content"' },
    {
      type: "invalid_request_error",
      message: "code: invalid_encrypted_content; message: no evidence",
    },
    { type: "invalid_request_error", message: embedded + " User input: example" },
    { type: "invalid_request_error", message: '"' + embedded + '"' },
  ])("never infers encrypted failures from numeric codes or unrelated quoted text: %j", (value) => {
    expect(upstreamErrorDetails(parseUpstreamError({ error: value })).code).toBe(
      "invalid_request_error",
    );
  });
  it("extracts only a safe request ID from the observed embedded wrapper", () => {
    const safe = upstreamErrorDetails(
      parseUpstreamError({
        error: { code: "-4003", message: embedded + ` (request id: ${requestId})` },
      }),
    );
    expect(safe.requestId).toBe(requestId);
    expect(safe.code).toBe("invalid_encrypted_content");
    const privateItem = upstreamErrorDetails({
      message: embedded.replace("content could", "content for item rs_secret could"),
    });
    expect(privateItem.code).toBe("invalid_encrypted_content");
    expect(privateItem.detail).not.toContain("rs_secret");
  });

  it.each([
    { error },
    { message: JSON.stringify({ error }) },
    { error: { code: "unknown_error", message: JSON.stringify({ error }) } },
    { error: JSON.stringify({ error }) },
    JSON.stringify({ error }),
    { ...error, type: "error" },
  ])("unwraps structured and JSON-encoded errors: %j", (value) => {
    const parsed = parseUpstreamError(value);
    expect(parsed).toMatchObject({ code: error.code, message: error.message, param: error.param });
    const safe = upstreamErrorDetails(parsed, requestId);
    expect(safe).toMatchObject({ code: "invalid_encrypted_content", requestId });
    expect(safe.detail).toContain(
      "Encrypted reasoning content could not be verified, decrypted or parsed.",
    );
    expect(safe.detail).toContain("parameter: input");
    expect(safe.detail).not.toContain("private");
    expect(safe.detail).not.toContain("input[2]");
  });

  it("recognizes an explicit error type but not a code mentioned in arbitrary prose", () => {
    expect(upstreamErrorDetails({ type: "invalid_encrypted_content" }).code).toBe(
      "invalid_encrypted_content",
    );
    expect(
      upstreamErrorDetails({
        code: "invalid_request_error",
        message: "User said invalid_encrypted_content",
      }).code,
    ).toBe("invalid_request_error");
    expect(
      upstreamErrorDetails({ code: "invalid_request_error", type: "invalid_encrypted_content" })
        .code,
    ).toBe("invalid_encrypted_content");
  });

  it.each([
    "private-upstream-key",
    "req_private-upstream-key",
    "req_private-header",
    "req_bad\nheader",
    "req_" + "a".repeat(100),
  ])("rejects unsafe or secret-bearing request IDs: %s", (id) => {
    expect(
      upstreamErrorDetails(error, id, ["private-upstream-key", "Bearer private-header"]).requestId,
    ).toBeUndefined();
  });

  it("uses a valid structured body ID when no safe header ID is available", () => {
    expect(
      upstreamErrorDetails({ ...error, request_id: requestId }, "unsafe-value").requestId,
    ).toBe(requestId);
    expect(upstreamErrorDetails({ ...error, requestId: "req_safe123" }).requestId).toBe(
      "req_safe123",
    );
    expect(
      upstreamErrorDetails({ ...error, message: error.message + ` (request id: ${requestId})` })
        .requestId,
    ).toBe(requestId);
  });

  it("redacts arbitrary error text and codes rather than leaking request content", () => {
    const details = upstreamErrorDetails({
      code: "private-upstream-key",
      message: "private prompt",
      param: "tools[0].secret",
    });
    expect(details).toEqual({
      code: undefined,
      requestId: undefined,
      detail: " Rejected request (parameter: tools).",
    });
  });

  it("bounds JSON wrapper nesting and input size", () => {
    let wrapped: unknown = { error };
    for (let index = 0; index < 12; index++) wrapped = { message: JSON.stringify(wrapped) };
    expect(upstreamErrorDetails(parseUpstreamError(wrapped)).code).toBeUndefined();
    expect(parseUpstreamError("{" + " ".repeat(16384))).toEqual({});
    expect(
      parseUpstreamError({ message: "not JSON", code: "invalid_request_error" }),
    ).toMatchObject({ code: "invalid_request_error" });
  });

  it("never inherits upstream properties or copies prototype-bearing fields", () => {
    const parsed = parseUpstreamError(
      JSON.parse(
        '{"__proto__":{"code":"invalid_encrypted_content"},"constructor":{"prototype":{"polluted":true}},"error":{"message":"ordinary error"}}',
      ),
    );
    expect(upstreamErrorDetails(parsed).code).toBeUndefined();
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(Object.hasOwn(parsed, "constructor")).toBe(false);
    expect(
      upstreamErrorDetails(parseUpstreamError(Object.create({ code: "invalid_encrypted_content" })))
        .code,
    ).toBeUndefined();
  });
});

describe("upstream policy rejections", () => {
  it.each(["invalid_prompt", "content_policy_violation", "content_filter", "cyber_policy"])(
    "keeps the %s code from a streamed failure",
    (code) => {
      const parsed = parseUpstreamError({
        type: "response.failed",
        response: { status: "failed" },
        error: { code, message: "private prompt text" },
      });
      const details = upstreamErrorDetails(parsed);
      expect(details.code).toBe(code);
      expect(details.detail).not.toContain("private prompt text");
    },
  );
});

describe("upstream context overflow", () => {
  it.each([
    [{ code: "context_length_exceeded" }, {}],
    [{ code: "string_above_max_length" }, {}],
    [
      {
        type: "invalid_request_error",
        message: "prompt is too long: 215000 tokens > 200000 maximum",
      },
      { tokens: 215000, limit: 200000 },
    ],
    [
      {
        status: "INVALID_ARGUMENT",
        message:
          "The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).",
      },
      { tokens: 1200000, limit: 1048576 },
    ],
    [
      {
        message:
          "This model's maximum context length is 128000 tokens. However, your messages resulted in 130500 tokens.",
      },
      { tokens: 130500, limit: 128000 },
    ],
    [{ message: "Request has too many tokens" }, {}],
    [{ message: "Your input exceeds the context window of this model." }, {}],
  ])("recognizes %j", (error, numbers) => {
    const overflow = upstreamContextOverflow(parseUpstreamError({ error }));
    expect(overflow).toEqual({ ...numbers, description: expect.any(String) });
    expect(overflow?.description).toContain("context window");
    if ("message" in error) expect(overflow?.description).not.toContain(error.message);
  });

  it.each([
    { code: "invalid_request_error", message: "User said: prompt is too long" },
    { code: "rate_limit_error", message: "too many requests" },
    { message: "private prompt" },
  ])("ignores unrelated errors %j", (error) => {
    expect(upstreamContextOverflow(parseUpstreamError({ error }))).toBeUndefined();
  });
});

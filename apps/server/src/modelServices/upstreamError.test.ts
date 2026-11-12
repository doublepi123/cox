import { describe, expect, it } from "vite-plus/test";
import { parseUpstreamError, upstreamErrorDetails } from "./upstreamError.ts";

const error = {
  code: "invalid_encrypted_content",
  type: "invalid_request_error",
  param: "input[2].encrypted_content",
  message:
    "The encrypted content for item rs_private could not be verified. Reason: Encrypted content could not be decrypted or parsed. private-upstream-key",
};
const requestId = "4171489b-838f-4e4c-9366-18cf20dadc55";

describe("upstream model error diagnostics", () => {
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
  it.each([
    "claude-opus-5-5 does not support forced tool_choice; use auto or none",
    "Vendor/claude-sonnet-5.5 does not support forced tool_choice; use auto or none (request id: req_123)",
    "Thinking may not be enabled when tool_choice forces tool use.",
    "tool_choice cannot force tool use",
  ])("classifies explicit forced tool_choice rejections safely: %s", (message) => {
    const safe = upstreamErrorDetails({
      type: "invalid_request_error",
      message,
    });
    expect(safe.code).toBe("unsupported_forced_tool_choice");
    expect(safe.detail).toContain("Forced tool choice is not supported by this model.");
    expect(safe.detail).not.toContain("claude-opus-5-5");
    const unsafe = upstreamErrorDetails({
      type: "invalid_request_error",
      message: `${message} private-upstream-key`,
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

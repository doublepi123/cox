# Model service reasoning replay compatibility

Model services preserve encrypted reasoning replay by default. A repair after an
explicit `invalid_encrypted_content` error applies only to that logical request;
it does not silently change the service's configuration or rewrite saved history.

For an upstream known to reject historical reasoning ciphertext, use **Settings →
Model services → Encrypted reasoning replay → Omit for incompatible services** and
save the service. The setting persists across new requests and server restarts.
It does not require changing the retry limits or sending a model test request.

Each model's editor also provides **Model encrypted reasoning replay**. It can
inherit the service setting, preserve replay, or omit replay for just that model.
Refreshing the catalog preserves these local overrides; upstream model metadata
cannot enable or disable replay on the user's behalf.

The settings contract uses an optional `encryptedReasoningReplay` field with
`"preserve"` or `"omit"` on both the service and individual model entries:

```json
{
  "encryptedReasoningReplay": "omit",
  "models": [
    { "id": "inherited-model", "capabilities": null },
    {
      "id": "compatible-model",
      "capabilities": null,
      "encryptedReasoningReplay": "preserve"
    }
  ]
}
```

Omission is applied after protocol conversion, immediately before sending OpenAI
Responses requests. It covers native Responses clients such as Codex and Pi, and
Anthropic Messages clients such as Claude Code converted to Responses. Other
upstream protocols are unchanged. Only reasoning items' `encrypted_content` is
removed; nonempty summary/content, visible messages and tool call/result pairs
are retained. Otherwise-empty reasoning items are omitted. Stored signatures and
conversation history are not modified.

In preserve mode, the gateway can repair a pre-output encrypted-content rejection
once and make one repaired attempt. If that attempt fails, recovery stops even
when non-transient retries are enabled. Known encrypted errors cannot be replayed
unchanged by the generic retry policy. Stateful requests, upstream-tool replay
permissions, cancellation, time/attempt budgets and the no-replay-after-output
boundary still apply. Old in-flight hedges are cancelled before the repaired
attempt, and that repaired attempt is not hedged.

Error normalization accepts structured errors, JSON-encoded error wrappers, and
the observed `code: invalid_encrypted_content; message: ...` wrapper with its
specific decryption/verification failure. Numeric `-4003` alone, generic invalid
requests and unrelated quoted text are not encrypted-content evidence.

Diagnostics log the compatibility action, attempt number, normalized error code
and validated upstream request ID without recording credentials, request bodies,
raw ciphertext or original upstream messages. `response_headers` describes an
HTTP attempt; `response_ready` means the logical request has usable output. It
does not prove completion of the stream or of the user's provider turn.

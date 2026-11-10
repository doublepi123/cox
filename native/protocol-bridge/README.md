# Cox protocol bridge

This private JSONL subprocess embeds the MIT-licensed CLIProxyAPI v8.0.53 translator SDK.
The Cox Node server owns HTTP networking and upstream credentials. The subprocess receives
request and response bodies for one HTTP request, converts them, then exits when that
request's scope closes. It does not run CLIProxyAPI's HTTP server, account management or OAuth.

Use Go 1.27.3 and Node 26.12.1:

```sh
node scripts/build-protocol-bridge.ts
pnpm test:protocol-bridge
node scripts/build-protocol-bridge.ts --all
```

`COX_GO_BINARY` selects a Go executable outside `PATH`. The default build targets the host;
`--all` targets Linux, macOS and Windows on x64 and arm64 with CGO disabled. Release scripts
build all targets and copy the binaries beside the server bundle. Generated notices include
licenses from the linked Go modules and the Go standard library. Normal installations use
the bundled executable without needing a Go toolchain.

Supported formats are OpenAI Responses, OpenAI Chat Completions, Anthropic Messages and
Gemini. The SDK's `codex` upstream format implements Responses translation; the wrapper
restores the caller's stream setting and removes unrequested reasoning defaults. Native
protocol requests bypass the subprocess. Converted streaming chunks are framed as SSE.

Protocol conversion cannot emulate provider-specific capabilities. Responses requests using
`previous_response_id` must supply full conversation input instead when conversion is needed.
Cross-protocol token counting, hosted tools, file stores, audio/video/realtime endpoints,
and Responses compaction are outside this gateway. Unsupported SDK transformations return
an explicit error rather than forwarding mismatched protocol bodies. The gateway does not
retry generation requests or silently substitute models. Tests use synthetic requests and
responses, without paid inference.

Streaming uses `chunk` for one already-dispatched SSE data frame and `finish`
after a checked upstream EOF. The subprocess does not parse HTTP chunk
boundaries. `finish` validates completion and is idempotent; it never completes a
Chat upstream based on EOF or `finish_reason` alone. Chat must supply `[DONE]`.
Duplicate terminators and further data after a completed Responses conversion
are errors, and a failed session cannot resume processing frames.

Chat-to-Responses completion requires finished choices, closed output items and
valid object-valued arguments/identities for successful function calls. Parallel
tool arguments remain independent; malformed or missing successful arguments
are rejected rather than silently converted to `{}`. Legacy `function_call`
deltas unsupported by the SDK return an explicit conversion error. Truncated
tool calls with a length/filter finish remain incomplete, never successful.
Reasoning-only and empty output arrays receive one legal terminal event after
the real marker. Late usage preserves input/output/total, cached and reasoning
token counts. Length/filter outcomes remain `response.incomplete`, including
when another choice stops normally.

The wrapper preserves SDK-emitted terminal events. Where the SDK omits a target
Chat `[DONE]` or Gemini-to-Messages `message_stop`, finalization maps a real
upstream terminal plus already-finished target choices/items to the missing
target terminator. It does not infer upstream completion from transport EOF.
Each JSONL reply includes only boolean completion `state` metadata alongside
converted bodies/chunks or static errors. No body, tool argument or credential
is included in this state. Tests use only local synthetic streams.

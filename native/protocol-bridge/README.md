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

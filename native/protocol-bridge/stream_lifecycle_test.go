package main

import (
	"encoding/json"
	"strings"
	"testing"

	tr "github.com/router-for-me/CLIProxyAPI/v8/sdk/translator"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/translator/builtin"
)

func TestSourceRejectsUnfinishedLifecycle(t *testing.T) {
	for _, test := range []struct {
		name   string
		format tr.Format
		events []string
	}{
		{"responses unfinished status", tr.FormatCodex, []string{`{"type":"response.completed","response":{"status":"completed","output":[{"type":"message","status":"in_progress"}]}}`}},
		{"responses invalid tool", tr.FormatCodex, []string{`{"type":"response.completed","response":{"status":"completed","output":[{"type":"function_call","name":"read","call_id":"a","arguments":"{"}]}}`}},
		{"anthropic missing start", tr.FormatClaude, []string{`{"type":"message_stop"}`}},
		{"anthropic missing stop delta", tr.FormatClaude, []string{`{"type":"message_start","message":{"content":[]}}`, `{"type":"message_stop"}`}},
		{"anthropic open block", tr.FormatClaude, []string{`{"type":"message_start","message":{"content":[]}}`, `{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`, `{"type":"message_delta","delta":{"stop_reason":"end_turn"}}`, `{"type":"message_stop"}`}},
		{"anthropic duplicate block", tr.FormatClaude, []string{`{"type":"message_start","message":{"content":[]}}`, `{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`, `{"type":"content_block_stop","index":0}`, `{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`, `{"type":"message_delta","delta":{"stop_reason":"end_turn"}}`, `{"type":"message_stop"}`}},
		{"anthropic incomplete tool", tr.FormatClaude, []string{`{"type":"message_start","message":{"content":[]}}`, `{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"a","name":"read","input":{}}}`, `{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{"}}`, `{"type":"content_block_stop","index":0}`, `{"type":"message_delta","delta":{"stop_reason":"tool_use"}}`, `{"type":"message_stop"}`}},
		{"gemini unfinished sibling", tr.FormatGemini, []string{`{"candidates":[{"index":0,"content":{"parts":[{"text":"partial"}]}},{"index":1,"finishReason":"STOP"}]}`}},
		{"gemini invalid index", tr.FormatGemini, []string{`{"candidates":[{"index":-1,"finishReason":"STOP"}]}`}},
		{"gemini invalid arguments", tr.FormatGemini, []string{`{"candidates":[{"index":0,"content":{"parts":[{"functionCall":{"name":"read","args":[]}}]},"finishReason":"STOP"}]}`}},
		{"responses unfinished observed item", tr.FormatCodex, []string{`{"type":"response.output_item.added","output_index":0,"item":{"type":"message"}}`, `{"type":"response.completed","response":{"status":"completed","output":[]}}`}},
		{"responses unfinished argument delta", tr.FormatCodex, []string{`{"type":"response.function_call_arguments.delta","output_index":0,"delta":"{"}`, `{"type":"response.completed","response":{"status":"completed","output":[{"type":"function_call","name":"read","call_id":"a","arguments":"{}"}]}}`}},
	} {
		t.Run(test.name, func(t *testing.T) {
			s := &session{to: test.format, from: tr.FormatOpenAI}
			var err error
			for _, event := range test.events {
				err = s.observeSource("data: " + event)
				if err != nil {
					break
				}
			}
			if err == nil && s.completion.sourceTerminal {
				t.Fatal("accepted unfinished source as terminal")
			}
		})
	}
}

func TestSourceAcceptsValidLifecycleAndTruncation(t *testing.T) {
	for _, test := range []struct {
		name   string
		format tr.Format
		events []string
	}{
		{"responses final object without deltas", tr.FormatCodex, []string{`{"type":"response.completed","response":{"status":"completed","output":[{"type":"function_call","name":"read","call_id":"a","arguments":"{}"}]}}`}},
		{"responses incomplete tool", tr.FormatCodex, []string{`{"type":"response.output_item.added","output_index":0,"item":{"type":"function_call"}}`, `{"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","status":"incomplete","arguments":"{"}}`, `{"type":"response.incomplete","response":{"status":"incomplete","output":[]}}`}},
		{"anthropic empty message", tr.FormatClaude, []string{`{"type":"message_start","message":{"content":[]}}`, `{"type":"message_delta","delta":{"stop_reason":"end_turn"}}`, `{"type":"message_stop"}`}},
		{"anthropic truncated tool", tr.FormatClaude, []string{`{"type":"message_start","message":{"content":[]}}`, `{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"a","name":"read","input":{}}}`, `{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{"}}`, `{"type":"content_block_stop","index":0}`, `{"type":"message_delta","delta":{"stop_reason":"max_tokens"}}`, `{"type":"message_stop"}`}},
		{"gemini safety prompt", tr.FormatGemini, []string{`{"promptFeedback":{"blockReason":"SAFETY"}}`, `{"usageMetadata":{"totalTokenCount":1}}`}},
		{"gemini optional arguments", tr.FormatGemini, []string{`{"candidates":[{"content":{"parts":[{"functionCall":{"name":"read"}}]},"finishReason":"STOP"}]}`}},
		{"gemini independent completion", tr.FormatGemini, []string{`{"candidates":[{"index":0,"finishReason":"STOP"},{"index":1}]}`, `{"candidates":[{"index":1,"finishReason":"MAX_TOKENS"}]}`, `{"usageMetadata":{"totalTokenCount":1}}`}},
	} {
		t.Run(test.name, func(t *testing.T) {
			s := &session{to: test.format, from: tr.FormatOpenAI}
			for _, event := range test.events {
				if err := s.observeSource("data: " + event); err != nil {
					t.Fatal(err)
				}
			}
			if !s.completion.sourceTerminal {
				t.Fatal("lost valid source completion")
			}
		})
	}
}

func TestGeminiSafetyBlockConvertsToIncomplete(t *testing.T) {
	for _, from := range []string{"openai", "openai-response", "claude"} {
		t.Run(from, func(t *testing.T) {
			request := json.RawMessage(`{"messages":[{"role":"user","content":"hello"}],"input":"hello","max_tokens":100}`)
			s := &session{registry: builtin.Registry()}
			if out := s.handle(input{Type: "request", From: from, To: "gemini", Model: "Model-Exact", Stream: true, Body: request}); out.Error != "" {
				t.Fatal(out.Error)
			}
			out := s.handle(input{Type: "chunk", Chunk: `data: {"promptFeedback":{"blockReason":"SAFETY"}}`})
			if out.Error != "" {
				t.Fatal(out.Error)
			}
			var wire strings.Builder
			for _, chunk := range out.Chunks {
				wire.Write(chunk)
			}
			finish := s.handle(input{Type: "finish"})
			if finish.Error != "" {
				t.Fatal(finish.Error)
			}
			for _, chunk := range finish.Chunks {
				wire.Write(chunk)
			}
			t.Logf("converted safety wire: %s", wire.String())
			expected := map[string]string{"openai": "content_filter", "openai-response": "content_filter", "claude": "refusal"}
			if !strings.Contains(wire.String(), expected[from]) || strings.Contains(wire.String(), `"status":"completed"`) {
				t.Fatal("lost safety block or fabricated success")
			}
		})
	}
}

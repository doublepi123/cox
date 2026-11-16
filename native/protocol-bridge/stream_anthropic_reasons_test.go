package main

import (
	"strings"
	"testing"

	tr "github.com/router-for-me/CLIProxyAPI/v8/sdk/translator"
)

func TestAnthropicRejectsUnknownStopReasons(t *testing.T) {
	for _, reason := range []string{"unknown_reason", "stop", "END_TURN"} {
		t.Run(reason, func(t *testing.T) {
			s := &session{to: tr.FormatClaude}
			if err := s.observeSource(`data: {"type":"message_start","message":{"content":[]}}`); err != nil {
				t.Fatal(err)
			}
			if err := s.observeSource(`data: {"type":"message_delta","delta":{"stop_reason":"` + reason + `"}}`); err == nil {
				t.Fatal("accepted invalid Anthropic stop reason")
			}
		})
	}
}

func TestAnthropicDocumentedStopReasonControls(t *testing.T) {
	for _, reason := range []string{"end_turn", "stop_sequence", "tool_use", "pause_turn", "max_tokens", "refusal", "model_context_window_exceeded"} {
		t.Run(reason, func(t *testing.T) {
			s := &session{to: tr.FormatClaude}
			for _, event := range []string{
				`{"type":"message_start","message":{"content":[]}}`,
				`{"type":"message_delta","delta":{"stop_reason":"` + reason + `"}}`,
				`{"type":"message_stop"}`,
			} {
				if err := s.observeSource("data: " + event); err != nil {
					t.Fatal(err)
				}
			}
			if !s.completion.sourceTerminal {
				t.Fatal("lost documented terminal reason")
			}
		})
	}
}

func TestAnthropicContextBoundaryPreservesPartialTool(t *testing.T) {
	s := &session{to: tr.FormatClaude}
	for _, event := range []string{
		`{"type":"message_start","message":{"content":[]}}`,
		`{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"a","name":"read","input":{}}}`,
		`{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{"}}`,
		`{"type":"content_block_stop","index":0}`,
		`{"type":"message_delta","delta":{"stop_reason":"model_context_window_exceeded"}}`,
		`{"type":"message_stop"}`,
	} {
		if err := s.observeSource("data: " + event); err != nil {
			t.Fatal(err)
		}
	}
	if !s.completion.sourceTerminal {
		t.Fatal("lost legitimate truncation terminal")
	}
}

func TestAnthropicContextBoundaryConvertsAsTruncated(t *testing.T) {
	for _, from := range []string{"openai", "openai-response", "gemini"} {
		t.Run(from, func(t *testing.T) {
			s, _ := start(t, from, "claude", `{"messages":[{"role":"user","content":"hello"}],"input":"hello","contents":[{"role":"user","parts":[{"text":"hello"}]}]}`, true)
			var wire strings.Builder
			for _, event := range []string{
				`{"type":"message_start","message":{"id":"msg-a","model":"Model-Exact","role":"assistant","type":"message","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}`,
				`{"type":"message_delta","delta":{"stop_reason":"model_context_window_exceeded"},"usage":{"output_tokens":0}}`,
				`{"type":"message_stop"}`,
			} {
				out := s.handle(input{Type: "chunk", Chunk: "data: " + event})
				if out.Error != "" {
					t.Fatal(out.Error)
				}
				for _, chunk := range out.Chunks {
					wire.Write(chunk)
				}
			}
			out := s.handle(input{Type: "finish"})
			if out.Error != "" {
				t.Fatal(out.Error)
			}
			for _, chunk := range out.Chunks {
				wire.Write(chunk)
			}
			expected := map[string]string{"openai": `"finish_reason":"length"`, "openai-response": `"status":"incomplete"`, "gemini": `"finishReason":"MAX_TOKENS"`}
			if !strings.Contains(wire.String(), expected[from]) {
				t.Fatalf("lost truncation: %s", wire.String())
			}
			t.Logf("context truncation SSE: %s", wire.String())
		})
	}
}

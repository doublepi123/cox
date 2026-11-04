package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"github.com/router-for-me/CLIProxyAPI/v8/sdk/translator/builtin"
)

func start(t *testing.T, from, to, body string, stream bool) (*session, map[string]any) {
	t.Helper()
	s := &session{registry: builtin.Registry()}
	out := s.handle(input{Type: "request", From: from, To: to, Model: "Model-Exact", Stream: stream, Body: json.RawMessage(body)})
	if out.Error != "" {
		t.Fatal(out.Error)
	}
	var result map[string]any
	if err := json.Unmarshal(out.Body, &result); err != nil {
		t.Fatal(err)
	}
	if result["model"] != "Model-Exact" {
		t.Fatalf("model ID changed: %v", result["model"])
	}
	return s, result
}

func TestResponsesToChatAndBack(t *testing.T) {
	s, request := start(t, "openai-response", "openai", `{"model":"other","input":[{"role":"user","content":[{"type":"input_text","text":"hello"}]}]}`, false)
	if !strings.Contains(string(s.translated), "hello") || request["messages"] == nil {
		t.Fatal("user input was lost")
	}
	response := s.handle(input{Type: "response", Body: json.RawMessage(`{"id":"chat-1","object":"chat.completion","model":"Model-Exact","choices":[{"index":0,"message":{"role":"assistant","content":"Hello"},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":3,"total_tokens":15}}`)})
	if response.Error != "" {
		t.Fatal(response.Error)
	}
	var result map[string]any
	if json.Unmarshal(response.Body, &result) != nil || result["object"] != "response" {
		t.Fatalf("invalid Responses output: %s", response.Body)
	}
	if !bytes.Contains(response.Body, []byte("Hello")) || !bytes.Contains(response.Body, []byte("input_tokens")) {
		t.Fatal("text or usage was lost")
	}
}

func TestPreservesServiceTierAcrossOpenAIConversions(t *testing.T) {
	for _, route := range [][2]string{{"openai-response", "openai"}, {"claude", "openai"}, {"claude", "openai-response"}} {
		t.Run(route[0]+" to "+route[1], func(t *testing.T) {
			body := `{"service_tier":"priority","max_tokens":100,"input":"hello","messages":[{"role":"user","content":"hello"}]}`
			_, request := start(t, route[0], route[1], body, false)
			if request["service_tier"] != "priority" {
				t.Fatalf("service tier was lost: %v", request)
			}
		})
	}
}

func TestClaudeToReasoningChatUsesCompletionTokenLimit(t *testing.T) {
	for _, model := range []string{"gpt-6.1-sol", "openai/gpt-5.4", "o3"} {
		s := &session{registry: builtin.Registry()}
		out := s.handle(input{Type: "request", From: "claude", To: "openai", Model: model, Body: json.RawMessage(`{"max_tokens":32000,"output_config":{"effort":"ultra"},"thinking":{"type":"adaptive"},"messages":[{"role":"user","content":"hi"}]}`)})
		var body map[string]any
		if out.Error != "" || json.Unmarshal(out.Body, &body) != nil {
			t.Fatalf("conversion failed: %s", out.Error)
		}
		if body["max_completion_tokens"] != float64(32000) || body["max_tokens"] != nil || body["reasoning_effort"] != "ultra" {
			t.Fatalf("invalid reasoning request: %s", out.Body)
		}
	}
}

func TestAnthropicToolHistoryToChat(t *testing.T) {
	s, _ := start(t, "claude", "openai", `{"max_tokens":100,"messages":[{"role":"assistant","content":[{"type":"tool_use","id":"call_a","name":"read","input":{"path":"one"}},{"type":"tool_use","id":"call_b","name":"read","input":{"path":"two"}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_a","content":"first"},{"type":"tool_result","tool_use_id":"call_b","content":"second"}]}]}`, false)
	for _, expected := range []string{`"tool_calls"`, `"tool_call_id":"call_a"`, `"tool_call_id":"call_b"`, "first", "second"} {
		if !bytes.Contains(s.translated, []byte(expected)) {
			t.Fatalf("missing %s in %s", expected, s.translated)
		}
	}
	out := s.handle(input{Type: "response", Body: json.RawMessage(`{"id":"chat-2","choices":[{"index":0,"message":{"role":"assistant","content":null,"tool_calls":[{"id":"call_c","type":"function","function":{"name":"write","arguments":"{\"path\":\"three\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":4,"completion_tokens":2}}`)})
	if out.Error != "" || !bytes.Contains(out.Body, []byte(`"tool_use"`)) || !bytes.Contains(out.Body, []byte(`"call_c"`)) {
		t.Fatalf("tool response was lost: %s %s", out.Error, out.Body)
	}
}

func TestChatToMessagesAndBack(t *testing.T) {
	s, _ := start(t, "openai", "claude", `{"messages":[{"role":"system","content":"rules"},{"role":"user","content":"hello"}],"tools":[{"type":"function","function":{"name":"read","parameters":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}}}]}`, false)
	if !bytes.Contains(s.translated, []byte("rules")) || !bytes.Contains(s.translated, []byte(`"input_schema"`)) {
		t.Fatalf("system or tools missing: %s", s.translated)
	}
	out := s.handle(input{Type: "response", Body: json.RawMessage(`{"id":"msg-1","type":"message","role":"assistant","content":[{"type":"text","text":"answer"}],"stop_reason":"end_turn","usage":{"input_tokens":9,"output_tokens":2}}`)})
	if out.Error != "" || !bytes.Contains(out.Body, []byte(`"choices"`)) || !bytes.Contains(out.Body, []byte("answer")) {
		t.Fatalf("invalid chat response: %s %s", out.Error, out.Body)
	}
}

func TestMessagesToResponsesAndBack(t *testing.T) {
	s, request := start(t, "claude", "openai-response", `{"max_tokens":100,"messages":[{"role":"user","content":"hello"}]}`, false)
	if request["stream"] != false {
		t.Fatal("converter changed a non-streaming request to streaming")
	}
	if request["reasoning"] != nil || request["include"] != nil {
		t.Fatal("converter invented unsupported reasoning settings")
	}
	out := s.handle(input{Type: "response", Body: json.RawMessage(`{"id":"resp-1","object":"response","model":"Model-Exact","status":"completed","output":[{"id":"msg-1","type":"message","role":"assistant","content":[{"type":"output_text","text":"answer"}]}],"usage":{"input_tokens":9,"output_tokens":2,"total_tokens":11}}`)})
	if out.Error != "" || !bytes.Contains(out.Body, []byte(`"text":"answer"`)) {
		t.Fatalf("invalid Messages reply: %s %s", out.Error, out.Body)
	}
}

func TestStreamingChatToMessages(t *testing.T) {
	s, _ := start(t, "claude", "openai", `{"max_tokens":100,"stream":true,"messages":[{"role":"user","content":"hello"}]}`, true)
	events := []string{
		`data: {"id":"chat-3","model":"Model-Exact","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"},"finish_reason":null}]}`,
		`data: {"id":"chat-3","model":"Model-Exact","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}`,
		`data: {"id":"chat-3","model":"Model-Exact","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":8,"completion_tokens":2}}`,
		`data: [DONE]`,
	}
	var combined bytes.Buffer
	for _, event := range events {
		out := s.handle(input{Type: "chunk", Chunk: event})
		if out.Error != "" {
			t.Fatal(out.Error)
		}
		for _, chunk := range out.Chunks {
			combined.Write(chunk)
		}
	}
	for _, expected := range []string{"message_start", "content_block_delta", "Hel", "message_stop"} {
		if !strings.Contains(combined.String(), expected) {
			t.Fatalf("missing %s in %s", expected, combined.String())
		}
	}
}

func TestRefusesMissingConvertersAndUnsupportedState(t *testing.T) {
	s := &session{registry: builtin.Registry()}
	if s.handle(input{Type: "request", From: "missing", To: "openai", Body: json.RawMessage(`{}`)}).Error == "" {
		t.Fatal("missing converter fell back to raw bytes")
	}
	if s.handle(input{Type: "request", From: "openai-response", To: "openai", Body: json.RawMessage(`{"previous_response_id":"prior","input":"next"}`)}).Error == "" {
		t.Fatal("stateful Responses request was silently converted")
	}
	if s.handle(input{Type: "chunk", Chunk: "data: {}"}).Error == "" {
		t.Fatal("stream accepted without request")
	}
}

func TestJsonLinesProtocol(t *testing.T) {
	var out bytes.Buffer
	if err := run(strings.NewReader("invalid\n{\"type\":\"response\"}\n"), &out); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 2 {
		t.Fatal("one response per command is required")
	}
	for _, line := range lines {
		var result output
		if json.Unmarshal([]byte(line), &result) != nil || result.Error == "" {
			t.Fatal("invalid safe error response")
		}
	}
}

func TestFourProtocolRoundTrips(t *testing.T) {
	requests := map[string]string{
		"openai":          `{"messages":[{"role":"user","content":"hello"}],"tools":[{"type":"function","function":{"name":"read_file","parameters":{"type":"object"}}}]}`,
		"openai-response": `{"input":[{"role":"user","content":[{"type":"input_text","text":"hello"}]}],"tools":[{"type":"function","name":"read_file","parameters":{"type":"object"}}]}`,
		"claude":          `{"max_tokens":100,"messages":[{"role":"user","content":"hello"}],"tools":[{"name":"read_file","input_schema":{"type":"object"}}]}`,
		"gemini":          `{"contents":[{"role":"user","parts":[{"text":"hello"}]}],"tools":[{"functionDeclarations":[{"name":"read_file","parameters":{"type":"object"}}]}]}`,
	}
	responses := map[string]string{
		"openai":          `{"id":"chat-1","model":"Model-Exact","choices":[{"index":0,"message":{"role":"assistant","content":"answer"},"finish_reason":"stop"}],"usage":{"prompt_tokens":9,"completion_tokens":2,"total_tokens":11}}`,
		"openai-response": `{"id":"resp-1","object":"response","model":"Model-Exact","status":"completed","output":[{"id":"msg-1","type":"message","role":"assistant","content":[{"type":"output_text","text":"answer"}]}],"usage":{"input_tokens":9,"output_tokens":2,"total_tokens":11}}`,
		"claude":          `{"id":"msg-1","type":"message","role":"assistant","content":[{"type":"text","text":"answer"}],"stop_reason":"end_turn","usage":{"input_tokens":9,"output_tokens":2}}`,
		"gemini":          `{"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"answer"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":9,"candidatesTokenCount":2,"totalTokenCount":11},"modelVersion":"Model-Exact","responseId":"gem-1"}`,
	}
	for from, request := range requests {
		for to, response := range responses {
			if from == to {
				continue
			}
			t.Run(from+" to "+to, func(t *testing.T) {
				s := &session{registry: builtin.Registry()}
				out := s.handle(input{Type: "request", From: from, To: to, Model: "Model-Exact", Body: json.RawMessage(request)})
				if out.Error != "" {
					t.Fatal(out.Error)
				}
				for _, expected := range []string{"hello", "read_file"} {
					if !bytes.Contains(out.Body, []byte(expected)) {
						t.Fatalf("lost %s: %s", expected, out.Body)
					}
				}
				out = s.handle(input{Type: "response", Body: json.RawMessage(response)})
				if out.Error != "" || !bytes.Contains(out.Body, []byte("answer")) {
					t.Fatalf("lost output: %s %s", out.Error, out.Body)
				}
			})
		}
	}
}

func TestFourProtocolStreams(t *testing.T) {
	requests := map[string]string{
		"openai":          `{"messages":[{"role":"user","content":"hello"}]}`,
		"openai-response": `{"input":"hello"}`,
		"claude":          `{"max_tokens":100,"messages":[{"role":"user","content":"hello"}]}`,
		"gemini":          `{"contents":[{"role":"user","parts":[{"text":"hello"}]}]}`,
	}
	events := map[string][]string{
		"openai": {
			`{"id":"chat-1","model":"Model-Exact","choices":[{"index":0,"delta":{"role":"assistant","content":"answer"},"finish_reason":null}]}`,
			`{"id":"chat-1","model":"Model-Exact","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":9,"completion_tokens":2,"total_tokens":11}}`,
			`[DONE]`,
		},
		"openai-response": {
			`{"type":"response.created","response":{"id":"resp-1","model":"Model-Exact","created_at":1}}`,
			`{"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg-1","role":"assistant","content":[]}}`,
			`{"type":"response.content_part.added","item_id":"msg-1","output_index":0,"content_index":0,"part":{"type":"output_text","text":""}}`,
			`{"type":"response.output_text.delta","item_id":"msg-1","output_index":0,"content_index":0,"delta":"answer"}`,
			`{"type":"response.output_text.done","item_id":"msg-1","output_index":0,"content_index":0,"text":"answer"}`,
			`{"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg-1","role":"assistant","content":[{"type":"output_text","text":"answer"}]}}`,
			`{"type":"response.completed","response":{"id":"resp-1","model":"Model-Exact","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"answer"}]}],"usage":{"input_tokens":9,"output_tokens":2,"total_tokens":11}}}`,
		},
		"claude": {
			`{"type":"message_start","message":{"id":"msg-1","type":"message","role":"assistant","model":"Model-Exact","content":[],"usage":{"input_tokens":9,"output_tokens":0}}}`,
			`{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
			`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"answer"}}`,
			`{"type":"content_block_stop","index":0}`,
			`{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}`,
			`{"type":"message_stop"}`,
		},
		"gemini": {
			`{"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"answer"}]}}],"modelVersion":"Model-Exact","responseId":"gem-1"}`,
			`{"candidates":[{"index":0,"content":{"role":"model","parts":[]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":9,"candidatesTokenCount":2,"totalTokenCount":11},"modelVersion":"Model-Exact","responseId":"gem-1"}`,
		},
	}
	for from, request := range requests {
		for to, upstream := range events {
			if from == to {
				continue
			}
			t.Run(from+" to "+to, func(t *testing.T) {
				s := &session{registry: builtin.Registry()}
				out := s.handle(input{Type: "request", From: from, To: to, Model: "Model-Exact", Stream: true, Body: json.RawMessage(request)})
				if out.Error != "" {
					t.Fatal(out.Error)
				}
				var combined bytes.Buffer
				for _, event := range upstream {
					out = s.handle(input{Type: "chunk", Chunk: "data: " + event})
					if out.Error != "" {
						t.Fatal(out.Error)
					}
					for _, chunk := range out.Chunks {
						if !bytes.HasPrefix(chunk, []byte("data:")) && !bytes.HasPrefix(chunk, []byte("event:")) {
							t.Fatalf("missing SSE framing: %s", chunk)
						}
						combined.Write(chunk)
					}
				}
				if !strings.Contains(combined.String(), "answer") {
					t.Fatalf("lost text: %s", combined.String())
				}
			})
		}
	}
}

func TestStreamingParallelToolArguments(t *testing.T) {
	s, _ := start(t, "claude", "openai", `{"stream":true,"max_tokens":100,"messages":[{"role":"user","content":"read files"}]}`, true)
	events := []string{
		`{"id":"chat-tools","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"read_file","arguments":"{\"path\":"}},{"index":1,"id":"call_b","type":"function","function":{"name":"read_file","arguments":"{\"path\":"}}]}}]}`,
		`{"id":"chat-tools","choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"function":{"arguments":"\"two\"}"}},{"index":0,"function":{"arguments":"\"one\"}"}}]}}]}`,
		`{"id":"chat-tools","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`,
		`[DONE]`,
	}
	var combined bytes.Buffer
	for _, event := range events {
		out := s.handle(input{Type: "chunk", Chunk: "data: " + event})
		if out.Error != "" {
			t.Fatal(out.Error)
		}
		for _, chunk := range out.Chunks {
			combined.Write(chunk)
		}
	}
	for _, expected := range []string{"call_a", "call_b", "one", "two", "tool_use", "message_stop"} {
		if !strings.Contains(combined.String(), expected) {
			t.Fatalf("missing %s: %s", expected, combined.String())
		}
	}
}

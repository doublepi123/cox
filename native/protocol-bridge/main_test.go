package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"github.com/router-for-me/CLIProxyAPI/v8/sdk/translator/builtin"
)

func chatFrame(delta any, reason any) string {
	event, _ := json.Marshal(map[string]any{"id": "chat-stream", "model": "Model-Exact", "choices": []any{
		map[string]any{"index": 0, "delta": delta, "finish_reason": reason},
	}})
	return string(event)
}

func convertedEvents(t *testing.T, chunks [][]byte) []map[string]any {
	t.Helper()
	var events []map[string]any
	for _, chunk := range chunks {
		for _, line := range strings.Split(string(chunk), "\n") {
			if !strings.HasPrefix(line, "data: ") {
				continue
			}
			var event map[string]any
			if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &event); err != nil {
				t.Fatal(err)
			}
			events = append(events, event)
		}
	}
	return events
}

func chatResponses(t *testing.T, frames []string) (*session, []map[string]any) {
	t.Helper()
	s, _ := start(t, "openai-response", "openai", `{"input":"hello","tools":[{"type":"function","name":"read_file","parameters":{"type":"object"}}]}`, true)
	var events []map[string]any
	for _, frame := range frames {
		out := s.handle(input{Type: "chunk", Chunk: "data: " + frame})
		if out.Error != "" {
			t.Fatal(out.Error)
		}
		events = append(events, convertedEvents(t, out.Chunks)...)
	}
	return s, events
}

func terminalResponse(t *testing.T, events []map[string]any, status string) map[string]any {
	t.Helper()
	var response map[string]any
	terminals := 0
	lastSequence := 0.0
	for _, event := range events {
		sequence := event["sequence_number"].(float64)
		if sequence <= lastSequence {
			t.Fatalf("non-monotonic event sequence: %v", event)
		}
		lastSequence = sequence
		typeName, _ := event["type"].(string)
		if typeName == "response.completed" || typeName == "response.incomplete" || typeName == "response.failed" {
			terminals++
			if typeName != "response."+status {
				t.Fatalf("wrong terminal: %v", event)
			}
			response = event["response"].(map[string]any)
		}
	}
	if terminals != 1 || response["status"] != status || response["object"] != "response" {
		t.Fatalf("expected exactly one valid %s response: %v", status, events)
	}
	return response
}

func TestChatResponsesCompleteTextReasoningAndEmpty(t *testing.T) {
	for _, scenario := range []struct {
		name   string
		delta  map[string]any
		reason string
		items  int
	}{
		{"text", map[string]any{"content": "OK"}, "stop", 1},
		{"reasoning content", map[string]any{"reasoning_content": "thinking"}, "stop", 1},
		{"reasoning alias", map[string]any{"reasoning": "thinking"}, "stop", 1},
		{"empty stop", map[string]any{}, "stop", 0},
		{"empty tool finish", map[string]any{}, "tool_calls", 0},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			s, events := chatResponses(t, []string{chatFrame(scenario.delta, nil), chatFrame(map[string]any{}, scenario.reason), "[DONE]"})
			response := terminalResponse(t, events, "completed")
			if len(response["output"].([]any)) != scenario.items {
				t.Fatalf("wrong output: %v", response)
			}
			if out := s.handle(input{Type: "finish"}); out.Error != "" || len(out.Chunks) != 0 {
				t.Fatalf("finish failed: %v", out)
			}
			if out := s.handle(input{Type: "finish"}); out.Error != "" || len(out.Chunks) != 0 {
				t.Fatalf("idempotent finish failed: %v", out)
			}
			if out := s.handle(input{Type: "chunk", Chunk: "data: [DONE]"}); out.Error == "" || len(out.Chunks) != 0 {
				t.Fatal("accepted data after finalization")
			}
		})
	}
}

func TestChatResponsesUsageOnlyTail(t *testing.T) {
	for _, reasoningOnly := range []bool{false, true} {
		t.Run(map[bool]string{false: "text", true: "reasoning fallback"}[reasoningOnly], func(t *testing.T) {
			delta := map[string]any{"content": "OK"}
			if reasoningOnly {
				delta = map[string]any{"reasoning_content": "thinking"}
			}
			_, events := chatResponses(t, []string{chatFrame(delta, nil), chatFrame(map[string]any{}, "stop"),
				`{"choices":[],"usage":{"prompt_tokens":11,"prompt_tokens_details":{"cached_tokens":7},"completion_tokens":5,"completion_tokens_details":{"reasoning_tokens":3},"total_tokens":16}}`, "[DONE]"})
			response := terminalResponse(t, events, "completed")
			usage := response["usage"].(map[string]any)
			if usage["input_tokens"] != float64(11) || usage["output_tokens"] != float64(5) || usage["total_tokens"] != float64(16) ||
				usage["input_tokens_details"].(map[string]any)["cached_tokens"] != float64(7) ||
				usage["output_tokens_details"].(map[string]any)["reasoning_tokens"] != float64(3) {
				t.Fatalf("usage lost: %v", usage)
			}
		})
	}
}

func TestChatResponsesIncompleteReasons(t *testing.T) {
	for _, reason := range []string{"length", "max_tokens", "content_filter"} {
		for _, delta := range []map[string]any{{"content": "partial"}, {"reasoning_content": "partial"}, {}} {
			t.Run(reason+"/"+chatFrame(delta, nil), func(t *testing.T) {
				_, events := chatResponses(t, []string{chatFrame(delta, nil), chatFrame(map[string]any{}, reason), "[DONE]"})
				response := terminalResponse(t, events, "incomplete")
				want := "max_output_tokens"
				if reason == "content_filter" {
					want = "content_filter"
				}
				if response["incomplete_details"].(map[string]any)["reason"] != want {
					t.Fatalf("wrong incomplete mapping: %v", response)
				}
			})
		}
	}
}

func TestChatResponsesParallelToolArgumentsAndUsage(t *testing.T) {
	_, events := chatResponses(t, []string{
		`{"id":"chat-tools","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"read_file","arguments":"{\"path\":"}},{"index":1,"id":"call_b","type":"function","function":{"name":"read_file","arguments":"{\"path\":"}}]}}]}`,
		`{"id":"chat-tools","choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"function":{"arguments":"\"two\"}"}},{"index":0,"function":{"arguments":"\"one\"}"}}]}}]}`,
		chatFrame(map[string]any{}, "tool_calls"),
		`{"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16}}`, "[DONE]",
	})
	response := terminalResponse(t, events, "completed")
	items := response["output"].([]any)
	if len(items) != 2 {
		t.Fatalf("lost tool calls: %v", response)
	}
	for i, path := range []string{"one", "two"} {
		item := items[i].(map[string]any)
		var arguments map[string]string
		if json.Unmarshal([]byte(item["arguments"].(string)), &arguments) != nil || arguments["path"] != path || item["status"] != "completed" {
			t.Fatalf("lost tool arguments: %v", item)
		}
	}
	if response["usage"].(map[string]any)["input_tokens"] != float64(12) {
		t.Fatal("lost late usage")
	}
}

func TestChatResponsesRejectsIncompleteSuccessfulTools(t *testing.T) {
	for _, arguments := range []string{"", `{`, `{"path":`, `[]`, `null`} {
		t.Run(arguments, func(t *testing.T) {
			delta := map[string]any{"tool_calls": []any{map[string]any{"index": 0, "id": "call_a", "type": "function", "function": map[string]any{"name": "read_file", "arguments": arguments}}}}
			s, events := chatResponses(t, []string{chatFrame(delta, nil)})
			out := s.handle(input{Type: "chunk", Chunk: "data: " + chatFrame(map[string]any{}, "tool_calls")})
			if out.Error == "" || len(out.Chunks) != 0 {
				t.Fatalf("accepted incomplete tool: %v", out)
			}
			for _, event := range events {
				if event["type"] == "response.completed" {
					t.Fatal("completed before DONE")
				}
			}
			if out = s.handle(input{Type: "chunk", Chunk: "data: [DONE]"}); out.Error == "" {
				t.Fatal("resumed failed stream")
			}
		})
	}
}

func TestChatResponsesAllowsTruncatedToolsOnlyAsIncomplete(t *testing.T) {
	delta := map[string]any{"tool_calls": []any{map[string]any{"index": 0, "id": "call_a", "type": "function", "function": map[string]any{"name": "read_file", "arguments": `{"path":`}}}}
	_, events := chatResponses(t, []string{chatFrame(delta, nil), chatFrame(map[string]any{}, "length"), "[DONE]"})
	response := terminalResponse(t, events, "incomplete")
	item := response["output"].([]any)[0].(map[string]any)
	if item["status"] != "incomplete" || item["arguments"] != `{"path":` {
		t.Fatalf("truncated tool was marked completed or modified: %v", item)
	}
}

func TestChatResponsesRequiresDoneAndFinishedChoices(t *testing.T) {
	for _, frames := range [][]string{
		{chatFrame(map[string]any{"content": "OK"}, nil)},
		{chatFrame(map[string]any{"content": "OK"}, nil), chatFrame(map[string]any{}, "stop")},
		{chatFrame(map[string]any{}, "stop")},
	} {
		s, events := chatResponses(t, frames)
		if out := s.handle(input{Type: "finish"}); out.Error == "" || len(out.Chunks) != 0 {
			t.Fatalf("completed at EOF without DONE: %v", out)
		}
		for _, event := range events {
			if event["type"] == "response.completed" {
				t.Fatal("completed before DONE")
			}
		}
	}
	for _, frames := range [][]string{{}, {chatFrame(map[string]any{"content": "partial"}, nil)}} {
		s, _ := chatResponses(t, frames)
		if out := s.handle(input{Type: "chunk", Chunk: "data: [DONE]"}); out.Error == "" {
			t.Fatal("accepted DONE without finished choice")
		}
	}
}

func TestChatResponsesRejectsDuplicateDoneAndDataAfterDone(t *testing.T) {
	for _, tail := range []string{"[DONE]", chatFrame(map[string]any{"content": "late"}, nil)} {
		s, _ := chatResponses(t, []string{chatFrame(map[string]any{}, "stop"), "[DONE]"})
		if out := s.handle(input{Type: "chunk", Chunk: "data: " + tail}); out.Error == "" || len(out.Chunks) != 0 {
			t.Fatal("accepted data after DONE")
		}
	}
}

func TestBridgeFinishRequiresConvertedTerminal(t *testing.T) {
	s, _ := start(t, "openai", "claude", `{"messages":[{"role":"user","content":"hello"}]}`, true)
	if out := s.handle(input{Type: "finish"}); out.Error == "" || len(out.Chunks) != 0 {
		t.Fatalf("accepted missing converted terminal: %v", out)
	}
}

func TestBridgeStreamErrorsDoNotExposeInput(t *testing.T) {
	s, _ := chatResponses(t, []string{})
	for _, frame := range []string{`{"private-key":`, `{"private-tool-argument":true}`} {
		out := s.handle(input{Type: "chunk", Chunk: "data: " + frame})
		if out.Error == "" || bytes.Contains([]byte(out.Error), []byte("private")) {
			t.Fatalf("unsafe stream error: %v", out)
		}
	}
}

func TestChatResponsesIncompleteChoiceCannotBeOverriddenByLaterStop(t *testing.T) {
	s, _ := chatResponses(t, []string{
		`{"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":"length"},{"index":1,"delta":{"content":"answer"},"finish_reason":"stop"}]}`,
	})
	out := s.handle(input{Type: "chunk", Chunk: "data: [DONE]"})
	if out.Error != "" {
		t.Fatal(out.Error)
	}
	terminals := 0
	for _, event := range convertedEvents(t, out.Chunks) {
		if event["type"] == "response.completed" {
			t.Fatal("an incomplete choice was reported completed")
		}
		if event["type"] == "response.incomplete" {
			terminals++
			if event["response"].(map[string]any)["incomplete_details"].(map[string]any)["reason"] != "max_output_tokens" {
				t.Fatal("wrong incomplete details")
			}
		}
	}
	if terminals != 1 {
		t.Fatal("missing incomplete terminal")
	}
}

func TestChatResponsesToolIdentityAndLegacySafety(t *testing.T) {
	for _, frames := range [][]string{
		{`{"choices":[{"index":0,"delta":{"function_call":{"name":"read_file","arguments":"{}"}},"finish_reason":"function_call"}]}`},
		{`{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"read_file","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}`},
		{
			`{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"read_file","arguments":"{"}}]}}]}`,
			`{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_b","function":{"arguments":"}"}}]}}]}`,
		},
	} {
		s, _ := chatResponses(t, nil)
		out := output{}
		for _, frame := range frames {
			out = s.handle(input{Type: "chunk", Chunk: "data: " + frame})
		}
		if out.Error == "" || len(out.Chunks) != 0 {
			t.Fatalf("unsafe tool was accepted: %v", out)
		}
	}
}

func TestBridgeStateReportsOnlyCompletionMetadata(t *testing.T) {
	s, _ := chatResponses(t, []string{chatFrame(map[string]any{}, "stop")})
	out := s.handle(input{Type: "chunk", Chunk: "data: [DONE]"})
	if out.Error != "" || out.State == nil || !out.State.DoneReceived || !out.State.DoneAccepted || !out.State.Terminal || out.State.Finalized || out.State.Failed {
		t.Fatalf("wrong terminal state: %+v", out.State)
	}
	out = s.handle(input{Type: "finish"})
	if out.Error != "" || out.State == nil || !out.State.Finalized {
		t.Fatal("missing finalization state")
	}

	s, _ = chatResponses(t, nil)
	out = s.handle(input{Type: "chunk", Chunk: "data: [DONE]"})
	if out.State == nil || !out.State.DoneReceived || out.State.DoneAccepted || out.State.Terminal || !out.State.Failed {
		t.Fatalf("missing rejected DONE state: %+v", out.State)
	}
}

func TestChatResponsesFallbackRetainsSplitUsage(t *testing.T) {
	_, events := chatResponses(t, []string{
		chatFrame(map[string]any{"reasoning_content": "thinking"}, nil),
		chatFrame(map[string]any{}, "stop"),
		`{"choices":[],"usage":{"prompt_tokens":11,"prompt_tokens_details":{"cached_tokens":7},"completion_tokens_details":{"reasoning_tokens":3}}}`,
		`{"choices":[],"usage":{"output_tokens":5}}`,
		"[DONE]",
	})
	response := terminalResponse(t, events, "completed")
	usage := response["usage"].(map[string]any)
	if usage["input_tokens"] != float64(11) || usage["output_tokens"] != float64(5) || usage["total_tokens"] != float64(16) ||
		usage["input_tokens_details"].(map[string]any)["cached_tokens"] != float64(7) ||
		usage["output_tokens_details"].(map[string]any)["reasoning_tokens"] != float64(3) {
		t.Fatalf("split usage was lost: %v", usage)
	}
}

func TestChatResponsesRejectsInvalidUsage(t *testing.T) {
	for _, usage := range []string{`{"prompt_tokens":-1}`, `{"completion_tokens":1.5}`, `{"total_tokens":"private-tokens"}`, `{"completion_tokens_details":{"reasoning_tokens":-1}}`} {
		s, _ := chatResponses(t, []string{chatFrame(map[string]any{}, "stop")})
		out := s.handle(input{Type: "chunk", Chunk: `data: {"choices":[],"usage":` + usage + `}`})
		if out.Error == "" || len(out.Chunks) != 0 || strings.Contains(out.Error, "private-tokens") {
			t.Fatalf("invalid usage accepted: %v", out)
		}
	}
}

func TestResponsesToChatStrictCompletionAndIncomplete(t *testing.T) {
	for _, scenario := range []struct{ status, reason, finish string }{
		{"completed", "", "stop"},
		{"incomplete", "max_output_tokens", "length"},
		{"incomplete", "content_filter", "content_filter"},
	} {
		t.Run(scenario.status+"/"+scenario.reason, func(t *testing.T) {
			s, _ := start(t, "openai", "openai-response", `{"messages":[{"role":"user","content":"hello"}]}`, true)
			terminal, _ := json.Marshal(map[string]any{"type": "response." + scenario.status, "response": map[string]any{
				"id": "resp-fixture", "model": "Model-Exact", "status": scenario.status, "output": []any{},
				"incomplete_details": map[string]any{"reason": scenario.reason},
			}})
			var combined bytes.Buffer
			for _, frame := range []string{`{"type":"response.created","response":{"id":"resp-fixture","created_at":1}}`, string(terminal)} {
				out := s.handle(input{Type: "chunk", Chunk: "data: " + frame})
				if out.Error != "" {
					t.Fatal(out.Error)
				}
				for _, chunk := range out.Chunks {
					combined.Write(chunk)
				}
			}
			if !strings.Contains(combined.String(), `"finish_reason":"`+scenario.finish+`"`) {
				t.Fatalf("wrong Chat finish reason: %s", combined.String())
			}
			if strings.Contains(combined.String(), "[DONE]") {
				t.Fatal("premature Chat DONE")
			}
			out := s.handle(input{Type: "finish"})
			if out.Error != "" || len(out.Chunks) != 1 || string(out.Chunks[0]) != "data: [DONE]\n\n" {
				t.Fatalf("missing mapped terminal: %+v", out)
			}
		})
	}

	s, _ := start(t, "openai", "openai-response", `{"messages":[{"role":"user","content":"hello"}]}`, true)
	for _, frame := range []string{
		`{"type":"response.created","response":{"id":"resp-fixture","created_at":1}}`,
		`{"type":"response.output_text.delta","delta":"partial"}`,
	} {
		if out := s.handle(input{Type: "chunk", Chunk: "data: " + frame}); out.Error != "" {
			t.Fatal(out.Error)
		}
	}
	if out := s.handle(input{Type: "finish"}); out.Error == "" || len(out.Chunks) != 0 {
		t.Fatal("invented Chat DONE without a real Responses terminal")
	}
}

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
				if out = s.handle(input{Type: "finish"}); out.Error != "" {
					t.Fatalf("stream did not finalize: %s", out.Error)
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

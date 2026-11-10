package main

import (
	"bytes"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	tr "github.com/router-for-me/CLIProxyAPI/v8/sdk/translator"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/translator/builtin"
)

func replayRequest(t *testing.T, items []any) (*session, map[string]any) {
	t.Helper()
	body, err := json.Marshal(map[string]any{
		"input": items, "reasoning": map[string]string{"effort": "max"}, "max_output_tokens": 4096,
		"tools": []any{map[string]any{"type": "function", "name": "diagnostic_probe", "parameters": map[string]any{"type": "object"}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	return start(t, "openai-response", "openai", string(body), true)
}

func replayToolPair(id string) []any {
	return []any{
		map[string]any{"type": "function_call", "call_id": id, "name": "diagnostic_probe", "arguments": `{"path":"keep exact","nested":{"count":2}}`},
		map[string]any{"type": "function_call_output", "call_id": id, "output": "private tool result"},
	}
}

func TestResponsesOpaqueReasoningNeverCreatesReplayText(t *testing.T) {
	for _, reasoning := range []string{
		`{"type":"reasoning","summary":[],"content":null,"encrypted_content":"diagnostic-non-secret-placeholder"}`,
		`{"type":"reasoning","summary":[]}`,
		`{"type":"reasoning","content":[]}`,
		`{"type":"reasoning","content":null}`,
		`{"type":"reasoning","summary":[{"type":"summary_text","text":"  \n "}]}`,
		`{"type":"reasoning","summary":[{"type":"summary_text","text":"[reasoning unavailable]"}]}`,
		`{"type":"reasoning","summary":[{"type":"summary_text","text":"[reasoning unavailable]"},{"type":"summary_text","text":"[reasoning unavailable]"}]}`,
		`{"type":"reasoning","summary":[{"type":"summary_text","text":"  [REASONING UNAVAILABLE]  "}]}`,
		`{"type":"reasoning","content":[{"type":"reasoning_text","text":""}]}`,
	} {
		t.Run(reasoning, func(t *testing.T) {
			var item any
			if json.Unmarshal([]byte(reasoning), &item) != nil {
				t.Fatal("invalid fixture")
			}
			pair := replayToolPair("call_diag")
			_, baseline := replayRequest(t, append(pair, map[string]any{"role": "user", "content": "hi"}))
			s, converted := replayRequest(t, append([]any{item}, append(pair, map[string]any{"role": "user", "content": "hi"})...))
			if !reflect.DeepEqual(baseline, converted) {
				t.Fatalf("opaque item changed visible history: %s", s.translated)
			}
			if bytes.Contains(s.translated, []byte("reasoning_content")) || bytes.Contains(s.translated, []byte("diagnostic-non-secret-placeholder")) {
				t.Fatalf("opaque item leaked into Chat replay: %s", s.translated)
			}
			var original map[string]json.RawMessage
			_ = json.Unmarshal(s.original, &original)
			var items []any
			_ = json.Unmarshal(original["input"], &items)
			if !reflect.DeepEqual(items[0], item) {
				t.Fatal("original request reasoning was changed")
			}
		})
	}
}

func TestOpaqueReasoningPreservesAssistantAndToolMessageBoundaries(t *testing.T) {
	items := []any{
		map[string]any{"type": "function_call", "call_id": "call_one", "name": "diagnostic_probe", "arguments": "{}"},
		map[string]any{"type": "reasoning", "summary": []any{}, "encrypted_content": "opaque"},
		map[string]any{"type": "function_call", "call_id": "call_two", "name": "diagnostic_probe", "arguments": "{}"},
		map[string]any{"type": "function_call_output", "call_id": "call_one", "output": "one"},
		map[string]any{"type": "function_call_output", "call_id": "call_two", "output": "two"},
		map[string]any{"role": "assistant", "content": "keep visible response"},
		map[string]any{"type": "reasoning", "summary": []any{}},
		map[string]any{"role": "user", "content": "hi"},
	}
	_, converted := replayRequest(t, items)
	body, _ := json.Marshal(map[string]any{"model": "Model-Exact", "input": items, "reasoning": map[string]string{"effort": "max"}, "max_output_tokens": 4096,
		"tools": []any{map[string]any{"type": "function", "name": "diagnostic_probe", "parameters": map[string]any{"type": "object"}}}})
	baseline := builtin.Registry().TranslateRequestEnvelope(t.Context(), tr.FormatOpenAIResponse, tr.FormatOpenAI, tr.RequestEnvelope{
		Format: tr.FormatOpenAIResponse, Model: "Model-Exact", Stream: true, Body: body,
	})
	if baseline.Err != nil {
		t.Fatal(baseline.Err)
	}
	var expected map[string]any
	_ = json.Unmarshal(baseline.Body, &expected)
	var messages []any
	for _, value := range expected["messages"].([]any) {
		message := value.(map[string]any)
		if message["role"] == "assistant" && message["reasoning_content"] == "[reasoning unavailable]" {
			delete(message, "reasoning_content")
			if len(message) <= 2 && message["content"] == "" {
				continue
			}
		}
		messages = append(messages, message)
	}
	if !reflect.DeepEqual(messages, converted["messages"]) {
		t.Fatalf("non-reasoning history changed: want %v; got %v", messages, converted["messages"])
	}
}

func TestResponsesReasoningEffortDoesNotInventToolReplayText(t *testing.T) {
	s, converted := replayRequest(t, append(replayToolPair("call_no_reasoning"), map[string]any{"role": "user", "content": "hi"}))
	if bytes.Contains(s.translated, []byte("reasoning_content")) {
		t.Fatalf("invented replay text from effort alone: %s", s.translated)
	}
	if converted["reasoning_effort"] != "max" {
		t.Fatal("reasoning effort changed")
	}
}

func TestResponsesVisibleReasoningIsPreserved(t *testing.T) {
	for _, item := range []map[string]any{
		{"type": "reasoning", "summary": []any{map[string]any{"type": "summary_text", "text": "real visible reasoning"}}},
		{"type": "reasoning", "summary": []any{}, "content": []any{map[string]any{"type": "reasoning_text", "text": "real visible reasoning"}}},
		{"type": "reasoning", "summary": nil, "content": "real visible reasoning", "encrypted_content": "diagnostic-non-secret-placeholder"},
		{"type": "reasoning", "summary": []any{map[string]any{"type": "summary_text", "text": "[reasoning unavailable]"}, map[string]any{"type": "summary_text", "text": "real visible reasoning"}}},
	} {
		s, converted := replayRequest(t, append([]any{item}, append(replayToolPair("call_visible"), map[string]any{"role": "user", "content": "hi"})...))
		messages := converted["messages"].([]any)
		if messages[0].(map[string]any)["reasoning_content"] != "real visible reasoning" || bytes.Contains(s.translated, []byte("reasoning unavailable")) {
			t.Fatalf("visible reasoning lost or polluted: %s", s.translated)
		}
		if messages[1].(map[string]any)["content"] != "private tool result" {
			t.Fatal("tool output changed")
		}
	}
}

func TestResponsesMixedReasoningDoesNotPolluteLaterHistory(t *testing.T) {
	items := []any{
		map[string]any{"type": "reasoning", "summary": []any{}, "encrypted_content": "opaque-one"},
		map[string]any{"type": "reasoning", "summary": []any{map[string]any{"type": "summary_text", "text": "real reasoning"}}},
	}
	items = append(items, replayToolPair("call_one")...)
	items = append(items, map[string]any{"role": "user", "content": "next"}, map[string]any{"type": "reasoning", "summary": []any{}})
	items = append(items, replayToolPair("call_two")...)
	items = append(items, map[string]any{"role": "user", "content": "hi"})
	s, converted := replayRequest(t, items)
	if strings.Contains(string(s.translated), "[reasoning unavailable]") {
		t.Fatalf("mixed reasoning polluted replay: %s", s.translated)
	}
	messages := converted["messages"].([]any)
	if len(messages) != 6 || messages[0].(map[string]any)["reasoning_content"] != "real reasoning" {
		t.Fatalf("history shape changed: %s", s.translated)
	}
	if _, ok := messages[3].(map[string]any)["reasoning_content"]; ok {
		t.Fatalf("opaque later item invented reasoning: %s", s.translated)
	}
}

func TestReplayPlaceholderRemovalIsFieldScoped(t *testing.T) {
	items := []any{map[string]any{"role": "assistant", "content": "[reasoning unavailable] is literal prose", "reasoning_content": "[reasoning unavailable] is a visible explanation"}}
	items = append(items, replayToolPair("call_literal")...)
	items = append(items, map[string]any{"role": "user", "content": "hi"})
	s, _ := replayRequest(t, items)
	for _, text := range []string{"[reasoning unavailable] is literal prose", "[reasoning unavailable] is a visible explanation"} {
		if !bytes.Contains(s.translated, []byte(text)) {
			t.Fatalf("legitimate text was removed: %s", s.translated)
		}
	}
}

func TestOpaqueReplayAdaptationDoesNotChangeOtherProtocolRoutes(t *testing.T) {
	s := &session{registry: builtin.Registry()}
	out := s.handle(input{Type: "request", From: "claude", To: "openai-response", Model: "Model-Exact", Body: json.RawMessage(`{"max_tokens":100,"messages":[{"role":"user","content":"hi"}]}`)})
	if out.Error != "" || bytes.Contains(out.Body, []byte("[reasoning unavailable]")) {
		t.Fatalf("unrelated route changed: %s %s", out.Error, out.Body)
	}
}

func TestLargeOpaqueReplayPreservesAllToolPairsAndVisibleMessages(t *testing.T) {
	var withReasoning, withoutReasoning []any
	for index := 0; index < 48; index++ {
		id := "call_" + strings.Repeat("x", index+1)
		pair := replayToolPair(id)
		message := map[string]any{"role": "user", "content": strings.Repeat("visible history ", 6000)}
		withReasoning = append(withReasoning, map[string]any{"type": "reasoning", "summary": []any{}, "encrypted_content": "diagnostic opaque"})
		withReasoning = append(withReasoning, pair...)
		withReasoning = append(withReasoning, message)
		withoutReasoning = append(withoutReasoning, pair...)
		withoutReasoning = append(withoutReasoning, message)
	}
	s, converted := replayRequest(t, withReasoning)
	_, expected := replayRequest(t, withoutReasoning)
	if !reflect.DeepEqual(converted, expected) {
		t.Fatal("opaque replay changed large visible history or tool pairing")
	}
	if bytes.Contains(s.translated, []byte("reasoning_content")) || bytes.Contains(s.translated, []byte("diagnostic opaque")) {
		t.Fatal("large opaque history generated replay text or leaked opaque metadata")
	}
}

func TestOpaqueReplayPreservesCustomToolInputAndResult(t *testing.T) {
	items := []any{
		map[string]any{"type": "reasoning", "summary": []any{}, "encrypted_content": "opaque"},
		map[string]any{"type": "custom_tool_call", "call_id": "call_custom", "name": "literal_tool", "input": "keep\nexact input"},
		map[string]any{"type": "custom_tool_call_output", "call_id": "call_custom", "output": "exact output"},
		map[string]any{"role": "user", "content": "hi"},
	}
	s, converted := replayRequest(t, items)
	if bytes.Contains(s.translated, []byte("reasoning_content")) {
		t.Fatal("opaque item polluted custom tool history")
	}
	messages := converted["messages"].([]any)
	tool := messages[0].(map[string]any)["tool_calls"].([]any)[0].(map[string]any)
	function := tool["function"].(map[string]any)
	var arguments map[string]string
	if json.Unmarshal([]byte(function["arguments"].(string)), &arguments) != nil || arguments["input"] != "keep\nexact input" || tool["id"] != "call_custom" {
		t.Fatalf("custom tool input changed: %s", s.translated)
	}
	if messages[1].(map[string]any)["content"] != "exact output" || messages[1].(map[string]any)["tool_call_id"] != "call_custom" {
		t.Fatalf("custom tool output changed: %s", s.translated)
	}
}

package main

import (
	"encoding/json"
	"testing"

	"github.com/router-for-me/CLIProxyAPI/v8/sdk/translator/builtin"
)

func TestFinishedChatAccounting(t *testing.T) {
	for _, reason := range []string{`null`, `"stop"`} {
		for _, delta := range []string{`{}`, `{"role":"assistant","content":"","reasoning":"","reasoning_content":"","refusal":"","tool_calls":[]}`} {
			t.Run(reason+delta, func(t *testing.T) {
				_, events := chatResponses(t, []string{chatFrame(map[string]any{"content": "OK"}, nil), chatFrame(map[string]any{}, "stop"),
					`{"choices":[{"index":0,"delta":` + delta + `,"finish_reason":` + reason + `}],"usage":{"prompt_tokens":11,"completion_tokens":5,"total_tokens":16}}`, "[DONE]"})
				response := terminalResponse(t, events, "completed")
				usage, ok := response["usage"].(map[string]any)
				if !ok || usage["input_tokens"] != float64(11) || usage["output_tokens"] != float64(5) {
					t.Fatalf("accounting usage lost: %v", response)
				}
			})
		}
	}
}

func TestFinishedChatRejectsContinuedOutput(t *testing.T) {
	for _, delta := range []string{`{"content":"late"}`, `{"reasoning":"late"}`, `{"reasoning_content":"late"}`, `{"refusal":"late"}`, `{"tool_calls":[{}]}`} {
		s, _ := chatResponses(t, []string{chatFrame(map[string]any{}, "stop")})
		out := s.handle(input{Type: "chunk", Chunk: `data: {"choices":[{"index":0,"delta":` + delta + `,"finish_reason":"stop"}]}`})
		if out.Error == "" {
			t.Fatalf("accepted output after finish: %s", delta)
		}
	}
	s, _ := chatResponses(t, []string{chatFrame(map[string]any{}, "stop")})
	if out := s.handle(input{Type: "chunk", Chunk: chatFrame(json.RawMessage(`{}`), "length")}); out.Error == "" {
		t.Fatal("accepted changed finish reason")
	}
}

func TestChatContentFilterBecomesRefusal(t *testing.T) {
	for _, stream := range []bool{false, true} {
		s, _ := start(t, "claude", "openai", `{"messages":[{"role":"user","content":"hello"}],"max_tokens":100}`, stream)
		if !stream {
			out := s.handle(input{Type: "response", Body: json.RawMessage(`{"id":"chat","choices":[{"index":0,"message":{"role":"assistant","content":""},"finish_reason":"content_filter"}],"usage":{}}`)})
			var body struct {
				StopReason string `json:"stop_reason"`
			}
			if out.Error != "" || json.Unmarshal(out.Body, &body) != nil || body.StopReason != "refusal" {
				t.Fatalf("content filter body lost refusal: %s %s", out.Body, out.Error)
			}
			continue
		}
		s.handle(input{Type: "chunk", Chunk: "data: " + chatFrame(map[string]any{}, "content_filter")})
		out := s.handle(input{Type: "chunk", Chunk: "data: [DONE]"})
		found := false
		for _, event := range convertedEvents(t, out.Chunks) {
			if event["type"] == "message_delta" {
				found = event["delta"].(map[string]any)["stop_reason"] == "refusal"
			}
		}
		if out.Error != "" || !found {
			t.Fatalf("content filter stream lost refusal: %s %s", out.Chunks, out.Error)
		}
	}
}

func TestGeminiFinishReasons(t *testing.T) {
	for _, upstream := range []string{"claude", "openai-response"} {
		for _, reason := range []struct{ source, response, want string }{{"max_tokens", "max_output_tokens", "MAX_TOKENS"}, {"refusal", "content_filter", "SAFETY"}} {
			for _, stream := range []bool{true, false} {
				t.Run(upstream+reason.source+map[bool]string{true: "stream", false: "body"}[stream], func(t *testing.T) {
					s, _ := start(t, "gemini", upstream, `{"contents":[{"role":"user","parts":[{"text":"hello"}]}]}`, stream)
					raw := `{"id":"msg","type":"message","role":"assistant","content":[],"stop_reason":"` + reason.source + `","usage":{"input_tokens":1,"output_tokens":1}}`
					if stream {
						raw = `{"type":"message_delta","delta":{"stop_reason":"` + reason.source + `"},"usage":{"output_tokens":1}}`
					}
					if upstream == "openai-response" {
						raw = `{"id":"resp","object":"response","status":"incomplete","incomplete_details":{"reason":"` + reason.response + `"},"output":[],"usage":{"input_tokens":1,"output_tokens":1}}`
						if stream {
							raw = `{"type":"response.incomplete","response":` + raw + `}`
						}
					}
					var events []map[string]any
					if stream {
						out := s.handle(input{Type: "chunk", Chunk: "data: " + raw})
						if out.Error != "" {
							t.Fatal(out.Error)
						}
						events = convertedEvents(t, out.Chunks)
					} else {
						out := s.handle(input{Type: "response", Body: json.RawMessage(raw)})
						var event map[string]any
						if out.Error != "" || json.Unmarshal(out.Body, &event) != nil {
							t.Fatalf("invalid body: %s %s", out.Body, out.Error)
						}
						events = append(events, event)
					}
					found := false
					for _, event := range events {
						if candidates, ok := event["candidates"].([]any); ok && len(candidates) > 0 {
							found = candidates[0].(map[string]any)["finishReason"] == reason.want
						}
					}
					if !found {
						t.Fatalf("want finishReason %s: %v", reason.want, events)
					}
				})
			}
		}
	}
}

func TestUpstreamErrorIsTerminalAndPreservesCause(t *testing.T) {
	for _, upstream := range []struct{ protocol, frame string }{
		{"claude", `{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`},
		{"openai-response", `{"type":"error","code":"overloaded_error","message":"Overloaded"}`},
		{"openai-response", `{"type":"response.failed","response":{"status":"failed","error":{"code":"overloaded_error","message":"Overloaded"}}}`},
		{"gemini", `{"error":{"code":503,"status":"overloaded_error","message":"Overloaded"}}`},
	} {
		for _, client := range []string{"openai-response", "claude", "openai", "gemini"} {
			if client == upstream.protocol {
				continue
			}
			t.Run(upstream.protocol+upstream.frame+client, func(t *testing.T) {
				request := `{"messages":[{"role":"user","content":"hello"}],"max_tokens":100}`
				switch client {
				case "openai-response":
					request = `{"input":"hello"}`
				case "gemini":
					request = `{"contents":[{"role":"user","parts":[{"text":"hello"}]}]}`
				}
				s := &session{registry: builtin.Registry()}
				setup := s.handle(input{Type: "request", From: client, To: upstream.protocol, Model: "Model-Exact", Stream: true, Body: json.RawMessage(request)})
				if setup.Error != "" {
					t.Fatal(setup.Error)
				}
				out := s.handle(input{Type: "chunk", Chunk: "data: " + upstream.frame})
				if out.Error != "" || len(out.Chunks) != 1 {
					t.Fatalf("missing converted error: %s %s", out.Chunks, out.Error)
				}
				events := convertedEvents(t, out.Chunks)
				if len(events) != 1 {
					t.Fatalf("want one error: %v", events)
				}
				event := events[0]
				if client == "openai-response" {
					if event["type"] != "error" || event["code"] != "overloaded_error" || event["message"] != "Overloaded" {
						t.Fatalf("lost error cause: %v", event)
					}
				} else {
					err, ok := event["error"].(map[string]any)
					if !ok || err["message"] != "Overloaded" || (err["type"] != "overloaded_error" && err["status"] != "overloaded_error") {
						t.Fatalf("lost error cause: %v", event)
					}
				}
				if out.State == nil || !out.State.Failed || !out.State.Terminal {
					t.Fatalf("error is not terminal-failed: %+v", out.State)
				}
				if tail, err := s.finishStream(); err != nil || len(tail) != 0 {
					t.Fatalf("finishStream added another error: %s %v", tail, err)
				}
				if later := s.handle(input{Type: "chunk", Chunk: "data: " + upstream.frame}); later.Error == "" || len(later.Chunks) != 0 {
					t.Fatal("accepted frame after terminal error")
				}
			})
		}
	}
}

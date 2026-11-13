package main

import (
	"encoding/json"
	"testing"

	"github.com/MoeForge/moego/ojson"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/translator/builtin"
)

func TestRequestCompatibility(t *testing.T) {
	for _, tc := range []struct {
		name, from, to, body, path, want string
		stream                           bool
	}{
		{"V6", "claude", "openai", `{"messages":[{"role":"user","content":"hi"}],"max_tokens":100}`, "stream_options.include_usage", "true", true},
		{"V11", "openai", "claude", `{"messages":[{"role":"user","content":"hi"}],"reasoning_effort":"high","max_tokens":16000}`, "thinking.budget_tokens", "15999", false},
		{"V11-small", "openai", "claude", `{"messages":[{"role":"user","content":"hi"}],"reasoning_effort":"high","max_tokens":1024}`, "thinking", "", false},
		{"V13", "openai", "claude", `{"messages":[{"role":"user","content":"hi"}],"reasoning_effort":"high","tool_choice":"required","tools":[{"type":"function","function":{"name":"run","parameters":{"type":"object"}}}]}`, "thinking", "", false},
		{"V14-off", "openai", "gemini", `{"messages":[{"role":"user","content":"hi"}],"reasoning_effort":"none"}`, "generationConfig.thinkingConfig.thinkingBudget", "0", false},
		{"V14-max", "claude", "gemini", `{"messages":[{"role":"user","content":"hi"}],"thinking":{"type":"adaptive"},"output_config":{"effort":"max"}}`, "generationConfig.thinkingConfig.thinkingLevel", `"high"`, false},
		{"V15", "gemini", "openai-response", `{"contents":[{"role":"user","parts":[{"text":"hi"}]}],"generationConfig":{"thinkingConfig":{"thinkingLevel":"low"}}}`, "reasoning.effort", `"low"`, false},
		{"V16-chat-responses", "openai", "openai-response", `{"messages":[{"role":"user","content":"hi"}],"temperature":0,"top_p":0.7,"response_format":{"type":"json_object"}}`, "text.format.type", `"json_object"`, false},
		{"V16-temperature", "openai", "openai-response", `{"messages":[{"role":"user","content":"hi"}],"temperature":0,"top_p":0.7}`, "temperature", "0", false},
		{"V16-top-p", "openai-response", "openai", `{"input":"hi","temperature":0.2,"top_p":0.7}`, "top_p", "0.7", false},
		{"V16-claude", "openai", "claude", `{"messages":[{"role":"user","content":"hi"}],"temperature":0.2}`, "temperature", "0.2", false},
		{"V17", "claude", "openai", `{"messages":[{"role":"user","content":"hi"}],"tools":[{"type":"web_search_20250305","name":"web_search"}]}`, "tools.0", "", false},
		{"V19", "gemini", "openai", `{"contents":[{"role":"user","parts":[{"text":"hi"}]}],"tools":[{"functionDeclarations":[{"name":"run","parameters":{"type":"OBJECT","properties":{"arg":{"type":"STRING","nullable":true}}}}]}]}`, "tools.0.function.parameters.properties.arg.type", `["string","null"]`, false},
		{"V21", "openai-response", "openai", `{"input":"hi","prompt_cache_key":"affinity"}`, "prompt_cache_key", `"affinity"`, false},
		{"V6-merge", "claude", "openai", `{"messages":[{"role":"user","content":"hi"}],"stream_options":{"include_usage":false,"include_obfuscation":true}}`, "stream_options.include_obfuscation", "true", true},
		{"V16-schema", "openai", "openai-response", `{"messages":[{"role":"user","content":"hi"}],"response_format":{"type":"json_schema","json_schema":{"name":"answer","strict":true,"schema":{"type":"object"}}}}`, "text.format.schema.type", `"object"`, false},
		{"V17-gemini", "claude", "gemini", `{"messages":[{"role":"user","content":"hi"}],"tools":[{"type":"web_search_20250305","name":"web_search"},{"name":"run","input_schema":{"type":"object"}}]}`, "tools.0.functionDeclarations.0.name", `"run"`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Log("WORKING: " + tc.name)
			s := session{registry: builtin.Registry()}
			out := s.handle(input{Type: "request", From: tc.from, To: tc.to, Model: "claude-opus-4-1", Stream: tc.stream, Body: json.RawMessage(tc.body)})
			if out.Error != "" {
				t.Fatal(out.Error)
			}
			if got := ojson.GetBytes(out.Body, tc.path).Raw; got != tc.want {
				t.Fatalf("%s: got %s, want %s", tc.path, got, tc.want)
			}
		})
	}
}

func TestClaudeServerToolChoiceCannotBeRepresented(t *testing.T) {
	for _, to := range []string{"openai", "gemini"} {
		t.Run(to, func(t *testing.T) {
			s := session{registry: builtin.Registry()}
			out := s.handle(input{Type: "request", From: "claude", To: to, Model: "test", Body: json.RawMessage(`{"messages":[{"role":"user","content":"hi"}],"tools":[{"type":"web_search_20250305","name":"web_search"}],"tool_choice":{"type":"tool","name":"web_search"}}`)})
			if out.Error != "The request cannot be represented by the upstream protocol." {
				t.Fatal("V17: accepted forced hosted tool")
			}
		})
	}
}

func TestClaudeRequestDocuments(t *testing.T) {
	for _, to := range []string{"openai", "openai-response", "gemini"} {
		for _, source := range []string{`{"type":"base64","media_type":"application/pdf","data":"JVBERg=="}`, `{"type":"text","media_type":"text/plain","data":"document text"}`, `{"type":"url","url":"https://example.com/file.pdf"}`} {
			for _, tool := range []bool{false, true} {
				t.Run(to+source+map[bool]string{true: "-tool", false: "-user"}[tool], func(t *testing.T) {
					block := `{"type":"document","title":"report.pdf","source":` + source + `}`
					if tool {
						block = `{"type":"tool_result","tool_use_id":"call_1","content":[` + block + `]}`
					}
					s := session{registry: builtin.Registry()}
					out := s.handle(input{Type: "request", From: "claude", To: to, Model: "test", Body: json.RawMessage(`{"messages":[{"role":"user","content":[` + block + `]}],"max_tokens":100}`)})
					kind := ojson.Get(source, "type").String()
					if kind == "url" && (to == "openai" || to == "gemini") {
						if out.Error != "The request cannot be represented by the upstream protocol." {
							t.Fatal("V18: expected explicit URL document error")
						}
						return
					}
					if out.Error != "" {
						t.Fatal(out.Error)
					}
					path, want := "", ""
					switch kind {
					case "text":
						switch to {
						case "openai":
							path = "messages.0.content.0.text"
						case "openai-response":
							path = "input.0.content.0.text"
						case "gemini":
							path = "contents.0.parts.0.text"
						}
						if tool {
							switch to {
							case "openai":
								path = "messages.0.content"
							case "openai-response":
								path = "input.0.output.0.text"
							case "gemini":
								path = "contents.0.parts.0.functionResponse.response.result"
							}
						}
						want = "document text"
					case "base64":
						switch to {
						case "openai":
							path = "messages.0.content.0.file.file_data"
							if tool {
								path = "messages.1.content.1.file.file_data"
							}
							want = "data:application/pdf;base64,JVBERg=="
						case "openai-response":
							path = "input.0.content.0.file_data"
							if tool {
								path = "input.0.output.0.file_data"
							}
							want = "data:application/pdf;base64,JVBERg=="
						case "gemini":
							path = "contents.0.parts.0.inline_data.data"
							if tool {
								path = "contents.0.parts.0.functionResponse.parts.0.inlineData.data"
							}
							want = "JVBERg=="
						}
					case "url":
						path = "input.0.content.0.file_url"
						if tool {
							path = "input.0.output.0.file_url"
						}
						want = "https://example.com/file.pdf"
					}
					if got := ojson.GetBytes(out.Body, path).String(); got != want {
						t.Fatalf("V12/V18 %s: got %q want %q", path, got, want)
					}
				})
			}
		}
	}
}

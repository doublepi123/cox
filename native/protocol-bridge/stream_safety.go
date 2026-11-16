package main

import (
	"encoding/json"

	tr "github.com/router-for-me/CLIProxyAPI/v8/sdk/translator"
)

func (s *session) safetyStream() ([][]byte, error) {
	if s.completion.sourceIntegrity.safetySent {
		return nil, nil
	}
	s.completion.sourceIntegrity.safetySent = true
	model, err := json.Marshal(s.model)
	if err != nil {
		return nil, errStreamLifecycle
	}
	var events []string
	switch s.from {
	case tr.FormatOpenAI:
		events = []string{`{"id":"chatcmpl_safety_block","object":"chat.completion.chunk","created":0,"model":` + string(model) + `,"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":"content_filter"}]}`, `[DONE]`}
	case tr.FormatOpenAIResponse, tr.FormatCodex:
		events = []string{`{"type":"response.incomplete","sequence_number":1,"response":{"id":"resp_safety_block","object":"response","created_at":0,"model":` + string(model) + `,"status":"incomplete","output":[],"incomplete_details":{"reason":"content_filter"}}}`}
	case tr.FormatClaude:
		events = []string{
			`{"type":"message_start","message":{"id":"msg_safety_block","type":"message","model":` + string(model) + `,"role":"assistant","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":0,"output_tokens":0}}}`,
			`{"type":"message_delta","delta":{"stop_reason":"refusal"},"usage":{"output_tokens":0}}`,
			`{"type":"message_stop"}`,
		}
	default:
		return nil, errStreamLifecycle
	}
	chunks := make([][]byte, 0, len(events))
	for _, event := range events {
		chunks = append(chunks, []byte("data: "+event+"\n\n"))
	}
	return chunks, nil
}

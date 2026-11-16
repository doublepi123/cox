package main

import (
	"bytes"
	"encoding/json"

	tr "github.com/router-for-me/CLIProxyAPI/v8/sdk/translator"
)

func (s *session) normalizeAnthropicTerminal(chunks [][]byte) ([][]byte, error) {
	for index, chunk := range chunks {
		lines := bytes.Split(chunk, []byte("\n"))
		for line, value := range lines {
			if !bytes.HasPrefix(value, []byte("data:")) {
				continue
			}
			data := bytes.TrimSpace(value[5:])
			if s.from == tr.FormatGemini && s.completion.sourceIntegrity.reason == "model_context_window_exceeded" {
				lines[line] = append([]byte("data: "), s.responseStopCompat(data, "max_tokens")...)
				continue
			}
			if (s.from != tr.FormatOpenAIResponse && s.from != tr.FormatCodex) || len(s.completion.sourceIntegrity.blocks) != 0 {
				continue
			}
			var event map[string]json.RawMessage
			if json.Unmarshal(data, &event) != nil || string(event["type"]) != `"response.incomplete"` {
				continue
			}
			var response map[string]json.RawMessage
			if json.Unmarshal(event["response"], &response) != nil {
				return nil, errStreamLifecycle
			}
			if _, exists := response["output"]; exists {
				continue
			}
			response["output"] = json.RawMessage(`[]`)
			encodedResponse, err := json.Marshal(response)
			if err != nil {
				return nil, errStreamLifecycle
			}
			event["response"] = encodedResponse
			encoded, err := json.Marshal(event)
			if err != nil {
				return nil, errStreamLifecycle
			}
			lines[line] = append([]byte("data: "), encoded...)
		}
		chunks[index] = bytes.Join(lines, []byte("\n"))
	}
	return chunks, nil
}

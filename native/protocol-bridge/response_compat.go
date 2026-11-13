package main

import (
	"bytes"
	"encoding/json"
	"strings"

	tr "github.com/router-for-me/CLIProxyAPI/v8/sdk/translator"
)

func (s *session) sourceStopReason(raw []byte) string {
	var event struct {
		StopReason string `json:"stop_reason"`
		Delta      struct {
			StopReason string `json:"stop_reason"`
		} `json:"delta"`
		Choices []struct {
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
		Status     string `json:"status"`
		Incomplete struct {
			Reason string `json:"reason"`
		} `json:"incomplete_details"`
		Response json.RawMessage `json:"response"`
	}
	if json.Unmarshal(raw, &event) != nil {
		return ""
	}
	if len(event.Response) > 0 {
		return s.sourceStopReason(event.Response)
	}
	switch s.to {
	case tr.FormatOpenAI:
		for _, choice := range event.Choices {
			if choice.FinishReason == "content_filter" {
				return "refusal"
			}
		}
	case tr.FormatClaude:
		if event.Delta.StopReason != "" {
			return event.Delta.StopReason
		}
		return event.StopReason
	case tr.FormatCodex:
		if event.Status == "incomplete" {
			switch event.Incomplete.Reason {
			case "max_output_tokens":
				return "max_tokens"
			case "content_filter":
				return "refusal"
			}
		}
	}
	return ""
}

func (s *session) responseStopCompat(body []byte, reason string) []byte {
	if reason == "" {
		return body
	}
	var event map[string]json.RawMessage
	if json.Unmarshal(body, &event) != nil {
		return body
	}
	switch s.from {
	case tr.FormatClaude:
		if s.to != tr.FormatOpenAI || reason != "refusal" {
			return body
		}
		if string(event["type"]) == `"message_delta"` {
			var delta map[string]json.RawMessage
			if json.Unmarshal(event["delta"], &delta) != nil {
				return body
			}
			delta["stop_reason"] = json.RawMessage(`"refusal"`)
			event["delta"], _ = json.Marshal(delta)
		} else if event["stop_reason"] != nil {
			event["stop_reason"] = json.RawMessage(`"refusal"`)
		} else {
			return body
		}
	case tr.FormatGemini:
		finish := ""
		switch reason {
		case "max_tokens":
			finish = "MAX_TOKENS"
		case "refusal":
			finish = "SAFETY"
		default:
			return body
		}
		var candidates []map[string]json.RawMessage
		if json.Unmarshal(event["candidates"], &candidates) != nil {
			return body
		}
		for _, candidate := range candidates {
			if candidate["finishReason"] != nil {
				candidate["finishReason"], _ = json.Marshal(finish)
			}
		}
		event["candidates"], _ = json.Marshal(candidates)
	default:
		return body
	}
	encoded, err := json.Marshal(event)
	if err != nil {
		return body
	}
	return encoded
}

func (s *session) streamStopCompat(chunks [][]byte, source string) [][]byte {
	reason := s.sourceStopReason([]byte(strings.TrimSpace(strings.TrimPrefix(source, "data:"))))
	if reason != "" {
		s.completion.stopReason = reason
	}
	reason = s.completion.stopReason
	if reason == "" {
		return chunks
	}
	for index, chunk := range chunks {
		lines := bytes.Split(chunk, []byte("\n"))
		for line, value := range lines {
			if bytes.HasPrefix(value, []byte("data:")) {
				lines[line] = append([]byte("data: "), s.responseStopCompat(bytes.TrimSpace(value[5:]), reason)...)
			}
		}
		chunks[index] = bytes.Join(lines, []byte("\n"))
	}
	return chunks
}

func (s *session) upstreamErrorFrame(source string) [][]byte {
	var event struct {
		Type    string `json:"type"`
		Code    string `json:"code"`
		Message string `json:"message"`
		Error   struct {
			Type    string          `json:"type"`
			Code    json.RawMessage `json:"code"`
			Status  string          `json:"status"`
			Message string          `json:"message"`
		} `json:"error"`
		Response json.RawMessage `json:"response"`
	}
	data := strings.TrimSpace(strings.TrimPrefix(source, "data:"))
	if json.Unmarshal([]byte(data), &event) != nil {
		return nil
	}
	if event.Type == "response.failed" {
		data = string(event.Response)
		if json.Unmarshal([]byte(data), &event) != nil {
			return nil
		}
	}
	if event.Type != "error" && event.Error.Message == "" {
		return nil
	}
	kind, message := event.Error.Type, event.Error.Message
	if kind == "" {
		kind = event.Error.Status
	}
	if kind == "" {
		_ = json.Unmarshal(event.Error.Code, &kind)
	}
	if kind == "" {
		kind = event.Code
	}
	if kind == "" {
		kind = "api_error"
	}
	if message == "" {
		message = event.Message
	}
	var body []byte
	switch s.from {
	case tr.FormatOpenAIResponse, tr.FormatCodex:
		body, _ = json.Marshal(map[string]string{"type": "error", "code": kind, "message": message})
	case tr.FormatGemini:
		body, _ = json.Marshal(map[string]any{"error": map[string]any{"code": 502, "status": kind, "message": message}})
	default:
		body, _ = json.Marshal(map[string]any{"type": "error", "error": map[string]string{"type": kind, "message": message}})
	}
	s.completion.sourceTerminal, s.completion.terminal, s.completion.failed, s.completion.finalized = true, true, true, true
	return [][]byte{append(append([]byte("event: error\ndata: "), body...), '\n', '\n')}
}

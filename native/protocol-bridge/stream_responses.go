package main

import (
	"encoding/json"
	"strings"
)

func validResponseItem(raw json.RawMessage) bool {
	var item struct {
		Type      string  `json:"type"`
		Status    string  `json:"status"`
		Name      string  `json:"name"`
		CallID    string  `json:"call_id"`
		Arguments string  `json:"arguments"`
		Input     *string `json:"input"`
		Content   []struct {
			Status string `json:"status"`
		} `json:"content"`
	}
	if json.Unmarshal(raw, &item) != nil || !streamObject(raw) || item.Type == "" || (item.Status != "" && item.Status != "completed") {
		return false
	}
	for _, content := range item.Content {
		if content.Status != "" && content.Status != "completed" {
			return false
		}
	}
	switch item.Type {
	case "function_call":
		return item.Name != "" && item.CallID != "" && validToolArguments(item.Arguments)
	case "custom_tool_call":
		return item.Name != "" && item.CallID != "" && item.Input != nil
	default:
		return true
	}
}

func (s *streamProtocolState) observeResponses(event streamProtocolEvent) (bool, error) {
	if strings.HasPrefix(event.Type, "response.") && (event.OutputIndex != nil ||
		strings.HasSuffix(event.Type, ".delta") || strings.HasPrefix(event.Type, "response.content_part.") ||
		strings.HasPrefix(event.Type, "response.reasoning_summary_part.")) {
		if !validStreamIndex(event.OutputIndex, 4096) {
			return false, errStreamLifecycle
		}
		if s.items == nil {
			s.items = make(map[int]*streamResponseItem)
		}
		index := *event.OutputIndex
		if s.items[index] == nil {
			s.items[index] = &streamResponseItem{valid: true}
		}
		if s.items[index].done {
			return false, errStreamLifecycle
		}
		if err := s.observeResponseContent(event); err != nil {
			return false, err
		}
	}
	switch event.Type {
	case "response.output_item.added", "response.output_item.done", "response.function_call_arguments.delta", "response.function_call_arguments.done":
		if !validStreamIndex(event.OutputIndex, 4096) {
			return false, errStreamLifecycle
		}
		if s.items == nil {
			s.items = make(map[int]*streamResponseItem)
		}
		index := *event.OutputIndex
		item := s.items[index]
		if item == nil {
			item = &streamResponseItem{valid: true}
			s.items[index] = item
		}
		if item.done {
			return false, errStreamLifecycle
		}
		switch event.Type {
		case "response.output_item.added":
			if item.added {
				return false, errStreamLifecycle
			}
			item.added = true
		case "response.function_call_arguments.delta":
			var delta string
			if item.argumentsDone || json.Unmarshal(event.Delta, &delta) != nil {
				return false, errStreamLifecycle
			}
			s.toolBytes += len(delta)
			if s.toolBytes > 16*1024*1024 {
				return false, errStreamLifecycle
			}
			item.arguments += delta
			item.argumentDelta = true
		case "response.function_call_arguments.done":
			if item.argumentsDone {
				return false, errStreamLifecycle
			}
			item.valid = item.valid && validToolArguments(event.Arguments) && (!item.argumentDelta || item.arguments == event.Arguments)
			item.argumentsDone = true
		case "response.output_item.done":
			var done struct {
				Arguments string `json:"arguments"`
			}
			if json.Unmarshal(event.Item, &done) != nil {
				return false, errStreamLifecycle
			}
			item.valid = item.valid && validResponseItem(event.Item) &&
				(!item.argumentDelta || (validToolArguments(item.arguments) && item.arguments == done.Arguments))
			fingerprint, err := responseFingerprint(event.Item)
			if err != nil {
				return false, err
			}
			item.fingerprint = fingerprint
			item.done = true
		}
	case "response.completed", "response.incomplete", "response.failed":
		if event.Type != "response.failed" {
			var response struct {
				Status string            `json:"status"`
				Output []json.RawMessage `json:"output"`
			}
			if json.Unmarshal(event.Response, &response) != nil ||
				event.Type != "response."+response.Status || response.Output == nil {
				return false, errStreamLifecycle
			}
			if event.Type == "response.completed" {
				for _, item := range response.Output {
					if !validResponseItem(item) {
						return false, errStreamLifecycle
					}
				}
				for index, item := range s.items {
					if !item.done || !item.valid || index >= len(response.Output) {
						return false, errStreamLifecycle
					}
					fingerprint, err := responseFingerprint(response.Output[index])
					if err != nil || fingerprint != item.fingerprint || !s.responseContentMatches(index, response.Output[index]) {
						return false, errStreamLifecycle
					}
				}
			}
		}
		s.terminal = true
	}
	return s.terminal, nil
}

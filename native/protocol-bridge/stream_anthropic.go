package main

import "encoding/json"

func incompleteAnthropicReason(reason string) bool {
	return reason == "max_tokens" || reason == "refusal" || reason == "model_context_window_exceeded"
}

func (s *streamProtocolState) observeAnthropic(event streamProtocolEvent) (bool, error) {
	if event.Type == "ping" {
		return s.terminal, nil
	}
	if event.Type == "message_start" {
		var message struct {
			Content []json.RawMessage `json:"content"`
		}
		if s.started || json.Unmarshal(event.Message, &message) != nil || message.Content == nil || len(message.Content) != 0 {
			return false, errStreamLifecycle
		}
		s.started = true
		s.blocks = make(map[int]*streamProtocolBlock)
		return false, nil
	}
	if !s.started {
		return false, errStreamLifecycle
	}
	switch event.Type {
	case "content_block_start":
		if s.reason != "" || !validStreamIndex(event.Index, 4096) || *event.Index != len(s.blocks) {
			return false, errStreamLifecycle
		}
		for _, block := range s.blocks {
			if !block.stopped {
				return false, errStreamLifecycle
			}
		}
		var block struct {
			Type  string          `json:"type"`
			ID    string          `json:"id"`
			Name  string          `json:"name"`
			Input json.RawMessage `json:"input"`
		}
		if json.Unmarshal(event.ContentBlock, &block) != nil || block.Type == "" {
			return false, errStreamLifecycle
		}
		kind := "other"
		switch block.Type {
		case "tool_use", "server_tool_use", "text", "thinking":
			kind = block.Type
		}
		s.blocks[*event.Index] = &streamProtocolBlock{kind: kind, validInput: streamObject(block.Input), validIdentity: block.ID != "" && block.Name != ""}
	case "content_block_delta", "content_block_stop":
		if s.reason != "" || !validStreamIndex(event.Index, 4096) {
			return false, errStreamLifecycle
		}
		block := s.blocks[*event.Index]
		if block == nil || block.stopped {
			return false, errStreamLifecycle
		}
		if event.Type == "content_block_stop" {
			block.stopped = true
			return false, nil
		}
		var delta struct {
			Type        string  `json:"type"`
			PartialJSON *string `json:"partial_json"`
		}
		if json.Unmarshal(event.Delta, &delta) != nil {
			return false, errStreamLifecycle
		}
		switch delta.Type {
		case "input_json_delta":
			if (block.kind != "tool_use" && block.kind != "server_tool_use") || delta.PartialJSON == nil {
				return false, errStreamLifecycle
			}
			s.toolBytes += len(*delta.PartialJSON)
			if s.toolBytes > 16*1024*1024 {
				return false, errStreamLifecycle
			}
			block.arguments += *delta.PartialJSON
			block.fragmented = true
		case "text_delta":
			if block.kind != "text" {
				return false, errStreamLifecycle
			}
		case "thinking_delta", "signature_delta":
			if block.kind != "thinking" {
				return false, errStreamLifecycle
			}
		}
	case "message_delta", "message_stop":
		for _, block := range s.blocks {
			if !block.stopped {
				return false, errStreamLifecycle
			}
		}
		if event.Type == "message_delta" {
			var delta struct {
				StopReason *string `json:"stop_reason"`
			}
			if json.Unmarshal(event.Delta, &delta) != nil {
				return false, errStreamLifecycle
			}
			if delta.StopReason != nil {
				if s.reason != "" {
					return false, errStreamLifecycle
				}
				switch *delta.StopReason {
				case "end_turn", "stop_sequence", "tool_use", "pause_turn", "max_tokens", "refusal", "model_context_window_exceeded":
					s.reason = *delta.StopReason
				default:
					return false, errStreamLifecycle
				}
			}
			return false, nil
		}
		if s.reason == "" {
			return false, errStreamLifecycle
		}
		if !incompleteAnthropicReason(s.reason) {
			for _, block := range s.blocks {
				if block.kind != "tool_use" && block.kind != "server_tool_use" {
					continue
				}
				valid := block.validInput
				if block.fragmented {
					valid = validToolArguments(block.arguments)
				}
				if !block.validIdentity || !valid {
					return false, errStreamLifecycle
				}
			}
		}
		s.terminal = true
	}
	return s.terminal, nil
}

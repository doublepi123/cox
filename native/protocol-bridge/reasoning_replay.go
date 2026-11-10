package main

import (
	"encoding/json"
	"errors"
	"strings"
)

type reasoningReplayState struct {
	OpaqueItemsOmitted       int `json:"opaqueItemsOmitted"`
	UnavailableFieldsOmitted int `json:"unavailableFieldsOmitted"`
}

func unavailableReasoning(text string) bool {
	text = strings.TrimSpace(text)
	return text == "" || strings.EqualFold(text, "[reasoning unavailable]")
}

func visibleReasoningParts(raw json.RawMessage, summary bool) []string {
	var text string
	if !summary && json.Unmarshal(raw, &text) == nil {
		if !unavailableReasoning(text) {
			return []string{text}
		}
		return nil
	}
	var parts []json.RawMessage
	if json.Unmarshal(raw, &parts) != nil {
		return nil
	}
	var texts []string
	for _, rawPart := range parts {
		var part struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}
		if json.Unmarshal(rawPart, &part) != nil {
			continue
		}
		if summary && part.Type != "summary_text" {
			continue
		}
		if !summary && part.Type != "reasoning_text" && part.Type != "text" && part.Type != "output_text" {
			continue
		}
		if !unavailableReasoning(part.Text) {
			texts = append(texts, part.Text)
		}
	}
	return texts
}

func responsesChatReplayBody(body []byte, replay *reasoningReplayState) ([]byte, error) {
	var fields map[string]json.RawMessage
	if json.Unmarshal(body, &fields) != nil {
		return nil, errors.New("Invalid Responses reasoning replay input.")
	}
	var items []json.RawMessage
	if json.Unmarshal(fields["input"], &items) != nil {
		return body, nil
	}
	next := make([]json.RawMessage, 0, len(items))
	changed := false
	for _, raw := range items {
		var item map[string]json.RawMessage
		var itemType string
		if json.Unmarshal(raw, &item) != nil || json.Unmarshal(item["type"], &itemType) != nil || itemType != "reasoning" {
			next = append(next, raw)
			continue
		}
		texts := visibleReasoningParts(item["summary"], true)
		if len(texts) == 0 {
			texts = visibleReasoningParts(item["content"], false)
		}
		if len(texts) == 0 {
			replay.OpaqueItemsOmitted++
			changed = true
			item["summary"] = json.RawMessage(`[]`)
			encoded, err := json.Marshal(item)
			if err != nil {
				return nil, errors.New("Could not prepare Responses reasoning replay.")
			}
			next = append(next, encoded)
			continue
		}
		changed = true
		summary := make([]map[string]string, 0, len(texts))
		for _, text := range texts {
			summary = append(summary, map[string]string{"type": "summary_text", "text": text})
		}
		item["summary"], _ = json.Marshal(summary)
		encoded, err := json.Marshal(item)
		if err != nil {
			return nil, errors.New("Could not prepare visible reasoning replay.")
		}
		next = append(next, encoded)
	}
	if !changed {
		return body, nil
	}
	fields["input"], _ = json.Marshal(next)
	encoded, err := json.Marshal(fields)
	if err != nil {
		return nil, errors.New("Could not prepare Responses reasoning replay.")
	}
	return encoded, nil
}

func withoutUnavailableChatReasoning(body []byte, replay *reasoningReplayState) ([]byte, error) {
	var fields map[string]json.RawMessage
	if json.Unmarshal(body, &fields) != nil {
		return nil, errors.New("Invalid Chat reasoning replay output.")
	}
	var messages []json.RawMessage
	if json.Unmarshal(fields["messages"], &messages) != nil {
		return body, nil
	}
	changed := false
	next := make([]json.RawMessage, 0, len(messages))
	for _, raw := range messages {
		var message map[string]json.RawMessage
		var role string
		if json.Unmarshal(raw, &message) != nil || json.Unmarshal(message["role"], &role) != nil || role != "assistant" {
			next = append(next, raw)
			continue
		}
		var text string
		if reasoningRaw, exists := message["reasoning_content"]; exists && json.Unmarshal(reasoningRaw, &text) == nil && unavailableReasoning(text) {
			delete(message, "reasoning_content")
			replay.UnavailableFieldsOmitted++
			changed = true
			var content string
			contentEmpty := message["content"] == nil || string(message["content"]) == "null" ||
				(json.Unmarshal(message["content"], &content) == nil && content == "")
			if contentEmpty && (len(message) == 1 || (len(message) == 2 && message["content"] != nil)) {
				continue
			}
			var err error
			raw, err = json.Marshal(message)
			if err != nil {
				return nil, errors.New("Could not remove unavailable Chat reasoning replay.")
			}
		}
		next = append(next, raw)
	}
	if !changed {
		return body, nil
	}
	fields["messages"], _ = json.Marshal(next)
	encoded, err := json.Marshal(fields)
	if err != nil {
		return nil, errors.New("Could not remove unavailable Chat reasoning replay.")
	}
	return encoded, nil
}

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"hash"
	"strconv"
	"strings"
)

type streamContent struct {
	outputIndex int
	index       int
	field       string
	summary     bool
	hash        hash.Hash
	done        bool
	deltaSeen   bool
	valid       bool
}

type streamOutputPart struct {
	Type    string `json:"type"`
	Text    string `json:"text"`
	Refusal string `json:"refusal"`
}

type streamOutputSnapshot struct {
	Type      string             `json:"type"`
	Name      string             `json:"name"`
	CallID    string             `json:"call_id"`
	Arguments string             `json:"arguments"`
	Input     string             `json:"input"`
	Content   []streamOutputPart `json:"content"`
	Summary   []streamOutputPart `json:"summary"`
}

func responseFingerprint(raw json.RawMessage) (string, error) {
	var item streamOutputSnapshot
	if json.Unmarshal(raw, &item) != nil {
		return "", errStreamLifecycle
	}
	canonical, err := json.Marshal(item)
	if err != nil {
		return "", errStreamLifecycle
	}
	sum := sha256.Sum256(canonical)
	return hex.EncodeToString(sum[:]), nil
}

func (s *streamProtocolState) observeResponseContent(event streamProtocolEvent) error {
	name := strings.TrimSuffix(strings.TrimSuffix(event.Type, ".delta"), ".done")
	field, summary := "text", false
	switch name {
	case "response.output_text", "response.reasoning_text":
	case "response.refusal":
		field = "refusal"
	case "response.reasoning_summary_text":
		summary = true
	default:
		return nil
	}
	var value struct {
		ContentIndex *int    `json:"content_index"`
		SummaryIndex *int    `json:"summary_index"`
		Delta        *string `json:"delta"`
		Text         *string `json:"text"`
		Refusal      *string `json:"refusal"`
	}
	if json.Unmarshal(event.Raw, &value) != nil || !validStreamIndex(event.OutputIndex, 4096) {
		return errStreamLifecycle
	}
	index := value.ContentIndex
	if summary {
		index = value.SummaryIndex
	}
	if !validStreamIndex(index, 4096) {
		return errStreamLifecycle
	}
	if s.content == nil {
		s.content = make(map[string]*streamContent)
	}
	key := strconv.Itoa(*event.OutputIndex) + ":" + strconv.Itoa(*index) + ":" + name
	part := s.content[key]
	if part == nil {
		if len(s.content) >= 4096 {
			return errStreamLifecycle
		}
		part = &streamContent{outputIndex: *event.OutputIndex, index: *index, field: field, summary: summary, hash: sha256.New(), valid: true}
		s.content[key] = part
	}
	if part.done {
		return errStreamLifecycle
	}
	if strings.HasSuffix(event.Type, ".delta") {
		if value.Delta == nil {
			return errStreamLifecycle
		}
		part.hash.Write([]byte(*value.Delta))
		part.deltaSeen = true
	} else {
		text := value.Text
		if field == "refusal" {
			text = value.Refusal
		}
		if text == nil {
			part.valid = false
		} else {
			if !part.deltaSeen {
				part.hash.Write([]byte(*text))
			}
			sum := sha256.Sum256([]byte(*text))
			part.valid = hex.EncodeToString(part.hash.Sum(nil)) == hex.EncodeToString(sum[:])
		}
		part.done = true
	}
	return nil
}

func (s *streamProtocolState) responseContentMatches(index int, raw json.RawMessage) bool {
	var item streamOutputSnapshot
	if json.Unmarshal(raw, &item) != nil {
		return false
	}
	for _, part := range s.content {
		if part.outputIndex != index {
			continue
		}
		values := item.Content
		if part.summary {
			values = item.Summary
		}
		if !part.valid || part.index >= len(values) {
			return false
		}
		text := values[part.index].Text
		if part.field == "refusal" {
			text = values[part.index].Refusal
		}
		sum := sha256.Sum256([]byte(text))
		if hex.EncodeToString(sum[:]) != hex.EncodeToString(part.hash.Sum(nil)) {
			return false
		}
	}
	return true
}

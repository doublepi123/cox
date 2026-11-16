package main

import (
	"encoding/json"
	"errors"

	tr "github.com/router-for-me/CLIProxyAPI/v8/sdk/translator"
)

type streamProtocolState struct {
	terminal   bool
	started    bool
	reason     string
	safety     bool
	safetySent bool
	blocks     map[int]*streamProtocolBlock
	candidates map[int]streamCandidate
	items      map[int]*streamResponseItem
	toolBytes  int
	content    map[string]*streamContent
}

type streamProtocolBlock struct {
	kind          string
	validInput    bool
	validIdentity bool
	arguments     string
	fragmented    bool
	stopped       bool
}

type streamCandidate struct {
	reason     string
	validTools bool
}

type streamResponseItem struct {
	done          bool
	arguments     string
	argumentDelta bool
	argumentsDone bool
	valid         bool
	added         bool
	fingerprint   string
}

type streamProtocolEvent struct {
	Raw            json.RawMessage   `json:"-"`
	Type           string            `json:"type"`
	Index          *int              `json:"index"`
	OutputIndex    *int              `json:"output_index"`
	Message        json.RawMessage   `json:"message"`
	ContentBlock   json.RawMessage   `json:"content_block"`
	Delta          json.RawMessage   `json:"delta"`
	Arguments      string            `json:"arguments"`
	Item           json.RawMessage   `json:"item"`
	Response       json.RawMessage   `json:"response"`
	Candidates     []json.RawMessage `json:"candidates"`
	PromptFeedback struct {
		BlockReason string `json:"blockReason"`
	} `json:"promptFeedback"`
}

var errStreamLifecycle = errors.New("The upstream stream has an invalid or unfinished protocol lifecycle.")

func (s *streamProtocolState) observe(format tr.Format, data string) (bool, error) {
	var event streamProtocolEvent
	if json.Unmarshal([]byte(data), &event) != nil {
		return false, errStreamLifecycle
	}
	event.Raw = json.RawMessage(data)
	if s.terminal && format != tr.FormatGemini && event.Type != "ping" {
		return false, errStreamLifecycle
	}
	switch format {
	case tr.FormatClaude:
		return s.observeAnthropic(event)
	case tr.FormatCodex, tr.FormatOpenAIResponse:
		return s.observeResponses(event)
	case tr.FormatGemini:
		return s.observeGemini(event)
	default:
		return false, nil
	}
}

func streamObject(raw json.RawMessage) bool {
	var value map[string]json.RawMessage
	return json.Unmarshal(raw, &value) == nil && value != nil
}

func validStreamIndex(index *int, limit int) bool {
	return index != nil && *index >= 0 && *index < limit
}

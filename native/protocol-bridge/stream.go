package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"

	tr "github.com/router-for-me/CLIProxyAPI/v8/sdk/translator"
)

type streamCompletion struct {
	sourceIntegrity    streamProtocolState
	convertedIntegrity streamProtocolState
	sourceDone         bool
	sourceDoneReceived bool
	sourceTerminal     bool
	chatFinished       map[int]bool
	messageFinished    bool
	finalized          bool
	terminal           bool
	failed             bool
	choices            map[int]string
	tools              map[[2]int]*streamTool
	toolBytes          int
	response           map[string]json.RawMessage
	items              map[int]json.RawMessage
	openItems          map[int]bool
	sequence           int
	usage              map[string]json.RawMessage
	itemBytes          int
	stopReason         string
}

type streamState struct {
	DoneReceived bool `json:"doneReceived"`
	DoneAccepted bool `json:"doneAccepted"`
	Terminal     bool `json:"terminal"`
	Finalized    bool `json:"finalized"`
	Failed       bool `json:"failed"`
}

type streamTool struct {
	id        string
	name      string
	arguments strings.Builder
}

func (s *session) observeConverted(chunks [][]byte) error {
	for _, chunk := range chunks {
		for _, frame := range bytes.Split(bytes.ReplaceAll(chunk, []byte("\r\n"), []byte("\n")), []byte("\n\n")) {
			var lines []string
			for _, line := range strings.Split(string(frame), "\n") {
				if strings.HasPrefix(line, "data:") {
					lines = append(lines, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
				}
			}
			if len(lines) == 0 {
				continue
			}
			data := strings.Join(lines, "\n")
			if data == "[DONE]" {
				if s.from == tr.FormatOpenAI {
					if s.completion.terminal {
						return errors.New("The protocol converter emitted duplicate terminal events.")
					}
					s.completion.terminal = true
				}
				continue
			}
			if s.from != tr.FormatOpenAI {
				if _, err := s.completion.convertedIntegrity.observe(s.from, data); err != nil {
					return err
				}
			}
			var event struct {
				Type     string                     `json:"type"`
				Sequence int                        `json:"sequence_number"`
				Index    int                        `json:"output_index"`
				Response map[string]json.RawMessage `json:"response"`
				Item     json.RawMessage            `json:"item"`
				Delta    json.RawMessage            `json:"delta"`
				Choices  []struct {
					Index        int     `json:"index"`
					FinishReason *string `json:"finish_reason"`
				} `json:"choices"`
				Candidates []struct {
					FinishReason string `json:"finishReason"`
				} `json:"candidates"`
			}
			if json.Unmarshal([]byte(data), &event) != nil {
				return errors.New("The protocol converter emitted invalid JSON.")
			}
			if s.completion.terminal && s.from != tr.FormatGemini {
				return errors.New("The protocol converter emitted data after its terminal event.")
			}
			if s.from == tr.FormatOpenAI {
				if s.completion.chatFinished == nil {
					s.completion.chatFinished = make(map[int]bool)
				}
				for _, choice := range event.Choices {
					s.completion.chatFinished[choice.Index] = choice.FinishReason != nil && *choice.FinishReason != ""
				}
			}
			if event.Type == "message_delta" {
				var delta struct {
					StopReason string `json:"stop_reason"`
				}
				if json.Unmarshal(event.Delta, &delta) == nil && delta.StopReason != "" {
					s.completion.messageFinished = true
				}
			}
			if event.Sequence > s.completion.sequence {
				s.completion.sequence = event.Sequence
			}
			if event.Type == "response.created" {
				s.completion.response = event.Response
			}
			if event.Type == "response.output_item.added" || event.Type == "response.output_item.done" {
				if s.completion.items == nil {
					s.completion.items = make(map[int]json.RawMessage)
					s.completion.openItems = make(map[int]bool)
				}
				if event.Index < 0 || event.Index >= 4096 {
					return errors.New("The protocol converter emitted too many output items.")
				}
				s.completion.openItems[event.Index] = event.Type == "response.output_item.added"
				if event.Type == "response.output_item.done" {
					var item struct {
						Type      string `json:"type"`
						Status    string `json:"status"`
						Arguments string `json:"arguments"`
					}
					if json.Unmarshal(event.Item, &item) != nil || (item.Type == "function_call" && item.Status != "incomplete" && !validToolArguments(item.Arguments)) {
						return errors.New("The protocol converter received incomplete tool arguments.")
					}
					s.completion.itemBytes += len(event.Item) - len(s.completion.items[event.Index])
					if s.completion.itemBytes > 16*1024*1024 {
						return errors.New("The protocol converter completion state is too large.")
					}
					s.completion.items[event.Index] = event.Item
				}
			}
			terminal := event.Type == "response.completed" || event.Type == "response.incomplete" || event.Type == "response.failed" || event.Type == "message_stop"
			if s.from == tr.FormatGemini {
				terminal = s.completion.convertedIntegrity.terminal
				s.completion.terminal = terminal
			}
			if terminal {
				if s.to == tr.FormatOpenAI && s.from == tr.FormatOpenAIResponse {
					if !s.completion.sourceDone {
						return errors.New("The protocol converter completed a Responses reply before [DONE].")
					}
					for _, open := range s.completion.openItems {
						if open {
							return errors.New("The protocol converter left an output item unfinished.")
						}
					}
				}
				if s.completion.terminal && s.from != tr.FormatGemini {
					return errors.New("The protocol converter emitted duplicate terminal events.")
				}
				s.completion.terminal = true
			}
		}
	}
	return nil
}

func (s *session) finishStream() ([][]byte, error) {
	if s.completion.failed && s.completion.terminal {
		return nil, nil
	}
	if s.to == tr.FormatOpenAI && !s.completion.sourceDone {
		return nil, errors.New("The upstream Chat stream ended without [DONE].")
	}
	if !s.completion.sourceTerminal {
		return nil, errors.New("The upstream stream ended before its terminal event.")
	}
	var tail [][]byte
	if !s.completion.terminal && s.completion.sourceTerminal {
		if s.from == tr.FormatOpenAI && len(s.completion.chatFinished) > 0 {
			for _, finished := range s.completion.chatFinished {
				if !finished {
					return nil, errors.New("The protocol converter left a Chat choice unfinished.")
				}
			}
			tail = append(tail, []byte("data: [DONE]\n\n"))
		} else if s.from == tr.FormatClaude && s.to == tr.FormatGemini && s.completion.messageFinished {
			tail = append(tail, []byte("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"))
		}
		if err := s.observeConverted(tail); err != nil {
			return nil, err
		}
	}
	if !s.completion.terminal {
		return nil, errors.New("The protocol converter did not emit a terminal stream event.")
	}
	s.completion.finalized = true
	return tail, nil
}

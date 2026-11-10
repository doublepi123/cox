package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"sort"
	"strings"

	tr "github.com/router-for-me/CLIProxyAPI/v8/sdk/translator"
)

type streamCompletion struct {
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

func incompleteChatReason(reason string) bool {
	return reason == "length" || reason == "max_tokens" || reason == "content_filter"
}

func validToolArguments(arguments string) bool {
	var value map[string]json.RawMessage
	return json.Unmarshal([]byte(arguments), &value) == nil && value != nil
}

func (s *session) validateTools(choice int, reason string) error {
	if incompleteChatReason(reason) {
		return nil
	}
	for key, tool := range s.completion.tools {
		if key[0] == choice && (tool.id == "" || tool.name == "" || !validToolArguments(tool.arguments.String())) {
			return errors.New("The upstream Chat stream has incomplete tool arguments or identity.")
		}
	}
	return nil
}

func (s *session) responseIncompleteReason() string {
	reason := ""
	for _, finish := range s.completion.choices {
		if finish == "content_filter" {
			return "content_filter"
		}
		if finish == "length" || finish == "max_tokens" {
			reason = "max_output_tokens"
		}
	}
	return reason
}

func (s *session) observeUsage(usage map[string]json.RawMessage) error {
	if usage == nil {
		return nil
	}
	if s.completion.usage == nil {
		s.completion.usage = make(map[string]json.RawMessage)
	}
	for _, key := range []string{"prompt_tokens", "completion_tokens", "output_tokens", "total_tokens"} {
		if value := usage[key]; value != nil && string(value) != "null" {
			var tokens int64
			if json.Unmarshal(value, &tokens) != nil || tokens < 0 {
				return errors.New("The upstream Chat stream has invalid usage metadata.")
			}
			s.completion.usage[key] = value
		}
	}
	for _, detail := range []struct{ key, token string }{
		{"prompt_tokens_details", "cached_tokens"},
		{"completion_tokens_details", "reasoning_tokens"},
		{"output_tokens_details", "reasoning_tokens"},
	} {
		if raw := usage[detail.key]; raw != nil && string(raw) != "null" {
			var fields map[string]json.RawMessage
			if json.Unmarshal(raw, &fields) != nil {
				return errors.New("The upstream Chat stream has invalid usage metadata.")
			}
			if value := fields[detail.token]; value != nil && string(value) != "null" {
				var tokens int64
				if json.Unmarshal(value, &tokens) != nil || tokens < 0 {
					return errors.New("The upstream Chat stream has invalid usage metadata.")
				}
				s.completion.usage[detail.key], _ = json.Marshal(map[string]json.RawMessage{detail.token: value})
			}
		}
	}
	return nil
}

func (s *session) normalizeResponseTerminal(chunks [][]byte) ([][]byte, error) {
	if s.to != tr.FormatOpenAI || s.from != tr.FormatOpenAIResponse || !s.completion.sourceDone {
		return chunks, nil
	}
	reason := s.responseIncompleteReason()
	if reason == "" {
		return chunks, nil
	}
	for index, chunk := range chunks {
		var frames [][]byte
		for _, frame := range bytes.Split(bytes.ReplaceAll(chunk, []byte("\r\n"), []byte("\n")), []byte("\n\n")) {
			if len(bytes.TrimSpace(frame)) == 0 {
				continue
			}
			var data []byte
			for _, line := range bytes.Split(frame, []byte("\n")) {
				if bytes.HasPrefix(line, []byte("data:")) {
					if len(data) > 0 {
						data = append(data, '\n')
					}
					data = append(data, bytes.TrimPrefix(line[5:], []byte(" "))...)
				}
			}
			var event map[string]json.RawMessage
			if json.Unmarshal(data, &event) == nil && string(event["type"]) == `"response.completed"` {
				var response map[string]json.RawMessage
				if json.Unmarshal(event["response"], &response) != nil {
					return nil, errors.New("The protocol converter emitted an invalid Responses terminal event.")
				}
				event["type"] = json.RawMessage(`"response.incomplete"`)
				response["status"] = json.RawMessage(`"incomplete"`)
				response["incomplete_details"], _ = json.Marshal(map[string]string{"reason": reason})
				event["response"], _ = json.Marshal(response)
				encoded, err := json.Marshal(event)
				if err != nil {
					return nil, errors.New("The protocol converter could not encode an incomplete reply.")
				}
				frame = append([]byte("event: response.incomplete\ndata: "), encoded...)
			}
			frames = append(frames, append(frame, '\n', '\n'))
		}
		chunks[index] = bytes.Join(frames, nil)
	}
	return chunks, nil
}

func (s *session) observeSource(frame string) error {
	if s.completion.finalized {
		return errors.New("The protocol stream is already finalized.")
	}
	if len(frame) > 16*1024*1024 {
		return errors.New("The upstream stream event is too large.")
	}
	data := strings.TrimSpace(strings.TrimPrefix(frame, "data:"))
	if data == "[DONE]" {
		s.completion.sourceDoneReceived = true
		if s.completion.sourceDone {
			return errors.New("The upstream stream sent duplicate [DONE] markers.")
		}
		if s.to == tr.FormatOpenAI && s.from == tr.FormatOpenAIResponse {
			if len(s.completion.choices) == 0 {
				return errors.New("The upstream Chat stream has no finished choice.")
			}
			for choice, reason := range s.completion.choices {
				if reason == "" {
					return errors.New("The upstream Chat stream has an unfinished choice.")
				}
				if err := s.validateTools(choice, reason); err != nil {
					return err
				}
			}
		}
		if s.to != tr.FormatOpenAI && (s.to != tr.FormatCodex || !s.completion.sourceTerminal) {
			return errors.New("The upstream stream sent an unexpected [DONE] marker.")
		}
		s.completion.sourceDone = true
		s.completion.sourceTerminal = s.completion.sourceTerminal || s.to == tr.FormatOpenAI
		return nil
	}
	if !json.Valid([]byte(data)) {
		return errors.New("The upstream stream event is not valid JSON.")
	}
	if s.to != tr.FormatOpenAI || s.from != tr.FormatOpenAIResponse {
		var event struct {
			Type       string `json:"type"`
			Candidates []struct {
				FinishReason string `json:"finishReason"`
			} `json:"candidates"`
		}
		if json.Unmarshal([]byte(data), &event) != nil {
			return errors.New("The upstream stream event is invalid.")
		}
		if s.to == tr.FormatCodex {
			s.completion.sourceTerminal = s.completion.sourceTerminal || event.Type == "response.completed" || event.Type == "response.incomplete" || event.Type == "response.failed"
		} else if s.to == tr.FormatClaude {
			s.completion.sourceTerminal = s.completion.sourceTerminal || event.Type == "message_stop"
		} else if s.to == tr.FormatGemini {
			for _, candidate := range event.Candidates {
				s.completion.sourceTerminal = s.completion.sourceTerminal || candidate.FinishReason != ""
			}
		}
		return nil
	}
	if s.completion.sourceDone {
		return errors.New("The upstream Chat stream sent data after [DONE].")
	}
	var event struct {
		Usage   map[string]json.RawMessage `json:"usage"`
		Choices []struct {
			Index        int             `json:"index"`
			FinishReason *string         `json:"finish_reason"`
			Delta        json.RawMessage `json:"delta"`
		} `json:"choices"`
	}
	if json.Unmarshal([]byte(data), &event) != nil || event.Choices == nil {
		return errors.New("The upstream sent an invalid Chat stream event.")
	}
	if err := s.observeUsage(event.Usage); err != nil {
		return err
	}
	if s.completion.choices == nil {
		s.completion.choices = make(map[int]string)
	}
	for _, choice := range event.Choices {
		if choice.Index < 0 || choice.Index >= 128 {
			return errors.New("The upstream Chat stream has too many choices.")
		}
		if s.completion.choices[choice.Index] != "" {
			return errors.New("The upstream Chat stream continued a finished choice.")
		}
		var delta struct {
			FunctionCall json.RawMessage `json:"function_call"`
			Tools        []struct {
				Index    int    `json:"index"`
				ID       string `json:"id"`
				Function struct {
					Name      string `json:"name"`
					Arguments string `json:"arguments"`
				} `json:"function"`
			} `json:"tool_calls"`
		}
		if len(choice.Delta) > 0 && json.Unmarshal(choice.Delta, &delta) != nil {
			return errors.New("The upstream Chat stream has an invalid delta.")
		}
		if len(delta.FunctionCall) > 0 && string(delta.FunctionCall) != "null" {
			return errors.New("Legacy Chat function calls cannot be converted safely to Responses.")
		}
		for _, part := range delta.Tools {
			if part.Index < 0 || part.Index >= 4096 {
				return errors.New("The upstream Chat stream has too many tool calls.")
			}
			if s.completion.tools == nil {
				s.completion.tools = make(map[[2]int]*streamTool)
			}
			key := [2]int{choice.Index, part.Index}
			tool := s.completion.tools[key]
			if tool == nil {
				if len(s.completion.tools) >= 4096 {
					return errors.New("The upstream Chat stream has too many tool calls.")
				}
				tool = &streamTool{}
				s.completion.tools[key] = tool
			}
			if part.ID != "" {
				if tool.id != "" && tool.id != part.ID {
					return errors.New("The upstream Chat stream changed a tool call identity.")
				}
				tool.id = part.ID
			}
			if part.Function.Name != "" {
				if tool.name != "" && tool.name != part.Function.Name {
					return errors.New("The upstream Chat stream changed a tool call identity.")
				}
				tool.name = part.Function.Name
			}
			s.completion.toolBytes += len(part.ID) + len(part.Function.Name) + len(part.Function.Arguments)
			if s.completion.toolBytes > 16*1024*1024 {
				return errors.New("The upstream Chat tool state is too large.")
			}
			tool.arguments.WriteString(part.Function.Arguments)
		}
		reason := ""
		if choice.FinishReason != nil {
			reason = *choice.FinishReason
		}
		switch reason {
		case "", "stop", "tool_calls", "function_call", "length", "max_tokens", "content_filter":
		default:
			return errors.New("The upstream Chat finish reason is unsupported.")
		}
		s.completion.choices[choice.Index] = reason
		if reason != "" {
			if err := s.validateTools(choice.Index, reason); err != nil {
				return err
			}
		}
	}
	return nil
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
				for _, candidate := range event.Candidates {
					terminal = terminal || candidate.FinishReason != ""
				}
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

func (s *session) completeResponse() ([][]byte, error) {
	if !s.completion.sourceDone || s.completion.response == nil {
		return nil, errors.New("The upstream Chat stream cannot complete a Responses reply.")
	}
	for _, open := range s.completion.openItems {
		if open {
			return nil, errors.New("The protocol converter left an output item unfinished.")
		}
	}
	status, eventType, incompleteReason := "completed", "response.completed", s.responseIncompleteReason()
	if incompleteReason != "" {
		status, eventType = "incomplete", "response.incomplete"
	}
	indexes := make([]int, 0, len(s.completion.items))
	for index := range s.completion.items {
		indexes = append(indexes, index)
	}
	sort.Ints(indexes)
	items := make([]json.RawMessage, 0, len(indexes))
	for _, index := range indexes {
		items = append(items, s.completion.items[index])
	}
	response := s.completion.response
	response["status"], _ = json.Marshal(status)
	response["output"], _ = json.Marshal(items)
	if s.completion.usage != nil {
		usage := s.completion.usage
		var prompt, completion, total int64
		_ = json.Unmarshal(usage["prompt_tokens"], &prompt)
		_ = json.Unmarshal(usage["completion_tokens"], &completion)
		if usage["completion_tokens"] == nil {
			_ = json.Unmarshal(usage["output_tokens"], &completion)
		}
		_ = json.Unmarshal(usage["total_tokens"], &total)
		if total == 0 {
			total = prompt + completion
		}
		mapped := map[string]any{"input_tokens": prompt, "output_tokens": completion, "total_tokens": total}
		var promptDetails, completionDetails map[string]json.RawMessage
		_ = json.Unmarshal(usage["prompt_tokens_details"], &promptDetails)
		_ = json.Unmarshal(usage["completion_tokens_details"], &completionDetails)
		if usage["output_tokens_details"] != nil {
			_ = json.Unmarshal(usage["output_tokens_details"], &completionDetails)
		}
		if cached := promptDetails["cached_tokens"]; cached != nil {
			mapped["input_tokens_details"] = map[string]json.RawMessage{"cached_tokens": cached}
		}
		if reasoning := completionDetails["reasoning_tokens"]; reasoning != nil {
			mapped["output_tokens_details"] = map[string]json.RawMessage{"reasoning_tokens": reasoning}
		}
		response["usage"], _ = json.Marshal(mapped)
	}
	if incompleteReason != "" {
		response["incomplete_details"], _ = json.Marshal(map[string]string{"reason": incompleteReason})
	}
	s.completion.sequence++
	event, err := json.Marshal(map[string]any{"type": eventType, "sequence_number": s.completion.sequence, "response": response})
	if err != nil {
		return nil, errors.New("The protocol converter could not finalize its reply.")
	}
	s.completion.terminal = true
	return [][]byte{[]byte("event: " + eventType + "\ndata: " + string(event) + "\n\n")}, nil
}

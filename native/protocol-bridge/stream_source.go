package main

import (
	"encoding/json"
	"errors"
	tr "github.com/router-for-me/CLIProxyAPI/v8/sdk/translator"
	"strings"
)

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
		terminal, err := s.completion.sourceIntegrity.observe(s.to, data)
		s.completion.sourceTerminal = terminal
		return err
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
		var delta struct {
			Content          string          `json:"content"`
			Reasoning        string          `json:"reasoning"`
			ReasoningContent string          `json:"reasoning_content"`
			Refusal          string          `json:"refusal"`
			FunctionCall     json.RawMessage `json:"function_call"`
			Tools            []struct {
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
		if finished := s.completion.choices[choice.Index]; finished != "" {
			if delta.Content != "" || delta.Reasoning != "" || delta.ReasoningContent != "" || delta.Refusal != "" || len(delta.Tools) > 0 || (choice.FinishReason != nil && *choice.FinishReason != finished) {
				return errors.New("The upstream Chat stream continued a finished choice.")
			}
			continue
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

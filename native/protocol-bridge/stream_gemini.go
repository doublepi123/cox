package main

import "encoding/json"

func (s *streamProtocolState) observeGemini(event streamProtocolEvent) (bool, error) {
	if event.PromptFeedback.BlockReason != "" {
		s.safety = true
	}
	if s.candidates == nil {
		s.candidates = make(map[int]streamCandidate)
	}
	seen := make(map[int]bool)
	for _, raw := range event.Candidates {
		var candidate struct {
			Index        int    `json:"index"`
			FinishReason string `json:"finishReason"`
			Content      struct {
				Parts []struct {
					FunctionCall *struct {
						Name string          `json:"name"`
						Args json.RawMessage `json:"args"`
					} `json:"functionCall"`
				} `json:"parts"`
			} `json:"content"`
		}
		if json.Unmarshal(raw, &candidate) != nil || candidate.Index < 0 || candidate.Index >= 128 || seen[candidate.Index] || len(candidate.FinishReason) > 128 {
			return false, errStreamLifecycle
		}
		seen[candidate.Index] = true
		previous, exists := s.candidates[candidate.Index]
		if previous.reason != "" {
			if len(candidate.Content.Parts) > 0 || (candidate.FinishReason != "" && candidate.FinishReason != previous.reason) {
				return false, errStreamLifecycle
			}
			continue
		}
		valid := !exists || previous.validTools
		for _, part := range candidate.Content.Parts {
			if call := part.FunctionCall; call != nil {
				valid = valid && call.Name != "" && (len(call.Args) == 0 || streamObject(call.Args))
			}
		}
		if candidate.FinishReason == "STOP" && !valid {
			return false, errStreamLifecycle
		}
		s.candidates[candidate.Index] = streamCandidate{reason: candidate.FinishReason, validTools: valid}
	}
	terminal := s.safety || len(s.candidates) > 0
	for _, candidate := range s.candidates {
		terminal = terminal && candidate.reason != ""
	}
	s.terminal = terminal
	return terminal, nil
}

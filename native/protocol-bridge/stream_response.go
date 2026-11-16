package main

import (
	"bytes"
	"encoding/json"
	"errors"
	tr "github.com/router-for-me/CLIProxyAPI/v8/sdk/translator"
	"sort"
)

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

func (s *session) normalizeResponseTerminal(chunks [][]byte) ([][]byte, error) {
	if s.completion.sourceIntegrity.safety {
		return s.safetyStream()
	}
	if s.to == tr.FormatClaude {
		return s.normalizeAnthropicTerminal(chunks)
	}
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
	if _, err := s.completion.convertedIntegrity.observe(s.from, string(event)); err != nil {
		return nil, err
	}
	s.completion.terminal = true
	return [][]byte{[]byte("event: " + eventType + "\ndata: " + string(event) + "\n\n")}, nil
}

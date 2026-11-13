package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"

	tr "github.com/router-for-me/CLIProxyAPI/v8/sdk/translator"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/translator/builtin"
)

type input struct {
	Type   string          `json:"type"`
	From   string          `json:"from"`
	To     string          `json:"to"`
	Model  string          `json:"model"`
	Stream bool            `json:"stream"`
	Body   json.RawMessage `json:"body"`
	Chunk  string          `json:"chunk"`
}

type output struct {
	Body   json.RawMessage       `json:"body,omitempty"`
	Chunks [][]byte              `json:"chunks,omitempty"`
	Error  string                `json:"error,omitempty"`
	State  *streamState          `json:"state,omitempty"`
	Replay *reasoningReplayState `json:"replay,omitempty"`
}

type session struct {
	registry   *tr.Registry
	from       tr.Format
	to         tr.Format
	model      string
	stream     bool
	original   []byte
	translated []byte
	parameter  any
	completion streamCompletion
}

var reasoningChatModel = regexp.MustCompile(`^(?:gpt-[5-9](?:[.-]|$)|o[1-9](?:[.-]|$))`)

func (s *session) handle(in input) (out output) {
	defer func() {
		if recover() != nil {
			out = output{Error: "Protocol conversion failed."}
		}
		if out.Error != "" && s.original != nil && s.stream {
			s.completion.failed = true
		}
		if s.original != nil && s.stream {
			out.State = &streamState{
				DoneReceived: s.completion.sourceDoneReceived,
				DoneAccepted: s.completion.sourceDone,
				Terminal:     s.completion.terminal,
				Finalized:    s.completion.finalized,
				Failed:       s.completion.failed,
			}
		}
	}()
	if s.completion.failed && !(in.Type == "finish" && s.completion.finalized) {
		return output{Error: "The protocol stream has already failed."}
	}
	switch in.Type {
	case "request":
		if s.original != nil {
			return output{Error: "A request is already active."}
		}
		from, to := tr.Format(in.From), tr.Format(in.To)
		if to == tr.FormatOpenAIResponse {
			to = tr.FormatCodex
		}
		var fields map[string]json.RawMessage
		if json.Unmarshal(in.Body, &fields) != nil {
			return output{Error: "Invalid protocol request."}
		}
		if value := fields["previous_response_id"]; from == tr.FormatOpenAIResponse && len(value) > 0 && string(value) != "null" && string(value) != `""` {
			return output{Error: "Stateful Responses requests require complete conversation input for protocol conversion."}
		}
		if !s.registry.HasRequestTransformer(from, to) ||
			(in.Stream && !s.registry.HasStreamResponseTransformer(from, to)) ||
			(!in.Stream && !s.registry.HasNonStreamResponseTransformer(from, to)) {
			return output{Error: "This protocol conversion is not supported."}
		}
		if from != tr.FormatGemini {
			fields["stream"], _ = json.Marshal(in.Stream)
			in.Body, _ = json.Marshal(fields)
		}
		replayBody := []byte(in.Body)
		var compatErr error
		replayBody, compatErr = requestInputCompat(in, to)
		if compatErr != nil {
			return output{Error: compatErr.Error()}
		}
		var replay *reasoningReplayState
		if from == tr.FormatOpenAIResponse && to == tr.FormatOpenAI {
			var err error
			replay = &reasoningReplayState{}
			replayBody, err = responsesChatReplayBody(in.Body, replay)
			if err != nil {
				return output{Error: err.Error()}
			}
		}
		request := s.registry.TranslateRequestEnvelope(context.Background(), from, to, tr.RequestEnvelope{
			Format: from, Model: in.Model, Stream: in.Stream, Body: replayBody,
		})
		if request.Err != nil || !json.Valid(request.Body) {
			return output{Error: "The request cannot be represented by the upstream protocol."}
		}
		if from == tr.FormatOpenAIResponse && to == tr.FormatOpenAI {
			var err error
			request.Body, err = withoutUnavailableChatReasoning(request.Body, replay)
			if err != nil {
				return output{Error: err.Error()}
			}
		}
		if to == tr.FormatCodex {
			var converted map[string]json.RawMessage
			if json.Unmarshal(request.Body, &converted) != nil {
				return output{Error: "Invalid Responses conversion."}
			}
			converted["stream"], _ = json.Marshal(in.Stream)
			converted["model"], _ = json.Marshal(in.Model)
			var generationConfig map[string]json.RawMessage
			_ = json.Unmarshal(fields["generationConfig"], &generationConfig)
			if fields["reasoning"] == nil && fields["reasoning_effort"] == nil && fields["thinking"] == nil && generationConfig["thinkingConfig"] == nil {
				delete(converted, "reasoning")
			}
			if fields["include"] == nil {
				delete(converted, "include")
			}
			request.Body, _ = json.Marshal(converted)
		}
		if to == tr.FormatOpenAI || to == tr.FormatCodex {
			var converted map[string]json.RawMessage
			if json.Unmarshal(request.Body, &converted) != nil {
				return output{Error: "Invalid OpenAI conversion."}
			}
			if tier := fields["service_tier"]; tier != nil {
				converted["service_tier"] = tier
			}
			model := strings.ToLower(in.Model)
			if index := strings.LastIndex(model, "/"); index >= 0 {
				model = model[index+1:]
			}
			if to == tr.FormatOpenAI && reasoningChatModel.MatchString(model) {
				if limit := converted["max_tokens"]; limit != nil {
					if converted["max_completion_tokens"] == nil {
						converted["max_completion_tokens"] = limit
					}
					delete(converted, "max_tokens")
				}
			}
			request.Body, _ = json.Marshal(converted)
		}
		request.Body, compatErr = requestOutputCompat(in, to, request.Body)
		if compatErr != nil {
			return output{Error: compatErr.Error()}
		}
		s.from, s.to, s.model, s.stream = from, to, in.Model, in.Stream
		s.original, s.translated = in.Body, request.Body
		return output{Body: request.Body, Replay: replay}
	case "response":
		if s.original == nil {
			return output{Error: "No request is active."}
		}
		raw := in.Body
		if s.to == tr.FormatCodex {
			var response map[string]json.RawMessage
			if json.Unmarshal(raw, &response) != nil {
				return output{Error: "Invalid Responses reply."}
			}
			if string(response["type"]) != `"response.completed"` {
				raw, _ = json.Marshal(map[string]any{"type": "response.completed", "response": raw})
			}
		}
		var body []byte
		if s.to == tr.FormatClaude && s.from == tr.FormatGemini {
			var intermediate any
			chat := s.registry.TranslateNonStream(context.Background(), s.to, tr.FormatOpenAI, s.model, nil, nil, raw, &intermediate)
			body = s.registry.TranslateNonStream(context.Background(), tr.FormatOpenAI, s.from, s.model, s.original, s.translated, chat, &s.parameter)
		} else {
			body = s.registry.TranslateNonStream(context.Background(), s.to, s.from, s.model, s.original, s.translated, raw, &s.parameter)
		}
		if !json.Valid(body) {
			return output{Error: "The upstream response could not be converted."}
		}
		body = s.responseStopCompat(body, s.sourceStopReason(raw))
		return output{Body: body}
	case "chunk":
		if s.original == nil || !s.stream {
			return output{Error: "No streaming request is active."}
		}
		if !s.completion.finalized {
			if chunks := s.upstreamErrorFrame(in.Chunk); chunks != nil {
				return output{Chunks: chunks}
			}
		}
		if err := s.observeSource(in.Chunk); err != nil {
			return output{Error: err.Error()}
		}
		chunks := s.registry.TranslateStream(context.Background(), s.to, s.from, s.model, s.original, s.translated, []byte(in.Chunk), &s.parameter)
		if state, ok := s.parameter.(interface{ ToolInputError() error }); ok && state.ToolInputError() != nil {
			return output{Error: "The upstream tool call could not be converted safely."}
		}
		framed := make([][]byte, 0, len(chunks))
		for _, chunk := range chunks {
			trimmed := bytes.TrimSpace(chunk)
			if len(trimmed) == 0 {
				continue
			}
			if json.Valid(trimmed) || bytes.Equal(trimmed, []byte("[DONE]")) {
				chunk = append(append([]byte("data: "), trimmed...), '\n', '\n')
			}
			framed = append(framed, chunk)
		}
		framed = s.streamStopCompat(framed, in.Chunk)
		framed, err := s.normalizeResponseTerminal(framed)
		if err != nil {
			return output{Error: err.Error()}
		}
		if err := s.observeConverted(framed); err != nil {
			return output{Error: err.Error()}
		}
		if s.to == tr.FormatOpenAI && s.from == tr.FormatOpenAIResponse && s.completion.sourceDone && !s.completion.terminal {
			completion, err := s.completeResponse()
			if err != nil {
				return output{Error: err.Error()}
			}
			framed = append(framed, completion...)
		}
		return output{Chunks: framed}
	case "finish":
		if s.original == nil || !s.stream {
			return output{Error: "No streaming request is active."}
		}
		if s.completion.finalized {
			return output{Chunks: [][]byte{}}
		}
		tail, err := s.finishStream()
		if err != nil {
			return output{Error: err.Error()}
		}
		return output{Chunks: tail}
	default:
		return output{Error: "Invalid protocol bridge operation."}
	}
}

func run(reader io.Reader, writer io.Writer) error {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 65536), 64*1024*1024)
	encoder := json.NewEncoder(writer)
	s := session{registry: builtin.Registry()}
	for scanner.Scan() {
		var in input
		if json.Unmarshal(scanner.Bytes(), &in) != nil {
			if err := encoder.Encode(output{Error: "Invalid protocol bridge input."}); err != nil {
				return err
			}
			continue
		}
		if err := encoder.Encode(s.handle(in)); err != nil {
			return err
		}
	}
	return scanner.Err()
}

func main() {
	if err := run(os.Stdin, os.Stdout); err != nil && !errors.Is(err, io.EOF) {
		fmt.Fprintln(os.Stderr, "Protocol bridge stopped.")
		os.Exit(1)
	}
}

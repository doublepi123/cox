package main

import (
	"encoding/json"
	"errors"
	"strconv"
	"strings"

	"github.com/MoeForge/moego/ojson"
	tr "github.com/router-for-me/CLIProxyAPI/v8/sdk/translator"
)

var errRequestRepresentation = errors.New("The request cannot be represented by the upstream protocol.")

func requestInputCompat(in input, to tr.Format) ([]byte, error) {
	doc := ojson.NewDoc(in.Body)
	if in.From != "claude" {
		return doc.Bytes(), nil
	}
	if to == tr.FormatOpenAI || to == tr.FormatGemini {
		var tools []json.RawMessage
		for _, tool := range doc.Get("tools").Array() {
			kind := tool.Get("type").String()
			if kind != "" && kind != "custom" {
				if doc.Get("tool_choice.type").String() == "tool" && doc.Get("tool_choice.name").String() == tool.Get("name").String() {
					return nil, errRequestRepresentation
				}
				continue
			}
			tools = append(tools, json.RawMessage(tool.Raw))
		}
		if doc.Get("tools").Exists() {
			if err := doc.Set("tools", tools); err != nil {
				return nil, err
			}
		}
	}
	for i, message := range doc.Get("messages").Array() {
		for j, part := range message.Get("content").Array() {
			path := "messages." + strconv.Itoa(i) + ".content." + strconv.Itoa(j)
			if part.Get("type").String() == "document" {
				if err := prepareDocument(doc, path, to); err != nil {
					return nil, err
				}
			}
			if part.Get("type").String() == "tool_result" {
				hasDocument := false
				for k, child := range part.Get("content").Array() {
					if child.Get("type").String() == "document" {
						hasDocument = true
						if err := prepareDocument(doc, path+".content."+strconv.Itoa(k), to); err != nil {
							return nil, err
						}
					}
				}
				if to == tr.FormatGemini && hasDocument {
					var texts []string
					allText := true
					for _, child := range doc.Get(path + ".content").Array() {
						if child.Get("type").String() != "text" {
							allText = false
							break
						}
						texts = append(texts, child.Get("text").String())
					}
					if allText && len(texts) > 0 {
						if err := doc.Set(path+".content", strings.Join(texts, "\n\n")); err != nil {
							return nil, err
						}
					}
				}
			}
		}
	}
	return doc.Bytes(), nil
}

func prepareDocument(doc *ojson.Doc, path string, to tr.Format) error {
	part := doc.Get(path)
	source := part.Get("source")
	switch source.Get("type").String() {
	case "text":
		return doc.Set(path, map[string]string{"type": "text", "text": source.Get("data").String()})
	case "url":
		if to != tr.FormatCodex {
			return errRequestRepresentation
		}
		return doc.Set(path, map[string]interface{}{"type": "image", "source": map[string]string{"type": "base64", "media_type": "application/x-cox-document-url", "data": source.Get("url").String()}})
	case "base64":
		if err := doc.Set(path+".type", "image"); err != nil {
			return err
		}
		return nil
	default:
		return errRequestRepresentation
	}
}

func requestOutputCompat(in input, to tr.Format, body []byte) ([]byte, error) {
	doc := ojson.NewDoc(body)
	source := ojson.ParseBytes(in.Body)
	if to == tr.FormatOpenAI && in.Stream {
		for key, value := range source.Get("stream_options").Map() {
			if err := doc.SetRaw("stream_options."+ojson.Escape(key), value.Raw); err != nil {
				return nil, err
			}
		}
		if err := doc.Set("stream_options.include_usage", true); err != nil {
			return nil, err
		}
	}
	if to == tr.FormatClaude && doc.Get("thinking.type").String() == "enabled" {
		choice := doc.Get("tool_choice.type").String()
		limit := doc.Get("max_tokens")
		if choice == "any" || choice == "tool" || (limit.Exists() && limit.Int() <= 1024 && doc.Get("thinking.budget_tokens").Int() >= limit.Int()) {
			if err := doc.Delete("thinking"); err != nil {
				return nil, err
			}
		} else if limit.Exists() && doc.Get("thinking.budget_tokens").Int() >= limit.Int() {
			if err := doc.Set("thinking.budget_tokens", limit.Int()-1); err != nil {
				return nil, err
			}
		}
	}
	if to == tr.FormatGemini {
		path := "generationConfig.thinkingConfig.thinkingLevel"
		if level := doc.Get(path); level.Exists() {
			switch strings.ToLower(level.String()) {
			case "minimal", "low", "medium", "high", "xhigh":
			case "none", "off", "disable":
				if err := doc.Delete(path); err != nil {
					return nil, err
				}
				if err := doc.Set("generationConfig.thinkingConfig.thinkingBudget", 0); err != nil {
					return nil, err
				}
			default:
				if err := doc.Set(path, "high"); err != nil {
					return nil, err
				}
			}
		}
	}
	if (in.From == "openai" && (to == tr.FormatCodex || to == tr.FormatClaude)) || (in.From == "openai-response" && to == tr.FormatOpenAI) {
		for _, key := range []string{"temperature", "top_p"} {
			if value := source.Get(key); value.Exists() {
				if err := doc.SetRaw(key, value.Raw); err != nil {
					return nil, err
				}
			}
		}
	}
	if in.From == "openai" && to == tr.FormatCodex {
		format := source.Get("response_format")
		switch format.Get("type").String() {
		case "json_object":
			if err := doc.SetRaw("text.format", format.Raw); err != nil {
				return nil, err
			}
		case "json_schema":
			if err := doc.SetRaw("text.format", format.Get("json_schema").Raw); err != nil {
				return nil, err
			}
			if err := doc.Set("text.format.type", "json_schema"); err != nil {
				return nil, err
			}
		}
	}
	if in.From == "openai-response" && to == tr.FormatOpenAI {
		if key := source.Get("prompt_cache_key"); key.Exists() {
			if err := doc.SetRaw("prompt_cache_key", key.Raw); err != nil {
				return nil, err
			}
		}
	}
	if in.From == "gemini" && to == tr.FormatOpenAI {
		for i, tool := range doc.Get("tools").Array() {
			if schema := tool.Get("function.parameters"); schema.Exists() {
				normalized, err := normalizeToolSchema(schema)
				if err != nil {
					return nil, err
				}
				if err := doc.SetRawBytes("tools."+strconv.Itoa(i)+".function.parameters", normalized); err != nil {
					return nil, err
				}
			}
		}
	}
	if in.From == "claude" {
		return restoreDocumentParts(doc.Bytes(), source)
	}
	return doc.Bytes(), nil
}

func normalizeToolSchema(value ojson.Result) ([]byte, error) {
	doc := ojson.NewDocString(value.Raw)
	if value.IsArray() {
		for i, child := range value.Array() {
			raw, err := normalizeToolSchema(child)
			if err != nil {
				return nil, err
			}
			if err := doc.SetRawBytes(strconv.Itoa(i), raw); err != nil {
				return nil, err
			}
		}
	} else if value.IsObject() {
		for key, child := range value.Map() {
			if child.IsArray() || child.IsObject() {
				raw, err := normalizeToolSchema(child)
				if err != nil {
					return nil, err
				}
				if err := doc.SetRawBytes(ojson.Escape(key), raw); err != nil {
					return nil, err
				}
			}
		}
		if kind := value.Get("type"); kind.Type == ojson.String {
			if err := doc.Set("type", strings.ToLower(kind.String())); err != nil {
				return nil, err
			}
		}
		if value.Get("nullable").Bool() {
			kind := doc.Get("type")
			if kind.Type == ojson.String {
				if err := doc.Set("type", []string{kind.String(), "null"}); err != nil {
					return nil, err
				}
			} else {
				if err := doc.Delete("nullable"); err != nil {
					return nil, err
				}
				return json.Marshal(map[string][]json.RawMessage{"anyOf": {doc.Bytes(), json.RawMessage(`{"type":"null"}`)}})
			}
			if err := doc.Delete("nullable"); err != nil {
				return nil, err
			}
		}
	}
	return doc.Bytes(), nil
}

func restoreDocumentParts(body []byte, source ojson.Result) ([]byte, error) {
	files := map[string]string{}
	var collect func(ojson.Result)
	collect = func(value ojson.Result) {
		if value.Get("type").String() == "document" {
			s := value.Get("source")
			if s.Get("type").String() == "base64" {
				files["data:"+s.Get("media_type").String()+";base64,"+s.Get("data").String()] = value.Get("title").String()
			}
			if s.Get("type").String() == "url" {
				files["data:application/x-cox-document-url;base64,"+s.Get("url").String()] = value.Get("title").String()
			}
		}
		if value.IsArray() {
			for _, child := range value.Array() {
				collect(child)
			}
		}
		for _, child := range value.Map() {
			collect(child)
		}
	}
	collect(source)
	var rewrite func(ojson.Result) ([]byte, error)
	rewrite = func(value ojson.Result) ([]byte, error) {
		doc := ojson.NewDocString(value.Raw)
		url := value.Get("image_url.url").String()
		if value.Get("type").String() == "input_image" {
			url = value.Get("image_url").String()
		}
		if name, ok := files[url]; ok {
			if strings.HasPrefix(url, "data:application/x-cox-document-url;base64,") {
				return json.Marshal(map[string]string{"type": "input_file", "file_url": strings.TrimPrefix(url, "data:application/x-cox-document-url;base64,")})
			}
			if name == "" {
				name = "document"
			}
			file := map[string]string{"filename": name, "file_data": url}
			if value.Get("type").String() == "image_url" {
				return json.Marshal(map[string]interface{}{"type": "file", "file": file})
			}
			if strings.HasPrefix(url, "data:") {
				return json.Marshal(map[string]string{"type": "input_file", "filename": name, "file_data": url})
			}
			return json.Marshal(map[string]string{"type": "input_file", "file_url": url})
		}
		if value.IsArray() {
			for i, child := range value.Array() {
				raw, err := rewrite(child)
				if err != nil {
					return nil, err
				}
				if err := doc.SetRawBytes(strconv.Itoa(i), raw); err != nil {
					return nil, err
				}
			}
		}
		for key, child := range value.Map() {
			if child.IsObject() || child.IsArray() {
				raw, err := rewrite(child)
				if err != nil {
					return nil, err
				}
				if err := doc.SetRawBytes(ojson.Escape(key), raw); err != nil {
					return nil, err
				}
			}
		}
		return doc.Bytes(), nil
	}
	return rewrite(ojson.ParseBytes(body))
}

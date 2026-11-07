package worker

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"

	core "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	ex "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
)

// These tests exercise the existing public entry, the real pinned CPA
// converter, and the final HTTP body. The subscription endpoint rejected the
// marked side of production control 42349693112; public Responses API support
// is not evidence that backend-api/codex accepts the same content-block field.
func captureCodexCacheRequest(t *testing.T, modelID string, messages []any) map[string]any {
	t.Helper()
	payload, err := json.Marshal(map[string]any{
		"model": modelID, "messages": messages, "reasoning_effort": "low",
		"tools": []any{map[string]any{"type": "function", "function": map[string]any{
			"name": "fixture_lookup", "description": "Read a fixture value", "parameters": map[string]any{"type": "object", "properties": map[string]any{}},
		}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	saved := append([]byte(nil), payload...)
	var body map[string]any
	calls := 0
	model := CPAPlainModel{Provider: "codex", Client: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.URL.String() != "https://chatgpt.com/backend-api/codex/responses" || r.Header.Get("Authorization") != "Bearer fixture-access" || r.Header.Get("ChatGPT-Account-Id") != "fixture-account" || r.Header.Get("Originator") != "Mikka" || r.Header.Get("User-Agent") != "Mikka/1.0" {
			t.Fatal("Codex subscription destination or application headers changed")
		}
		if r.Header.Get("Session-Id") != "" || r.Header.Get("X-Codex-Turn-State") != "" {
			t.Fatal("cache breakpoints must not introduce session affinity")
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		terminal := `data: {"type":"response.completed","response":{"id":"fixture-response","model":"` + modelID + `","output":[],"usage":{"input_tokens":1,"output_tokens":1}}}` + "\n\n"
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"text/event-stream"}}, Body: io.NopCloser(strings.NewReader(terminal))}, nil
	})}}
	result, err := model.ExecuteStream(context.Background(), &core.Auth{Metadata: map[string]any{"access_token": "fixture-access", "account_id": "fixture-account"}}, ex.Request{Model: modelID, Payload: payload}, ex.Options{})
	if err != nil {
		t.Fatal(err)
	}
	for chunk := range result.Chunks {
		if chunk.Err != nil {
			t.Fatal(chunk.Err)
		}
	}
	if calls != 1 || !bytes.Equal(payload, saved) {
		t.Fatal("expected one actual CPA transport call and unchanged source payload")
	}
	return body
}

func codexCacheMarkerCount(value any) int {
	count := 0
	switch node := value.(type) {
	case map[string]any:
		if _, exists := node["prompt_cache_breakpoint"]; exists {
			count++
		}
		for _, child := range node {
			count += codexCacheMarkerCount(child)
		}
	case []any:
		for _, child := range node {
			count += codexCacheMarkerCount(child)
		}
	}
	return count
}

func codexCacheMessages(tail string, hinted bool) []any {
	messages := []any{
		map[string]any{"role": "system", "content": "规则\nfixture-rules 🦊"},
		map[string]any{"role": "system", "content": "\nfixture-repositories-and-models\n"},
		map[string]any{"role": "system", "content": tail},
		map[string]any{"role": "user", "content": "fixture-request"},
	}
	if hinted {
		for _, message := range messages[:2] {
			message.(map[string]any)["mikka_cache_breakpoint"] = "stable_system_v1"
		}
	}
	return messages
}

func TestCodexSubscriptionPreservesImplicitCaching(t *testing.T) {
	var stablePrefix []byte
	for _, tail := range []string{"fixture-live-A", "fixture-live-B", "fixture-live-B"} {
		body := captureCodexCacheRequest(t, "gpt-6-luna", codexCacheMessages(tail, true))
		if count := codexCacheMarkerCount(body); count != 0 {
			t.Fatalf("codex_subscription_explicit_cache_marker: want no unsupported content-block markers, got %d", count)
		}
		input, _ := body["input"].([]any)
		if len(input) != 4 || body["instructions"] != "" {
			t.Fatal("CPA's separate developer messages or empty instructions changed")
		}
		wantText := []string{"规则\nfixture-rules 🦊", "\nfixture-repositories-and-models\n", tail, "fixture-request"}
		for index, value := range input {
			message := objectMap(value)
			wantRole := "developer"
			if index == 3 {
				wantRole = "user"
			}
			parts, _ := message["content"].([]any)
			if message["type"] != "message" || message["role"] != wantRole || len(parts) != 1 {
				t.Fatal("converted message order or shape changed")
			}
			part := objectMap(parts[0])
			if part["type"] != "input_text" || part["text"] != wantText[index] {
				t.Fatal("converted prompt text changed bytes")
			}
			if part["prompt_cache_breakpoint"] != nil {
				t.Fatal("the subscription request contains an unsupported explicit breakpoint")
			}
		}
		prefix, _ := json.Marshal(input[:2])
		if stablePrefix != nil && !bytes.Equal(prefix, stablePrefix) {
			t.Fatal("changing the live tail changed the implicit stable prefix")
		}
		stablePrefix = prefix
		for _, key := range []string{"prompt_cache_options", "prompt_cache_key", "prompt_cache_retention", "metadata", "session_id", "mikka_cache_breakpoint"} {
			if _, exists := body[key]; exists {
				t.Fatalf("unexpected top-level cache/identity option %s", key)
			}
		}
		raw, _ := json.Marshal(body)
		if strings.Contains(string(raw), "mikka_cache_breakpoint") {
			t.Fatal("private marker leaked to the provider")
		}
		unhinted := captureCodexCacheRequest(t, "gpt-6-luna", codexCacheMessages(tail, false))
		if !reflect.DeepEqual(body, unhinted) {
			t.Fatal("legacy hints changed converted fields, tools or reasoning")
		}
	}
}

func TestCodexSubscriptionCacheBreakpointCompatibility(t *testing.T) {
	for _, model := range []string{"gpt-5.6", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-6-luna", "gpt-6-sol", "gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-5.5", "gpt-5.4", "gpt-5.6-unknown", "gpt-6", "gpt-6-unknown", "gpt-6.2-sol", "gpt-7-luna", "openai/gpt-6-luna", "claude-haiku-5-5", "fixture-model"} {
		t.Run(model, func(t *testing.T) {
			marked := captureCodexCacheRequest(t, model, codexCacheMessages("tail", true))
			unmarked := captureCodexCacheRequest(t, model, codexCacheMessages("tail", false))
			if !reflect.DeepEqual(marked, unmarked) || codexCacheMarkerCount(marked) != 0 {
				t.Fatal("the subscription route must ignore legacy cache hints regardless of model name")
			}
		})
	}
}

func TestCodexSubscriptionCacheBreakpointAlignment(t *testing.T) {
	for _, test := range []struct {
		name   string
		mutate func([]any) []any
	}{
		{"unhinted legacy", func(messages []any) []any { return codexCacheMessages("tail", false) }},
		{"coincident boundaries", func(messages []any) []any { return append(messages[:1], messages[2:]...) }},
		{"absent live tail", func(messages []any) []any { return append(messages[:2], messages[3:]...) }},
		{"three private markers", func(messages []any) []any {
			objectMap(messages[2])["mikka_cache_breakpoint"] = "stable_system_v1"
			return messages
		}},
		{"non-string later system", func(messages []any) []any {
			objectMap(messages[2])["content"] = []any{map[string]any{"type": "text", "text": "tail"}}
			return messages
		}},
		{"empty later system", func(messages []any) []any { objectMap(messages[2])["content"] = ""; return messages }},
		{"history first", func(messages []any) []any { return append(messages[3:], messages[:3]...) }},
		{"public part marker is not supported on this route", func(messages []any) []any {
			return []any{map[string]any{"role": "system", "content": []any{map[string]any{"type": "text", "text": "rules", "prompt_cache_breakpoint": map[string]any{"mode": "explicit"}}}}, messages[3]}
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			if count := codexCacheMarkerCount(captureCodexCacheRequest(t, "gpt-6-luna", test.mutate(codexCacheMessages("tail", true)))); count != 0 {
				t.Fatalf("want no subscription content-block markers, got %d", count)
			}
		})
	}
}

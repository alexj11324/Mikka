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
// converter, and the final HTTP body. The baseline can compile this file
// unchanged; its failure is a missing wire breakpoint, not a new helper import.
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

func TestCodexSubscriptionStableSystemCacheBreakpoints(t *testing.T) {
	var stablePrefix []byte
	for _, tail := range []string{"fixture-live-A", "fixture-live-B", "fixture-live-B"} {
		body := captureCodexCacheRequest(t, "gpt-6-luna", codexCacheMessages(tail, true))
		if count := codexCacheMarkerCount(body); count != 2 {
			t.Fatalf("codex_stable_cache_breakpoints_missing: want 2 explicit stable-system markers, got %d", count)
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
			if index < 2 {
				if !reflect.DeepEqual(part["prompt_cache_breakpoint"], map[string]any{"mode": "explicit"}) {
					t.Fatal("stable layer lacks its content-block explicit breakpoint")
				}
			} else if part["prompt_cache_breakpoint"] != nil {
				t.Fatal("live tail or history received an explicit breakpoint")
			}
		}
		prefix, _ := json.Marshal(input[:2])
		if stablePrefix != nil && !bytes.Equal(prefix, stablePrefix) {
			t.Fatal("changing the live tail changed the explicit stable prefix")
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
		for _, value := range input[:2] {
			parts := objectMap(value)["content"].([]any)
			delete(objectMap(parts[0]), "prompt_cache_breakpoint")
		}
		unhinted := captureCodexCacheRequest(t, "gpt-6-luna", codexCacheMessages(tail, false))
		if !reflect.DeepEqual(body, unhinted) {
			t.Fatal("explicit breakpoints changed other converted fields, tools or reasoning")
		}
	}
}

func TestCodexSubscriptionCacheBreakpointCompatibility(t *testing.T) {
	for _, model := range []string{"gpt-5.6", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-6-luna", "gpt-6-sol", "gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra"} {
		t.Run(model, func(t *testing.T) {
			if codexCacheMarkerCount(captureCodexCacheRequest(t, model, codexCacheMessages("tail", true))) != 2 {
				t.Fatal("a supported canonical model lost stable-system boundaries")
			}
		})
	}
	for _, model := range []string{"gpt-5.5", "gpt-5.4", "gpt-5.6-unknown", "gpt-6", "gpt-6-unknown", "gpt-6.2-sol", "gpt-7-luna", "openai/gpt-6-luna", "claude-haiku-5-5", "fixture-model"} {
		t.Run(model, func(t *testing.T) {
			marked := captureCodexCacheRequest(t, model, codexCacheMessages("tail", true))
			unmarked := captureCodexCacheRequest(t, model, codexCacheMessages("tail", false))
			if !reflect.DeepEqual(marked, unmarked) || codexCacheMarkerCount(marked) != 0 {
				t.Fatal("an old or unknown model's request changed")
			}
		})
	}
}

func TestCodexSubscriptionCacheBreakpointAlignment(t *testing.T) {
	for _, test := range []struct {
		name   string
		mutate func([]any) []any
		want   int
	}{
		{"unhinted legacy", func(messages []any) []any { return codexCacheMessages("tail", false) }, 0},
		{"coincident boundaries", func(messages []any) []any { return append(messages[:1], messages[2:]...) }, 1},
		{"absent live tail", func(messages []any) []any { return append(messages[:2], messages[3:]...) }, 2},
		{"three private markers", func(messages []any) []any { objectMap(messages[2])["mikka_cache_breakpoint"] = "stable_system_v1"; return messages }, 0},
		{"non-string later system", func(messages []any) []any { objectMap(messages[2])["content"] = []any{map[string]any{"type": "text", "text": "tail"}}; return messages }, 0},
		{"empty later system", func(messages []any) []any { objectMap(messages[2])["content"] = ""; return messages }, 0},
		{"history first", func(messages []any) []any { return append(messages[3:], messages[:3]...) }, 0},
		{"public part marker is not a private hint", func(messages []any) []any { return []any{map[string]any{"role": "system", "content": []any{map[string]any{"type": "text", "text": "rules", "prompt_cache_breakpoint": map[string]any{"mode": "explicit"}}}}, messages[3]} }, 0},
	} {
		t.Run(test.name, func(t *testing.T) {
			if count := codexCacheMarkerCount(captureCodexCacheRequest(t, "gpt-6-luna", test.mutate(codexCacheMessages("tail", true)))); count != test.want {
				t.Fatalf("want %d explicit markers, got %d", test.want, count)
			}
		})
	}
}

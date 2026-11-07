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
// converter, and the final HTTP body. Synthetic transport responses prove
// serialization only, not that the live OAuth endpoint accepts the request.
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
			t.Fatal("the layout must not introduce session affinity")
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

func codexCacheFieldCount(value any, key string) int {
	count := 0
	switch node := value.(type) {
	case map[string]any:
		if _, exists := node[key]; exists {
			count++
		}
		for _, child := range node {
			count += codexCacheFieldCount(child, key)
		}
	case []any:
		for _, child := range node {
			count += codexCacheFieldCount(child, key)
		}
	}
	return count
}

func assertCodexImplicitOnly(t *testing.T, body map[string]any) {
	t.Helper()
	for _, key := range []string{"prompt_cache_breakpoint", "mikka_cache_breakpoint", "prompt_cache_options", "prompt_cache_key", "prompt_cache_retention", "session_id", "cache_control"} {
		if count := codexCacheFieldCount(body, key); count != 0 {
			t.Fatalf("codex_implicit_cache_fields_unexpected: %s count=%d", key, count)
		}
	}
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

func codexExpectedMessage(role, text string) map[string]any {
	partType := "input_text"
	if role == "assistant" {
		partType = "output_text"
	}
	return map[string]any{"type": "message", "role": role, "content": []any{map[string]any{"type": partType, "text": text}}}
}

// This same test compiles against the old public entry. Its RED is the actual
// injected wire fields, not a fabricated provider 400 or a missing helper.
func TestCodexSubscriptionLegacyMarkersAreNotSent(t *testing.T) {
	marked := captureCodexCacheRequest(t, "gpt-6-luna", codexCacheMessages("tail", true))
	assertCodexImplicitOnly(t, marked)
	unmarked := captureCodexCacheRequest(t, "gpt-6-luna", codexCacheMessages("tail", false))
	if !reflect.DeepEqual(marked, unmarked) {
		t.Fatal("legacy private hints changed other converted fields, tools or reasoning")
	}
}

func TestCodexSubscriptionImplicitStablePrefix(t *testing.T) {
	var stablePrefix []byte
	for _, tail := range []string{"fixture-live-A", "fixture-live-B", "fixture-live-B"} {
		messages := codexCacheMessages(tail, false)
		body := captureCodexCacheRequest(t, "gpt-6-luna", []any{messages[0], messages[1], messages[3], messages[2]})
		assertCodexImplicitOnly(t, body)
		input, _ := body["input"].([]any)
		want := []any{
			codexExpectedMessage("developer", "规则\nfixture-rules 🦊"),
			codexExpectedMessage("developer", "\nfixture-repositories-and-models\n"),
			codexExpectedMessage("user", "fixture-request"),
			codexExpectedMessage("developer", tail),
		}
		if !reflect.DeepEqual(input, want) || body["instructions"] != "" {
			t.Fatal("CPA changed prompt roles, text bytes or the system tail position")
		}
		prefix, _ := json.Marshal(input[:2])
		if stablePrefix != nil && !bytes.Equal(prefix, stablePrefix) {
			t.Fatal("changing the live tail changed the initial developer prefix")
		}
		stablePrefix = prefix
		before := captureCodexCacheRequest(t, "gpt-6-luna", messages)
		before["input"] = want
		if !reflect.DeepEqual(body, before) {
			t.Fatal("moving the tail changed model, tools, reasoning or other request fields")
		}
	}
}

func TestCodexSubscriptionTailFollowsAllHistoryAndToolOutputs(t *testing.T) {
	user := map[string]any{"role": "user", "content": "fixture-request"}
	assistant := map[string]any{"role": "assistant", "content": "fixture-reply 🦊"}
	calls := map[string]any{"role": "assistant", "content": nil, "tool_calls": []any{
		map[string]any{"id": "fixture-call-1", "type": "function", "function": map[string]any{"name": "fixture_lookup", "arguments": `{"key":"one"}`}},
		map[string]any{"id": "fixture-call-2", "type": "function", "function": map[string]any{"name": "fixture_lookup", "arguments": `{"key":"two"}`}},
	}}
	outputs := []any{
		map[string]any{"role": "tool", "tool_call_id": "fixture-call-1", "content": `{"value":"one"}`},
		map[string]any{"role": "tool", "tool_call_id": "fixture-call-2", "content": "two"},
	}
	wantTools := []any{
		map[string]any{"type": "function_call", "call_id": "fixture-call-1", "name": "fixture_lookup", "arguments": `{"key":"one"}`},
		map[string]any{"type": "function_call", "call_id": "fixture-call-2", "name": "fixture_lookup", "arguments": `{"key":"two"}`},
		map[string]any{"type": "function_call_output", "call_id": "fixture-call-1", "output": `{"value":"one"}`},
		map[string]any{"type": "function_call_output", "call_id": "fixture-call-2", "output": "two"},
	}
	for _, test := range []struct {
		name     string
		history  []any
		expected []any
	}{
		{"first user", []any{user}, []any{codexExpectedMessage("user", "fixture-request")}},
		{"multiple turns", []any{user, assistant, user}, []any{codexExpectedMessage("user", "fixture-request"), codexExpectedMessage("assistant", "fixture-reply 🦊"), codexExpectedMessage("user", "fixture-request")}},
		{"assistant last", []any{user, assistant}, []any{codexExpectedMessage("user", "fixture-request"), codexExpectedMessage("assistant", "fixture-reply 🦊")}},
		{"parallel tool outputs last", []any{user, calls, outputs[0], outputs[1]}, append([]any{codexExpectedMessage("user", "fixture-request")}, wantTools...)},
		{"assistant after tools", []any{user, calls, outputs[0], outputs[1], assistant}, append(append([]any{codexExpectedMessage("user", "fixture-request")}, wantTools...), codexExpectedMessage("assistant", "fixture-reply 🦊"))},
	} {
		t.Run(test.name, func(t *testing.T) {
			messages := codexCacheMessages("Factory rules\nSchedule rules\nmemory/live fixture", false)
			ordered := append(append([]any{}, messages[:2]...), test.history...)
			ordered = append(ordered, messages[2])
			body := captureCodexCacheRequest(t, "gpt-6-luna", ordered)
			assertCodexImplicitOnly(t, body)
			want := []any{codexExpectedMessage("developer", "规则\nfixture-rules 🦊"), codexExpectedMessage("developer", "\nfixture-repositories-and-models\n")}
			want = append(want, test.expected...)
			want = append(want, codexExpectedMessage("developer", "Factory rules\nSchedule rules\nmemory/live fixture"))
			if !reflect.DeepEqual(body["input"], want) {
				t.Fatal("history role/text/order, tool call IDs/results or trusted tail changed")
			}
		})
	}
	messages := codexCacheMessages("tail", false)
	body := captureCodexCacheRequest(t, "gpt-6-luna", messages[:3])
	if !reflect.DeepEqual(body["input"], []any{codexExpectedMessage("developer", "规则\nfixture-rules 🦊"), codexExpectedMessage("developer", "\nfixture-repositories-and-models\n"), codexExpectedMessage("developer", "tail")}) {
		t.Fatal("a prompt without history must retain its original order")
	}
}

func TestCodexSubscriptionCacheBreakpointCompatibility(t *testing.T) {
	for _, model := range []string{"gpt-5.6", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-6-luna", "gpt-6-sol", "gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-5.5", "gpt-5.4", "gpt-5.6-unknown", "gpt-6", "gpt-6-unknown", "gpt-6.2-sol", "gpt-7-luna", "openai/gpt-6-luna", "fixture-model"} {
		t.Run(model, func(t *testing.T) {
			marked := captureCodexCacheRequest(t, model, codexCacheMessages("tail", true))
			unmarked := captureCodexCacheRequest(t, model, codexCacheMessages("tail", false))
			assertCodexImplicitOnly(t, marked)
			if !reflect.DeepEqual(marked, unmarked) {
				t.Fatal("a legacy private hint changed the request")
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
		{"empty later system", func(messages []any) []any {
			objectMap(messages[2])["content"] = ""
			return messages
		}},
		{"history first", func(messages []any) []any { return append(messages[3:], messages[:3]...) }},
		{"public part marker", func(messages []any) []any {
			return []any{map[string]any{"role": "system", "content": []any{map[string]any{"type": "text", "text": "rules", "prompt_cache_breakpoint": map[string]any{"mode": "explicit"}, "mikka_cache_breakpoint": "stable_system_v1"}}}, messages[3]}
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			assertCodexImplicitOnly(t, captureCodexCacheRequest(t, "gpt-6-luna", test.mutate(codexCacheMessages("tail", true))))
		})
	}
}

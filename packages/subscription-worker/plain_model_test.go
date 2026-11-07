package worker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"reflect"
	"strings"
	"testing"

	core "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	ex "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
)

type fixedTransport struct {
	status      int
	contentType string
	body        string
}

func (t fixedTransport) RoundTrip(*http.Request) (*http.Response, error) {
	return &http.Response{StatusCode: t.status, Header: http.Header{"Content-Type": []string{t.contentType}}, Body: io.NopCloser(strings.NewReader(t.body))}, nil
}

// captureStderr runs fn and returns what it wrote to os.Stderr.
func captureStderr(t *testing.T, fn func()) string {
	t.Helper()
	read, write, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	saved := os.Stderr
	os.Stderr = write
	fn()
	os.Stderr = saved
	write.Close()
	var out bytes.Buffer
	_, _ = io.Copy(&out, read)
	return out.String()
}

func TestPlainModelUpstreamRefusalIsLoggedByStatusAndTypeOnly(t *testing.T) {
	model := CPAPlainModel{Provider: "claude", Client: &http.Client{Transport: fixedTransport{
		status: 400, contentType: "application/json",
		body: `{"type":"error","error":{"type":"invalid_request_error","message":"fixture-upstream-message"}}`,
	}}}
	auth := &core.Auth{Metadata: map[string]any{"access_token": "fixture-access-token"}}
	request := ex.Request{Model: "claude-haiku-5-5", Payload: []byte(`{"model":"claude-haiku-5-5","stream":true,"messages":[{"role":"user","content":"hi"}]}`)}
	var err error
	logged := captureStderr(t, func() { _, err = model.ExecuteStream(context.Background(), auth, request, ex.Options{}) })
	if !errors.Is(err, ErrRequestRejected) {
		t.Fatalf("want ErrRequestRejected, got %v", err)
	}
	if logged != "subscription_upstream_failure claude response 400 invalid_request_error\n" {
		t.Fatalf("unexpected stderr line %q", logged)
	}
	for _, secret := range []string{"fixture-upstream-message", "fixture-access-token"} {
		if strings.Contains(logged, secret) {
			t.Fatalf("stderr leaked %q", secret)
		}
	}
}

func TestPlainModelProviderStatusKeepsOnlyActionableRefusal(t *testing.T) {
	for _, test := range []struct {
		status int
		want   string
	}{
		{401, "reconnect_required"}, {403, "provider_access_denied"}, {429, "subscription_rate_limited"},
		{400, "provider_request_rejected"}, {404, "provider_request_rejected"}, {503, "provider_temporarily_unavailable"},
	} {
		t.Run(fmt.Sprint(test.status), func(t *testing.T) {
			model := CPAPlainModel{Provider: "claude", Client: &http.Client{Transport: fixedTransport{status: test.status, contentType: "application/json", body: `{"error":{"message":"fixture-private-provider-text","type":"fixture_secret"}}`}}}
			_, err := model.ExecuteStream(context.Background(), &core.Auth{Metadata: map[string]any{"access_token": "fixture-private-token"}}, ex.Request{Model: "fixture-model", Payload: []byte(`{"messages":[{"role":"user","content":"hi"}]}`)}, ex.Options{})
			if err == nil || err.Error() != test.want {
				t.Fatalf("got %v, want %s", err, test.want)
			}
		})
	}
}

func TestPlainModelProviderStreamErrorKeepsOnlyKnownTypes(t *testing.T) {
	for _, test := range []struct{ kind, want string }{
		{"authentication_error", "reconnect_required"}, {"permission_error", "provider_access_denied"},
		{"rate_limit_error", "subscription_rate_limited"}, {"overloaded_error", "provider_temporarily_unavailable"},
		{"fixture_private_token", "provider_operation_failed"},
	} {
		t.Run(test.kind, func(t *testing.T) {
			model := CPAPlainModel{Provider: "claude", Client: &http.Client{Transport: fixedTransport{status: 200, contentType: "text/event-stream", body: fmt.Sprintf("data: {\"type\":\"error\",\"error\":{\"type\":%q,\"message\":\"fixture-private-provider-text\"}}\n\n", test.kind)}}}
			result, err := model.ExecuteStream(context.Background(), &core.Auth{Metadata: map[string]any{"access_token": "fixture-private-token"}}, ex.Request{Model: "fixture-model", Payload: []byte(`{"messages":[{"role":"user","content":"hi"}]}`)}, ex.Options{})
			if err != nil {
				t.Fatal(err)
			}
			chunk := <-result.Chunks
			if chunk.Err == nil || chunk.Err.Error() != test.want {
				t.Fatalf("got %v, want %s", chunk.Err, test.want)
			}
		})
	}
}

func TestUpstreamErrorTypeKeepsOnlyTheEnum(t *testing.T) {
	for body, want := range map[string]string{
		`{"type":"error","error":{"type":"authentication_error","message":"x"}}`:                             "authentication_error",
		`{"error":{"code":"rate_limit_exceeded"}}`:                                                           "rate_limit_exceeded",
		`{"type":"response.failed","response":{"error":{"code":"rate_limit_exceeded","message":"private"}}}`: "rate_limit_exceeded",
		`not json`: "unparsed",
		`{}`:       "unknown",
	} {
		if got := upstreamErrorType([]byte(body)); got != want {
			t.Errorf("%s: got %q, want %q", body, got, want)
		}
	}
	logged := captureStderr(t, func() { upstreamFailure("claude", "response", 403, "Has Spaces And A Message") })
	if logged != "subscription_upstream_failure claude response 403 unknown\n" {
		t.Fatalf("an unexpected type must not pass through: %q", logged)
	}
	logged = captureStderr(t, func() { upstreamFailure("claude", "event", 200, "fixture_private_token") })
	if strings.Contains(logged, "fixture_private_token") {
		t.Fatal("an enum-shaped unknown provider value reached logs")
	}
}

func TestRequestDiagnosticsAcceptOnlyLocalEnumsAndByteCounts(t *testing.T) {
	logged := captureStderr(t, func() {
		requestFailure("fixture-private-provider", "input", "json_invalid", 12, 262144)
		requestFailure("claude", "conversion", "fixture_private_reason", 12, 524288)
		requestFailure("claude", "fixture_private_phase", "json_invalid", 12, 262144)
		requestFailure("claude", "stream", "json_invalid", 12, 262144)
		requestFailure("claude", "input", "json_invalid", -1, 262144)
		requestFailure("claude", "input", "json_invalid", 12, 12345)
		requestFailure("claude", "input", "payload_too_large", 1048577, 1048576)
		requestFailure("codex", "conversion", "payload_too_large", 2097153, 2097152)
		requestFailure("claude", "input", "json_invalid", 12, 2097152)
		requestFailure("codex", "conversion", "json_invalid", 12, 1048576)
		requestFailure("claude", "stream", "chunk_too_large", 1048577, 1048576)
	})
	if logged != "subscription_request_failure unknown input json_invalid 12 262144\n"+
		"subscription_request_failure claude input payload_too_large 1048577 1048576\n"+
		"subscription_request_failure codex conversion payload_too_large 2097153 2097152\n" {
		t.Fatalf("unexpected local diagnostic: %q", logged)
	}
}

func TestPlainModelRequestBoundariesDoNotReachProviderOrExposeInput(t *testing.T) {
	for _, provider := range []string{"claude", "codex"} {
		t.Run(provider, func(t *testing.T) {
			calls, sentBytes, inputBytes := 0, 0, 0
			model := CPAPlainModel{Provider: provider, Client: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				calls++
				raw, err := io.ReadAll(r.Body)
				if err != nil {
					t.Fatal(err)
				}
				sentBytes = len(raw)
				body := "data: {\"type\":\"message_stop\"}\n\n"
				if provider == "codex" {
					body = "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"fixture\",\"model\":\"fixture-model\",\"output\":[],\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}}\n\n"
				}
				return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"text/event-stream"}}, Body: io.NopCloser(strings.NewReader(body))}, nil
			})}}
			auth := &core.Auth{Metadata: map[string]any{"access_token": "fixture-private-access", "account_id": "fixture-account"}}
			execute := func(text string) error {
				var input bytes.Buffer
				encoder := json.NewEncoder(&input)
				// Match JSON.stringify: HTML characters arrive unescaped. Real
				// conversion can expand them while the input stays under 1 MiB.
				encoder.SetEscapeHTML(false)
				if err := encoder.Encode(map[string]any{"model": "fixture-model", "stream": true, "messages": []any{map[string]any{"role": "user", "content": text}}}); err != nil {
					t.Fatal(err)
				}
				payload := bytes.TrimSuffix(input.Bytes(), []byte("\n"))
				inputBytes = len(payload)
				result, err := model.ExecuteStream(context.Background(), auth, ex.Request{Model: "fixture-model", Payload: payload}, ex.Options{})
				if err != nil {
					return err
				}
				for chunk := range result.Chunks {
					if chunk.Err != nil {
						return chunk.Err
					}
				}
				return nil
			}
			if err := execute("seed"); err != nil {
				t.Fatal(err)
			}
			// Calibrate the real CPA conversion, rather than copying its format.
			capacity := 2097152 - sentBytes + len("seed")
			boundary := strings.Repeat("<", capacity/6) + strings.Repeat("x", capacity%6)
			calls = 0
			if err := execute(boundary); err != nil || calls != 1 || sentBytes != 2097152 || inputBytes > 1048576 {
				t.Fatalf("exact converted boundary failed: err=%v calls=%d input=%d output=%d", err, calls, inputBytes, sentBytes)
			}
			calls = 0
			var err error
			logged := captureStderr(t, func() { err = execute(boundary + "x") })
			if err != ErrProvider || calls != 0 || inputBytes > 1048576 || logged != fmt.Sprintf("subscription_request_failure %s conversion payload_too_large 2097153 2097152\n", provider) {
				t.Fatalf("converted overflow crossed boundary: err=%v calls=%d diagnostic=%q", err, calls, logged)
			}
			invalid := []byte(`{"fixture-private-body":`)
			logged = captureStderr(t, func() {
				_, err = model.ExecuteStream(context.Background(), auth, ex.Request{Model: "fixture-model", Payload: invalid}, ex.Options{})
			})
			if err != ErrProvider || calls != 0 || logged != fmt.Sprintf("subscription_request_failure %s input json_invalid %d 1048576\n", provider, len(invalid)) {
				t.Fatalf("invalid input crossed boundary: err=%v calls=%d diagnostic=%q", err, calls, logged)
			}
			if strings.Contains(logged, "fixture-private") {
				t.Fatal("request diagnostic exposed input or credential")
			}
		})
	}
}

func TestClaudeSubscriptionSystemPreservesHostBlocks(t *testing.T) {
	prefix := map[string]any{"type": "text", "text": "You are Claude Code, Anthropic's official CLI for Claude."}
	host := map[string]any{"type": "text", "text": "Mikka host instructions", "cache_control": map[string]any{"type": "ephemeral"}}
	for _, test := range []struct {
		name  string
		input any
		want  []any
	}{
		{"absent", nil, []any{prefix}},
		{"string", "host instructions", []any{prefix, map[string]any{"type": "text", "text": "host instructions"}}},
		{"blocks", []any{host}, []any{prefix, host}},
		{"already prefixed", []any{prefix, host}, []any{prefix, host}},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := claudeSubscriptionSystem(test.input); !reflect.DeepEqual(got, test.want) {
				t.Fatalf("system blocks changed: got %#v, want %#v", got, test.want)
			}
		})
	}
}

func TestClaudeSubscriptionRequestPreservesInstructionsAndToolHistory(t *testing.T) {
	model := CPAPlainModel{Provider: "claude", Client: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != "api.anthropic.com" || r.URL.Path != "/v1/messages" || r.Header.Get("User-Agent") != "Mikka/1.0" || r.Header.Get("Authorization") != "Bearer fixture-access" {
			t.Fatal("unexpected subscription destination or credentials")
		}
		var body map[string]any
		if json.NewDecoder(r.Body).Decode(&body) != nil {
			t.Fatal("invalid request")
		}
		system, _ := body["system"].([]any)
		if len(system) < 2 || objectMap(system[0])["text"] != "You are Claude Code, Anthropic's official CLI for Claude." || objectMap(system[1])["text"] != "You are Mikka. Follow the host's tool permissions." {
			t.Fatal("subscription protocol block or host instructions missing")
		}
		if body["metadata"] != nil {
			t.Fatal("unexpected synthesized device identity")
		}
		tools, _ := body["tools"].([]any)
		if len(tools) != 1 || objectMap(tools[0])["name"] != "lookup" {
			t.Fatal("tool schema lost")
		}
		raw, _ := json.Marshal(body["messages"])
		if !strings.Contains(string(raw), "tool_use") || !strings.Contains(string(raw), "tool_result") || !strings.Contains(string(raw), "fixture-result") {
			t.Fatal("tool history lost")
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"text/event-stream"}}, Body: io.NopCloser(strings.NewReader("data: {\"type\":\"message_stop\"}\n\n"))}, nil
	})}}
	payload := []byte(`{"model":"fixture-model","messages":[{"role":"system","content":"You are Mikka. Follow the host's tool permissions."},{"role":"user","content":"Look up the value"},{"role":"assistant","content":null,"tool_calls":[{"id":"call-1","type":"function","function":{"name":"lookup","arguments":"{}"}}]},{"role":"tool","tool_call_id":"call-1","content":"fixture-result"}],"tools":[{"type":"function","function":{"name":"lookup","description":"Read one value","parameters":{"type":"object","properties":{}}}}]}`)
	result, err := model.ExecuteStream(context.Background(), &core.Auth{Metadata: map[string]any{"access_token": "fixture-access"}}, ex.Request{Model: "fixture-model", Payload: payload}, ex.Options{})
	if err != nil {
		t.Fatal(err)
	}
	for chunk := range result.Chunks {
		if chunk.Err != nil {
			t.Fatal(chunk.Err)
		}
	}
}

func TestClaudeSubscriptionLayeredCacheBreakpoints(t *testing.T) {
	cc := map[string]any{"type": "ephemeral"}
	wantSystem, err := json.Marshal([]any{
		map[string]any{"type": "text", "text": "You are Claude Code, Anthropic's official CLI for Claude."},
		map[string]any{"type": "text", "text": "fixture-rules", "cache_control": cc},
		map[string]any{"type": "text", "text": "fixture-repositories-and-models", "cache_control": cc},
		map[string]any{"type": "text", "text": "fixture-live-tail"},
	})
	if err != nil {
		t.Fatal(err)
	}
	var countMarkers func(any) int
	countMarkers = func(value any) int {
		count := 0
		switch node := value.(type) {
		case map[string]any:
			if _, exists := node["cache_control"]; exists {
				count++
			}
			for _, child := range node {
				count += countMarkers(child)
			}
		case []any:
			for _, child := range node {
				count += countMarkers(child)
			}
		}
		return count
	}
	const systems = `{"role":"system","content":"fixture-rules","cache_control":{"type":"ephemeral"}},{"role":"system","content":"fixture-repositories-and-models","cache_control":{"type":"ephemeral"}},{"role":"system","content":"fixture-live-tail"}`
	for _, test := range []struct {
		name        string
		history     string
		role        string
		wantContent []any
	}{
		{
			name:    "user text",
			history: `{"role":"user","content":"fixture-request","cache_control":{"type":"ephemeral"}}`,
			role:    "user",
			wantContent: []any{
				map[string]any{"type": "text", "text": "fixture-request", "cache_control": cc},
			},
		},
		{
			name: "assistant tool call with duplicated SDK metadata",
			// The compatible SDK retains metadata on both the assistant message
			// and its last tool call. CPA must emit just one final tool_use marker.
			history: `{"role":"user","content":"fixture-request"},{"role":"assistant","content":"fixture-text","cache_control":{"type":"ephemeral"},"tool_calls":[{"id":"fixture-call","type":"function","function":{"name":"lookup","arguments":"{}"},"cache_control":{"type":"ephemeral"}}]}`,
			role:    "assistant",
			wantContent: []any{
				map[string]any{"type": "text", "text": "fixture-text"},
				map[string]any{"type": "tool_use", "id": "fixture-call", "name": "lookup", "input": map[string]any{}, "cache_control": cc},
			},
		},
		{
			name:    "tool result",
			history: `{"role":"user","content":"fixture-request"},{"role":"assistant","content":null,"tool_calls":[{"id":"fixture-call","type":"function","function":{"name":"lookup","arguments":"{}"}}]},{"role":"tool","tool_call_id":"fixture-call","content":"fixture-result","cache_control":{"type":"ephemeral"}}`,
			role:    "user",
			wantContent: []any{
				map[string]any{"type": "tool_result", "tool_use_id": "fixture-call", "content": "fixture-result", "cache_control": cc},
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			called := false
			model := CPAPlainModel{Provider: "claude", Client: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				called = true
				raw, err := io.ReadAll(r.Body)
				if err != nil {
					t.Fatal(err)
				}
				var body map[string]any
				if err := json.Unmarshal(raw, &body); err != nil {
					t.Fatal(err)
				}
				var wire struct{ System json.RawMessage }
				if err := json.Unmarshal(raw, &wire); err != nil {
					t.Fatal(err)
				}
				if !bytes.Equal(wire.System, wantSystem) {
					t.Fatal("the four outgoing system blocks changed bytes or marker placement")
				}
				messages, _ := body["messages"].([]any)
				if len(messages) == 0 {
					t.Fatal("conversation lost")
				}
				last := objectMap(messages[len(messages)-1])
				if last["role"] != test.role || !reflect.DeepEqual(last["content"], test.wantContent) {
					t.Fatal("the final content or its single cache breakpoint changed")
				}
				if countMarkers(body) != 3 {
					t.Fatal("expected exactly three breakpoints in the actual Anthropic request")
				}
				return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"text/event-stream"}}, Body: io.NopCloser(strings.NewReader("data: {\"type\":\"message_stop\"}\n\n"))}, nil
			})}}
			payload := []byte(fmt.Sprintf(`{"model":"fixture-model","messages":[%s,%s],"tools":[{"type":"function","function":{"name":"lookup","description":"Read one value","parameters":{"type":"object","properties":{}}}}]}`, systems, test.history))
			result, err := model.ExecuteStream(context.Background(), &core.Auth{Metadata: map[string]any{"access_token": "fixture-access"}}, ex.Request{Model: "fixture-model", Payload: payload}, ex.Options{})
			if err != nil {
				t.Fatal(err)
			}
			for chunk := range result.Chunks {
				if chunk.Err != nil {
					t.Fatal(chunk.Err)
				}
			}
			if !called {
				t.Fatal("the actual CPA translator did not reach the test HTTP transport")
			}
		})
	}
}

func TestCodexSubscriptionStreamWithoutContentType(t *testing.T) {
	for _, test := range []struct {
		name        string
		contentType string
		body        string
		wantError   bool
	}{
		{"valid SSE without MIME", "", "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"fixture-response\",\"model\":\"fixture-model\",\"output\":[],\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}}\n\n", false},
		{"HTML", "text/html", "<html>not a model reply</html>", true},
		{"JSON without MIME", "", `{"error":{"type":"invalid_request_error"}}`, true},
		{"truncated SSE", "", "data: {\"type\":\"response.created\",\"response\":{\"id\":\"fixture-response\",\"output\":[]}}\n\n", true},
	} {
		t.Run(test.name, func(t *testing.T) {
			model := CPAPlainModel{Provider: "codex", Client: &http.Client{Transport: fixedTransport{status: 200, contentType: test.contentType, body: test.body}}}
			result, err := model.ExecuteStream(context.Background(), &core.Auth{Metadata: map[string]any{"access_token": "fixture-access", "account_id": "fixture-account"}}, ex.Request{Model: "fixture-model", Payload: []byte(`{"messages":[{"role":"user","content":"hi"}]}`)}, ex.Options{})
			failed, done := err != nil, false
			if err == nil {
				for chunk := range result.Chunks {
					failed = failed || chunk.Err != nil
					done = done || strings.Contains(string(chunk.Payload), "[DONE]")
				}
			}
			if failed != test.wantError || (!test.wantError && !done) {
				t.Fatalf("failed=%v, done=%v", failed, done)
			}
		})
	}
}

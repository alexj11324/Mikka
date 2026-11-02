package worker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
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
	if !errors.Is(err, ErrProvider) {
		t.Fatalf("want ErrProvider, got %v", err)
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

func TestUpstreamErrorTypeKeepsOnlyTheEnum(t *testing.T) {
	for body, want := range map[string]string{
		`{"type":"error","error":{"type":"authentication_error","message":"x"}}`: "authentication_error",
		`{"error":{"code":"rate_limit_exceeded"}}`:                               "rate_limit_exceeded",
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

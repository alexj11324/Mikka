package worker

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"os"
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
		`{"error":{"code":"rate_limit_exceeded"}}`:                                "rate_limit_exceeded",
		`not json`:                                                                "unparsed",
		`{}`:                                                                      "unknown",
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

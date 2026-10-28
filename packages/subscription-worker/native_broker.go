package worker

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	core "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

// Native clients send their original protocol through a task-bound broker.
// Provider access credentials remain in this process, outside the CLI runtime.
// This does not invoke CPA's native fingerprint/identity executors.
type NativeRequest struct {
	Path    string            `json:"path"`
	Headers map[string]string `json:"headers"`
	Body    json.RawMessage   `json:"body"`
}

type NativeContext struct {
	AccountID string    `json:"accountId"`
	Plan      string    `json:"plan,omitempty"`
	ExpiresAt time.Time `json:"expiresAt"`
}

func (w *Worker) NativeContext(ctx context.Context, epoch int64) (NativeContext, error) {
	if w.Use == nil || w.Use.RunID == "" {
		return NativeContext{}, ErrUnavailable
	}
	if err := w.authorizeRuntime(ctx, epoch, "native", ""); err != nil {
		return NativeContext{}, err
	}
	r, auth, err := w.readyAuth(ctx, epoch)
	if err != nil || core.IsCodexUseSIWC(auth) {
		return NativeContext{}, ErrUnavailable
	}
	expires, known := auth.AccessTokenExpirationTime()
	if !known {
		return NativeContext{}, ErrCredential
	}
	account := r.Subject
	plan := ""
	if w.Scope.Provider == "codex" {
		account, _ = auth.Metadata["account_id"].(string)
		plan, _ = auth.Metadata["plan_type"].(string)
	}
	return NativeContext{AccountID: account, Plan: plan, ExpiresAt: expires}, nil
}

func (w *Worker) NativeStream(ctx context.Context, epoch int64, request NativeRequest, head func(string) error, emit func([]byte) error) error {
	if w.Use == nil || w.Use.RunID == "" {
		return ErrUnavailable
	}
	var body struct {
		Model string `json:"model"`
	}
	if len(request.Body) > 262144 || json.Unmarshal(request.Body, &body) != nil || !modelPattern.MatchString(body.Model) || len(request.Headers) > 32 {
		return ErrUnsupported
	}
	if err := w.authorizeRuntime(ctx, epoch, "native", body.Model); err != nil {
		return err
	}
	var canonical map[string]any
	canonicalDecoder := json.NewDecoder(bytes.NewReader(request.Body))
	canonicalDecoder.UseNumber()
	if canonicalDecoder.Decode(&canonical) != nil {
		return ErrUnsupported
	}
	request.Body, _ = json.Marshal(canonical)
	endpoint := ""
	if w.Scope.Provider == "claude" && (request.Path == "/v1/messages" || request.Path == "/v1/messages?beta=true") {
		endpoint = "https://api.anthropic.com" + request.Path
	} else if w.Scope.Provider == "codex" && request.Path == "/responses" {
		endpoint = "https://chatgpt.com/backend-api/codex/responses"
	} else {
		return ErrUnsupported
	}
	r, auth, err := w.readyAuth(ctx, epoch)
	if err != nil || core.IsCodexUseSIWC(auth) {
		return ErrUnavailable
	}
	token, _ := auth.Metadata["access_token"].(string)
	if token == "" {
		return ErrCredential
	}
	callCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	upstream, err := http.NewRequestWithContext(callCtx, http.MethodPost, endpoint, bytes.NewReader(request.Body))
	if err != nil {
		return ErrUnsupported
	}
	// Only protocol headers produced by the actual native client are forwarded.
	// No client-supplied URL, cookie, authorization, account or proxy credentials.
	for key, value := range request.Headers {
		name := strings.ToLower(key)
		if len(value) > 4096 || strings.ContainsAny(value, "\r\n\x00") {
			return ErrUnsupported
		}
		switch name {
		case "accept", "content-type", "user-agent", "anthropic-version", "anthropic-beta", "openai-beta", "originator", "x-app":
			upstream.Header.Set(name, value)
		}
	}
	upstream.Header.Set("Authorization", "Bearer "+token)
	upstream.Header.Set("Content-Type", "application/json")
	if w.Scope.Provider == "codex" {
		account, _ := auth.Metadata["account_id"].(string)
		upstream.Header.Set("ChatGPT-Account-Id", account)
	}
	client := http.Client{Timeout: 270 * time.Second}
	if w.NativeClient != nil {
		client = *w.NativeClient
	}
	client.Timeout = 270 * time.Second
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	// Check revocation even while upstream is silent; closing IPC also cancels.
	done := make(chan struct{})
	defer close(done)
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-callCtx.Done():
				return
			case <-ticker.C:
				if w.authorizeRuntime(callCtx, epoch, "native_active", body.Model) != nil {
					cancel()
					return
				}
			}
		}
	}()
	response, err := client.Do(upstream)
	if err != nil {
		return ErrProvider
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return ErrProvider
	}
	contentType := strings.Split(response.Header.Get("Content-Type"), ";")[0]
	if contentType != "text/event-stream" && contentType != "application/json" {
		return ErrProvider
	}
	if err = head(contentType); err != nil {
		return ErrUnavailable
	}
	// Retain a token-sized tail so an upstream echo split across chunks cannot
	// leak a bearer into the native client, tools, events or diagnostics.
	carry := []byte{}
	buffer := make([]byte, 8192)
	for {
		n, readErr := response.Body.Read(buffer)
		carry = append(carry, buffer[:n]...)
		if bytes.Contains(carry, []byte(token)) {
			return ErrIntegrity
		}
		if w.authorizeRuntime(ctx, r.Epoch, "native_active", body.Model) != nil {
			return ErrUnavailable
		}
		flush := len(carry) - len(token) + 1
		if readErr == io.EOF {
			flush = len(carry)
		}
		if flush > 0 {
			if emit(carry[:flush]) != nil {
				return ErrUnavailable
			}
			carry = append([]byte(nil), carry[flush:]...)
		}
		if readErr == io.EOF {
			return nil
		}
		if readErr != nil {
			return ErrProvider
		}
	}
}

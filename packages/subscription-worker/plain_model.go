package worker

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	core "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	ex "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
	compat "github.com/router-for-me/CLIProxyAPI/v8/sdk/mikkaadapter"
	"net/http"
	"strings"
	"time"
)

// CPA's actual conversion functions and ProviderExecutor contract, with Mikka's
// ordinary HTTPS transport. Never invokes CPA's native identity/cloaking,
// fingerprint transports, account pool, usage logging or fallback executors.
type CPAPlainModel struct {
	core.ProviderExecutor
	Provider string
	Client   *http.Client
}

func (e CPAPlainModel) Identifier() string { return e.Provider }
func (e CPAPlainModel) ExecuteStream(ctx context.Context, a *core.Auth, request ex.Request, _ ex.Options) (*ex.StreamResult, error) {
	if a == nil || core.IsCodexUseSIWC(a) {
		return nil, ErrUnsupported
	}
	token, _ := a.Metadata["access_token"].(string)
	if token == "" {
		return nil, ErrCredential
	}
	var original map[string]any
	if json.Unmarshal(request.Payload, &original) != nil {
		return nil, ErrProvider
	}
	var converted []byte
	var err error
	endpoint := "https://api.anthropic.com/v1/messages"
	if e.Provider == "claude" {
		// The converter accepts an explicit user field before its cache-ID derivation.
		// Supply an honest application marker, then drop metadata entirely before
		// transport. No synthesized device/session identity is sent or generated.
		delete(original, "metadata")
		original["user"] = "Mikka"
		input, _ := json.Marshal(original)
		converted, err = compat.OpenAIToClaude(request.Model, input, true)
	} else if e.Provider == "codex" {
		endpoint = "https://chatgpt.com/backend-api/codex/responses"
		converted, err = compat.OpenAIToCodex(request.Model, request.Payload, true)
	} else {
		return nil, ErrUnsupported
	}
	if err != nil {
		return nil, ErrProvider
	}
	var body map[string]any
	if json.Unmarshal(converted, &body) != nil {
		return nil, ErrProvider
	}
	allowed := " model messages system max_tokens stream tools tool_choice temperature top_p stop_sequences thinking output_config service_tier "
	if e.Provider == "codex" {
		allowed = " model input instructions stream store max_output_tokens tools tool_choice parallel_tool_calls reasoning text include "
	}
	for key := range body {
		if !strings.Contains(allowed, " "+key+" ") {
			delete(body, key)
		}
	}
	body["model"] = request.Model
	body["stream"] = true
	if e.Provider == "codex" {
		body["store"] = false
	}
	converted, err = json.Marshal(body)
	if err != nil || len(converted) > 524288 {
		return nil, ErrProvider
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(converted))
	if err != nil {
		return nil, ErrProvider
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("User-Agent", "Mikka/1.0")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	if e.Provider == "claude" {
		req.Header.Set("anthropic-version", "2023-06-01")
		req.Header.Set("anthropic-beta", "oauth-2025-04-20")
	} else {
		account, _ := a.Metadata["account_id"].(string)
		if !scopePattern.MatchString(account) {
			return nil, ErrCredential
		}
		req.Header.Set("ChatGPT-Account-Id", account)
		req.Header.Set("Originator", "Mikka")
	}
	client := http.Client{Timeout: 270 * time.Second}
	if e.Client != nil {
		client = *e.Client
	}
	client.Timeout = 270 * time.Second
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	response, err := client.Do(req)
	if err != nil {
		return nil, ErrProvider
	}
	if response.StatusCode != http.StatusOK || !strings.HasPrefix(response.Header.Get("Content-Type"), "text/event-stream") {
		response.Body.Close()
		return nil, ErrProvider
	}
	chunks := make(chan ex.StreamChunk)
	go func() {
		defer close(chunks)
		defer response.Body.Close()
		emit := func(value ex.StreamChunk) bool {
			select {
			case chunks <- value:
				return true
			case <-ctx.Done():
				return false
			}
		}
		scanner := bufio.NewScanner(response.Body)
		scanner.Buffer(make([]byte, 4096), 524288)
		var param any
		completed := false
		total := 0
		for scanner.Scan() {
			total += len(scanner.Bytes())
			if total > 16<<20 {
				emit(ex.StreamChunk{Err: ErrProvider})
				return
			}
			line := bytes.TrimSpace(scanner.Bytes())
			if !bytes.HasPrefix(line, []byte("data:")) {
				continue
			}
			raw := bytes.TrimSpace(bytes.TrimPrefix(line, []byte("data:")))
			if bytes.Equal(raw, []byte("[DONE]")) {
				break
			}
			var event map[string]any
			if json.Unmarshal(raw, &event) != nil {
				emit(ex.StreamChunk{Err: ErrProvider})
				return
			}
			kind, _ := event["type"].(string)
			if kind == "error" || kind == "response.failed" || event["error"] != nil {
				emit(ex.StreamChunk{Err: ErrProvider})
				return
			}
			completed = kind == "message_stop" || kind == "response.completed" || kind == "response.incomplete"
			var translated [][]byte
			if e.Provider == "claude" {
				translated = compat.ClaudeToOpenAIStream(ctx, request.Model, request.Payload, converted, line, &param)
			} else {
				translated = compat.CodexToOpenAIStream(ctx, request.Model, request.Payload, converted, line, &param)
			}
			for _, piece := range translated {
				if len(piece) > 65536 || !json.Valid(piece) {
					emit(ex.StreamChunk{Err: ErrProvider})
					return
				}
				if !emit(ex.StreamChunk{Payload: append(append([]byte("data: "), piece...), []byte("\n\n")...)}) {
					return
				}
			}
			if completed {
				break
			}
		}
		if scanner.Err() != nil || !completed {
			emit(ex.StreamChunk{Err: ErrProvider})
			return
		}
		emit(ex.StreamChunk{Payload: []byte("data: [DONE]\n\n")})
	}()
	return &ex.StreamResult{Chunks: chunks}, nil
}

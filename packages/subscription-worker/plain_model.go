package worker

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	core "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	ex "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
	compat "github.com/router-for-me/CLIProxyAPI/v8/sdk/mikkaadapter"
	"io"
	"net/http"
	"net/http/httptrace"
	"os"
	"strings"
	"time"
)

// CPA's actual conversion functions and ProviderExecutor contract, with Mikka's
// ordinary HTTPS transport. Claude OAuth requires the subscription protocol's
// opening system block (also used by CPA). Host instructions and tool history
// follow unchanged. No generated device identity, fingerprint transport,
// account pool, usage logging or fallback executor is used.
type CPAPlainModel struct {
	core.ProviderExecutor
	Provider string
	Client   *http.Client
}

func (e CPAPlainModel) Identifier() string { return e.Provider }

// upstreamFailure writes one fixed-shape line for the control plane's logs: the
// provider, the stage, the HTTP status and the provider's error type enum. It
// never writes a message, body, header or credential.
func upstreamFailure(provider, stage string, status int, kind string) {
	if !knownUpstreamType(kind) {
		kind = "unknown"
	}
	fmt.Fprintf(os.Stderr, "subscription_upstream_failure %s %s %d %s\n", provider, stage, status, kind)
}

// Local request boundaries have no upstream response. Only fixed enums and
// byte counts cross stderr; zero means no byte buffer/limit exists at that
// boundary. Never accept error text, model names, payloads or credentials.
func requestFailure(provider, phase, reason string, size, limit int) {
	if provider != "claude" && provider != "codex" {
		provider = "unknown"
	}
	switch phase + ":" + reason {
	case "input:model_invalid", "input:payload_too_large", "input:json_invalid",
		"conversion:conversion_failed", "conversion:json_invalid", "conversion:encode_failed",
		"conversion:payload_too_large", "conversion:request_invalid",
		"stream:stream_unavailable", "stream:chunk_too_large":
	default:
		return
	}
	if size < 0 || limit < 0 {
		return
	}
	switch limit {
	case modelRequestMaxBytes:
		if phase != "input" {
			return
		}
	case modelConvertedRequestMaxBytes:
		if phase != "conversion" {
			return
		}
	case 0, 65536, 262144, 524288:
	default:
		return
	}
	fmt.Fprintf(os.Stderr, "subscription_request_failure %s %s %s %d %d\n", provider, phase, reason, size, limit)
}

func knownUpstreamType(kind string) bool {
	if providerEventFailure(kind) != ErrProvider {
		return true
	}
	switch kind {
	case "unknown", "unparsed", "network", "stream_ended", "request_invalid":
		return true
	}
	return false
}

// upstreamErrorType reads the error type enum from a provider error body:
// {"error":{"type":"..."}} (Anthropic, OpenAI) or {"type":"..."}.
func upstreamErrorType(body []byte) string {
	type providerError struct {
		Type string `json:"type"`
		Code string `json:"code"`
	}
	var parsed struct {
		Type     string        `json:"type"`
		Error    providerError `json:"error"`
		Response struct {
			Error providerError `json:"error"`
		} `json:"response"`
	}
	if json.Unmarshal(body, &parsed) != nil {
		return "unparsed"
	}
	for _, value := range []string{parsed.Error.Type, parsed.Error.Code, parsed.Response.Error.Type, parsed.Response.Error.Code, parsed.Type} {
		if value != "" && value != "error" {
			return value
		}
	}
	return "unknown"
}
func (e CPAPlainModel) ExecuteStream(ctx context.Context, a *core.Auth, request ex.Request, _ ex.Options) (*ex.StreamResult, error) {
	if a == nil || core.IsCodexUseSIWC(a) {
		return nil, ErrUnsupported
	}
	token, _ := a.Metadata["access_token"].(string)
	if token == "" {
		return nil, ErrCredential
	}
	conversionDone := timingSpan(ctx, timingConversion)
	defer conversionDone()
	var original map[string]any
	if json.Unmarshal(request.Payload, &original) != nil {
		requestFailure(e.Provider, "input", "json_invalid", len(request.Payload), modelRequestMaxBytes)
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
		beginCodexServiceTier(ctx, original["service_tier"])
		converted, err = compat.OpenAIToCodex(request.Model, request.Payload, true)
	} else {
		return nil, ErrUnsupported
	}
	if err != nil {
		requestFailure(e.Provider, "conversion", "conversion_failed", 0, 0)
		return nil, ErrProvider
	}
	var body map[string]any
	if json.Unmarshal(converted, &body) != nil {
		requestFailure(e.Provider, "conversion", "json_invalid", len(converted), modelConvertedRequestMaxBytes)
		return nil, ErrProvider
	}
	allowed := " model messages system max_tokens stream tools tool_choice temperature top_p stop_sequences thinking output_config service_tier "
	if e.Provider == "codex" {
		allowed = " model input instructions stream store max_output_tokens tools tool_choice parallel_tool_calls reasoning text include service_tier "
		// The pinned converter also accepts ultrafast. This path only enables
		// the fixed priority tier; no arbitrary tier reaches native transport.
		if tier, ok := body["service_tier"].(string); !ok || tier != "priority" {
			delete(body, "service_tier")
		}
	}
	for key := range body {
		if !strings.Contains(allowed, " "+key+" ") {
			delete(body, key)
		}
	}
	body["model"] = request.Model
	body["stream"] = true
	if e.Provider == "claude" {
		body["system"] = claudeSubscriptionSystem(body["system"])
	} else {
		body["store"] = false
	}
	converted, err = json.Marshal(body)
	if err != nil {
		requestFailure(e.Provider, "conversion", "encode_failed", 0, 0)
		return nil, ErrProvider
	}
	if len(converted) > modelConvertedRequestMaxBytes {
		requestFailure(e.Provider, "conversion", "payload_too_large", len(converted), modelConvertedRequestMaxBytes)
		return nil, ErrProvider
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(converted))
	if err != nil {
		requestFailure(e.Provider, "conversion", "request_invalid", len(converted), modelConvertedRequestMaxBytes)
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
		// Official Codex uses session-id for ChatGPT cache affinity
		// (openai/codex d4a341bd, codex-rs/core/src/client.rs:734).
		// Only our already-authorized Stream context supplies it; never payloads
		// or credential metadata. No provider identity or body option changes.
		if session, ok := ctx.Value(codexSessionKey{}).(string); ok && session != "" {
			req.Header.Set("Session-Id", session)
		}
	}
	client := http.Client{Timeout: 270 * time.Second}
	if e.Client != nil {
		client = *e.Client
	}
	client.Timeout = 270 * time.Second
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	conversionDone()
	httpStarted := time.Now()
	if trace := requestHTTPTrace(ctx, httpStarted); trace != nil {
		req = req.WithContext(httptrace.WithClientTrace(req.Context(), trace))
	}
	headersDone := timingSpan(ctx, timingHTTPHeaders)
	if e.Provider == "codex" {
		recordCodexRequestedTier(ctx, body["service_tier"])
	}
	response, err := client.Do(req)
	headersDone()
	if response != nil {
		recordHTTPHeaders(ctx)
	}
	if err != nil {
		upstreamFailure(e.Provider, "transport", 0, "network")
		kind := "network_error"
		if ctx.Err() == context.DeadlineExceeded {
			kind = "timeout_error"
		}
		return nil, providerTransportFailure(e.Provider, kind, err)
	}
	contentType := response.Header.Get("Content-Type")
	// Codex can omit MIME on a successful streaming response. The parser below
	// still requires valid SSE JSON and a terminal response event; an HTML/JSON
	// error page or truncated stream cannot become a successful model reply.
	streamType := strings.HasPrefix(contentType, "text/event-stream") || (e.Provider == "codex" && contentType == "")
	if response.StatusCode != http.StatusOK || !streamType {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 8192))
		response.Body.Close()
		upstreamFailure(e.Provider, "response", response.StatusCode, upstreamErrorType(body))
		if response.StatusCode != http.StatusOK {
			return nil, providerFailure(providerStatusFailure(response.StatusCode), e.Provider, response.StatusCode, body, request.Payload, token)
		}
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
			timingOnceSince(ctx, timingHTTPFirstEvent, httpStarted)
			kind, _ := event["type"].(string)
			if e.Provider == "codex" {
				recordCodexResponseTier(ctx, kind, event)
			}
			if providerTextEvent(e.Provider, kind, event) {
				timingOnceSince(ctx, timingHTTPFirstTextEvent, httpStarted)
			}
			if kind == "error" || kind == "response.failed" || event["error"] != nil {
				kind := upstreamErrorType(raw)
				upstreamFailure(e.Provider, "event", 200, kind)
				emit(ex.StreamChunk{Err: providerFailure(providerEventFailure(kind), e.Provider, 0, raw, request.Payload, token)})
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
				timingOnceSince(ctx, timingFirstConvertedChunk, httpStarted)
				if !emit(ex.StreamChunk{Payload: append(append([]byte("data: "), piece...), []byte("\n\n")...)}) {
					return
				}
			}
			if completed {
				break
			}
		}
		if scanner.Err() != nil || !completed {
			upstreamFailure(e.Provider, "incomplete", 200, "stream_ended")
			emit(ex.StreamChunk{Err: ErrProvider})
			return
		}
		emit(ex.StreamChunk{Payload: []byte("data: [DONE]\n\n")})
	}()
	return &ex.StreamResult{Chunks: chunks}, nil
}

// Inspect only the already-parsed closed event shapes; never retain the text.
func providerTextEvent(provider, kind string, event map[string]any) bool {
	if provider == "claude" && kind == "content_block_delta" {
		delta, _ := event["delta"].(map[string]any)
		text, _ := delta["text"].(string)
		return delta["type"] == "text_delta" && text != ""
	}
	if provider == "codex" && kind == "response.output_text.delta" {
		text, _ := event["delta"].(string)
		return text != ""
	}
	return false
}

// Keep the OAuth subscription's required protocol prefix separate from the
// bot's instructions. Do not replace its prompt or synthesize native metadata.
func claudeSubscriptionSystem(value any) []any {
	const prefix = "You are Claude Code, Anthropic's official CLI for Claude."
	blocks, _ := value.([]any)
	if text, ok := value.(string); ok && text != "" {
		blocks = []any{map[string]any{"type": "text", "text": text}}
	}
	if len(blocks) > 0 && objectMap(blocks[0])["text"] == prefix {
		return blocks
	}
	return append([]any{map[string]any{"type": "text", "text": prefix}}, blocks...)
}

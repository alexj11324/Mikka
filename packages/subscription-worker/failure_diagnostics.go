package worker

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

// This private IPC record carries only a bounded provider error object. It is
// never written to stderr. Node applies the shared RunFailure policy again
// before persistence; refusal strings retain their existing recovery meaning.
type providerDiagnostic struct {
	Provider string                  `json:"provider"`
	Status   int                     `json:"status,omitempty"`
	Error    providerDiagnosticError `json:"error"`
}
type providerDiagnosticError struct {
	Type    string `json:"type"`
	Message string `json:"message,omitempty"`
}
type providerDiagnosticFailure struct {
	refusal    Refusal
	diagnostic providerDiagnostic
	cause      error
}

func (e *providerDiagnosticFailure) Error() string { return e.refusal.Error() }
func (e *providerDiagnosticFailure) Unwrap() []error {
	if e.cause != nil {
		return []error{e.refusal, e.cause}
	}
	return []error{e.refusal}
}

var diagnosticSecrets = regexp.MustCompile(`(?i)(?:bearer\s+\S+|(?:sk-|sk-ant-|ghp_|github_pat_|mka_|mkr_)[A-Za-z0-9_.-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?|https?://[^\s]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|[A-Za-z0-9_+/=-]{40,})`)
var diagnosticQuoted = regexp.MustCompile("\"[^\"]*\"|'[^']*'|`[^`]*`")

// Only these closed provider codes may replace a generic error type in the
// diagnostic. Keep them aligned with the shared TypeScript provider-code set;
// this never changes providerEventFailure or the refusal used for recovery.
func specificDiagnosticCode(code string) bool {
	switch code {
	case "context_length_exceeded", "context_window_exceeded", "max_tokens_exceeded", "prompt_too_long", "request_too_large",
		"insufficient_quota", "quota_exceeded", "usage_limit_reached", "usage_limit_exceeded", "credit_balance_too_low", "insufficient_balance",
		"billing_hard_limit", "billing_hard_limit_reached", "billing_not_active", "billing_error", "payment_required",
		"model_not_found", "model_not_available", "model_unavailable", "model_deprecated", "model_retired",
		"authentication_error", "authentication_failed", "invalid_api_key", "invalid_authentication", "unauthorized",
		"permission_error", "permission_denied", "access_denied", "forbidden",
		"resource_exhausted", "rate_limit", "rate_limit_error", "rate_limit_exceeded", "too_many_requests",
		"timeout", "timeout_error", "request_timeout", "connection_error", "network_error":
		return true
	}
	return false
}

func diagnosticType(kind string) string {
	if knownUpstreamType(kind) || specificDiagnosticCode(kind) {
		return kind
	}
	return "unknown"
}

func providerFailure(refusal Refusal, provider string, status int, body, payload []byte, secrets ...string) error {
	if provider != "codex" && provider != "claude" {
		return refusal
	}
	// Code is inspected locally only; the existing private IPC shape continues
	// carrying a single safe type and an optional redacted message.
	type sourceError struct {
		Type    string `json:"type"`
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	var parsed struct {
		Error    sourceError `json:"error"`
		Response struct {
			Error sourceError `json:"error"`
		} `json:"response"`
	}
	_ = json.Unmarshal(body, &parsed)
	message := parsed.Error.Message
	if message == "" {
		message = parsed.Response.Error.Message
	}
	kind := diagnosticType(upstreamErrorType(body))
	for _, code := range []string{parsed.Error.Code, parsed.Response.Error.Code} {
		if specificDiagnosticCode(code) {
			kind = code
			break
		}
	}
	if status < 400 || status > 599 {
		status = 0
	}
	detail := providerDiagnostic{Provider: provider, Status: status, Error: providerDiagnosticError{Type: kind, Message: redactProviderMessage(message, payload, secrets)}}
	return &providerDiagnosticFailure{refusal: refusal, diagnostic: detail}
}

func providerTransportFailure(provider, kind string, cause error) error {
	var timed interface{ Timeout() bool }
	if errors.Is(cause, context.DeadlineExceeded) || errors.As(cause, &timed) && timed.Timeout() {
		kind = "timeout_error"
	}
	return &providerDiagnosticFailure{refusal: ErrProvider, diagnostic: providerDiagnostic{Provider: provider, Error: providerDiagnosticError{Type: diagnosticType(kind)}}, cause: cause}
}

func failureDiagnostic(err error) *providerDiagnostic {
	var detail *providerDiagnosticFailure
	if errors.As(err, &detail) {
		return &detail.diagnostic
	}
	return nil
}

const diagnosticMessageBytes = 8192
const diagnosticInputBytes = 2 << 20
const diagnosticInputCount = 4096

func redactProviderMessage(message string, payload []byte, secrets []string) string {
	if message == "" || len(message) > diagnosticMessageBytes || !utf8.ValidString(message) || len(payload) > diagnosticInputBytes || len(secrets) > diagnosticInputCount {
		return ""
	}
	private := []string{}
	seen := make(map[string]struct{})
	privateBytes := 0
	addPrivate := func(value string) bool {
		if value == "" {
			return true
		}
		if _, exists := seen[value]; exists {
			return true
		}
		if !utf8.ValidString(value) || len(private) >= diagnosticInputCount || len(value) > diagnosticInputBytes-privateBytes {
			return false
		}
		seen[value] = struct{}{}
		private = append(private, value)
		privateBytes += len(value)
		return true
	}
	for _, value := range secrets {
		if !addPrivate(value) {
			return ""
		}
	}
	// All request strings are considered private (including tool descriptions).
	// An over-complex/malformed request drops the text rather than partly masking it.
	var input any
	if len(payload) > 0 && json.Unmarshal(payload, &input) != nil {
		return ""
	}
	budget := diagnosticInputCount
	var collect func(any, int) bool
	collect = func(value any, depth int) bool {
		budget--
		if budget < 0 || depth > 32 {
			return false
		}
		switch v := value.(type) {
		case string:
			return addPrivate(v)
		case []any:
			for _, child := range v {
				if !collect(child, depth+1) {
					return false
				}
			}
		case map[string]any:
			for _, child := range v {
				if !collect(child, depth+1) {
					return false
				}
			}
		}
		return true
	}
	if !collect(input, 0) {
		return ""
	}
	// Match only the original bounded response, then merge covered ranges.
	// Replacing one input must never rewrite a previous [redacted] marker or
	// break a credential/URL pattern before that pattern can be recognized.
	masked := make([]bool, len(message))
	mask := func(start, end int) {
		for i := start; i < end; i++ {
			masked[i] = true
		}
	}
	for _, value := range private {
		for start := 0; start < len(message); {
			at := strings.Index(message[start:], value)
			if at < 0 {
				break
			}
			at += start
			end := at + len(value)
			mask(at, end)
			start = end
		}
	}
	for _, pattern := range []*regexp.Regexp{diagnosticSecrets, diagnosticQuoted} {
		for _, match := range pattern.FindAllStringIndex(message, -1) {
			mask(match[0], match[1])
		}
	}
	// Providers sometimes quote only the beginning of a rejected input. A
	// prefix not already fully covered by an exact match drops the whole text.
	for _, value := range private {
		if len(value) < 12 {
			continue
		}
		for start := 0; start < len(message); {
			at := strings.Index(message[start:], value[:12])
			if at < 0 {
				break
			}
			at += start
			for i := at; i < at+12; i++ {
				if !masked[i] {
					return ""
				}
			}
			start = at + 12
		}
	}
	var safe strings.Builder
	for i := range masked {
		if masked[i] {
			if i == 0 || !masked[i-1] {
				safe.WriteString("[redacted]")
			}
		} else {
			safe.WriteByte(message[i])
		}
		if safe.Len() > diagnosticMessageBytes {
			return ""
		}
	}
	message = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, safe.String())
	message = strings.Join(strings.Fields(message), " ")
	if len(message) > 512 {
		message = message[:512]
		for !utf8.ValidString(message) {
			message = message[:len(message)-1]
		}
	}
	return message
}

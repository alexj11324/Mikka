package worker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
)

func TestProviderDiagnosticKeepsRecoveryAndRedactsBeforeIPC(t *testing.T) {
	payload := []byte(`{"messages":[{"role":"user","content":"a private customer request"}]}`)
	body := []byte(`{"error":{"type":"invalid_request_error","message":"Unsupported field. a private customer request fixture-access-token https://private.invalid/path?token=private someone@example.invalid"}}`)
	err := providerFailure(ErrRequestRejected, "claude", 400, body, payload, "fixture-access-token")
	if !errors.Is(err, ErrRequestRejected) || err.Error() != "provider_request_rejected" {
		t.Fatal("refusal policy changed")
	}
	diagnostic := failureDiagnostic(executionFailure(fmt.Errorf("private wrapper: %w", err)))
	if diagnostic == nil || diagnostic.Status != 400 || diagnostic.Error.Type != "invalid_request_error" || !strings.Contains(diagnostic.Error.Message, "Unsupported field.") {
		t.Fatalf("safe diagnostic lost: %+v", diagnostic)
	}
	encoded, _ := json.Marshal(diagnostic)
	for _, private := range []string{"private wrapper", "private customer", "fixture-access-token", "private.invalid", "someone@example"} {
		if bytes.Contains(encoded, []byte(private)) {
			t.Fatal("diagnostic leaked a private fixture value")
		}
	}
	if failureDiagnostic(executionFailure(errors.New("arbitrary executor text"))) != nil {
		t.Fatal("arbitrary error text gained export authority")
	}
}

func TestProviderDiagnosticNeverExportsBodiesOrPartialRequestEchoes(t *testing.T) {
	for _, test := range []struct {
		body, payload string
		want          string
	}{
		{`<html>private upstream failure</html>`, `{}`, ""},
		{`{"message":"outer untrusted text"}`, `{}`, ""},
		{`{"error":{"message":"private customer prefix was rejected"}}`, `{"messages":[{"content":"private customer prefix plus the rest"}]}`, ""},
		{`{"error":{"message":"valid failure"}}`, `{malformed`, ""},
		{`{"response":{"error":{"type":"rate_limit_exceeded","message":"Too many requests."}}}`, `{}`, "Too many requests."},
	} {
		diagnostic := failureDiagnostic(providerFailure(ErrProvider, "codex", 0, []byte(test.body), []byte(test.payload)))
		if diagnostic == nil || diagnostic.Error.Message != test.want {
			t.Fatalf("unexpected safe message: %+v", diagnostic)
		}
	}
}

func TestRPCPreservesSafeDiagnosticsAtBothStreamFailureBoundaries(t *testing.T) {
	w, _, issuer := fixtureWorker(t, "claude")
	initial := mustAcquire(t, w)
	failure := providerFailure(ErrRequestRejected, "claude", 400, []byte(`{"error":{"type":"invalid_request_error","message":"Unsupported field."}}`), nil)
	for _, chunk := range []bool{false, true} {
		w.Executor = refusalExecutor{fakeExecutor: fakeExecutor{issuer}, failure: failure, chunk: chunk}
		request := fmt.Sprintf("{\"id\":\"fixture\",\"method\":\"executeStream\",\"revision\":%d,\"model\":\"fixture-model\",\"payload\":{}}\n", initial.Revision)
		var out bytes.Buffer
		if err := w.Serve(context.Background(), strings.NewReader(request), &out); err != nil {
			t.Fatal(err)
		}
		var result struct {
			Error   string             `json:"error"`
			Failure providerDiagnostic `json:"providerFailure"`
		}
		if json.Unmarshal(out.Bytes(), &result) != nil || result.Error != "provider_request_rejected" || result.Failure.Status != 400 || result.Failure.Error.Message != "Unsupported field." {
			t.Fatalf("chunk=%v did not preserve safe IPC result", chunk)
		}
	}
}

func TestProviderDiagnosticRedactionNeverRewritesItsMarkers(t *testing.T) {
	inputs := make([]string, 512)
	for i := range inputs {
		inputs[i] = "e"
	}
	payload, err := json.Marshal(map[string]any{"inputs": inputs})
	if err != nil {
		t.Fatal(err)
	}
	// Each occurrence is matched in the original text once. Repeating "e"
	// must not match the two e's in every newly written [redacted] marker.
	got := redactProviderMessage("server error.", payload, nil)
	if want := "s[redacted]rv[redacted]r [redacted]rror."; got != want {
		t.Fatalf("redaction rewrote a marker: %q", got)
	}
	// Pattern recognition also sees the original input, even when a private
	// single character occurs inside a URL, email address or quoted value.
	message := "server error. https://private.invalid/e?token=fixture someone@example.invalid 'private value'"
	got = redactProviderMessage(message, payload, nil)
	if want := "s[redacted]rv[redacted]r [redacted]rror. [redacted] [redacted] [redacted]"; got != want {
		t.Fatalf("a short input interfered with pattern redaction: %q", got)
	}
}

func TestProviderDiagnosticRedactionMergesKnownInputMatches(t *testing.T) {
	payload := []byte(`{"input":["private customer request","customer","e","e"]}`)
	got := redactProviderMessage("Rejected: private customer request.", payload, nil)
	if want := "R[redacted]j[redacted]ct[redacted]d: [redacted]."; got != want {
		t.Fatalf("overlapping inputs were not masked together: %q", got)
	}
	// Duplicate private values do not consume the unique-input byte budget.
	long := strings.Repeat("s", 2048)
	if got := redactProviderMessage("No matching input.", nil, []string{long, long}); got != "No matching input." {
		t.Fatalf("safe provider wording was lost: %q", got)
	}
}

func TestProviderDiagnosticRedactionFailsClosedAtInputAndOutputBounds(t *testing.T) {
	if got := redactProviderMessage("Safe provider wording.", []byte(strings.Repeat(" ", diagnosticInputBytes+1)), nil); got != "" {
		t.Fatal("oversized request retained a partly inspected diagnostic")
	}
	if got := redactProviderMessage("Safe provider wording.", nil, []string{strings.Repeat("x", diagnosticInputBytes+1)}); got != "" {
		t.Fatal("oversized secret retained a partly inspected diagnostic")
	}
	if got := redactProviderMessage(strings.Repeat("e.", diagnosticMessageBytes/2), []byte(`{"input":"e"}`), nil); got != "" {
		t.Fatal("redaction expansion exceeded its output budget")
	}
}

func TestProviderDiagnosticKeepsSpecificCodeWhenPrivateMessageIsDropped(t *testing.T) {
	payload := []byte(`{"messages":[{"content":"private customer prefix plus the rest"}]}`)
	for _, code := range []string{"context_length_exceeded", "insufficient_quota", "model_not_found"} {
		for _, nested := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/nested=%v", code, nested), func(t *testing.T) {
				bodyValue := map[string]any{"error": map[string]any{"type": "invalid_request_error", "code": code, "message": "private customer prefix was rejected"}}
				if nested {
					bodyValue = map[string]any{"type": "response.failed", "response": bodyValue}
				}
				body, err := json.Marshal(bodyValue)
				if err != nil {
					t.Fatal(err)
				}
				// Existing refusal/retry behavior is deliberately unchanged.
				kind := upstreamErrorType(body)
				refusal := providerEventFailure(kind)
				failure := providerFailure(refusal, "codex", 400, body, payload)
				if kind != "invalid_request_error" || refusal != ErrRequestRejected || !errors.Is(failure, ErrRequestRejected) || safeCode(failure) != string(ErrRequestRejected) {
					t.Fatal("diagnostic code changed recovery behavior")
				}
				diagnostic := failureDiagnostic(failure)
				if diagnostic == nil || diagnostic.Error.Type != code || diagnostic.Error.Message != "" {
					t.Fatalf("specific cause was lost with the private message: %+v", diagnostic)
				}
				encoded, _ := json.Marshal(diagnostic)
				if bytes.Contains(encoded, []byte(`"code"`)) || bytes.Contains(encoded, []byte("private customer")) {
					t.Fatal("diagnostic expanded IPC fields or retained private text")
				}
			})
		}
	}
	unknown := providerFailure(ErrRequestRejected, "codex", 400, []byte(`{"error":{"type":"invalid_request_error","code":"fixture_private_token","message":"Unsupported field."}}`), nil)
	if diagnostic := failureDiagnostic(unknown); diagnostic == nil || diagnostic.Error.Type != "invalid_request_error" {
		t.Fatal("an unknown code gained authority over the diagnostic type")
	}
}

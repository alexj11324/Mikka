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
	"time"

	core "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	ex "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
)

func tierTestEvent(kind string, tier any, present bool) string {
	response := map[string]any{"id": "fixture-response", "model": "fixture-model", "output": []any{}, "usage": map[string]any{"input_tokens": 1, "output_tokens": 1}}
	if present {
		response["service_tier"] = tier
	}
	data, _ := json.Marshal(map[string]any{"type": kind, "response": response})
	return "data: " + string(data) + "\n\n"
}

func tierTestExecute(t *testing.T, tier any, present bool, status int, events string) (map[string]any, map[string]any, int, error) {
	t.Helper()
	payload := map[string]any{"model": "fixture-model", "messages": []any{map[string]any{"role": "system", "content": "fixture-system"}, map[string]any{"role": "user", "content": "fixture-user"}},
		"reasoning_effort": "high", "parallel_tool_calls": true, "tools": []any{map[string]any{"type": "function", "function": map[string]any{"name": "lookup", "parameters": map[string]any{"type": "object", "properties": map[string]any{}}}}}}
	if present {
		payload["service_tier"] = tier
	}
	input, _ := json.Marshal(payload)
	calls := 0
	var sent map[string]any
	model := CPAPlainModel{Provider: "codex", Client: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		calls++
		if err := json.NewDecoder(req.Body).Decode(&sent); err != nil {
			t.Fatal(err)
		}
		if req.Method != http.MethodPost || req.URL.String() != "https://chatgpt.com/backend-api/codex/responses" || req.Header.Get("User-Agent") != "Mikka/1.0" || req.Header.Get("Session-Id") != "fixture-session" || req.Header.Get("ChatGPT-Account-Id") != "fixture-account" || req.Header.Get("Originator") != "Mikka" {
			t.Fatal("request transport identity changed")
		}
		return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": []string{"text/event-stream"}}, Body: io.NopCloser(strings.NewReader(events))}, nil
	})}}
	ctx, recorder := withRequestTiming(context.WithValue(context.Background(), codexSessionKey{}, "fixture-session"))
	result, failure := model.ExecuteStream(ctx, &core.Auth{Metadata: map[string]any{"access_token": "fixture-token", "account_id": "fixture-account"}}, ex.Request{Model: "fixture-model", Payload: input}, ex.Options{})
	if failure == nil {
		for chunk := range result.Chunks {
			if chunk.Err != nil {
				failure = chunk.Err
			}
		}
	}
	var output bytes.Buffer
	if err := encodeTimingMessage(json.NewEncoder(&output), map[string]any{"id": "fixture", "result": "unchanged"}, recorder); err != nil {
		t.Fatal(err)
	}
	var frame map[string]any
	if err := json.Unmarshal(output.Bytes(), &frame); err != nil {
		t.Fatal(err)
	}
	receipt, _ := frame["serviceTier"].(map[string]any)
	return sent, receipt, calls, failure
}

func TestCodexServiceTierOnlyPriorityPassesWithoutChangingOtherRequestFields(t *testing.T) {
	events := tierTestEvent("response.completed", nil, false)
	baseline, _, _, err := tierTestExecute(t, nil, false, 200, events)
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name    string
		value   any
		present bool
		input   string
		sent    string
	}{
		{"omitted", nil, false, "omitted", "omitted"},
		{"priority", "priority", true, "priority", "priority"},
		{"official fast alias", "fast", true, "priority", "priority"},
		{"normalized official alias", " FAST ", true, "priority", "priority"},
		{"ultrafast", "ultrafast", true, "omitted", "omitted"},
		{"default", "default", true, "omitted", "omitted"},
		{"unknown", "fixture-private-tier", true, "omitted", "omitted"},
		{"object", map[string]any{"secret": "fixture-private-tier"}, true, "omitted", "omitted"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			sent, receipt, calls, err := tierTestExecute(t, tc.value, tc.present, 200, events)
			if err != nil || calls != 1 {
				t.Fatalf("request failure/retry: %v %d", err, calls)
			}
			if tc.sent == "priority" {
				if sent["service_tier"] != "priority" {
					t.Fatal("priority was lost")
				}
			} else if _, ok := sent["service_tier"]; ok {
				t.Fatal("unsupported tier reached upstream")
			}
			delete(sent, "service_tier")
			if !reflect.DeepEqual(sent, baseline) {
				t.Fatal("tier selection changed model/effort/input/tools/store/stream")
			}
			expected := map[string]any{"version": float64(1), "inputRequested": tc.input, "requested": tc.sent, "created": "missing", "completed": "missing", "incomplete": "missing"}
			if !reflect.DeepEqual(receipt, expected) {
				t.Fatalf("receipt mismatch: %#v", receipt)
			}
		})
	}
}

func TestCodexServiceTierRecordsNativeEventValuesWithoutInferringPriority(t *testing.T) {
	cases := []struct{ name, events, created, completed, incomplete string }{
		{"mismatch", tierTestEvent("response.created", "auto", true) + tierTestEvent("response.completed", "default", true), "auto", "default", "missing"},
		{"priority", tierTestEvent("response.created", "priority", true) + tierTestEvent("response.completed", "priority", true), "priority", "priority", "missing"},
		{"incomplete", tierTestEvent("response.created", "default", true) + tierTestEvent("response.incomplete", "flex", true), "default", "missing", "flex"},
		{"missing", tierTestEvent("response.created", nil, false) + tierTestEvent("response.completed", nil, false), "missing", "missing", "missing"},
		{"private", tierTestEvent("response.created", "fixture-private-tier", true) + tierTestEvent("response.completed", map[string]any{"secret": "fixture-private-tier"}, true), "unrecognized", "unrecognized", "missing"},
		{"null", tierTestEvent("response.completed", nil, true), "missing", "unrecognized", "missing"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, receipt, calls, err := tierTestExecute(t, "priority", true, 200, tc.events)
			if err != nil || calls != 1 {
				t.Fatalf("failure/retry: %v %d", err, calls)
			}
			if receipt["created"] != tc.created || receipt["completed"] != tc.completed || receipt["incomplete"] != tc.incomplete || receipt["requested"] != "priority" {
				t.Fatalf("native tiers lost or inferred: %#v", receipt)
			}
			raw, _ := json.Marshal(receipt)
			if strings.Contains(string(raw), "fixture-private") {
				t.Fatal("private provider tier leaked")
			}
		})
	}
}

func TestCodexServiceTierRefusalsAndStreamErrorsKeepOneHTTPRequest(t *testing.T) {
	errorBody, _ := json.Marshal(map[string]any{"type": "error", "error": map[string]any{"type": "rate_limit_error", "message": "fixture-private-provider"}})
	cases := []struct {
		name   string
		status int
		body   string
		want   string
	}{
		{"rejected", 400, string(errorBody), "provider_request_rejected"},
		{"quota", 429, string(errorBody), "subscription_rate_limited"},
		{"stream error", 200, "data: " + string(errorBody) + "\n\n", "subscription_rate_limited"},
		{"no completed", 200, tierTestEvent("response.created", "priority", true), "provider_operation_failed"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, receipt, calls, err := tierTestExecute(t, "priority", true, tc.status, tc.body)
			if err == nil || err.Error() != tc.want || calls != 1 {
				t.Fatalf("failure contract changed: %v %d", err, calls)
			}
			if receipt["requested"] != "priority" || receipt["completed"] != "missing" || receipt["incomplete"] != "missing" {
				t.Fatalf("failure invented a terminal tier: %#v", receipt)
			}
		})
	}
}

type tierCancellationBody struct {
	ctx     context.Context
	initial *strings.Reader
	waiting chan struct{}
}

func (b *tierCancellationBody) Read(p []byte) (int, error) {
	n, err := b.initial.Read(p)
	if n > 0 || err != io.EOF {
		return n, err
	}
	close(b.waiting) // the preceding native created event has been consumed
	<-b.ctx.Done()
	return 0, b.ctx.Err()
}
func (b *tierCancellationBody) Close() error { return nil }

func TestCodexServiceTierCancellationKeepsCreatedWithoutInventingCompletion(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	ctx, recorder := withRequestTiming(ctx)
	body := &tierCancellationBody{ctx: ctx, initial: strings.NewReader(tierTestEvent("response.created", "priority", true)), waiting: make(chan struct{})}
	calls := 0
	model := CPAPlainModel{Provider: "codex", Client: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		calls++
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"text/event-stream"}}, Body: body}, nil
	})}}
	result, err := model.ExecuteStream(ctx, &core.Auth{Metadata: map[string]any{"access_token": "fixture-token", "account_id": "fixture-account"}},
		ex.Request{Model: "fixture-model", Payload: []byte(`{"messages":[{"role":"user","content":"fixture"}],"service_tier":"priority"}`)}, ex.Options{})
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() {
		for range result.Chunks {
		}
		close(done)
	}()
	select {
	case <-body.waiting:
	case <-ctx.Done():
		t.Fatal("native created event was not consumed")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("cancelled reader did not exit")
	}
	var output bytes.Buffer
	if err := encodeTimingMessage(json.NewEncoder(&output), map[string]any{"id": "fixture", "error": "cancelled"}, recorder); err != nil {
		t.Fatal(err)
	}
	var frame struct {
		ServiceTier serviceTierReceipt `json:"serviceTier"`
	}
	if err := json.Unmarshal(output.Bytes(), &frame); err != nil {
		t.Fatal(err)
	}
	if calls != 1 || frame.ServiceTier.Requested != "priority" || frame.ServiceTier.Created != "priority" || frame.ServiceTier.Completed != "missing" || frame.ServiceTier.Incomplete != "missing" {
		t.Fatalf("cancellation retried or invented a tier: %d %#v", calls, frame.ServiceTier)
	}
}

func TestCodexServiceTierTerminalBudgetPreservesOriginalResultAndTiming(t *testing.T) {
	ctx, recorder := withRequestTiming(context.Background())
	beginCodexServiceTier(ctx, "priority")
	recordCodexRequestedTier(ctx, "priority")
	requestHTTPTrace(ctx, time.Now())
	old := map[string]any{"id": "fixture", "result": "", "timing": recorder.snapshot(), "transportTiming": recorder.transportSnapshot()}
	encoded, err := json.Marshal(old)
	if err != nil {
		t.Fatal(err)
	}
	// Keep the original result, timing and HTTP receipt just inside the cap.
	// The separate tier receipt does not fit and must be dropped on its own.
	message := map[string]any{"id": "fixture", "result": strings.Repeat("x", timingTerminalMaxBytes-len(encoded)-64)}
	var output bytes.Buffer
	if err := encodeTimingMessage(json.NewEncoder(&output), message, recorder); err != nil {
		t.Fatal(err)
	}
	var frame map[string]any
	if err := json.Unmarshal(output.Bytes(), &frame); err != nil {
		t.Fatal(err)
	}
	if frame["result"] != message["result"] || frame["timing"] == nil || frame["transportTiming"] == nil || frame["serviceTier"] != nil || output.Len() > timingTerminalMaxBytes+1 {
		t.Fatal("optional tier receipt displaced the original result/timing or exceeded the existing line budget")
	}
}

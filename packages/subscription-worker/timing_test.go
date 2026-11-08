package worker

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	core "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	ex "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
)

func TestWorkerTimingSnapshotIsPerRequestAndSurvivesCancellation(t *testing.T) {
	parent, cancel := context.WithCancel(WithStartupTiming(context.Background(), time.Now(), 3*time.Millisecond))
	ctx, first := withRequestTiming(parent)
	var pending sync.WaitGroup
	for n := 0; n < 20; n++ {
		pending.Add(1)
		go func() {
			defer pending.Done()
			done := timingSpan(ctx, timingRead)
			done()
			done()
		}()
	}
	pending.Wait()
	cancel()
	old := first.snapshot()
	if old["readCalls"] != float64(20) || old["dbInitMs"] != float64(3) {
		t.Fatalf("unexpected observed counts/startup: %v", old)
	}
	timingSpan(ctx, timingRead)()
	if old["readCalls"] != float64(20) {
		t.Fatal("an emitted snapshot changed after a later observation")
	}
	_, second := withRequestTiming(parent)
	if fresh := second.snapshot(); fresh["readCalls"] != float64(0) || fresh["readMs"] != nil || fresh["dbInitMs"] != float64(3) {
		t.Fatalf("a later request inherited another request's phases: %v", fresh)
	}
}

func TestWorkerTimingTerminalKeepsOneOriginalFrameAndBudget(t *testing.T) {
	for _, large := range []bool{false, true} {
		_, timing := withRequestTiming(context.Background())
		result := "unchanged"
		if large {
			result = strings.Repeat("x", 262144-100)
		}
		var output bytes.Buffer
		if err := encodeTimingMessage(json.NewEncoder(&output), map[string]any{"id": "fixture", "result": result}, timing); err != nil {
			t.Fatal(err)
		}
		decoder := json.NewDecoder(&output)
		var message map[string]any
		if err := decoder.Decode(&message); err != nil || message["result"] != result || message["id"] != "fixture" {
			t.Fatal("timing changed the original result")
		}
		if _, present := message["timing"]; present == large {
			t.Fatal("optional timing did not respect the original terminal budget")
		}
		if decoder.Decode(new(any)) != io.EOF {
			t.Fatal("timing created an extra IPC frame")
		}
	}
	_, timing := withRequestTiming(context.Background())
	timing.values[timingAuthorize], timing.observed[timingAuthorize] = math.NaN(), true
	var output bytes.Buffer
	if encodeTimingMessage(json.NewEncoder(&output), map[string]any{"id": "fixture", "error": "account_unavailable"}, timing) != nil {
		t.Fatal("an unusable observation changed the original refusal")
	}
	if strings.Contains(output.String(), "NaN") || !strings.Contains(output.String(), "account_unavailable") {
		t.Fatal("invalid timing reached the wire or replaced the refusal")
	}
	if encodeTimingMessage(json.NewEncoder(io.Discard), map[string]any{"result": make(chan int)}, timing) == nil {
		t.Fatal("diagnostics swallowed the original encoder failure")
	}
}

func TestWorkerTimingServePreservesUnsupportedAndInvalidRequests(t *testing.T) {
	w := &Worker{ExecutionOnly: true}
	input := "{\"id\":\"first\",\"method\":\"status\"}\n{\"id\":\"second\",\"method\":\"unknown\"}\n{\"id\":\"invalid\",\"method\":\"status\",\"private\":\"fixture-private\"}\n{\"id\":\"prepared\",\"method\":\"prepare\"}\n{\"id\":\"stream-prepared\",\"method\":\"prepareStream\"}\n"
	var output bytes.Buffer
	if err := w.Serve(context.Background(), strings.NewReader(input), &output); err != nil {
		t.Fatal(err)
	}
	decoder := json.NewDecoder(&output)
	for n, id := range []string{"first", "second", "", "prepared", "stream-prepared"} {
		var message map[string]any
		if decoder.Decode(&message) != nil || message["id"] != id || message["error"] != string(ErrUnsupported) {
			t.Fatal("the original unsupported/invalid refusal changed")
		}
		timing, present := message["timing"].(map[string]any)
		if present != (n >= 3) || (present && (timing["readCalls"] != float64(0) || timing["readyAuthMs"] != nil)) {
			t.Fatal("only the model RPC refusal may carry numeric timing")
		}
	}
	if decoder.Decode(new(any)) != io.EOF {
		t.Fatal("extra terminal frame")
	}
}

func TestWorkerTimingProviderTextUsesOnlyKnownNonemptyTextEvents(t *testing.T) {
	for _, sample := range []struct {
		provider string
		kind     string
		event    map[string]any
		want     bool
	}{
		{"claude", "content_block_delta", map[string]any{"delta": map[string]any{"type": "text_delta", "text": "yes"}}, true},
		{"claude", "content_block_delta", map[string]any{"delta": map[string]any{"type": "text_delta", "text": ""}}, false},
		{"claude", "content_block_delta", map[string]any{"delta": map[string]any{"type": "thinking_delta", "text": "not text"}}, false},
		{"codex", "response.output_text.delta", map[string]any{"delta": "yes"}, true},
		{"codex", "response.output_text.delta", map[string]any{"delta": ""}, false},
		{"codex", "response.function_call_arguments.delta", map[string]any{"delta": "{}"}, false},
		{"codex", "unknown", map[string]any{"delta": "not text"}, false},
	} {
		if providerTextEvent(sample.provider, sample.kind, sample.event) != sample.want {
			t.Fatalf("unexpected text classification for %s/%s", sample.provider, sample.kind)
		}
	}
}

func TestPlainModelTimingUsesExistingTransportAndKeepsRequestAndRefusal(t *testing.T) {
	for _, provider := range []string{"claude", "codex"} {
		var originalBody []byte
		var originalHeaders http.Header
		for _, timed := range []bool{false, true} {
			calls := 0
			model := CPAPlainModel{Provider: provider, Client: &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
				calls++
				if request.Header.Get("Authorization") != "Bearer fixture-private-token" {
					t.Fatal("observation changed authorization")
				}
				body, err := io.ReadAll(request.Body)
				if err != nil {
					t.Fatal(err)
				}
				if !timed {
					originalBody, originalHeaders = body, request.Header.Clone()
				} else if !bytes.Equal(body, originalBody) || !reflect.DeepEqual(request.Header, originalHeaders) {
					t.Fatal("observation changed the original body or headers")
				}
				return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"text/event-stream"}}, Body: io.NopCloser(strings.NewReader("data: {\"type\":\"error\",\"error\":{\"type\":\"authentication_error\",\"message\":\"fixture-private-body\"}}\n\n"))}, nil
			})}}
			ctx := context.Background()
			var timing *timingRecorder
			if timed {
				ctx, timing = withRequestTiming(ctx)
			}
			auth := &core.Auth{Metadata: map[string]any{"access_token": "fixture-private-token", "account_id": "fixture-account"}}
			result, err := model.ExecuteStream(ctx, auth, ex.Request{Model: "fixture-model", Payload: []byte(`{"messages":[{"role":"user","content":"fixture-private-prompt"}]}`)}, ex.Options{})
			if err != nil {
				t.Fatal(err)
			}
			chunks := 0
			for chunk := range result.Chunks {
				chunks++
				if chunk.Err == nil || chunk.Err.Error() != "reconnect_required" {
					t.Fatal("timing changed the original streamed refusal")
				}
			}
			if calls != 1 || chunks != 1 {
				t.Fatal("timing added a request or changed stream frames")
			}
			if timed {
				snapshot := timing.snapshot()
				if snapshot["conversionMs"] == nil || snapshot["httpHeadersMs"] == nil || snapshot["httpFirstEventMs"] == nil || snapshot["httpFirstTextEventMs"] != nil {
					t.Fatal("event timings did not preserve missing text")
				}
				encoded, _ := json.Marshal(snapshot)
				if bytes.Contains(encoded, []byte("fixture-private")) {
					t.Fatal("timing retained private input")
				}
			}
		}
	}
}

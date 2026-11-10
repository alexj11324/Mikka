package worker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httptrace"
	"net/url"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	core "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	ex "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
)

func TestHTTPTransportConcurrentHooksAreFirstOffsetsNotSummedDurations(t *testing.T) {
	start := time.Unix(0, 0)
	var ticks atomic.Int64
	r := newHTTPTransportTiming(start, func() time.Time { return start.Add(time.Duration(ticks.Add(1)) * time.Millisecond) })
	trace := r.trace()
	trace.GetConn("fixture-private-host")
	trace.DNSStart(httptrace.DNSStartInfo{Host: "fixture-private-dns"})
	trace.DNSDone(httptrace.DNSDoneInfo{Err: errors.New("fixture-private-error")})
	var done sync.WaitGroup
	for n := 0; n < 20; n++ {
		done.Add(1)
		go func() {
			defer done.Done()
			trace.ConnectStart("fixture-private-network", "fixture-private-address")
			trace.ConnectDone("fixture-private-network", "fixture-private-address", errors.New("fixture-private-error"))
		}()
	}
	done.Wait()
	trace.GotConn(httptrace.GotConnInfo{Reused: true})
	trace.WroteRequest(httptrace.WroteRequestInfo{})
	trace.WroteRequest(httptrace.WroteRequestInfo{Err: errors.New("fixture-private-error")})
	trace.GotFirstResponseByte()
	value := r.snapshot()
	if value["connectCalls"] != 20 || value["writeCalls"] != 2 || value["dnsCalls"] != 1 {
		t.Fatal("repeated hooks disappeared")
	}
	if value["connectDoneMs"].(float64) < value["connectStartMs"].(float64) || value["connectStartMs"].(float64) != 4 {
		t.Fatal("offsets were summed or overwritten")
	}
	if value["dnsFailed"] != true || value["connectFailed"] != true || value["writeFailed"] != false || value["reused"] != true {
		t.Fatal("first-hook flags changed")
	}
	if _, ok := value["tlsStartMs"]; ok {
		t.Fatal("missing handshake became zero")
	}
	trace.ConnectStart("late-private", "late-private")
	trace.GotFirstResponseByte()
	if !reflect.DeepEqual(value, r.snapshot()) {
		t.Fatal("late callbacks changed terminal snapshot")
	}
	raw, _ := json.Marshal(value)
	if bytes.Contains(raw, []byte("fixture-private")) || bytes.Contains(raw, []byte("late-private")) {
		t.Fatal("a hook argument reached the receipt")
	}
}

func TestHTTPTransportOptionalBudgetNeverDisplacesLegacyTiming(t *testing.T) {
	ctx, timing := withRequestTiming(context.Background())
	trace := requestHTTPTrace(ctx, time.Now())
	trace.GetConn("fixture-private-host")
	trace.GotConn(httptrace.GotConnInfo{})
	legacy := timing.snapshot()
	base := map[string]any{"id": "fixture", "result": "", "timing": legacy}
	encoded, _ := json.Marshal(base)
	// Leave enough for the legacy duration's numeric formatting, not the new row.
	padding := strings.Repeat("x", timingTerminalMaxBytes-len(encoded)-20)
	var output bytes.Buffer
	if encodeTimingMessage(json.NewEncoder(&output), map[string]any{"id": "fixture", "result": padding}, timing) != nil {
		t.Fatal("observation rejected an original result")
	}
	var frame map[string]any
	decoder := json.NewDecoder(&output)
	if decoder.Decode(&frame) != nil || frame["result"] != padding || frame["timing"] == nil {
		t.Fatal("new receipt displaced the legacy frame")
	}
	if frame["transportTiming"] != nil {
		t.Fatal("new optional row exceeded the original budget")
	}
	if decoder.Decode(new(any)) != io.EOF {
		t.Fatal("unexpected extra IPC frame")
	}
}

func TestHTTPTransportPreservesRefusedRedirectAndParentDeadline(t *testing.T) {
	var calls, redirects atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		http.Redirect(w, r, "/fixture-private-redirect", http.StatusFound)
	}))
	defer server.Close()
	target, _ := url.Parse(server.URL)
	base := server.Client().Transport
	parent, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	want, _ := parent.Deadline()
	ctx, timing := withRequestTiming(parent)
	model := CPAPlainModel{Provider: "claude", Client: &http.Client{Timeout: time.Millisecond, CheckRedirect: func(*http.Request, []*http.Request) error { redirects.Add(1); return nil }, Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		deadline, ok := request.Context().Deadline()
		if !ok || !deadline.Equal(want) {
			t.Error("original context deadline was replaced")
		}
		copy := request.Clone(request.Context())
		copy.URL.Scheme, copy.URL.Host = target.Scheme, target.Host
		copy.Host = target.Host
		return base.RoundTrip(copy)
	})}}
	_, err := model.ExecuteStream(ctx, &core.Auth{Metadata: map[string]any{"access_token": "fixture-private-token"}}, ex.Request{Model: "fixture-model", Payload: []byte(`{"messages":[]}`)}, ex.Options{})
	if err == nil || calls.Load() != 1 || redirects.Load() != 0 {
		t.Fatal("observation changed redirect/timeout behavior")
	}
	if timing.transportSnapshot()["firstByteMs"] == nil {
		t.Fatal("refusal transport was not measured")
	}
}

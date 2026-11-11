package worker

import (
	"context"
	"crypto/tls"
	"math"
	"net/http/httptrace"
	"sync"
	"time"
)

// Offsets share the original client.Do clock. They are first observations, not
// additive phases: Happy Eyeballs and Transport retries can overlap. Counts
// expose repeated hooks without retaining addresses, connections or errors.
var transportOffsets = []string{"getConnMs", "gotConnMs", "dnsStartMs", "dnsDoneMs", "connectStartMs", "connectDoneMs", "tlsStartMs", "tlsDoneMs", "wroteRequestMs", "firstByteMs", "headersMs"}
var transportCounts = []string{"getConnCalls", "dnsCalls", "connectCalls", "tlsCalls", "writeCalls"}
var transportFlags = []string{"reused", "dnsFailed", "connectFailed", "tlsFailed", "writeFailed"}

type httpTransportTiming struct {
	mu      sync.Mutex
	started time.Time
	now     func() time.Time
	values  map[string]any
	frozen  bool
}

func newHTTPTransportTiming(started time.Time, now func() time.Time) *httpTransportTiming {
	r := &httpTransportTiming{started: started, now: now, values: make(map[string]any)}
	for _, name := range transportCounts {
		r.values[name] = 0
	}
	return r
}

func (r *httpTransportTiming) point(name, count, flag string, value bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.frozen {
		return
	}
	if count != "" {
		r.values[count] = r.values[count].(int) + 1
	}
	if _, seen := r.values[name]; seen {
		return
	}
	ms := float64(r.now().Sub(r.started)) / float64(time.Millisecond)
	if ms < 0 || math.IsNaN(ms) || math.IsInf(ms, 0) || ms > 3_600_000 {
		return
	}
	r.values[name] = math.Round(ms*1_000) / 1_000
	if flag != "" {
		r.values[flag] = value
	}
}

func (r *httpTransportTiming) trace() *httptrace.ClientTrace {
	return &httptrace.ClientTrace{
		GetConn:           func(string) { r.point("getConnMs", "getConnCalls", "", false) },
		GotConn:           func(info httptrace.GotConnInfo) { r.point("gotConnMs", "", "reused", info.Reused) },
		DNSStart:          func(httptrace.DNSStartInfo) { r.point("dnsStartMs", "dnsCalls", "", false) },
		DNSDone:           func(info httptrace.DNSDoneInfo) { r.point("dnsDoneMs", "", "dnsFailed", info.Err != nil) },
		ConnectStart:      func(string, string) { r.point("connectStartMs", "connectCalls", "", false) },
		ConnectDone:       func(_, _ string, err error) { r.point("connectDoneMs", "", "connectFailed", err != nil) },
		TLSHandshakeStart: func() { r.point("tlsStartMs", "tlsCalls", "", false) },
		TLSHandshakeDone:  func(_ tls.ConnectionState, err error) { r.point("tlsDoneMs", "", "tlsFailed", err != nil) },
		WroteRequest: func(info httptrace.WroteRequestInfo) {
			r.point("wroteRequestMs", "writeCalls", "writeFailed", info.Err != nil)
		},
		// This is the first response-header byte, not an SSE event or text.
		GotFirstResponseByte: func() { r.point("firstByteMs", "", "", false) },
	}
}

func (r *httpTransportTiming) snapshot() map[string]any {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.frozen = true // late Dial/Transport callbacks cannot mutate a terminal receipt
	out := map[string]any{"version": 1}
	for _, names := range [][]string{transportOffsets, transportCounts, transportFlags} {
		for _, name := range names {
			if value, ok := r.values[name]; ok {
				out[name] = value
			}
		}
	}
	return out
}

func requestHTTPTrace(ctx context.Context, started time.Time) *httptrace.ClientTrace {
	timing := timingFrom(ctx)
	if timing == nil {
		return nil
	}
	r := newHTTPTransportTiming(started, time.Now)
	timing.mu.Lock()
	timing.transport = r
	timing.mu.Unlock()
	return r.trace()
}

// Called only when Do returned a response; the legacy failed-Do timing is unchanged.
func recordHTTPHeaders(ctx context.Context) {
	if timing := timingFrom(ctx); timing != nil {
		timing.mu.Lock()
		trace := timing.transport
		timing.mu.Unlock()
		if trace != nil {
			trace.point("headersMs", "", "", false)
		}
	}
}

func (r *timingRecorder) transportSnapshot() map[string]any {
	r.mu.Lock()
	trace := r.transport
	values, observed := r.values, r.observed
	r.mu.Unlock()
	if trace == nil {
		return nil
	}
	out := trace.snapshot()
	for _, entry := range []struct {
		key  timingMetric
		name string
	}{
		{timingHTTPFirstEvent, "firstEventMs"}, {timingHTTPFirstTextEvent, "firstTextMs"},
	} {
		value := values[entry.key]
		if observed[entry.key] && value >= 0 && value <= 3_600_000 && !math.IsNaN(value) && !math.IsInf(value, 0) {
			out[entry.name] = math.Round(value*1_000) / 1_000
		}
	}
	return out
}

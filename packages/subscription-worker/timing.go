package worker

import (
	"context"
	"encoding/json"
	"math"
	"sync"
	"time"
)

// The legacy timing projection uses fixed numeric slots. A recorder never retains scope,
// credentials, requests, response bodies or errors.
type timingMetric int

const (
	timingConfigToServe timingMetric = iota
	timingDBInit
	timingRPCBody
	timingAuthorize
	timingPrepareRecord
	timingMigrationCalls
	timingMigration
	timingReadyAuth
	timingRefreshCalls
	timingRefresh
	timingCleanup
	timingStatus
	timingReadCalls
	timingRead
	timingCreateCalls
	timingCreate
	timingDeleteCalls
	timingDelete
	timingConversion
	timingExecutorOpen
	timingHTTPHeaders
	timingHTTPFirstEvent
	timingHTTPFirstTextEvent
	timingFirstConvertedChunk
	timingFirstChunkGuard
	timingFirstEmit
	timingMetricCount
)

var timingNames = [timingMetricCount]string{
	"configToServeMs", "dbInitMs", "rpcBodyMs", "authorizeMs", "prepareRecordMs",
	"migrationCalls", "migrationMs", "readyAuthMs", "refreshCalls", "refreshMs",
	"cleanupMs", "statusMs", "readCalls", "readMs", "createCalls", "createMs",
	"deleteCalls", "deleteMs", "conversionMs", "executorOpenMs", "httpHeadersMs",
	"httpFirstEventMs", "httpFirstTextEventMs", "firstConvertedChunkMs", "firstChunkGuardMs", "firstEmitMs",
}

type timingKey struct{}
type startupTimingKey struct{}
type startupTiming struct{ configToServe, dbInit float64 }
type timingRecorder struct {
	mu          sync.Mutex
	started     time.Time
	values      [timingMetricCount]float64
	observed    [timingMetricCount]bool
	backend     string
	transport   *httpTransportTiming
	serviceTier *serviceTierReceipt
}

// Called only by the private entry point after its original initialization.
// Failure before Serve keeps the existing stderr/exit behavior and no report.
func WithStartupTiming(ctx context.Context, configStarted time.Time, dbInit time.Duration) context.Context {
	return context.WithValue(ctx, startupTimingKey{}, startupTiming{float64(time.Since(configStarted)) / float64(time.Millisecond), float64(dbInit) / float64(time.Millisecond)})
}

func withRequestTiming(ctx context.Context) (context.Context, *timingRecorder) {
	r := &timingRecorder{started: time.Now()}
	if startup, ok := ctx.Value(startupTimingKey{}).(startupTiming); ok {
		r.values[timingConfigToServe], r.observed[timingConfigToServe] = startup.configToServe, true
		r.values[timingDBInit], r.observed[timingDBInit] = startup.dbInit, true
	}
	// The complete request is observed; zero calls is distinct from a missing
	// duration for a stage which was never entered.
	for _, key := range []timingMetric{timingMigrationCalls, timingRefreshCalls, timingReadCalls, timingCreateCalls, timingDeleteCalls} {
		r.observed[key] = true
	}
	return context.WithValue(ctx, timingKey{}, r), r
}

func timingFrom(ctx context.Context) *timingRecorder {
	r, _ := ctx.Value(timingKey{}).(*timingRecorder)
	return r
}

func timingSpan(ctx context.Context, key timingMetric) func() {
	r := timingFrom(ctx)
	if r == nil {
		return func() {}
	}
	started := time.Now()
	r.mu.Lock()
	switch key {
	case timingMigration, timingRefresh, timingRead, timingCreate, timingDelete:
		r.values[key-1]++
		r.observed[key-1] = true
	}
	r.mu.Unlock()
	done := false
	return func() {
		r.mu.Lock()
		if !done {
			done = true
			r.values[key] += float64(time.Since(started)) / float64(time.Millisecond)
			r.observed[key] = true
		}
		r.mu.Unlock()
	}
}

func timingOnceSince(ctx context.Context, key timingMetric, started time.Time) {
	if r := timingFrom(ctx); r != nil {
		r.mu.Lock()
		if !r.observed[key] {
			r.values[key], r.observed[key] = float64(time.Since(started))/float64(time.Millisecond), true
		}
		r.mu.Unlock()
	}
}

func recordFirstEmit(ctx context.Context) {
	if r := timingFrom(ctx); r != nil {
		timingOnceSince(ctx, timingFirstEmit, r.started)
	}
}

func timingBackend(ctx context.Context, backend string) {
	if backend != "vault" && backend != "snapshot" {
		return
	}
	if r := timingFrom(ctx); r != nil {
		r.mu.Lock()
		if r.backend == "" {
			r.backend = backend
		} else if r.backend != backend {
			r.backend = "unobserved"
		}
		r.mu.Unlock()
	}
}

func (r *timingRecorder) snapshot() map[string]any {
	r.mu.Lock()
	r.values[timingRPCBody], r.observed[timingRPCBody] = float64(time.Since(r.started))/float64(time.Millisecond), true
	values, observed, backend := r.values, r.observed, r.backend
	r.mu.Unlock()
	// Copy fixed scalars under the lock; never encode or perform I/O there.
	out := map[string]any{"version": 1}
	for key, name := range timingNames {
		value := values[key]
		if observed[key] && value >= 0 && !math.IsNaN(value) && !math.IsInf(value, 0) {
			out[name] = value
		}
	}
	if backend == "vault" || backend == "snapshot" || backend == "unobserved" {
		out["accessReadBackend"] = backend
	}
	return out
}

// The Node response-line budget is smaller than the Go legacy request budget.
const timingTerminalMaxBytes = 262144

func encodeTimingMessage(encoder *json.Encoder, message map[string]any, timing *timingRecorder) error {
	if timing != nil {
		message["timing"] = timing.snapshot()
		// Preserve the parent's original 262144-character line limit. Counting
		// UTF-8 bytes is conservative. A diagnostic never rejects a valid result.
		encoded, err := json.Marshal(message)
		if err != nil || len(encoded) > timingTerminalMaxBytes {
			delete(message, "timing")
		}
		// Preserve the original timing inclusion decision. The new optional
		// diagnostic is dropped on its own if it would exceed the same IPC cap.
		if transport := timing.transportSnapshot(); transport != nil {
			message["transportTiming"] = transport
			encoded, err := json.Marshal(message)
			if err != nil || len(encoded) > timingTerminalMaxBytes {
				delete(message, "transportTiming")
			}
		}
		// This receipt has its own budget decision; never displace old timing.
		if serviceTier := timing.serviceTierSnapshot(); serviceTier != nil {
			message["serviceTier"] = serviceTier
			encoded, err := json.Marshal(message)
			if err != nil || len(encoded) > timingTerminalMaxBytes {
				delete(message, "serviceTier")
			}
		}
	}
	return encoder.Encode(message)
}

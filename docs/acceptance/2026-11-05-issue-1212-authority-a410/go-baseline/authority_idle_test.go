package worker

import (
	"context"
	"encoding/json"
	"net/http"
	"sync/atomic"
	"testing"
	"time"

	core "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	exec "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
)

// The provider boundary is silent; authorization, credential custody and its
// committed revocation use the real worker and real isolated PostgreSQL.
type silentAuthorityExecutor struct {
	fakeExecutor
	entered   chan struct{}
	cancelled chan time.Time
}

func (s silentAuthorityExecutor) ExecuteStream(ctx context.Context, _ *core.Auth, _ exec.Request, _ exec.Options) (*exec.StreamResult, error) {
	close(s.entered)
	go func() { <-ctx.Done(); s.cancelled <- time.Now() }()
	return &exec.StreamResult{Chunks: make(chan exec.StreamChunk)}, nil
}

func TestIdleAuthorityProviderCancellationDeadline(t *testing.T) {
	for _, route := range []string{"claude-native", "codex-native", "claude-cpa"} {
		t.Run(route, func(t *testing.T) {
			provider := "claude"
			if route == "codex-native" {
				provider = "codex"
			}
			w, _, issuer := fixtureWorker(t, provider)
			initial := mustAcquire(t, w)
			entered := make(chan struct{})
			cancelled := make(chan time.Time, 1)
			finished := make(chan error, 1)
			var emitted atomic.Int32
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if route == "claude-cpa" {
				w.Executor = silentAuthorityExecutor{fakeExecutor{issuer}, entered, cancelled}
				go func() {
					finished <- w.Stream(ctx, initial.Revision, "fixture-model", []byte(`{"prompt":"isolated silent fixture"}`), func([]byte) error { emitted.Add(1); return nil })
				}()
			} else {
				bindingRoute, path := "claude_code_cli", "/v1/messages"
				if provider == "codex" {
					bindingRoute, path = "codex_cli", "/responses"
				}
				bindNativeRunFixture(t, w, initial.Revision, bindingRoute)
				w.NativeClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
					close(entered)
					<-r.Context().Done()
					cancelled <- time.Now()
					return nil, r.Context().Err()
				})}
				go func() {
					finished <- w.NativeStream(ctx, initial.Revision, NativeRequest{Path: path, Body: json.RawMessage(`{"model":"fixture-model","stream":true}`)}, func(string) error { return nil }, func([]byte) error { emitted.Add(1); return nil })
				}()
			}
			select {
			case <-entered:
			case err := <-finished:
				t.Fatalf("provider was not reached: %v", err)
			case <-time.After(3 * time.Second):
				t.Fatal("silent provider not entered")
			}
			started := time.Now()
			if _, err := w.Disconnect(context.Background(), initial.Revision); err != nil {
				t.Fatal(err)
			}
			committed := time.Now()
			var at time.Time
			select {
			case at = <-cancelled:
			case <-time.After(time.Second):
				t.Logf("authority_idle_provider route=%s committed=true emitted=%d commitMs=%.3f deadlineMs=1000 contextCancelled=false", route, emitted.Load(), float64(committed.Sub(started))/float64(time.Millisecond))
				t.Fatal("silent provider context survived the one-second committed revocation deadline")
			}
			elapsed := at.Sub(committed)
			t.Logf("authority_idle_provider route=%s committed=true emitted=%d commitMs=%.3f contextCancelAfterCommitMs=%.3f deadlineMs=1000", route, emitted.Load(), float64(committed.Sub(started))/float64(time.Millisecond), float64(elapsed)/float64(time.Millisecond))
			if emitted.Load() != 0 || elapsed > time.Second {
				t.Fatal("idle revocation deadline exceeded")
			}
			if err := <-finished; err == nil {
				t.Fatal("revoked stream returned success")
			}
		})
	}
}

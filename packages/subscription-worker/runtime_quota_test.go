package worker

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"testing"
	"time"
)

func TestRuntimeQuotaAvailabilityUsesTheActualModel(t *testing.T) {
	now := time.Date(2026, 11, 2, 19, 0, 0, 0, time.UTC)
	for _, item := range []struct {
		name, model, scope string
		account, scoped    float64
		stale, allowed     bool
	}{
		{"haiku with opus exhausted", "claude-haiku-5-5", "Opus", .2, 1, false, true},
		{"sonnet with opus exhausted", "claude-sonnet-5-5", "Opus", .2, 1, false, true},
		{"opus exhausted", "claude-opus-5-5", "Opus", .2, 1, false, false},
		{"account exhausted", "claude-haiku-5-5", "Opus", 1, .2, false, false},
		{"unknown exhausted scope", "claude-haiku-5-5", "Scoped 2", .2, 1, false, false},
		{"unknown native model", "", "Opus", .2, 1, false, false},
		{"stale quota", "claude-haiku-5-5", "Opus", .2, .2, true, false},
	} {
		t.Run(item.name, func(t *testing.T) {
			observed := now
			if item.stale {
				observed = observed.Add(-61 * time.Second)
			}
			raw, _ := json.Marshal(map[string]any{"vendor": "claude_code", "status": "ok", "observedAt": observed.Format(time.RFC3339Nano), "windows": []map[string]any{{"used": item.account}, {"model": item.scope, "used": item.scoped}}})
			if got := runtimeQuotaAvailable(raw, "claude", item.model, now); got != item.allowed {
				t.Fatalf("available=%v want=%v", got, item.allowed)
			}
		})
	}
	for _, item := range []struct{ raw, want string }{
		{"Claude Opus 4.6", "claude-opus-4-6"},
		{"gpt-5.4-codex", "gpt-5-4-codex"},
		{"Bearer fixture-secret", "Scoped"},
		{"gpt-fixture-secret", "Scoped"},
	} {
		if got := safeQuotaModel(item.raw, "Scoped"); got != item.want {
			t.Errorf("scope projection=%q want=%q", got, item.want)
		}
	}
}

func TestRuntimeAuthorizationKeepsOtherModelQuotaIndependent(t *testing.T) {
	w, _, _ := fixtureWorker(t, "claude")
	initial := mustAcquire(t, w)
	bindFixture(t, w, initial.Revision, "claude_cpa")
	for _, model := range []string{"claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"} {
		if _, err := w.Repo.DB.Exec(`update byos_bindings set "modelId"=$2 where id=$1`, w.Use.BindingID, model); err != nil {
			t.Fatal(err)
		}
		raw, _ := json.Marshal(map[string]any{"vendor": "claude_code", "status": "ok", "observedAt": time.Now().UTC().Format(time.RFC3339Nano), "windows": []map[string]any{{"used": .2}, {"model": "Opus", "used": 1}}})
		if _, err := w.Repo.DB.Exec(`update byos_connections set quota=$2 where id=$1`, w.Scope.ConnectionID, raw); err != nil {
			t.Fatal(err)
		}
		err := w.authorizeRuntime(context.Background(), initial.Revision, "model", model)
		if (err == nil) != (model != "claude-opus-5-5") {
			t.Fatalf("model=%s error=%v", model, err)
		}
	}
}

func TestQuotaProjectionPreservesRecognizedModelScope(t *testing.T) {
	for _, provider := range []string{"claude", "codex"} {
		t.Run(provider, func(t *testing.T) {
			w, _, _ := fixtureWorker(t, provider)
			initial := mustAcquire(t, w)
			w.QuotaClient = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
				body := map[string]any{"five_hour": map[string]any{"utilization": 20}, "limits": []any{map[string]any{"kind": "weekly_scoped", "utilization": 100, "scope": map[string]any{"model": map[string]any{"display_name": "Claude Opus 4.6"}}}}}
				if provider == "codex" {
					body = map[string]any{"additional_rate_limits": []any{map[string]any{"limit_name": "gpt-5.4-codex", "rate_limit": map[string]any{"primary_window": map[string]any{"used_percent": 100, "limit_window_seconds": 18000}}}}}
				}
				raw, _ := json.Marshal(body)
				return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(raw)), Header: make(http.Header)}, nil
			})}
			result, err := w.Quota(context.Background(), initial.Revision)
			if err != nil {
				t.Fatal(err)
			}
			raw, _ := json.Marshal(result)
			scope := "claude-opus-4-6"
			if provider == "codex" {
				scope = "gpt-5-4-codex"
			}
			if !bytes.Contains(raw, []byte(scope)) || !bytes.Contains(raw, []byte("100")) {
				t.Fatal("model scope or exhausted allowance was dropped")
			}
		})
	}
}

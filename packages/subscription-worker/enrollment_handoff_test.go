package worker

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestEnrollmentHandoffBindsFullCeremonyAndRetainsGlobalCredentials(t *testing.T) {
	e, o, a, claims, grants := enrollmentFixture()
	e.RetainSources = true
	ctx := context.Background()
	start, err := e.Start(ctx, "operator:fixture-principal")
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := a.Read(ctx, "mikka-byos-"+start.ID)
	if strings.Contains(string(raw), start.HandoffKey) || len(start.HandoffKey) != 43 {
		t.Fatal("capability was persisted in plaintext")
	}
	var saved enrollmentAttempt
	_ = json.Unmarshal(raw, &saved)
	attempts := []struct{ id, provider, key, callback string }{
		{newID(), "claude", start.HandoffKey, enrollmentCallback(start)},
		{start.ID, "codex", start.HandoffKey, enrollmentCallback(start)},
		{start.ID, "claude", "", enrollmentCallback(start)},
		{start.ID, "claude", randomCode(), enrollmentCallback(start)},
		{start.ID, "claude", start.HandoffKey, enrollmentCallback(start) + "&state=x"},
		{start.ID, "claude", start.HandoffKey, strings.Replace(enrollmentCallback(start), "localhost:54545", "evil.example", 1)},
	}
	for _, x := range attempts {
		if _, err = e.Handoff(ctx, x.id, x.provider, x.key, x.callback); err == nil {
			t.Fatal("substituted ceremony accepted")
		}
	}
	for _, field := range []string{"principal", "state", "verifier", "provider", "expiry"} {
		changed := saved
		switch field {
		case "principal":
			changed.Principal = "operator:another-owner"
		case "state":
			changed.State = randomCode()
		case "verifier":
			changed.Verifier = randomCode()
		case "provider":
			changed.Provider = "codex"
		case "expiry":
			changed.ExpiresAt = changed.ExpiresAt.Add(time.Minute)
		}
		bad, _ := json.Marshal(changed)
		a.values["mikka-byos-"+start.ID] = bad
		if _, err = e.Handoff(ctx, start.ID, "claude", start.HandoffKey, enrollmentCallback(start)); err == nil {
			t.Fatal("stored ownership/PKCE binding bypass", field)
		}
	}
	a.values["mikka-byos-"+start.ID] = raw
	e.Now = func() time.Time { return saved.ExpiresAt }
	if _, err = e.Handoff(ctx, start.ID, "claude", start.HandoffKey, enrollmentCallback(start)); err == nil {
		t.Fatal("expired capability accepted")
	}
	e.Now = nil
	if o.calls.Load() != 0 || len(claims.values) != 0 {
		t.Fatal("rejected handoff consumed claim or reached provider")
	}
	// A new process needs only protected attempts, not the current global operator key.
	restarted := Enrollment{Attempts: a, Claims: claims, Grants: grants, OAuth: o, RetainSources: true}
	result, err := restarted.Handoff(ctx, start.ID, "claude", start.HandoffKey, enrollmentCallback(start))
	if err != nil || result.State != "pending_unbound" || result.TaskUseAllowed || o.calls.Load() != 1 || a.deletes != 0 {
		t.Fatal("scoped restart/retention failed", err)
	}
	public, _ := json.Marshal(result)
	if strings.Contains(string(public), start.HandoffKey) || strings.Contains(string(public), "token") {
		t.Fatal("completion leaked credentials")
	}
	if _, err = restarted.Handoff(ctx, start.ID, "claude", start.HandoffKey, enrollmentCallback(start)); err == nil || o.calls.Load() != 1 {
		t.Fatal("scoped replay repeated exchange")
	}
}
func TestEnrollmentHandoffAndLegacyCompletionShareOneUseLatch(t *testing.T) {
	e, o, _, _, _ := enrollmentFixture()
	ctx := context.Background()
	start, err := e.Start(ctx, "operator:fixture-principal")
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	var passed atomic.Int32
	for n := range 12 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var err error
			if n%2 == 0 {
				_, err = e.Handoff(ctx, start.ID, "claude", start.HandoffKey, enrollmentCallback(start))
			} else {
				_, err = e.Complete(ctx, "operator:fixture-principal", start.ID, enrollmentCallback(start))
			}
			if err == nil {
				passed.Add(1)
			}
		}()
	}
	wg.Wait()
	if o.calls.Load() != 1 || passed.Load() != 1 {
		t.Fatal("parallel entry points exchanged twice")
	}
}
func TestEnrollmentHandoffRefusesLegacyAttemptsWithoutWeakeningLegacyOperator(t *testing.T) {
	e, o, a, _, _ := enrollmentFixture()
	ctx := context.Background()
	start, err := e.Start(ctx, "operator:fixture-principal")
	if err != nil {
		t.Fatal(err)
	}
	var old enrollmentAttempt
	_ = json.Unmarshal(a.values["mikka-byos-"+start.ID], &old)
	old.Provider = ""
	old.HandoffDigest = ""
	raw, _ := json.Marshal(old)
	a.values["mikka-byos-"+start.ID] = raw
	if _, err = e.Handoff(ctx, start.ID, "claude", start.HandoffKey, enrollmentCallback(start)); err == nil || o.calls.Load() != 0 {
		t.Fatal("unscoped legacy attempt accepted")
	}
	if _, err = e.Complete(ctx, "operator:fixture-principal", start.ID, enrollmentCallback(start)); err != nil || o.calls.Load() != 1 {
		t.Fatal("legacy completion regressed", err)
	}
}
func TestEnrollmentHandoffUncertainClaimNeverRetriesProvider(t *testing.T) {
	e, o, _, claims, _ := enrollmentFixture()
	ctx := context.Background()
	start, err := e.Start(ctx, "operator:fixture-principal")
	if err != nil {
		t.Fatal(err)
	}
	claims.commitThenFail = true
	if _, err = e.Handoff(ctx, start.ID, "claude", start.HandoffKey, enrollmentCallback(start)); err == nil || o.calls.Load() != 0 {
		t.Fatal("uncertain claim allowed exchange")
	}
	claims.commitThenFail = false
	if _, err = e.Complete(ctx, "operator:fixture-principal", start.ID, enrollmentCallback(start)); err == nil || o.calls.Load() != 0 {
		t.Fatal("other entry point bypassed consumed claim")
	}
}

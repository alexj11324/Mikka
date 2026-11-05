package worker

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	core "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

type resumableDevice struct {
	starts           atomic.Int32
	entered, release chan struct{}
}

func (*resumableDevice) Authorize(string, string) (string, error) { return "", ErrUnsupported }
func (*resumableDevice) Exchange(context.Context, string, string, string) (*core.Auth, error) {
	return nil, ErrUnsupported
}
func (d *resumableDevice) BeginDevice(ctx context.Context) (DeviceAttempt, error) {
	d.starts.Add(1)
	if d.entered != nil {
		close(d.entered)
		select {
		case <-d.release:
		case <-ctx.Done():
			return DeviceAttempt{}, ctx.Err()
		}
	}
	return DeviceAttempt{DeviceAuthID: "private-resume-device", UserCode: "ABCD-EFGH", Interval: 5}, nil
}
func (*resumableDevice) PollDevice(context.Context, DeviceAttempt) (*DeviceGrant, error) {
	return nil, nil
}

func TestOAuthResumePreservesAttemptWithoutProviderRestartAndRejectsOtherScopes(t *testing.T) {
	for _, provider := range []string{"codex", "claude"} {
		t.Run(provider, func(t *testing.T) {
			w, inf, _ := fixtureWorker(t, provider)
			device := &resumableDevice{}
			if provider == "codex" {
				w.OAuth = device
			} else {
				w.OAuth = CPAClaudeOAuth{}
			}
			ctx := context.Background()
			start, err := w.StartOAuth(ctx, 1, "resume-session")
			if err != nil {
				t.Fatal(err)
			}
			// A fresh worker models page close/reopen and a separate HTTP request.
			fresh := *w
			resumed, err := fresh.ResumeOAuth(ctx, "resume-session")
			if err != nil || !reflect.DeepEqual(start, resumed) {
				t.Fatal("resume changed authorization attempt", err)
			}
			duplicate, err := fresh.StartOAuth(ctx, 1, "resume-session")
			if err != nil || !reflect.DeepEqual(start, duplicate) {
				t.Fatal("duplicate start replaced existing attempt", err)
			}
			if provider == "codex" && device.starts.Load() != 1 {
				t.Fatal("resume contacted provider again")
			}
			if _, err := fresh.ResumeOAuth(ctx, "another-session"); err != ErrStale {
				t.Fatal("other session resumed attempt", err)
			}
			for _, alter := range []func(*Scope){func(s *Scope) { s.OwnerID = "another-owner" }, func(s *Scope) { s.WorkspaceID = "another-workspace" }, func(s *Scope) { s.ConnectionID = newID() }} {
				other := fresh
				alter(&other.Scope)
				if _, err := other.ResumeOAuth(ctx, "resume-session"); err != ErrStale {
					t.Fatal("other scope resumed attempt", err)
				}
			}
			var raw, name string
			if err := w.Repo.DB.QueryRow(`select row_to_json(a)::text,"secretName" from byos_oauth_attempts a where "stateHash"=$1`, hashText(start.State)).Scan(&raw, &name); err != nil {
				t.Fatal(err)
			}
			for _, private := range []string{start.State, start.AuthorizationURL, "private-resume-device", "resume-session"} {
				if strings.Contains(raw, private) {
					t.Fatal("recovery data entered SQL metadata")
				}
			}
			// Legacy starts and another session remain explicitly restartable.
			inf.mu.Lock()
			var legacy oauthSecret
			_ = json.Unmarshal(inf.values[name], &legacy)
			legacy.Start = nil
			inf.values[name], _ = json.Marshal(legacy)
			inf.mu.Unlock()
			if _, err := fresh.ResumeOAuth(ctx, "resume-session"); err != ErrReauthenticate {
				t.Fatal("legacy data reconstructed unsafely", err)
			}
			disconnected, err := fresh.Disconnect(ctx, start.Revision)
			if err != nil {
				t.Fatal(err)
			}
			var consumed bool
			if err := w.Repo.DB.QueryRow(`select "consumedAt" is not null from byos_oauth_attempts where "stateHash"=$1`, hashText(start.State)).Scan(&consumed); err != nil || !consumed {
				t.Fatal("cancel did not invalidate attempt", err)
			}
			if _, err := fresh.ResumeOAuth(ctx, "resume-session"); err != ErrStale {
				t.Fatal("cancelled attempt resumed", err)
			}
			if provider == "claude" {
				if _, err := fresh.CompleteHandoff(ctx, "resume-session", start.State, claudeCallbackURI+"?code=unused&state="+start.State); err != ErrStale {
					t.Fatal("cancelled callback reached provider", err)
				}
			}
			next, err := fresh.StartOAuth(ctx, disconnected.Revision, "another-session")
			if err != nil || next.State == start.State || next.Revision <= start.Revision {
				t.Fatal("explicit reconnect did not start a fresh attempt", err)
			}
			if _, err := w.Repo.DB.Exec(`update byos_connections set "operationDeadline"=now()-interval '1 second' where id=$1`, w.Scope.ConnectionID); err != nil {
				t.Fatal(err)
			}
			if _, err := fresh.ResumeOAuth(ctx, "another-session"); err != ErrStale {
				t.Fatal("expired operation resumed", err)
			}
		})
	}
}

func TestConcurrentOAuthStartReturnsBusyUntilSingleProviderStartCanBeResumed(t *testing.T) {
	w, _, _ := fixtureWorker(t, "codex")
	device := &resumableDevice{entered: make(chan struct{}), release: make(chan struct{})}
	w.OAuth = device
	type outcome struct {
		start OAuthStart
		err   error
	}
	finished := make(chan outcome, 1)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	go func() { start, err := w.StartOAuth(ctx, 1, "session"); finished <- outcome{start, err} }()
	select {
	case <-device.entered:
	case <-ctx.Done():
		t.Fatal("first provider start not reached")
	}
	if _, err := w.StartOAuth(ctx, 1, "session"); err != ErrBusy {
		t.Fatal("overlapping start did not preserve pending operation", err)
	}
	if device.starts.Load() != 1 {
		t.Fatal("concurrent provider start")
	}
	close(device.release)
	first := <-finished
	if first.err != nil {
		t.Fatal(first.err)
	}
	resumed, err := w.ResumeOAuth(ctx, "session")
	if err != nil || !reflect.DeepEqual(first.start, resumed) {
		t.Fatal("in-flight start was lost after completion", err)
	}
}

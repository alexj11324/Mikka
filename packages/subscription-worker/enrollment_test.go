package worker

import (
	"context"
	"encoding/json"
	core "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	compat "github.com/router-for-me/CLIProxyAPI/v8/sdk/mikkaadapter"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestEnrollmentActualPlainClaudeAdapterWithoutSQL(t *testing.T) {
	e, _, _, _, _ := enrollmentFixture()
	var calls atomic.Int32
	e.OAuth = CPAClaudeOAuth{Client: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		calls.Add(1)
		if r.URL.String() != "https://platform.claude.com/v1/oauth/token" || r.Header.Get("User-Agent") != "Mikka/1.0" {
			t.Error("unexpected endpoint or identity")
		}
		var body map[string]string
		if json.NewDecoder(r.Body).Decode(&body) != nil || body["redirect_uri"] != claudeCallbackURI || len(body["code_verifier"]) != 43 || body["code"] != "fixture-code" {
			t.Error("OAuth request changed")
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"access_token":"fixture-plain-access","refresh_token":"fixture-plain-refresh","expires_in":3600,"account":{"uuid":"fixture-account","email_address":"fixture@example.invalid"},"organization":{"uuid":"fixture-org","name":"Fixture"}}`))}, nil
	})}}
	start, err := e.Start(context.Background(), "operator:fixture-principal")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = e.Handoff(context.Background(), start.ID, "claude", start.HandoffKey, enrollmentCallback(start)); err != nil || calls.Load() != 1 {
		t.Fatal("plain acquisition failed", err)
	}
}

type enrollmentMemory struct {
	mu                               sync.Mutex
	values                           map[string][]byte
	writes, reads, deletes           int
	fail, commitThenFail, deleteFail bool
	uncertainBeforeCommit            int
}

func (s *enrollmentMemory) Create(_ context.Context, name string, raw []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.writes++
	if s.uncertainBeforeCommit > 0 {
		s.uncertainBeforeCommit--
		return ErrCreateUncertain
	}
	if s.fail {
		return ErrStore
	}
	if _, ok := s.values[name]; ok {
		return ErrStore
	}
	if err := retainFixtureValue(name, raw); err != nil {
		return err
	}
	s.values[name] = append([]byte{}, raw...)
	if s.commitThenFail {
		return ErrCreateUncertain
	}
	return nil
}
func (s *enrollmentMemory) Read(_ context.Context, name string) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.reads++
	v, ok := s.values[name]
	if !ok {
		return nil, ErrMissing
	}
	return append([]byte{}, v...), nil
}
func (s *enrollmentMemory) Delete(_ context.Context, name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.deletes++
	if s.deleteFail {
		return ErrStore
	}
	if err := retainFixtureValue(name, s.values[name]); err != nil {
		return err
	}
	delete(s.values, name)
	return nil
}

type enrollmentOAuth struct {
	calls atomic.Int32
	fail  bool
}

func (o *enrollmentOAuth) Authorize(state, verifier string) (string, error) {
	return (CPAClaudeOAuth{}).Authorize(state, verifier)
}
func (o *enrollmentOAuth) Exchange(_ context.Context, code, state, verifier string) (*core.Auth, error) {
	o.calls.Add(1)
	if o.fail || code != "fixture-code" || !validState(state) || len(verifier) != 43 {
		return nil, ErrProvider
	}
	return &core.Auth{Provider: "claude", Storage: &compat.ClaudeTokenStorage{Type: "claude", AccessToken: "fixture-enrollment-access", RefreshToken: "fixture-enrollment-refresh", AccountUUID: "fixture-account", OrganizationUUID: "fixture-org", Email: "fixture@example.invalid", Expire: time.Now().Add(time.Hour).UTC().Format(time.RFC3339)}}, nil
}
func enrollmentFixture() (*Enrollment, *enrollmentOAuth, *enrollmentMemory, *enrollmentMemory, *enrollmentMemory) {
	a, c, g := &enrollmentMemory{values: map[string][]byte{}}, &enrollmentMemory{values: map[string][]byte{}}, &enrollmentMemory{values: map[string][]byte{}}
	o := &enrollmentOAuth{}
	return &Enrollment{Attempts: a, Claims: c, Grants: g, OAuth: o}, o, a, c, g
}
func enrollmentCallback(start EnrollmentStart) string {
	u, _ := url.Parse(start.AuthorizationURL)
	return claudeCallbackURI + "?code=fixture-code&state=" + u.Query().Get("state")
}
func TestEnrollmentPersistsStateAndFullCPAStorageWithoutDatabaseOrExecution(t *testing.T) {
	e, o, a, c, g := enrollmentFixture()
	ctx := context.Background()
	principal := "operator:fixture-principal"
	start, err := e.Start(ctx, principal)
	if err != nil || start.TaskUseAllowed || len(a.values) != 1 {
		t.Fatal("start not durably staged", err)
	}
	// A new process/service instance can finish using only vault state.
	restarted := Enrollment{Attempts: a, Claims: c, Grants: g, OAuth: o}
	result, err := restarted.Complete(ctx, principal, start.ID, enrollmentCallback(start))
	if err != nil || result.State != "pending_unbound" || result.TaskUseAllowed {
		t.Fatal("custody failed", err)
	}
	if len(a.values) != 0 || len(c.values) != 2 || len(g.values) != 1 || o.calls.Load() != 1 {
		t.Fatal("lifecycle incorrect")
	}
	var stored enrollmentGrant
	for _, raw := range g.values {
		if json.Unmarshal(raw, &stored) != nil {
			t.Fatal("invalid storage")
		}
		scope := Scope{OwnerID: "fixture-owner", WorkspaceID: "fixture-workspace", ConnectionID: start.ID, Provider: "claude"}
		if _, err := decodeBundle(scope, raw, hashText(string(raw))); err != ErrIntegrity {
			t.Fatal("unbound grant became execution credentials")
		}
		if _, err := decodeAccessBundle(scope, raw, hashText(string(raw))); err != ErrIntegrity {
			t.Fatal("unbound grant became access projection")
		}
	}
	if stored.Payload["refresh_token"] != "fixture-enrollment-refresh" || stored.Payload["access_token"] != "fixture-enrollment-access" || stored.Payload["account_uuid"] != "fixture-account" {
		t.Fatal("CPA Storage lost")
	}
	public, _ := json.Marshal(result)
	if strings.Contains(string(public), "fixture-") || strings.Contains(string(public), "token") {
		t.Fatal("public result leaked credentials")
	}
	if _, err = e.Complete(ctx, principal, start.ID, enrollmentCallback(start)); err == nil || o.calls.Load() != 1 {
		t.Fatal("replayed exchange")
	}
	if _, err = e.Status(ctx, principal, start.ID); err != nil {
		t.Fatal("durable grant cannot be rediscovered")
	}
	before := g.reads
	if _, err = e.Status(ctx, "operator:another-principal", start.ID); err == nil || g.reads != before {
		t.Fatal("foreign principal read grant")
	}
}
func TestEnrollmentRefusesMalformedForeignExpiredAndConcurrentCallbacks(t *testing.T) {
	e, o, _, _, _ := enrollmentFixture()
	ctx := context.Background()
	principal := "operator:fixture-principal"
	start, err := e.Start(ctx, principal)
	if err != nil {
		t.Fatal(err)
	}
	callback := enrollmentCallback(start)
	for _, bad := range []string{callback + "&state=x", callback + "#x", strings.Replace(callback, "localhost:54545", "mikka.example", 1), strings.Replace(callback, "/callback?", "/%63allback?", 1), claudeCallbackURI + "?code=fixture-code&state=" + strings.Repeat("x", 43)} {
		if _, err = e.Complete(ctx, principal, start.ID, bad); err == nil {
			t.Fatal("malformed callback accepted")
		}
	}
	if _, err = e.Complete(ctx, "operator:another-principal", start.ID, callback); err == nil || o.calls.Load() != 0 {
		t.Fatal("foreign principal exchanged")
	}
	var wg sync.WaitGroup
	var passed atomic.Int32
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := e.Complete(ctx, principal, start.ID, callback); err == nil {
				passed.Add(1)
			}
		}()
	}
	wg.Wait()
	if passed.Load() != 1 || o.calls.Load() != 1 {
		t.Fatal("one-use claim failed")
	}
	next, _ := e.Start(ctx, principal)
	e.Now = func() time.Time { return time.Now().Add(6 * time.Minute) }
	if _, err = e.Complete(ctx, principal, next.ID, enrollmentCallback(next)); err == nil || o.calls.Load() != 1 {
		t.Fatal("expired callback exchanged")
	}
}
func TestEnrollmentPersistenceFailuresNeverRepeatConsumedCode(t *testing.T) {
	for _, uncertain := range []bool{false, true} {
		t.Run(map[bool]string{false: "failed", true: "uncertain_committed"}[uncertain], func(t *testing.T) {
			e, o, a, _, g := enrollmentFixture()
			ctx := context.Background()
			principal := "operator:fixture-principal"
			a.fail = true
			if _, err := e.Start(ctx, principal); err == nil || o.calls.Load() != 0 {
				t.Fatal("released unstored PKCE")
			}
			a.fail = false
			start, _ := e.Start(ctx, principal)
			g.fail = !uncertain
			g.commitThenFail = uncertain
			_, err := e.Complete(ctx, principal, start.ID, enrollmentCallback(start))
			if uncertain && err != nil {
				t.Fatal("committed create not recovered")
			}
			if !uncertain && err == nil {
				t.Fatal("failed publication claimed success")
			}
			state, statusErr := e.Status(ctx, principal, start.ID)
			if statusErr != nil || (!uncertain && state.State != "custody_unconfirmed") {
				t.Fatal("publication outcome hidden", statusErr)
			}
			if _, err = e.Complete(ctx, principal, start.ID, enrollmentCallback(start)); err == nil || o.calls.Load() != 1 {
				t.Fatal("consumed code retried")
			}
		})
	}
}

func TestEnrollmentRetriesOnlyCapturedUncertainWriteAndFencesUncertainClaim(t *testing.T) {
	e, o, _, c, g := enrollmentFixture()
	ctx := context.Background()
	principal := "operator:fixture-principal"
	start, _ := e.Start(ctx, principal)
	g.uncertainBeforeCommit = 1
	if _, err := e.Complete(ctx, principal, start.ID, enrollmentCallback(start)); err != nil || o.calls.Load() != 1 || g.writes != 2 {
		t.Fatal("captured publication was not recovered", err)
	}
	next, _ := e.Start(ctx, principal)
	c.commitThenFail = true
	if _, err := e.Complete(ctx, principal, next.ID, enrollmentCallback(next)); err == nil || o.calls.Load() != 1 {
		t.Fatal("uncertain claim exchanged code")
	}
	if _, err := e.Complete(ctx, principal, next.ID, enrollmentCallback(next)); err == nil || o.calls.Load() != 1 {
		t.Fatal("uncertain claim replayed")
	}
}

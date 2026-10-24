package worker

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	osexec "os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	core "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

func TestExpiredAccessRefreshesOnceAndTasksReuseConnection(t *testing.T) {
	for _, provider := range []string{"codex", "claude"} {
		t.Run(provider, func(t *testing.T) {
			w, _, issuer := fixtureWorker(t, provider)
			issuer.expiredAcquire.Store(true)
			initial := mustAcquire(t, w)
			for task := 0; task < 2; task++ {
				if _, err := w.Execute(context.Background(), initial.Revision, "fixture-model", nil); err != nil {
					t.Fatal(err)
				}
			}
			current, err := w.Status(context.Background())
			if err != nil || current.Revision != initial.Revision || current.CredentialVersion != 2 {
				t.Fatal("automatic refresh changed account binding")
			}
			if issuer.acquires.Load() != 1 || issuer.refreshes.Load() != 1 || issuer.executions.Load() != 2 {
				t.Fatal("task reuse repeated login/refresh or skipped inference")
			}
		})
	}
}

func TestClaudeNativeAccessLeaseReusesCPARotationAuthority(t *testing.T) {
	w, _, issuer := fixtureWorker(t, "claude")
	issuer.expiredAcquire.Store(true)
	initial := mustAcquire(t, w)
	for task := 0; task < 2; task++ {
		lease, err := w.ClaudeNativeAuth(context.Background(), initial.Revision)
		if err != nil || lease.AccessToken == "" || lease.AccountID == "" || !lease.ExpiresAt.After(time.Now()) {
			t.Fatal("native lease unavailable", err)
		}
		raw, _ := json.Marshal(lease)
		if strings.Contains(string(raw), "refresh") || strings.Contains(string(raw), "id_token") || strings.Contains(fmt.Sprint(lease), lease.AccessToken) {
			t.Fatal("native lease exposed refresh material or diagnostics")
		}
	}
	if issuer.acquires.Load() != 1 || issuer.refreshes.Load() != 1 {
		t.Fatal("native starts repeated login or independently rotated grant")
	}
	if _, err := w.Disconnect(context.Background(), initial.Revision); err != nil {
		t.Fatal(err)
	}
	if _, err := w.ClaudeNativeAuth(context.Background(), initial.Revision); err != ErrUnavailable {
		t.Fatal("disconnected native lease available")
	}
}

func TestDisconnectDuringRefreshRejectsItsLatePublication(t *testing.T) {
	w, _, issuer := fixtureWorker(t, "claude")
	initial := mustAcquire(t, w)
	ctx := context.Background()
	issuer.refreshEntered = make(chan struct{})
	issuer.refreshRelease = make(chan struct{})
	var release sync.Once
	t.Cleanup(func() { release.Do(func() { close(issuer.refreshRelease) }) })
	finished := make(chan error, 1)
	go func() { _, err := w.Refresh(ctx, initial.Revision); finished <- err }()
	select {
	case <-issuer.refreshEntered:
	case <-time.After(10 * time.Second):
		t.Fatal("refresh did not start")
	}
	if _, err := w.Disconnect(ctx, initial.Revision); err != nil {
		t.Fatal(err)
	}
	release.Do(func() { close(issuer.refreshRelease) })
	if err := <-finished; err == nil {
		t.Fatal("disconnected grant was republished")
	}
	if _, err := w.Execute(ctx, initial.Revision, "fixture-model", nil); err != ErrUnavailable {
		t.Fatal("disconnected account remained usable")
	}
}

func TestExpiredLeaseCannotReplayRotatingGrant(t *testing.T) {
	w, _, issuer := fixtureWorker(t, "codex")
	initial := mustAcquire(t, w)
	ctx := context.Background()
	operation, err := w.Repo.ClaimRefresh(ctx, w.Scope, initial.Revision, 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = w.Repo.DB.Exec(`update byos_connections set "operationDeadline"=now()-interval '1 second' where id=$1`, w.Scope.ConnectionID); err != nil {
		t.Fatal(err)
	}
	if _, err = w.Refresh(ctx, initial.Revision); err == nil {
		t.Fatal("expired lease allowed a new refresh authority")
	}
	if _, err = w.store(&operation).List(ctx); err != ErrStale {
		t.Fatal("expired lease loaded a rotating grant")
	}
	if issuer.refreshes.Load() != 0 {
		t.Fatal("expired operation repeated provider refresh")
	}
}

func TestInfisicalRedirectAndIntegrityFailuresDoNotPublish(t *testing.T) {
	var forwarded atomic.Int32
	other := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { forwarded.Add(1); w.WriteHeader(200) }))
	defer other.Close()
	redirect := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL, http.StatusTemporaryRedirect)
	}))
	defer redirect.Close()
	store, err := NewInfisical(InfisicalConfig{Origin: redirect.URL, ProjectID: "fixture-project", Environment: "test", Path: "/byos-cpa", Token: func(context.Context) (string, error) { return "fixture-workload-token", nil }, Client: redirect.Client()})
	if err != nil {
		t.Fatal(err)
	}
	if err = store.Create(context.Background(), "mikka-byos-"+newID(), []byte("synthetic")); err != ErrStore {
		t.Fatal("redirect was not refused")
	}
	if forwarded.Load() != 0 {
		t.Fatal("workload token was forwarded to redirected origin")
	}
	w, inf, _ := fixtureWorker(t, "codex")
	initial := mustAcquire(t, w)
	record, _ := w.Repo.Lookup(context.Background(), w.Scope)
	inf.mu.Lock()
	inf.values[record.SecretName] = []byte(`{"schema":1,"ownerId":"bob"}`)
	inf.mu.Unlock()
	if _, err = w.Execute(context.Background(), initial.Revision, "fixture-model", nil); err != ErrIntegrity {
		t.Fatal("tampered/cross-owner bundle was used")
	}
}

func TestStoreCannotChangeConnectionScopeOrRunImportedHelpers(t *testing.T) {
	w, _, _ := fixtureWorker(t, "codex")
	ctx := context.Background()
	operation, err := w.Repo.BeginAcquire(ctx, w.Scope, 1)
	if err != nil {
		t.Fatal(err)
	}
	a := actualStorageAuth(w.Scope, fixturePayload("codex", "0"))
	a.ID = newID()
	if _, err = w.store(&operation).Save(ctx, a); err != ErrCredential {
		t.Fatal("CPA account ID was accepted outside fixed scope")
	}
	called := false
	a = &core.Auth{ID: w.Scope.ConnectionID, Provider: "codex", Storage: hostileStorage{&called}, Metadata: fixturePayload("codex", "0")}
	if _, err = w.store(&operation).Save(ctx, a); err != ErrCredential || called {
		t.Fatal("imported storage helper executed")
	}
}

func TestWorkerExecutableHasPrivateScopeAndNoLiveRegistry(t *testing.T) {
	binary := os.Getenv("MIKKA_BYOS_WORKER_BINARY")
	if binary == "" {
		t.Fatal("build worker first and set MIKKA_BYOS_WORKER_BINARY for process acceptance")
	}
	w, inf, _ := fixtureWorker(t, "codex")
	initial := mustAcquire(t, w)
	config := map[string]any{"scope": w.Scope, "databaseUrl": os.Getenv("MIKKA_BYOS_TEST_DATABASE_URL"), "infisicalOrigin": inf.server.URL, "project": "fixture-project", "environment": "test", "path": "/byos-cpa", "workloadToken": "fixture-workload-token"}
	var input bytes.Buffer
	encoder := json.NewEncoder(&input)
	_ = encoder.Encode(config)
	_ = encoder.Encode(map[string]any{"id": "status", "method": "status"})
	_ = encoder.Encode(map[string]any{"id": "live", "method": "acquire", "revision": initial.Revision})
	_ = encoder.Encode(map[string]any{"id": "override", "method": "status", "ownerId": "bob"})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	command := osexec.CommandContext(ctx, binary)
	command.Env = []string{"PATH=" + os.Getenv("PATH"), "LANG=C.UTF-8"}
	command.Stdin = &input
	var output, diagnostics bytes.Buffer
	command.Stdout = &output
	command.Stderr = &diagnostics
	if command.Run() != nil {
		t.Fatal("private worker process failed", diagnostics.String())
	}
	if !strings.Contains(output.String(), "provider_route_unavailable") || !strings.Contains(output.String(), "connected") {
		t.Fatal("worker did not retain owner scope or gate its live registry")
	}
	for _, secret := range []string{"fixture-workload-token", "fixture-codex-access", "fixture-codex-refresh", "mikka_cpa_test_only", "access_token", "secretName"} {
		if strings.Contains(output.String()+diagnostics.String(), secret) {
			t.Fatal("private process emitted credential material")
		}
	}
}

func TestPrivateFramingRejectsTrailingObjectsAndOversizedFrames(t *testing.T) {
	w, _, _ := fixtureWorker(t, "claude")
	var out bytes.Buffer
	if err := w.Serve(context.Background(), strings.NewReader("{\"id\":\"1\",\"method\":\"status\"}{\"ownerId\":\"bob\"}\n"), &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "provider_route_unavailable") {
		t.Fatal("trailing object accepted")
	}
	if err := w.Serve(context.Background(), strings.NewReader(strings.Repeat("x", 131073)+"\n"), &out); err != ErrUnsupported {
		t.Fatal("oversized frame accepted")
	}
}

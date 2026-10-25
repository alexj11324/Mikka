//go:build application_integration

// Requires the application checkout and Node runtime, not the worker-only Go image.
package worker

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Real Go broker, retained PG rows and loopback TLS fixtures. No provider account,
// fake native CLI, existing cleanup helpers, or deletion of synthetic records.
func TestDaemonCredentialRevokeCancelsSilentNativeStream(t *testing.T) {
	db := testDB(t)
	scope := fixtureScope("claude")
	repo := &Repository{DB: db}
	if err := repo.Create(context.Background(), scope); err != nil {
		t.Fatal(err)
	}
	_, secrets := newFakeInfisical(t)
	issuer := newFakeProvider(t, "claude")
	w := &Worker{Repo: repo, Secrets: secrets, AccessSecrets: secrets, AllowNativeAuth: true, Scope: scope, Authenticator: fakeAuthenticator{issuer}, Executor: fakeExecutor{issuer}}
	initial := mustAcquire(t, w)
	bindFixture(t, w, initial.Revision, "claude_code_cli")
	agent, device, run, credential := newID(), newID(), newID(), newID()
	hash := sha256.Sum256([]byte(newID()))
	statements := []struct {
		query string
		args  []any
	}{
		{`INSERT INTO device_tokens(id,"userId","tokenHash") VALUES($1,$2,$3)`, []any{credential, scope.OwnerID, hex.EncodeToString(hash[:])}},
		{`INSERT INTO devices(id,"ownerId",name) VALUES($1,$2,'retained daemon fixture')`, []any{device, scope.OwnerID}},
		{`INSERT INTO agents(id,"userId",harness,name,"deviceId") VALUES($1,$2,'claude_code',$3,$4)`, []any{agent, scope.OwnerID, "daemon-revoke-" + agent, device}},
		{`INSERT INTO agent_runs(id,"userId","agentId","deviceId","deviceTokenId",status,"leaseExpiresAt") VALUES($1,$2,$3,$4,$5,'running',now()+interval '90 seconds')`, []any{run, scope.OwnerID, agent, device, credential}},
		{`UPDATE byos_bindings SET "consumerId"=$2 WHERE id=$1`, []any{w.Use.BindingID, agent}},
		{`INSERT INTO byos_native_runs("runId","bindingId") VALUES($1,$2)`, []any{run, w.Use.BindingID}},
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	w.Use.ConsumerID, w.Use.RunID = agent, run
	entered, cancelled := make(chan struct{}), make(chan struct{})
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		response.Header().Set("Content-Type", "text/event-stream")
		response.WriteHeader(http.StatusOK)
		response.(http.Flusher).Flush()
		close(entered)
		<-r.Context().Done()
		close(cancelled)
	}))
	runContext, cancelNative := context.WithCancel(context.Background())
	defer func() { cancelNative(); server.CloseClientConnections(); server.Close() }()
	destination, _ := url.Parse(server.URL)
	transport := server.Client().Transport
	w.NativeClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		copy := r.Clone(r.Context())
		copy.URL.Scheme = destination.Scheme
		copy.URL.Host = destination.Host
		copy.Host = destination.Host
		return transport.RoundTrip(copy)
	})}
	done := make(chan error, 1)
	go func() {
		done <- w.NativeStream(runContext, initial.Revision, NativeRequest{Path: "/v1/messages", Body: json.RawMessage(`{"model":"fixture-model","stream":true}`)}, func(string) error { return nil }, func([]byte) error { t.Error("silent revoked stream emitted bytes"); return nil })
	}()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("native request did not reach isolated TLS fixture")
	}
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]string{"owner": scope.OwnerID, "tokenId": credential})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "node", "--conditions=react-server", "--import", "./scripts/daemon/server-only.mjs", "--import", "tsx", "scripts/daemon/revoke-fixture.mjs")
	command.Dir = root
	command.Env = []string{"PATH=" + os.Getenv("PATH"), "MIKKA_DATABASE_URL=" + os.Getenv("MIKKA_BYOS_TEST_DATABASE_URL"), "E2E_DATABASE_URL=" + os.Getenv("MIKKA_BYOS_TEST_DATABASE_URL")}
	command.Stdin = strings.NewReader(string(body))
	if err = command.Run(); err != nil {
		t.Fatal("actual application revoke helper failed", err)
	}
	started := time.Now()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("revoked silent request survived")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("revocation cancellation exceeded fixture bound")
	}
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("upstream TLS request did not observe cancellation")
	}
	for _, candidate := range []*Worker{w, func() *Worker { copy := *w; return &copy }()} {
		if _, err = candidate.NativeContext(context.Background(), initial.Revision); err != ErrUnavailable {
			t.Fatal("revoked run regained native context", err)
		}
		if _, err = candidate.PrepareRuntime(context.Background(), initial.Revision); err != ErrUnavailable {
			t.Fatal("revoked run reached refresh/prepare", err)
		}
	}
	var count int
	if err = db.QueryRow(`SELECT count(*) FROM security_audit_events WHERE tenant=$1 AND event->>'resourceId'=$2 AND event->>'action'='device.credential.revoked'`, "personal:"+scope.OwnerID, credential).Scan(&count); err != nil || count != 1 {
		t.Fatal("expected one revoke audit event", err, count)
	}
	t.Logf("actual application revoke cancelled real Go broker + loopback TLS request within %s; context/prepare/reinstantiation denied; one audit event", time.Since(started))
}

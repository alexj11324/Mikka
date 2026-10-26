package worker

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func bindNativeRunFixture(t *testing.T, w *Worker, revision int64, route string) string {
	t.Helper()
	bindFixture(t, w, revision, route)
	agent, device, run := newID(), newID(), newID()
	db := w.Repo.DB
	harness := "codex"
	if w.Scope.Provider == "claude" {
		harness = "claude_code"
	}
	_, err := db.Exec(`insert into devices(id,"ownerId",name) values($1,$2,'native fixture')`, device, w.Scope.OwnerID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`insert into agents(id,"userId",harness,name,"deviceId") values($1,$2,$3,$4,$5)`, agent, w.Scope.OwnerID, harness, "native-fixture-"+agent, device)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`insert into agent_runs(id,"userId","agentId","deviceId",status,"leaseExpiresAt") values($1,$2,$3,$4,'running',now()+interval '1 minute')`, run, w.Scope.OwnerID, agent, device)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`insert into byos_native_runs("runId","bindingId") values($1,$2)`, run, w.Use.BindingID)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { t.Logf("retained native fixture run=%s agent=%s device=%s", run, agent, device) })
	_, err = db.Exec(`update byos_bindings set "consumerId"=$2 where id=$1`, w.Use.BindingID, agent)
	if err != nil {
		t.Fatal(err)
	}
	w.Use.ConsumerID, w.Use.RunID = agent, run
	return run
}

func TestNativeBrokerUsesAccessOnlyCredentialsWithoutExportOrEndpointSelection(t *testing.T) {
	for _, provider := range []string{"codex", "claude"} {
		t.Run(provider, func(t *testing.T) {
			w, _, _ := fixtureWorker(t, provider)
			initial := mustAcquire(t, w)
			route, path := "codex_cli", "/responses"
			if provider == "claude" {
				route, path = "claude_code_cli", "/v1/messages?beta=true"
			}
			bindNativeRunFixture(t, w, initial.Revision, route)
			record, _ := w.Repo.Lookup(context.Background(), w.Scope)
			access := &boundedAccessStore{SecretStore: w.AccessSecrets, allowed: record.AccessName}
			w.AccessSecrets, w.Secrets, w.ExecutionOnly, w.AllowNativeAuth = access, nil, true, false
			info, err := w.NativeContext(context.Background(), initial.Revision)
			encoded, _ := json.Marshal(info)
			if err != nil || info.AccountID == "" || bytes.Contains(encoded, []byte("access")) || bytes.Contains(encoded, []byte("refresh")) {
				t.Fatal("native metadata leaked credentials", err)
			}
			var calls atomic.Int32
			w.NativeClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				calls.Add(1)
				expected := "https://chatgpt.com/backend-api/codex/responses"
				if provider == "claude" {
					expected = "https://api.anthropic.com/v1/messages?beta=true"
				}
				if r.URL.String() != expected || !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer fixture-"+provider+"-access-") || r.Header.Get("Cookie") != "" || r.Header.Get("X-Api-Key") != "" {
					t.Error("native forwarding changed destination/authority")
				}
				return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"text/event-stream"}}, Body: io.NopCloser(strings.NewReader("data: {\"native\":true}\n\n"))}, nil
			})}
			request := NativeRequest{Path: path, Headers: map[string]string{"authorization": "Bearer caller-placeholder", "cookie": "foreign", "x-api-key": "foreign", "user-agent": "actual-official-cli-fixture"}, Body: json.RawMessage(`{"model":"fixture-model","stream":true}`)}
			var output bytes.Buffer
			if err = w.NativeStream(context.Background(), initial.Revision, request, func(kind string) error {
				if kind != "text/event-stream" {
					t.Error("bad content type")
				}
				return nil
			}, func(part []byte) error { _, e := output.Write(part); return e }); err != nil || output.String() != "data: {\"native\":true}\n\n" {
				t.Fatal("native stream failed", err)
			}
			before := access.reads
			for _, bad := range []NativeRequest{{Path: "https://attacker.invalid/v1/messages", Body: request.Body}, {Path: path, Body: json.RawMessage(`{"model":"another-model"}`)}} {
				if w.NativeStream(context.Background(), initial.Revision, bad, func(string) error { return nil }, func([]byte) error { return nil }) == nil {
					t.Fatal("native request bypass")
				}
			}
			if access.reads != before || calls.Load() != 1 {
				t.Fatal("invalid native request reached vault/provider")
			}
		})
	}
}

func TestNativeBrokerFencesSilentRequestsOnDisconnectAndRefusesEchoedBearer(t *testing.T) {
	w, _, _ := fixtureWorker(t, "claude")
	initial := mustAcquire(t, w)
	bindNativeRunFixture(t, w, initial.Revision, "claude_code_cli")
	entered := make(chan struct{})
	w.NativeClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		close(entered)
		<-r.Context().Done()
		return nil, r.Context().Err()
	})}
	request := NativeRequest{Path: "/v1/messages", Body: json.RawMessage(`{"model":"fixture-model","stream":true}`)}
	finished := make(chan error, 1)
	go func() {
		finished <- w.NativeStream(context.Background(), initial.Revision, request, func(string) error { return nil }, func([]byte) error { return nil })
	}()
	<-entered
	if _, err := w.Disconnect(context.Background(), initial.Revision); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-finished:
		if err == nil {
			t.Fatal("silent revoked request survived")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("revocation did not cancel silent native request")
	}

	w2, _, _ := fixtureWorker(t, "claude")
	second := mustAcquire(t, w2)
	bindNativeRunFixture(t, w2, second.Revision, "claude_code_cli")
	w2.NativeClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"echo":"` + token + `"}`))}, nil
	})}
	var output bytes.Buffer
	err := w2.NativeStream(context.Background(), second.Revision, request, func(string) error { return nil }, func(part []byte) error { _, e := output.Write(part); return e })
	if err != ErrIntegrity || strings.Contains(output.String(), "fixture-claude-access-") {
		t.Fatal("upstream bearer echo escaped broker")
	}
}

func TestNativeRunLedgerAndLeaseRefuseUseBeforeVaultReads(t *testing.T) {
	w, _, _ := fixtureWorker(t, "codex")
	initial := mustAcquire(t, w)
	run := bindNativeRunFixture(t, w, initial.Revision, "codex_cli")
	db := w.Repo.DB
	record, _ := w.Repo.Lookup(context.Background(), w.Scope)
	access := &boundedAccessStore{SecretStore: w.AccessSecrets, allowed: record.AccessName}
	w.AccessSecrets = access
	w.Secrets = nil
	w.ExecutionOnly = true
	if _, err := w.NativeContext(context.Background(), initial.Revision); err != nil {
		t.Fatal(err)
	}
	for _, update := range []string{`"leaseExpiresAt"=now()-interval '1 second'`, `"leaseExpiresAt"=now()+interval '1 minute',"stopRequestedAt"=now()`, `"stopRequestedAt"=null,status='succeeded'`, `status='running',"userId"='another-owner'`} {
		if _, err := db.Exec(`update agent_runs set `+update+` where id=$1`, run); err != nil {
			t.Fatal(err)
		}
		before := access.reads
		if _, err := w.NativeContext(context.Background(), initial.Revision); err != ErrUnavailable || access.reads != before {
			t.Fatal("invalid run reached vault", err)
		}
	}
}

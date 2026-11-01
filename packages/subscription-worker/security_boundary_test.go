package worker

import (
	"bytes"
	"context"
	"encoding/json"
	"encoding/pem"
	"fmt"
	core "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	ex "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
	"io"
	"net/http"
	"os"
	osexec "os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestProductionWorkerRefusesNativeExportWithoutAConfigurableBypass(t *testing.T) {
	w, inf, _ := fixtureWorker(t, "codex")
	initial := mustAcquire(t, w)
	bindFixture(t, w, initial.Revision, "codex_cli")
	config := map[string]any{"scope": w.Scope, "use": w.Use, "databaseUrl": os.Getenv("MIKKA_BYOS_TEST_DATABASE_URL"), "infisicalOrigin": inf.server.URL, "project": "fixture-project", "environment": "test", "path": "/byos-cpa", "workloadToken": "fixture-workload-token", "accessPath": "/byos-access", "accessToken": "fixture-access-reader", "enableRuntime": true}
	for _, bypass := range []bool{false, true} {
		if bypass {
			config["allowNativeAuth"] = true
		}
		var input bytes.Buffer
		enc := json.NewEncoder(&input)
		_ = enc.Encode(config)
		_ = enc.Encode(map[string]any{"id": "native", "method": "nativeAuth", "revision": initial.Revision})
		command := osexec.Command(os.Getenv("MIKKA_BYOS_WORKER_BINARY"))
		command.Env = []string{"PATH=" + os.Getenv("PATH"), "LANG=C.UTF-8"}
		command.Stdin = &input
		out, err := command.Output()
		if bypass {
			if err == nil {
				t.Fatal("production accepted a caller's native attestation")
			}
			continue
		}
		if err != nil || !bytes.Contains(out, []byte(ErrUnsupported)) || bytes.Contains(out, []byte("accessToken")) {
			t.Fatal("production exported native credential", err)
		}
	}
}

type boundedAccessStore struct {
	SecretStore
	allowed string
	reads   int
}

func (s *boundedAccessStore) Create(context.Context, string, []byte) error { return ErrUnsupported }
func (s *boundedAccessStore) Delete(context.Context, string) error         { return ErrUnsupported }
func (s *boundedAccessStore) Read(ctx context.Context, name string) ([]byte, error) {
	s.reads++
	if name != s.allowed {
		return nil, ErrStore
	}
	return s.SecretStore.Read(ctx, name)
}

type rejectingStore struct {
	SecretStore
	reject bool
}

func TestProductionExecutionWorkerAcceptsOnlyItsAccessSnapshot(t *testing.T) {
	w, inf, _ := fixtureWorker(t, "codex")
	initial := mustAcquire(t, w)
	bindNativeRunFixture(t, w, initial.Revision, "codex_cli")
	record, err := w.Repo.Lookup(context.Background(), w.Scope)
	if err != nil {
		t.Fatal(err)
	}
	inf.mu.Lock()
	projection := string(inf.values[record.AccessName])
	inf.mu.Unlock()
	config := map[string]any{"scope": w.Scope, "use": w.Use, "executionOnly": true, "databaseUrl": os.Getenv("MIKKA_BYOS_TEST_DATABASE_URL"), "accessPath": "/byos-access", "accessSnapshot": AccessSnapshot{Name: record.AccessName, Value: projection}, "enableRuntime": true}
	var input bytes.Buffer
	enc := json.NewEncoder(&input)
	_ = enc.Encode(config)
	_ = enc.Encode(map[string]any{"id": "snapshot", "method": "nativeContext", "revision": initial.Revision})
	command := osexec.Command(os.Getenv("MIKKA_BYOS_WORKER_BINARY"))
	command.Env = []string{"PATH=" + os.Getenv("PATH"), "LANG=C.UTF-8"}
	command.Stdin = &input
	out, err := command.Output()
	if err != nil || !bytes.Contains(out, []byte(`"result"`)) || bytes.Contains(out, []byte(`"error"`)) || bytes.Contains(out, []byte("fixture-codex-access")) {
		t.Fatal("snapshot execution failed or exposed credentials", err)
	}
}

func (s *rejectingStore) Create(ctx context.Context, name string, raw []byte) error {
	if s.reject {
		return ErrStore
	}
	return s.SecretStore.Create(ctx, name, raw)
}
func TestExecutionReadsOnlyAccessProjectionAndEnforcesEveryBinding(t *testing.T) {
	for _, provider := range []string{"codex", "claude"} {
		t.Run(provider, func(t *testing.T) {
			w, inf, issuer := fixtureWorker(t, provider)
			initial := mustAcquire(t, w)
			ctx := context.Background()
			record, _ := w.Repo.Lookup(ctx, w.Scope)
			inf.mu.Lock()
			raw := append([]byte(nil), inf.values[record.AccessName]...)
			inf.mu.Unlock()
			if bytes.Contains(raw, []byte("refresh_token")) || bytes.Contains(raw, []byte("id_token")) {
				t.Fatal("access projection contains refresh/ID material")
			}
			access := &boundedAccessStore{SecretStore: w.AccessSecrets, allowed: record.AccessName}
			w.AccessSecrets = access
			w.Secrets = nil
			w.ExecutionOnly = true
			if _, err := w.Execute(ctx, initial.Revision, "fixture-model", nil); err != nil {
				t.Fatal("normal task failed without full-store authority", err)
			}
			valid := *w.Use
			for _, bad := range []*RuntimeUse{nil, {BindingID: newID(), ConsumerID: valid.ConsumerID}, {BindingID: valid.BindingID, ConsumerID: "other-task"}} {
				before := access.reads
				w.Use = bad
				if _, err := w.Execute(ctx, initial.Revision, "fixture-model", nil); err != ErrUnavailable || access.reads != before {
					t.Fatal("binding bypass reached vault")
				}
			}
			w.Use = &valid
			before := access.reads
			foreign := *w
			foreign.Scope.OwnerID = "another-owner"
			if _, err := foreign.Execute(ctx, initial.Revision, "fixture-model", nil); err != ErrUnavailable || access.reads != before {
				t.Fatal("foreign owner reached vault")
			}
			if _, err := w.Execute(ctx, initial.Revision+1, "fixture-model", nil); err != ErrUnavailable || access.reads != before {
				t.Fatal("stale revision reached vault")
			}
			route := "codex_cli"
			if provider == "claude" {
				route = "claude_code_cli"
			}
			_, _ = w.Repo.DB.Exec(`update byos_bindings set route=$2 where id=$1`, valid.BindingID, route)
			if _, err := w.Execute(ctx, initial.Revision, "fixture-model", nil); err != ErrUnavailable || access.reads != before {
				t.Fatal("native binding used for model execution")
			}
			_, _ = w.Repo.DB.Exec(`update byos_bindings set route=$2 where id=$1`, valid.BindingID, provider+"_cpa")
			before = access.reads
			if _, err := w.Execute(ctx, initial.Revision, "other-model", nil); err != ErrUnavailable || access.reads != before {
				t.Fatal("model substitution reached vault")
			}
			_, _ = w.Repo.DB.Exec(`update byos_connections set quota=null where id=$1`, w.Scope.ConnectionID)
			if _, err := w.Execute(ctx, initial.Revision, "fixture-model", nil); err != ErrUnavailable || access.reads != before {
				t.Fatal("missing quota bypassed worker authorization")
			}
			if _, err := w.Refresh(ctx, initial.Revision); err != ErrUnsupported {
				t.Fatal("execution role refreshed")
			}
			if _, err := w.Disconnect(ctx, initial.Revision); err != ErrUnsupported {
				t.Fatal("execution role changed account")
			}
			var out bytes.Buffer
			_ = w.Serve(ctx, strings.NewReader(`{"id":"1","method":"nativeAuth","revision":2}`+"\n"), &out)
			if !strings.Contains(out.String(), string(ErrUnsupported)) || strings.Contains(out.String(), "accessToken") {
				t.Fatal("execution IPC exported a token")
			}
			if issuer.executions.Load() != 1 {
				t.Fatal("invalid task reached provider")
			}
		})
	}
}

func TestQuotaProjectionDropsEchoedSecretsWithoutDroppingExhaustedWindows(t *testing.T) {
	for _, provider := range []string{"codex", "claude"} {
		t.Run(provider, func(t *testing.T) {
			w, _, _ := fixtureWorker(t, provider)
			initial := mustAcquire(t, w)
			w.QuotaClient = &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
				if request.Header.Get("User-Agent") != "Mikka/1.0" {
					t.Error("unexpected identity")
				}
				secret := request.Header.Get("Authorization")
				if !strings.HasPrefix(secret, "Bearer ") {
					t.Error("missing access header")
				}
				body := map[string]any{"diagnostic": secret}
				if provider == "codex" {
					body["credits"] = map[string]any{"has_credits": false, "unlimited": false}
					body["plan_type"] = secret
					body["rate_limit"] = map[string]any{"primary_window": map[string]any{"used_percent": 20, "limit_window_seconds": 18000}}
					body["additional_rate_limits"] = []any{map[string]any{"limit_name": secret, "rate_limit": map[string]any{"primary_window": map[string]any{"used_percent": 100, "limit_window_seconds": 604800}}}}
				} else {
					body["extra_usage"] = map[string]any{"is_enabled": false}
					body["five_hour"] = map[string]any{"utilization": 20}
					body["limits"] = []any{map[string]any{"kind": "weekly_scoped", "utilization": 100, "scope": map[string]any{"model": map[string]any{"display_name": secret}}}}
				}
				raw, _ := json.Marshal(body)
				return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(raw)), Header: make(http.Header)}, nil
			})}
			result, err := w.Quota(context.Background(), initial.Revision)
			if err != nil {
				t.Fatal(err)
			}
			raw, _ := json.Marshal(result)
			if bytes.Contains(raw, []byte("Bearer")) || bytes.Contains(raw, []byte("fixture-")) {
				t.Fatal("quota exported an echoed credential")
			}
			if !bytes.Contains(raw, []byte("100")) {
				t.Fatal("quota projection dropped exhausted additional window")
			}
		})
	}
}
func TestTrustedLegacyProjectionMigrationDoesNotLoginOrRefresh(t *testing.T) {
	w, _, issuer := fixtureWorker(t, "codex")
	initial := mustAcquire(t, w)
	ctx := context.Background()
	_, _ = w.Repo.DB.Exec(`update byos_connections set "accessSecretName"=null,"accessDigest"=null where id=$1`, w.Scope.ConnectionID)
	if _, err := w.Execute(ctx, initial.Revision, "fixture-model", nil); err != ErrUnavailable {
		t.Fatal("legacy record silently read full grant")
	}
	if _, err := w.PrepareRuntime(ctx, initial.Revision); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Execute(ctx, initial.Revision, "fixture-model", nil); err != nil {
		t.Fatal(err)
	}
	if issuer.acquires.Load() != 1 || issuer.refreshes.Load() != 0 {
		t.Fatal("projection migration repeated provider ceremony")
	}
}
func TestAccessPublicationFailureRecoversWithoutAnotherProviderRefresh(t *testing.T) {
	w, _, issuer := fixtureWorker(t, "claude")
	initial := mustAcquire(t, w)
	ctx := context.Background()
	access := &rejectingStore{SecretStore: w.AccessSecrets, reject: true}
	w.AccessSecrets = access
	if _, err := w.Refresh(ctx, initial.Revision); err == nil {
		t.Fatal("partial access publication became usable")
	}
	if _, err := w.Execute(ctx, initial.Revision, "fixture-model", nil); err != ErrUnavailable {
		t.Fatal("partial publication used")
	}
	access.reject = false
	if _, err := w.Recover(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Execute(ctx, initial.Revision, "fixture-model", nil); err != nil {
		t.Fatal(err)
	}
	if issuer.refreshes.Load() != 1 || issuer.acquires.Load() != 1 {
		t.Fatal("recovery replayed a rotating grant")
	}
}

type failedDeleteStore struct {
	SecretStore
	reject bool
}

func (s *failedDeleteStore) Delete(ctx context.Context, name string) error {
	if s.reject {
		return ErrStore
	}
	return s.SecretStore.Delete(ctx, name)
}
func TestDisconnectFencesBeforeDeletionAndRetriesWithoutClaimingProviderRevocation(t *testing.T) {
	w, inf, _ := fixtureWorker(t, "codex")
	initial := mustAcquire(t, w)
	ctx := context.Background()
	grants := &failedDeleteStore{SecretStore: w.Secrets, reject: true}
	access := &failedDeleteStore{SecretStore: w.AccessSecrets, reject: true}
	w.Secrets = grants
	w.AccessSecrets = access
	result, err := w.Disconnect(ctx, initial.Revision)
	if err != nil || result.State != "disconnected" || result.Cleanup == nil || result.Cleanup.Pending != 2 || result.Cleanup.Failed != 2 || result.Cleanup.ProviderRevocation != "not_implemented" {
		t.Fatal("disconnect obscured failed cleanup", err, result)
	}
	if _, err = w.Execute(ctx, initial.Revision, "fixture-model", nil); err != ErrUnavailable {
		t.Fatal("delete failure restored use")
	}
	grants.reject = false
	access.reject = false
	status, err := w.Cleanup(ctx)
	if err != nil || status.Pending != 0 || status.Failed != 0 {
		t.Fatal("cleanup could not resume", err)
	}
	inf.mu.Lock()
	defer inf.mu.Unlock()
	if len(inf.values) != 0 {
		t.Fatal("disconnected credentials retained")
	}
}

type delayedCreateStore struct {
	SecretStore
	entered, release chan struct{}
	once             sync.Once
}

func (s *delayedCreateStore) Create(ctx context.Context, name string, raw []byte) error {
	s.once.Do(func() { close(s.entered); <-s.release })
	return s.SecretStore.Create(ctx, name, raw)
}
func TestDisconnectTracksLateCreateAndNeverResurrectsDeletedArtifacts(t *testing.T) {
	w, inf, _ := fixtureWorker(t, "claude")
	initial := mustAcquire(t, w)
	ctx := context.Background()
	delayed := &delayedCreateStore{SecretStore: w.Secrets, entered: make(chan struct{}), release: make(chan struct{})}
	w.Secrets = delayed
	outcome := make(chan error, 1)
	go func() { _, err := w.Acquire(ctx, initial.Revision); outcome <- err }()
	select {
	case <-delayed.entered:
	case <-time.After(3 * time.Second):
		t.Fatal("create did not start")
	}
	record, _ := w.Repo.Lookup(ctx, w.Scope)
	if _, err := w.Disconnect(ctx, record.Epoch); err != nil {
		t.Fatal(err)
	}
	_, _ = w.Repo.DB.Exec(`update byos_secret_artifacts set "notBefore"=now()-interval '1 second' where "connectionId"=$1`, w.Scope.ConnectionID)
	if _, err := w.Cleanup(ctx); err != nil {
		t.Fatal(err)
	}
	close(delayed.release)
	if err := <-outcome; err == nil {
		t.Fatal("late create published over disconnect")
	}
	_, _ = w.Repo.DB.Exec(`update byos_secret_artifacts set "notBefore"=now()-interval '1 second' where "connectionId"=$1`, w.Scope.ConnectionID)
	if _, err := w.Cleanup(ctx); err != nil {
		t.Fatal(err)
	}
	inf.mu.Lock()
	count := len(inf.values)
	inf.mu.Unlock()
	if count != 0 {
		t.Fatal("late-created grant was orphaned")
	}
	op := Operation{record}
	if err := createArtifact(ctx, w.Repo, w.Secrets, op, "grant", record.StagedName, []byte("synthetic")); err != ErrStale {
		t.Fatal("retired operation could recreate an artifact")
	}
}

type streamFixtureExecutor struct{ fakeExecutor }

func (s streamFixtureExecutor) ExecuteStream(context.Context, *core.Auth, ex.Request, ex.Options) (*ex.StreamResult, error) {
	chunks := make(chan ex.StreamChunk, 2)
	chunks <- ex.StreamChunk{Payload: []byte("first")}
	chunks <- ex.StreamChunk{Payload: []byte("second")}
	close(chunks)
	return &ex.StreamResult{Chunks: chunks}, nil
}
func TestConcurrentRotationPreservesStreamButDisconnectStopsIt(t *testing.T) {
	for _, disconnect := range []bool{false, true} {
		t.Run(map[bool]string{false: "refresh", true: "disconnect"}[disconnect], func(t *testing.T) {
			w, _, issuer := fixtureWorker(t, "codex")
			initial := mustAcquire(t, w)
			w.Executor = streamFixtureExecutor{fakeExecutor{issuer}}
			seen := 0
			err := w.Stream(context.Background(), initial.Revision, "fixture-model", nil, func([]byte) error {
				seen++
				if seen == 1 {
					if disconnect {
						_, e := w.Disconnect(context.Background(), initial.Revision)
						return e
					}
					_, e := w.Refresh(context.Background(), initial.Revision)
					return e
				}
				return nil
			})
			if disconnect {
				if err != ErrUnavailable || seen != 1 {
					t.Fatal("disconnect did not stop remaining chunks", err)
				}
			} else if err != nil || seen != 2 {
				t.Fatal("ordinary rotation interrupted another task", err)
			}
		})
	}
}
func TestAccessProjectionRejectsFullAndNestedRefreshCopies(t *testing.T) {
	scope := fixtureScope("codex")
	b, err := normalizeAuth(scope, actualStorageAuth(scope, fixturePayload("codex", "0")), nil)
	if err != nil {
		t.Fatal(err)
	}
	projection, _ := accessProjection(b)
	for _, nested := range []bool{false, true} {
		p := projection
		p.Payload = cloneMap(projection.Payload)
		if nested {
			p.Payload["siwc"] = map[string]any{"refresh_token": "fixture-forbidden"}
		} else {
			p.Payload["refresh_token"] = "fixture-forbidden"
		}
		raw, digest, _ := encodeBundle(p)
		if _, err = decodeAccessBundle(scope, raw, digest); err != ErrIntegrity {
			t.Fatal("refresh copy accepted as access-only")
		}
	}
	raw, _ := json.Marshal(projection)
	if bytes.Contains(raw, []byte("fixture-forbidden")) {
		t.Fatal("test contaminated legitimate projection")
	}
}

type lateCommitStore struct {
	SecretStore
	name string
	raw  []byte
}

func (s *lateCommitStore) Create(_ context.Context, name string, raw []byte) error {
	s.name = name
	s.raw = append([]byte(nil), raw...)
	return ErrCreateUncertain
}
func TestUnknownRemoteCreateRemainsQueuedAfter404AndLateCommit(t *testing.T) {
	w, inf, _ := fixtureWorker(t, "codex")
	initial := mustAcquire(t, w)
	ctx := context.Background()
	late := &lateCommitStore{SecretStore: w.Secrets}
	w.Secrets = late
	if _, err := w.Acquire(ctx, initial.Revision); err == nil {
		t.Fatal("uncertain creation was published")
	}
	record, _ := w.Repo.Lookup(ctx, w.Scope)
	if _, err := w.Disconnect(ctx, record.Epoch); err != nil {
		t.Fatal(err)
	}
	_, _ = w.Repo.DB.Exec(`update byos_secret_artifacts set "notBefore"=now()-interval '1 second' where "connectionId"=$1`, w.Scope.ConnectionID)
	first, err := w.Cleanup(ctx)
	if err != nil || first.Uncertain == 0 {
		t.Fatal("404 hid an uncertain write", err)
	}
	if err = late.SecretStore.Create(ctx, late.name, late.raw); err != nil {
		t.Fatal(err)
	}
	if _, err = w.Cleanup(ctx); err != nil {
		t.Fatal(err)
	}
	inf.mu.Lock()
	_, exists := inf.values[late.name]
	inf.mu.Unlock()
	if exists {
		t.Fatal("late remote commit escaped deletion retry")
	}
	var deleted bool
	if w.Repo.DB.QueryRow(`select "deletedAt" is not null from byos_secret_artifacts where name=$1`, late.name).Scan(&deleted) != nil || deleted {
		t.Fatal("unknown creation falsely declared permanently deleted")
	}
}

type selectiveDeleteStore struct {
	SecretStore
	blocked map[string]bool
}

func (s selectiveDeleteStore) Delete(ctx context.Context, name string) error {
	if s.blocked[name] {
		return ErrStore
	}
	return s.SecretStore.Delete(ctx, name)
}
func TestCleanupFailuresCannotStarveLaterArtifacts(t *testing.T) {
	w, inf, _ := fixtureWorker(t, "claude")
	initial := mustAcquire(t, w)
	ctx := context.Background()
	if _, err := w.Disconnect(ctx, initial.Revision); err != nil {
		t.Fatal(err)
	}
	blocked := map[string]bool{}
	var last string
	for i := 0; i < 5; i++ {
		name := "mikka-byos-00000000-0000-4000-8000-" + fmt.Sprintf("%012d", i+1)
		if i < 4 {
			blocked[name] = true
		} else {
			last = name
		}
		inf.mu.Lock()
		inf.values[name] = []byte("synthetic")
		inf.mu.Unlock()
		_, err := w.Repo.DB.Exec(`insert into byos_secret_artifacts(name,"connectionId","ownerId","workspaceId",provider,kind,"notBefore","publishedAt","createStarted","createSettled") values($1,$2,$3,$4,$5,'grant',now(),now(),true,true)`, name, w.Scope.ConnectionID, w.Scope.OwnerID, w.Scope.WorkspaceID, w.Scope.Provider)
		if err != nil {
			t.Fatal(err)
		}
	}
	w.Secrets = selectiveDeleteStore{SecretStore: w.Secrets, blocked: blocked}
	for i := 0; i < 2; i++ {
		if _, err := w.Cleanup(ctx); err != nil {
			t.Fatal(err)
		}
	}
	inf.mu.Lock()
	defer inf.mu.Unlock()
	if _, ok := inf.values[last]; ok {
		t.Fatal("four failed deletions starved the next artifact")
	}
}

func usageAnswer(provider string, rejected func(string) bool) *http.Client {
	return &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		secret := request.Header.Get("Authorization")
		if rejected(secret) {
			return &http.Response{StatusCode: 401, Body: io.NopCloser(strings.NewReader(`{"error":"` + secret + `"}`)), Header: make(http.Header)}, nil
		}
		body := map[string]any{"diagnostic": secret, "plan_type": "plus"}
		if provider == "codex" {
			body["rate_limit"] = map[string]any{"primary_window": map[string]any{"used_percent": 25, "limit_window_seconds": 18000, "reset_at": 1793000000}, "secondary_window": map[string]any{"used_percent": 60, "limit_window_seconds": 604800, "reset_at": 1793400000}}
		} else {
			body["five_hour"] = map[string]any{"utilization": 25, "resets_at": "2026-10-28T12:00:00Z"}
			body["seven_day"] = map[string]any{"utilization": 60, "resets_at": "2026-11-02T08:00:00Z"}
		}
		raw, _ := json.Marshal(body)
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(raw)), Header: make(http.Header)}, nil
	})}
}

func TestUsageReadsOwnConnectionWithoutBindingOrToken(t *testing.T) {
	for _, provider := range []string{"codex", "claude"} {
		t.Run(provider, func(t *testing.T) {
			w, _, issuer := fixtureWorker(t, provider)
			initial := mustAcquire(t, w)
			w.QuotaClient = usageAnswer(provider, func(string) bool { return false })
			ctx := context.Background()
			bound := w.Use
			if _, err := w.Usage(ctx, initial.Revision); err != ErrUnsupported {
				t.Fatal("usage ran under a model binding")
			}
			w.Use = nil
			result, err := w.Usage(ctx, initial.Revision)
			if err != nil {
				t.Fatal(err)
			}
			raw, _ := json.Marshal(result)
			if bytes.Contains(raw, []byte("Bearer")) || bytes.Contains(raw, []byte("fixture-"+provider)) || bytes.Contains(raw, []byte("diagnostic")) {
				t.Fatal("usage exported a credential")
			}
			if result.Status != 200 || result.Account != "fixture@example.invalid" || !bytes.Contains(raw, []byte("60")) || issuer.refreshes.Load() != 0 {
				t.Fatalf("usage lost its projection: %s", raw)
			}
			if _, err := w.Usage(ctx, initial.Revision+1); err == nil {
				t.Fatal("usage read a stale revision")
			}
			w.ExecutionOnly = true
			if _, err := w.Usage(ctx, initial.Revision); err != ErrUnsupported {
				t.Fatal("execution role read usage")
			}
			w.ExecutionOnly, w.Use = false, bound
		})
	}
}

func TestPersistentUsage401NeverRefreshesOrStopsTheConnection(t *testing.T) {
	for _, status := range []int{401, 403} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			w, _, issuer := fixtureWorker(t, "claude")
			initial := mustAcquire(t, w)
			w.Use = nil
			ctx := context.Background()
			w.QuotaClient = &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(`{"error":"` + request.Header.Get("Authorization") + `"}`)), Header: make(http.Header)}, nil
			})}
			for i := 0; i < 3; i++ {
				result, err := w.Usage(ctx, initial.Revision)
				if err != nil || result.Status != status || result.Account != "fixture@example.invalid" || len(result.Body) != 0 {
					t.Fatalf("refused read not reported for itself: %+v %v", result, err)
				}
			}
			if issuer.refreshes.Load() != 0 {
				t.Fatal("a Settings read spent the refresh token")
			}
			record, err := w.Repo.Lookup(ctx, w.Scope)
			if err != nil || record.State != "connected" || record.Epoch != initial.Revision || record.Version != initial.CredentialVersion {
				t.Fatalf("a Settings read changed the connection: %+v %v", record, err)
			}
			// The runtime path still works afterwards.
			bindFixture(t, w, initial.Revision, "claude_cpa")
			if _, err := w.Execute(ctx, initial.Revision, "fixture-model", nil); err != nil {
				t.Fatal("bots stopped after a Settings 401:", err)
			}
		})
	}
}

// Device runners (orchestration.md §6): the production worker exports only a
// run's short-lived access lease, and only when the server asks for one live
// run. The refresh grant never appears in its output.
func TestProductionWorkerExportsOnlyARunAccessLease(t *testing.T) {
	for _, provider := range []string{"codex", "claude"} {
		t.Run(provider, func(t *testing.T) {
			w, inf, _ := fixtureWorker(t, provider)
			initial := mustAcquire(t, w)
			route := "codex_cli"
			if provider == "claude" {
				route = "claude_code_cli"
			}
			bindNativeRunFixture(t, w, initial.Revision, route)
			inf.mu.Lock()
			inf.readablePath = "/byos-access"
			inf.mu.Unlock()
			ca := filepath.Join(t.TempDir(), "infisical.pem")
			if err := os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: inf.server.Certificate().Raw}), 0o600); err != nil {
				t.Fatal(err)
			}
			run := func(lease bool, use *RuntimeUse, executionOnly bool) []byte {
				config := map[string]any{"scope": w.Scope, "use": use, "databaseUrl": os.Getenv("MIKKA_BYOS_TEST_DATABASE_URL"), "infisicalOrigin": inf.server.URL, "project": "fixture-project", "environment": "test", "path": "/byos-cpa", "workloadToken": "fixture-workload-token", "accessPath": "/byos-access", "accessToken": "fixture-access-reader", "enableRuntime": true, "exportAccessLease": lease, "executionOnly": executionOnly}
				var input bytes.Buffer
				enc := json.NewEncoder(&input)
				_ = enc.Encode(config)
				_ = enc.Encode(map[string]any{"id": "lease", "method": "nativeAuth", "revision": initial.Revision})
				command := osexec.Command(os.Getenv("MIKKA_BYOS_WORKER_BINARY"))
				// Trust only the fake secret store's own test certificate.
				command.Env = []string{"PATH=" + os.Getenv("PATH"), "LANG=C.UTF-8", "SSL_CERT_FILE=" + ca}
				command.Stdin = &input
				out, _ := command.Output()
				return out
			}
			leased := run(true, w.Use, false)
			if !bytes.Contains(leased, []byte(`"accessToken":"fixture-`+provider+`-access`)) {
				t.Fatal("run lease was not exported", string(bytes.ReplaceAll(leased, []byte("fixture-"), []byte("x-"))))
			}
			for _, forbidden := range []string{"refresh", "fixture-workload-token", "fixture-access-reader", "id_token"} {
				if bytes.Contains(leased, []byte(forbidden)) {
					t.Fatal("lease output carries more than the access token:", forbidden)
				}
			}
			runless := *w.Use
			runless.RunID = ""
			for name, out := range map[string][]byte{
				"without the lease flag": run(false, w.Use, false),
				"without a run":          run(true, &runless, false),
			} {
				if bytes.Contains(out, []byte("accessToken")) || bytes.Contains(out, []byte("fixture-"+provider+"-access")) {
					t.Fatal("exported native credential", name)
				}
			}
		})
	}
}

func TestUsageNamesClaudePlanOnlyFromKnownProfileLabels(t *testing.T) {
	for organization, want := range map[string]string{"claude_max": "Max", "claude_pro": "Pro", "unexpected<b>": "", "": ""} {
		t.Run("type "+organization, func(t *testing.T) {
			w, _, _ := fixtureWorker(t, "claude")
			initial := mustAcquire(t, w)
			w.Use = nil
			usage := usageAnswer("claude", func(string) bool { return false })
			w.QuotaClient = &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
				if request.URL.Path != "/api/oauth/profile" {
					return usage.Transport.RoundTrip(request)
				}
				raw, _ := json.Marshal(map[string]any{"organization": map[string]any{"organization_type": organization}})
				return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(raw)), Header: http.Header{}}, nil
			})}
			result, err := w.Usage(context.Background(), initial.Revision)
			if err != nil {
				t.Fatal(err)
			}
			if result.Plan != want || result.Status != 200 {
				t.Fatalf("plan %q status %d, want %q", result.Plan, result.Status, want)
			}
		})
	}
}

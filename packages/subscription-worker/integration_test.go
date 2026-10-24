package worker

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	sdkauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/auth"
	core "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	exec "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/config"
	compat "github.com/router-for-me/CLIProxyAPI/v8/sdk/mikkaadapter"
)

func testDB(t *testing.T) *sql.DB {
	t.Helper()
	raw := os.Getenv("MIKKA_BYOS_TEST_DATABASE_URL")
	u, err := url.Parse(raw)
	if err != nil || u == nil || u.Hostname() != "127.0.0.1" || !strings.HasSuffix(u.Path, "_e2e") {
		t.Fatal("integration tests require an explicit isolated loopback *_e2e Postgres; no fallback")
	}
	db, err := sql.Open("pgx", raw)
	if err != nil {
		t.Fatal("test database unavailable")
	}
	db.SetMaxOpenConns(8)
	t.Cleanup(func() { _ = db.Close() })
	if db.Ping() != nil {
		t.Fatal("test database unavailable")
	}
	return db
}

type fakeInfisical struct {
	mu                                 sync.Mutex
	values                             map[string][]byte
	rejectCreate, loseCreate, failRead bool
	unreadableName                     string
	creates, reads                     int
	server                             *httptest.Server
}

func newFakeInfisical(t *testing.T) (*fakeInfisical, *Infisical) {
	f := &fakeInfisical{values: map[string][]byte{}}
	f.server = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		if r.Header.Get("Authorization") != "Bearer fixture-workload-token" {
			http.Error(w, "fixture-token-must-not-leak", 401)
			return
		}
		name := strings.TrimPrefix(r.URL.Path, "/api/v4/secrets/")
		if !validSecretName(name) {
			http.Error(w, "bad secret name", 400)
			return
		}
		var value []byte
		switch r.Method {
		case "POST":
			f.creates++
			var p struct {
				Project     string `json:"projectId"`
				Environment string `json:"environment"`
				Path        string `json:"secretPath"`
				Type        string `json:"type"`
				Value       string `json:"secretValue"`
				Skip        bool   `json:"skipMultilineEncoding"`
			}
			decoder := json.NewDecoder(io.LimitReader(r.Body, 262144))
			decoder.DisallowUnknownFields()
			if decoder.Decode(&p) != nil || p.Project != "fixture-project" || p.Environment != "test" || p.Path != "/byos-cpa" || p.Type != "shared" || !p.Skip {
				http.Error(w, "bad creation contract", 400)
				return
			}
			if f.rejectCreate {
				http.Error(w, "fixture-private-provider-token echoed in upstream failure", 500)
				return
			}
			if _, exists := f.values[name]; exists {
				http.Error(w, "already exists", 400)
				return
			}
			value = []byte(p.Value)
			f.values[name] = append([]byte(nil), value...)
			if f.loseCreate {
				f.unreadableName = name
				connection, _, _ := w.(http.Hijacker).Hijack()
				_ = connection.Close()
				return
			}
		case "DELETE":
			var p map[string]string
			if json.NewDecoder(r.Body).Decode(&p) != nil || p["projectId"] != "fixture-project" || p["environment"] != "test" || p["secretPath"] != "/byos-cpa" || p["type"] != "shared" || len(p) != 4 {
				w.WriteHeader(400)
				return
			}
			if _, ok := f.values[name]; !ok {
				w.WriteHeader(404)
				return
			}
			delete(f.values, name)
			w.WriteHeader(204)
			return
		case "GET":
			f.reads++
			q := r.URL.Query()
			if q.Get("projectId") != "fixture-project" || q.Get("environment") != "test" || q.Get("secretPath") != "/byos-cpa" || q.Get("version") != "1" || q.Get("expandSecretReferences") != "false" || q.Get("includeImports") != "false" || q.Get("viewSecretValue") != "true" {
				http.Error(w, "bad read contract", 400)
				return
			}
			if f.failRead && name == f.unreadableName {
				http.Error(w, "fixture-sensitive-response", 503)
				return
			}
			var exists bool
			value, exists = f.values[name]
			if !exists {
				http.Error(w, "missing", 404)
				return
			}
		default:
			t.Errorf("unexpected secret operation %s; no PATCH CAS or bulk list is permitted", r.Method)
			http.Error(w, "unsupported", 405)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"secret": map[string]any{"secretKey": name, "secretValue": string(value), "version": 1, "secretValueHidden": false}})
	}))
	t.Cleanup(f.server.Close)
	store, err := NewInfisical(InfisicalConfig{Origin: f.server.URL, ProjectID: "fixture-project", Environment: "test", Path: "/byos-cpa", Token: func(context.Context) (string, error) { return "fixture-workload-token", nil }, Client: f.server.Client()})
	if err != nil {
		t.Fatal(err)
	}
	return f, store
}

type fakeProvider struct {
	provider                        string
	server                          *httptest.Server
	acquires, refreshes, executions atomic.Int32
	refreshEntered                  chan struct{}
	refreshRelease                  chan struct{}
	forceError                      atomic.Bool
	expiredAcquire                  atomic.Bool
}

func newFakeProvider(t *testing.T, provider string) *fakeProvider {
	f := &fakeProvider{provider: provider}
	f.server = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/infer" {
			f.executions.Add(1)
			if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer fixture-"+provider+"-access-") {
				http.Error(w, "bad synthetic bearer", 401)
				return
			}
			if f.forceError.Load() {
				http.Error(w, "fixture-private-provider-token must never reach IPC", 500)
				return
			}
			_, _ = io.WriteString(w, `{"text":"fixture inference","usage":{"input":1,"output":1}}`)
			return
		}
		if r.URL.Path != "/oauth/token" {
			http.Error(w, "not found", 404)
			return
		}
		var p map[string]string
		if json.NewDecoder(r.Body).Decode(&p) != nil {
			http.Error(w, "bad request", 400)
			return
		}
		var suffix string
		if p["grant_type"] == "authorization_code" {
			suffix = fmt.Sprintf("a%d", f.acquires.Add(1))
		} else {
			if !strings.HasPrefix(p["refresh_token"], "fixture-"+provider+"-refresh-") {
				http.Error(w, "wrong synthetic refresh", 400)
				return
			}
			suffix = fmt.Sprintf("r%d", f.refreshes.Add(1))
			if f.refreshEntered != nil {
				close(f.refreshEntered)
				<-f.refreshRelease
			}
		}
		payload := fixturePayload(provider, suffix)
		if p["grant_type"] == "authorization_code" && f.expiredAcquire.Load() {
			payload["expired"] = "2020-01-01T00:00:00Z"
		}
		_ = json.NewEncoder(w).Encode(payload)
	}))
	t.Cleanup(f.server.Close)
	return f
}
func (f *fakeProvider) call(ctx context.Context, path string, payload any, bearer string) ([]byte, error) {
	encoded, _ := json.Marshal(payload)
	req, _ := http.NewRequestWithContext(ctx, "POST", f.server.URL+path, bytes.NewReader(encoded))
	req.Header.Set("Content-Type", "application/json")
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	response, err := f.server.Client().Do(req)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(response.Body, 65536))
	if response.StatusCode != 200 {
		return nil, errors.New(string(raw))
	}
	return raw, nil
}

type fakeAuthenticator struct{ provider *fakeProvider }

func (f fakeAuthenticator) Provider() string          { return f.provider.provider }
func (fakeAuthenticator) RefreshLead() *time.Duration { v := time.Minute; return &v }
func (f fakeAuthenticator) Login(ctx context.Context, _ *config.Config, _ *sdkauth.LoginOptions) (*core.Auth, error) {
	raw, err := f.provider.call(ctx, "/oauth/token", map[string]string{"grant_type": "authorization_code", "code": "synthetic-code"}, "")
	if err != nil {
		return nil, err
	}
	var payload map[string]any
	if json.Unmarshal(raw, &payload) != nil {
		return nil, ErrProvider
	}
	s := fixtureScope(f.Provider())
	a := actualStorageAuth(s, payload)
	// The real SDK authenticator initially names this with a provider filename;
	// the owner-scoped wrapper assigns a Mikka connection ID before Store.Save.
	a.ID = "fixture-provider-filename.json"
	a.FileName = a.ID
	return a, nil
}

type fakeExecutor struct{ provider *fakeProvider }

func (f fakeExecutor) Identifier() string { return f.provider.provider }
func (f fakeExecutor) Refresh(ctx context.Context, a *core.Auth) (*core.Auth, error) {
	refresh, _ := a.Metadata["refresh_token"].(string)
	raw, err := f.provider.call(ctx, "/oauth/token", map[string]string{"grant_type": "refresh_token", "refresh_token": refresh}, "")
	if err != nil {
		return nil, err
	}
	var payload map[string]any
	if json.Unmarshal(raw, &payload) != nil {
		return nil, ErrProvider
	}
	copy := a.Clone()
	before := cloneMap(a.Metadata)
	after := cloneMap(a.Metadata)
	for k, v := range payload {
		after[k] = v
	}
	copy.Metadata = after
	if f.Identifier() == "codex" {
		copy.CodexRefreshPatch = compat.NewCredentialRefreshPatch(before, after, true, false)
	}
	return copy, nil
}
func (f fakeExecutor) Execute(ctx context.Context, a *core.Auth, _ exec.Request, _ exec.Options) (exec.Response, error) {
	if _, exists := a.Metadata["refresh_token"]; exists {
		return exec.Response{}, errors.New("refresh credential reached inference executor")
	}
	if _, exists := a.Metadata["id_token"]; exists {
		return exec.Response{}, errors.New("ID credential reached inference executor")
	}
	token, _ := a.Metadata["access_token"].(string)
	raw, err := f.provider.call(ctx, "/infer", map[string]string{"prompt": "synthetic"}, token)
	return exec.Response{Payload: raw}, err
}
func (fakeExecutor) ExecuteStream(context.Context, *core.Auth, exec.Request, exec.Options) (*exec.StreamResult, error) {
	return nil, ErrUnsupported
}
func (fakeExecutor) CountTokens(context.Context, *core.Auth, exec.Request, exec.Options) (exec.Response, error) {
	return exec.Response{}, ErrUnsupported
}
func (fakeExecutor) HttpRequest(context.Context, *core.Auth, *http.Request) (*http.Response, error) {
	return nil, ErrUnsupported
}

func fixtureWorker(t *testing.T, provider string) (*Worker, *fakeInfisical, *fakeProvider) {
	db := testDB(t)
	s := fixtureScope(provider)
	repo := &Repository{DB: db}
	if err := repo.Create(context.Background(), s); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = db.Exec(`delete from byos_bindings where "connectionId"=$1`, s.ConnectionID)
		_, _ = db.Exec(`delete from byos_oauth_attempts where "connectionId"=$1`, s.ConnectionID)
		_, _ = db.Exec(`delete from byos_connections where id=$1`, s.ConnectionID)
	})
	inf, secrets := newFakeInfisical(t)
	issuer := newFakeProvider(t, provider)
	return &Worker{Repo: repo, Secrets: secrets, AccessSecrets: secrets, AllowNativeAuth: true, Scope: s, Authenticator: fakeAuthenticator{issuer}, Executor: fakeExecutor{issuer}}, inf, issuer
}
func mustAcquire(t *testing.T, w *Worker) Metadata {
	t.Helper()
	r, e := w.Status(context.Background())
	if e != nil {
		t.Fatal(e)
	}
	result, e := w.Acquire(context.Background(), r.Revision)
	if e != nil {
		t.Fatal(e)
	}
	bindFixture(t, w, result.Revision, w.Scope.Provider+"_cpa")
	return result
}

func bindFixture(t *testing.T, w *Worker, revision int64, route string) {
	t.Helper()
	id := newID()
	consumer := "fixture-consumer"
	_, err := w.Repo.DB.Exec(`insert into byos_bindings(id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId") values($1,$2,$3,$4,$5,$6,$7,'fixture-model')`, id, w.Scope.OwnerID, w.Scope.WorkspaceID, consumer, w.Scope.ConnectionID, revision, route)
	if err != nil {
		t.Fatal(err)
	}
	w.Use = &RuntimeUse{BindingID: id, ConsumerID: consumer}
	vendor := "codex"
	if w.Scope.Provider == "claude" {
		vendor = "claude_code"
	}
	quota, _ := json.Marshal(map[string]any{"vendor": vendor, "source": "official", "status": "ok", "observedAt": time.Now().UTC().Format(time.RFC3339Nano), "windows": []map[string]any{{"kind": "five_hour", "used": .2, "resetsAt": nil}}})
	if _, err = w.Repo.DB.Exec(`update byos_connections set quota=$2 where id=$1`, w.Scope.ConnectionID, quota); err != nil {
		t.Fatal(err)
	}
}

func TestCPAInitialSaveRestartRefreshAndRepeatedUse(t *testing.T) {
	for _, provider := range []string{"codex", "claude"} {
		t.Run(provider, func(t *testing.T) {
			w, inf, issuer := fixtureWorker(t, provider)
			ctx := context.Background()
			initial := mustAcquire(t, w)
			if initial.State != "connected" || initial.CredentialVersion != 1 {
				t.Fatal("acquisition was not durably published")
			}
			for task := 0; task < 2; task++ {
				out, err := w.Execute(ctx, initial.Revision, "fixture-model", []byte(`{"prompt":"fixture"}`))
				if err != nil || !bytes.Contains(out, []byte("fixture inference")) {
					t.Fatal("repeat task failed", err)
				}
			}
			// Reconstruct a worker: only Postgres metadata + mock Infisical survive.
			restarted := &Worker{Repo: w.Repo, Secrets: w.Secrets, AccessSecrets: w.AccessSecrets, Use: w.Use, AllowNativeAuth: w.AllowNativeAuth, Scope: w.Scope, Authenticator: w.Authenticator, Executor: w.Executor}
			refreshed, err := restarted.Refresh(ctx, initial.Revision)
			if err != nil {
				t.Fatal(err)
			}
			if refreshed.Revision != initial.Revision || refreshed.CredentialVersion != 2 {
				t.Fatal("ordinary rotation changed authorization epoch or failed to publish")
			}
			if _, err = restarted.Execute(ctx, initial.Revision, "fixture-model", nil); err != nil {
				t.Fatal(err)
			}
			if issuer.acquires.Load() != 1 || issuer.refreshes.Load() != 1 || issuer.executions.Load() != 3 {
				t.Fatal("unexpected login, refresh or execution count")
			}
			if inf.creates != 4 {
				t.Fatal("rotation must publish an immutable grant and access-only projection")
			}
			var row string
			if w.Repo.DB.QueryRow(`select row_to_json(c)::text from byos_connections c where id=$1`, w.Scope.ConnectionID).Scan(&row) != nil {
				t.Fatal("metadata audit failed")
			}
			if strings.Contains(row, "fixture-"+provider+"-access") || strings.Contains(row, "fixture-"+provider+"-refresh") {
				t.Fatal("credential value persisted to Postgres")
			}
			other := *restarted
			other.Scope.OwnerID = "bob"
			if _, err = other.Status(ctx); err != ErrUnavailable {
				t.Fatal("cross-owner metadata lookup succeeded")
			}
			if _, err = other.Execute(ctx, initial.Revision, "fixture-model", nil); err != ErrUnavailable {
				t.Fatal("cross-owner model use succeeded")
			}
			if _, err = w.Disconnect(ctx, initial.Revision); err != nil {
				t.Fatal(err)
			}
			if _, err = w.Execute(ctx, initial.Revision, "fixture-model", nil); err != ErrUnavailable {
				t.Fatal("disconnect did not fence future use")
			}
		})
	}
}

func TestSingleRefreshAuthorityAndReconnectRejectsLateResult(t *testing.T) {
	w, _, issuer := fixtureWorker(t, "codex")
	ctx := context.Background()
	initial := mustAcquire(t, w)
	issuer.refreshEntered = make(chan struct{})
	issuer.refreshRelease = make(chan struct{})
	var release sync.Once
	t.Cleanup(func() { release.Do(func() { close(issuer.refreshRelease) }) })
	finished := make(chan error, 1)
	go func() { _, err := w.Refresh(ctx, initial.Revision); finished <- err }()
	select {
	case <-issuer.refreshEntered:
	case <-time.After(10 * time.Second):
		t.Fatal("refresh did not reach fake provider")
	}
	if _, err := w.Refresh(ctx, initial.Revision); err == nil {
		t.Fatal("second refresh authority acquired same rotating grant")
	}
	if _, err := w.Execute(ctx, initial.Revision, "fixture-model", nil); err != ErrUnavailable {
		t.Fatal("use continued while grant outcome was uncertain")
	}
	reconnected, err := w.Acquire(ctx, initial.Revision)
	if err != nil {
		t.Fatal(err)
	}
	release.Do(func() { close(issuer.refreshRelease) })
	if err = <-finished; err == nil {
		t.Fatal("late refresh published over reconnect")
	}
	current, err := w.Status(ctx)
	if err != nil || current.Revision != reconnected.Revision || current.CredentialVersion != reconnected.CredentialVersion {
		t.Fatal("late result changed newer account")
	}
	if issuer.refreshes.Load() != 1 || issuer.acquires.Load() != 2 {
		t.Fatal("unexpected grant replay")
	}
	if _, err = w.Execute(ctx, initial.Revision, "fixture-model", nil); err != ErrUnavailable {
		t.Fatal("old binding resumed after reconnect")
	}
	bindFixture(t, w, reconnected.Revision, w.Scope.Provider+"_cpa")
	if _, err = w.Execute(ctx, reconnected.Revision, "fixture-model", nil); err != nil {
		t.Fatal(err)
	}
}

func TestAcceptedSecretLostResponseRecoversAfterRestartWithoutLogin(t *testing.T) {
	w, inf, issuer := fixtureWorker(t, "claude")
	ctx := context.Background()
	initial := mustAcquire(t, w)
	inf.mu.Lock()
	inf.loseCreate = true
	inf.failRead = true
	inf.mu.Unlock()
	if _, err := w.Refresh(ctx, initial.Revision); err == nil {
		t.Fatal("lost publication was reported successful")
	}
	if _, err := w.Execute(ctx, initial.Revision, "fixture-model", nil); err != ErrUnavailable {
		t.Fatal("unpersisted in-memory refresh was used")
	}
	if _, err := w.Refresh(ctx, initial.Revision); err == nil {
		t.Fatal("uncertain grant refreshed twice")
	}
	inf.mu.Lock()
	inf.failRead = false
	inf.mu.Unlock()
	restarted := &Worker{Repo: w.Repo, Secrets: w.Secrets, AccessSecrets: w.AccessSecrets, Use: w.Use, AllowNativeAuth: w.AllowNativeAuth, Scope: w.Scope, Executor: w.Executor}
	recovered, err := restarted.Recover(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if recovered.CredentialVersion != 2 || recovered.Revision != initial.Revision || issuer.acquires.Load() != 1 || issuer.refreshes.Load() != 1 {
		t.Fatal("recovery replayed grant or changed account")
	}
	if _, err = restarted.Execute(ctx, initial.Revision, "fixture-model", nil); err != nil {
		t.Fatal(err)
	}
}

func TestRejectedStoreAndRawProviderErrorsFailClosed(t *testing.T) {
	w, inf, issuer := fixtureWorker(t, "codex")
	ctx := context.Background()
	initial := mustAcquire(t, w)
	inf.mu.Lock()
	inf.rejectCreate = true
	inf.mu.Unlock()
	_, err := w.Refresh(ctx, initial.Revision)
	if err == nil || strings.Contains(err.Error(), "fixture-private") {
		t.Fatal("store failure succeeded or leaked raw error")
	}
	if _, err = w.Execute(ctx, initial.Revision, "fixture-model", nil); err != ErrUnavailable {
		t.Fatal("failed durable refresh remained usable")
	}
	if _, err = w.Recover(ctx); err != ErrMissing {
		t.Fatal("missing publication manufactured a credential")
	}
	if issuer.refreshes.Load() != 1 {
		t.Fatal("failed persistence repeated refresh")
	}
}

func TestPostgresPublishFailureRecoversStoredBundle(t *testing.T) {
	w, _, issuer := fixtureWorker(t, "codex")
	ctx := context.Background()
	name := "fixture_fail_" + strings.ReplaceAll(w.Scope.ConnectionID, "-", "")
	ddl := fmt.Sprintf(`create function %s() returns trigger language plpgsql as $$ begin if new.id='%s' and new.state='connected' then raise exception 'synthetic publication failure'; end if; return new; end $$; create trigger %s before update on byos_connections for each row execute function %s()`, name, w.Scope.ConnectionID, name, name)
	if _, err := w.Repo.DB.Exec(ddl); err != nil {
		t.Fatal("failed to install isolated fault trigger")
	}
	cleanup := func() {
		_, _ = w.Repo.DB.Exec(fmt.Sprintf(`drop trigger if exists %s on byos_connections; drop function if exists %s()`, name, name))
	}
	t.Cleanup(cleanup)
	if _, err := w.Acquire(ctx, 1); err == nil {
		t.Fatal("database publication failure reported connected")
	}
	cleanup()
	r, err := w.Recover(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if r.State != "connected" || issuer.acquires.Load() != 1 {
		t.Fatal("database recovery reacquired provider authorization")
	}
}

func TestPrivateIPCDoesNotExposeCredentialsOrAcceptTenantOverrides(t *testing.T) {
	w, inf, issuer := fixtureWorker(t, "codex")
	ctx := context.Background()
	initial := mustAcquire(t, w)
	issuer.forceError.Store(true)
	requests := fmt.Sprintf("{\"id\":\"1\",\"method\":\"status\"}\n{\"id\":\"2\",\"method\":\"execute\",\"revision\":%d,\"model\":\"fixture-model\"}\n{\"id\":\"3\",\"method\":\"status\",\"ownerId\":\"bob\"}\n", initial.Revision)
	var out bytes.Buffer
	if err := w.Serve(ctx, strings.NewReader(requests), &out); err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"access_token", "refresh_token", "id_token", "secretName", "fixture-private-provider-token", "fixture-workload-token"} {
		if strings.Contains(out.String(), forbidden) {
			t.Fatalf("IPC exposed %s", forbidden)
		}
	}
	if !strings.Contains(out.String(), "provider_operation_failed") || !strings.Contains(out.String(), "provider_route_unavailable") {
		t.Fatal("IPC did not return safe refusals")
	}
	bindFixture(t, w, initial.Revision, "codex_cli")
	auth, err := w.CodexNativeAuth(ctx, initial.Revision)
	if err != nil || auth.Type != "chatgptAuthTokens" || auth.ChatGPTAccountID != "fixture-account" {
		t.Fatal("native Codex shape unavailable", err)
	}
	if strings.Contains(fmt.Sprintf("%v %#v", auth, auth), "fixture-codex-access") {
		t.Fatal("native handoff exposed token in diagnostics")
	}
	// A separately authorized SIWC partition must not become a native ChatGPT
	// login merely because the same bundle also contains an outer access token.
	record, err := w.Repo.Lookup(ctx, w.Scope)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := w.Secrets.Read(ctx, record.SecretName)
	if err != nil {
		t.Fatal(err)
	}
	b, err := decodeBundle(w.Scope, raw, record.Digest)
	if err != nil {
		t.Fatal(err)
	}
	b.Payload["use_siwc"] = true
	b.Payload["siwc"] = map[string]any{"access_token": "fixture-siwc-access", "refresh_token": "fixture-siwc-refresh", "client_id": "fixture-client", "expired": expiry}
	raw, digest, err := encodeBundle(b)
	if err != nil {
		t.Fatal(err)
	}
	inf.mu.Lock()
	projection, _ := accessProjection(b)
	raw, digest, _ = encodeBundle(projection)
	inf.values[record.AccessName] = raw
	inf.mu.Unlock()
	if _, err = w.Repo.DB.Exec(`update byos_connections set "accessDigest"=$2 where id=$1`, w.Scope.ConnectionID, digest); err != nil {
		t.Fatal(err)
	}
	if _, err = w.CodexNativeAuth(ctx, initial.Revision); err != ErrUnsupported {
		t.Fatal("SIWC grant was silently reinterpreted as native ChatGPT auth")
	}
	claude := *w
	claude.Scope.Provider = "claude"
	if _, err = claude.CodexNativeAuth(ctx, initial.Revision); err != ErrUnsupported {
		t.Fatal("unsupported native credential conversion was claimed")
	}
}

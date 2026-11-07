package worker

import (
	"bytes"
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"

	core "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	ex "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
)

// An in-memory SQL driver supplies existing authority/credential rows. It
// checks the real Stream call's SQL arguments and ordering; it is not a real
// PostgreSQL authorization test. No socket, database or credential is used.
type affinityFixture struct {
	t          *testing.T
	scope      Scope
	use        RuntimeUse
	epoch      int64
	version    int64
	digest     string
	queries    int
	lookups    int
	reads      int
	deny       bool
	denyLookup int
	beforeHTTP []string
	requests   int
	headers    http.Header
	body       []byte
}

type affinityConnector struct{ fixture *affinityFixture }
type affinityDriver struct{ fixture *affinityFixture }
type affinityConnection struct{ fixture *affinityFixture }
type affinityRows struct {
	columns []string
	values  []driver.Value
	done    bool
}

func (c affinityConnector) Connect(context.Context) (driver.Conn, error) {
	return affinityConnection{c.fixture}, nil
}
func (c affinityConnector) Driver() driver.Driver {
	return affinityDriver{c.fixture}
}
func (d affinityDriver) Open(string) (driver.Conn, error) {
	return affinityConnection{d.fixture}, nil
}
func (affinityConnection) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("unexpected prepare in affinity fixture")
}
func (affinityConnection) Begin() (driver.Tx, error) {
	return nil, errors.New("unexpected transaction in affinity fixture")
}
func (affinityConnection) Close() error {
	return nil
}
func (r *affinityRows) Columns() []string {
	return r.columns
}
func (r *affinityRows) Close() error {
	return nil
}
func (r *affinityRows) Next(dest []driver.Value) error {
	if r.done || r.values == nil {
		return io.EOF
	}
	r.done = true
	copy(dest, r.values)
	return nil
}
func (c affinityConnection) QueryContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	f := c.fixture
	f.queries++
	values := make([]any, len(args))
	for i, arg := range args {
		values[i] = arg.Value
	}
	if strings.Contains(query, "from byos_bindings b join byos_connections c") {
		if len(args) != 8 || !reflect.DeepEqual(values[:7], []any{f.use.BindingID, f.use.ConsumerID, f.scope.OwnerID, f.scope.WorkspaceID, f.scope.ConnectionID, f.scope.Provider, f.epoch}) {
			f.t.Fatal("Stream changed its binding/owner/connection/epoch authority arguments")
		}
		if f.requests == 0 {
			f.beforeHTTP = append(f.beforeHTTP, "authorize")
			if args[7].Value != true {
				f.t.Fatal("the initial authority check no longer checks quota")
			}
		} else if !f.deny && args[7].Value != false {
			f.t.Fatal("an active check unexpectedly changed its quota contract")
		}
		rows := &affinityRows{columns: []string{"route", "model", "state", "epoch", "quota", "paused"}}
		if !f.deny {
			quota, _ := json.Marshal(map[string]any{"vendor": "codex", "status": "ok", "observedAt": time.Now().UTC().Format(time.RFC3339Nano), "windows": []any{map[string]any{"used": 0.1}}})
			rows.values = []driver.Value{"codex_cpa", "gpt-6-luna", "connected", f.epoch, quota, false}
		}
		return rows, nil
	}
	if !strings.Contains(query, "from byos_connections where") || !reflect.DeepEqual(values, []any{f.scope.ConnectionID, f.scope.OwnerID, f.scope.WorkspaceID, f.scope.Provider}) {
		f.t.Fatal("unexpected SQL in affinity fixture")
	}
	f.lookups++
	f.beforeHTTP = append(f.beforeHTTP, "lookup")
	rows := &affinityRows{columns: strings.Split("connection,owner,workspace,provider,state,epoch,version,secret,digest,subject,operation,kind,staged,stagedDigest,deadline,access,accessDigest,stagedAccess,stagedAccessDigest", ",")}
	if f.lookups != f.denyLookup {
		rows.values = []driver.Value{f.scope.ConnectionID, f.scope.OwnerID, f.scope.WorkspaceID, f.scope.Provider, "connected", f.epoch, f.version, "", "", "fixture-account", "", "", "", "", time.Unix(0, 0), "mikka-byos-20000000-0000-4000-8000-000000000009", f.digest, "", ""}
	}
	return rows, nil
}

type affinityAccessStore struct {
	SecretStore
	fixture *affinityFixture
}

func (s affinityAccessStore) Read(ctx context.Context, name string) ([]byte, error) {
	s.fixture.reads++
	s.fixture.beforeHTTP = append(s.fixture.beforeHTTP, "access")
	return s.SecretStore.Read(ctx, name)
}

func newAffinityFixture(t *testing.T, scope Scope, use RuntimeUse, epoch, version int64, token string) (*Worker, *affinityFixture) {
	t.Helper()
	f := &affinityFixture{t: t, scope: scope, use: use, epoch: epoch, version: version}
	projection := bundle{Schema: 1, OwnerID: scope.OwnerID, WorkspaceID: scope.WorkspaceID, ConnectionID: scope.ConnectionID, Provider: scope.Provider, Payload: map[string]any{"type": "codex", "access_token": token, "account_id": "fixture-account", "expired": expiry}}
	raw, digest, err := encodeBundle(projection)
	if err != nil {
		t.Fatal(err)
	}
	f.digest = digest
	store, err := NewAccessSnapshot(AccessSnapshot{Name: "mikka-byos-20000000-0000-4000-8000-000000000009", Value: string(raw)})
	if err != nil {
		t.Fatal(err)
	}
	db := sql.OpenDB(affinityConnector{f})
	t.Cleanup(func() { _ = db.Close() })
	w := &Worker{Scope: scope, Use: &use, Repo: &Repository{DB: db}, ExecutionOnly: true, AccessSecrets: affinityAccessStore{store, f}}
	w.Executor = CPAPlainModel{Provider: "codex", Client: &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		f.requests++
		if f.queries != 4 || f.reads != 1 || !reflect.DeepEqual(f.beforeHTTP, []string{"authorize", "lookup", "lookup", "access", "lookup"}) {
			t.Fatal("affinity changed the existing fresh authorization/readiness order or SQL budget")
		}
		f.headers = request.Header.Clone()
		f.body, err = io.ReadAll(request.Body)
		if err != nil {
			t.Fatal(err)
		}
		terminal := "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"fixture-response\",\"model\":\"gpt-6-luna\",\"output\":[],\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}}\n\n"
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"text/event-stream"}}, Body: io.NopCloser(strings.NewReader(terminal))}, nil
	})}}
	return w, f
}

var affinitySessionPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

func TestCodexSessionAffinityUsesAuthorizedConversationScope(t *testing.T) {
	scope := Scope{"fixture-owner", "20000000-0000-4000-8000-000000000001", "20000000-0000-4000-8000-000000000002", "codex"}
	use := RuntimeUse{BindingID: "20000000-0000-4000-8000-000000000003", ConsumerID: "fixture-bot"}
	clean := []byte(`{"messages":[{"role":"user","content":"fixture-request"}]}`)
	forged := []byte(`{"messages":[{"role":"user","content":"fixture-request"}],"session_id":"forged","prompt_cache_key":"forged","metadata":{"user_id":"forged"},"headers":{"session-id":"forged"}}`)
	var firstID string
	var firstBody []byte
	var firstHeaders http.Header
	seen := map[string]bool{}
	for _, name := range []string{"base", "another workflow", "token rotation", "owner", "custody workspace", "connection", "binding", "consumer", "epoch"} {
		t.Run(name, func(t *testing.T) {
			s, u, epoch, version, token := scope, use, int64(7), int64(11), "fixture-access"
			switch name {
			case "owner":
				s.OwnerID = "another-owner"
			case "custody workspace":
				s.WorkspaceID = "20000000-0000-4000-8000-000000000004"
			case "connection":
				s.ConnectionID = "20000000-0000-4000-8000-000000000005"
			case "binding":
				u.BindingID = "20000000-0000-4000-8000-000000000006"
			case "consumer":
				u.ConsumerID = "another-bot"
			case "epoch":
				epoch++
			case "token rotation":
				version++
				token = "fixture-rotated-access"
			}
			w, f := newAffinityFixture(t, s, u, epoch, version, token)
			payload := forged
			if name == "base" {
				payload = clean
			}
			ctx := context.WithValue(context.Background(), affinityWorkflowKey{}, name)
			if err := w.Stream(ctx, epoch, "gpt-6-luna", payload, func([]byte) error { return nil }); err != nil {
				t.Fatal(err)
			}
			id := f.headers.Get("Session-Id")
			if !affinitySessionPattern.MatchString(id) {
				t.Fatal("codex_trusted_session_header_missing")
			}
			if f.requests != 1 || f.headers.Get("Authorization") != "Bearer "+token || f.headers.Get("Originator") != "Mikka" || f.headers.Get("ChatGPT-Account-Id") != "fixture-account" || f.headers.Get("X-Codex-Turn-State") != "" {
				t.Fatal("affinity changed the provider identity or introduced another request/header")
			}
			f.headers.Del("Authorization")
			f.headers.Del("Session-Id")
			if name == "base" {
				firstID, firstBody, firstHeaders = id, f.body, f.headers
			} else if !bytes.Equal(f.body, firstBody) || !reflect.DeepEqual(f.headers, firstHeaders) {
				t.Fatal("affinity or forged input changed the final body or unrelated headers")
			}
			if name == "another workflow" || name == "token rotation" {
				if id != firstID {
					t.Fatal("workflow or ordinary token rotation changed conversation affinity")
				}
			} else {
				if seen[id] {
					t.Fatal("independent authority scopes shared an affinity identifier")
				}
				seen[id] = true
			}
			f.deny = true
			beforeQueries, beforeReads := f.queries, f.reads
			if err := w.Stream(context.Background(), epoch, "gpt-6-luna", clean, func([]byte) error { return nil }); err == nil || f.requests != 1 || f.queries != beforeQueries+1 || f.reads != beforeReads {
				t.Fatal("the next call reused authority after revocation")
			}
		})
	}
}

type affinityWorkflowKey struct{}

func TestCodexSessionAffinityCannotBypassAuthorizationReadinessOrCancellation(t *testing.T) {
	for _, stage := range []string{"authorization", "first lookup", "store lookup", "connected lookup", "cancelled", "missing use"} {
		t.Run(stage, func(t *testing.T) {
			scope := Scope{"fixture-owner", "20000000-0000-4000-8000-000000000001", "20000000-0000-4000-8000-000000000002", "codex"}
			w, f := newAffinityFixture(t, scope, RuntimeUse{BindingID: "20000000-0000-4000-8000-000000000003", ConsumerID: "fixture-bot"}, 7, 11, "fixture-access")
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			switch stage {
			case "authorization":
				f.deny = true
			case "first lookup":
				f.denyLookup = 1
			case "store lookup":
				f.denyLookup = 2
			case "connected lookup":
				f.denyLookup = 3
			case "cancelled":
				cancel()
			case "missing use":
				w.Use = nil
			}
			if err := w.Stream(ctx, 7, "gpt-6-luna", []byte(`{"messages":[]}`), func([]byte) error { return nil }); err == nil || f.requests != 0 {
				t.Fatal("failed authority/readiness/cancellation reached the provider")
			}
		})
	}
}

func TestPlainModelCannotTakeSessionAffinityFromUntrustedInputs(t *testing.T) {
	for _, provider := range []string{"codex", "claude"} {
		t.Run(provider, func(t *testing.T) {
			calls := 0
			model := CPAPlainModel{Provider: provider, Client: &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
				calls++
				if request.Header.Get("Session-Id") != "" || request.Header.Get("X-Codex-Turn-State") != "" {
					t.Fatal("an untrusted input introduced a routing header")
				}
				return &http.Response{StatusCode: 400, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"error":{"type":"invalid_request_error"}}`))}, nil
			})}}
			auth := &core.Auth{Metadata: map[string]any{"access_token": "fixture-access", "account_id": "fixture-account", "session_id": "forged", "headers": map[string]string{"session-id": "forged"}}}
			ctx := context.WithValue(context.Background(), "session-id", "forged")
			_, err := model.ExecuteStream(ctx, auth, ex.Request{Model: "gpt-6-luna", Payload: []byte(`{"messages":[{"role":"user","content":"fixture"}],"session_id":"forged","headers":{"session-id":"forged"}}`)}, ex.Options{})
			if calls != 1 || !errors.Is(err, ErrRequestRejected) {
				t.Fatal("the existing refusal contract changed")
			}
		})
	}
}

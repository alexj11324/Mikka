package worker

import (
	"bytes"
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

// Exercise the real private Serve -> preparation -> Repository/Store path.
// This driver supplies rows, counts every SQL operation, and rejects any
// unexpected statement; it does not implement preparation logic.
type preparationConnector struct{ fixture *affinityFixture }
type preparationConnection struct{ affinityConnection }

func (c preparationConnector) Connect(context.Context) (driver.Conn, error) {
	return preparationConnection{affinityConnection{c.fixture}}, nil
}
func (c preparationConnector) Driver() driver.Driver { return affinityDriver{c.fixture} }

func (c preparationConnection) QueryContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	f := c.fixture
	if strings.Contains(query, "from byos_bindings b join byos_connections c") {
		f.queries++
		values := make([]any, len(args))
		for i, arg := range args {
			values[i] = arg.Value
		}
		if !reflect.DeepEqual(values, []any{f.use.BindingID, f.use.ConsumerID, f.scope.OwnerID, f.scope.WorkspaceID, f.scope.ConnectionID, f.scope.Provider, f.epoch, false}) {
			f.t.Fatal("preparation changed its exact authority or quota-probe contract")
		}
		f.beforeHTTP = append(f.beforeHTTP, "authorize")
		rows := &affinityRows{columns: []string{"route", "model", "state", "epoch", "quota", "paused"}}
		if !f.deny {
			rows.values = []driver.Value{"codex_cpa", "gpt-6-luna", "connected", f.epoch, nil, false}
		}
		return rows, nil
	}
	if strings.HasPrefix(query, "with candidates as(") {
		f.queries++
		return &affinityRows{columns: []string{"name", "kind"}}, nil
	}
	if strings.Contains(query, "from byos_secret_artifacts a") {
		f.queries++
		return &affinityRows{columns: []string{"pending", "failed", "uncertain"}, values: []driver.Value{int64(0), int64(0), int64(0)}}, nil
	}
	if strings.Contains(query, "from byos_enrollment_sources a") {
		f.queries++
		return &affinityRows{columns: []string{"total", "pending", "failed", "protected", "uncertain", "ownershipFailed"}, values: []driver.Value{int64(0), int64(0), int64(0), int64(0), int64(0), false}}, nil
	}
	return c.affinityConnection.QueryContext(ctx, query, args)
}
func (c preparationConnection) ExecContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Result, error) {
	c.fixture.queries++
	if !strings.HasPrefix(query, "delete from byos_oauth_attempts") {
		c.fixture.t.Fatal("unexpected write in readiness fixture")
	}
	return driver.RowsAffected(0), nil
}

func preparationWorker(t *testing.T) (*Worker, *affinityFixture) {
	t.Helper()
	scope := Scope{OwnerID: "fixture-owner", WorkspaceID: "20000000-0000-4000-8000-000000000001", ConnectionID: "20000000-0000-4000-8000-000000000002", Provider: "codex"}
	use := RuntimeUse{BindingID: "20000000-0000-4000-8000-000000000003", ConsumerID: "fixture-bot"}
	w, f := newAffinityFixture(t, scope, use, 2, 3, "fixture-access")
	db := sql.OpenDB(preparationConnector{f})
	t.Cleanup(func() { _ = db.Close() })
	w.Repo = &Repository{DB: db}
	w.ExecutionOnly = false
	w.Secrets = w.AccessSecrets
	return w, f
}
func servePreparation(t *testing.T, w *Worker, method string) map[string]any {
	t.Helper()
	var input, output bytes.Buffer
	if err := json.NewEncoder(&input).Encode(map[string]any{"id": "fixture", "method": method, "revision": int64(2)}); err != nil {
		t.Fatal(err)
	}
	if err := w.Serve(context.Background(), &input, &output); err != nil {
		t.Fatal(err)
	}
	var response map[string]any
	if err := json.Unmarshal(output.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	return response
}

func TestPrepareStreamKeepsReadinessAndAvoidsUnusedMaintenanceQueries(t *testing.T) {
	for _, sample := range []struct {
		method  string
		queries int
	}{{"prepare", 13}, {"prepareStream", 5}} {
		t.Run(sample.method, func(t *testing.T) {
			w, f := preparationWorker(t)
			response := servePreparation(t, w, sample.method)
			if response["error"] != nil {
				t.Fatalf("prepare_stream_did_not_complete_readiness: %v", response["error"])
			}
			if f.queries != sample.queries || f.reads != 1 || f.requests != 0 {
				t.Fatalf("preparation SQL/read/provider budget: got %d/%d/%d want %d/1/0", f.queries, f.reads, f.requests, sample.queries)
			}
			if sample.method == "prepareStream" {
				if !reflect.DeepEqual(f.beforeHTTP, []string{"authorize", "lookup", "lookup", "lookup", "access", "lookup"}) {
					t.Fatal("light preparation removed or reordered a fresh readiness check")
				}
				if !reflect.DeepEqual(response["result"], map[string]any{"ready": true}) {
					t.Fatal("light preparation returned unused metadata or credentials")
				}
				timing, ok := response["timing"].(map[string]any)
				if !ok || timing["cleanupMs"] != nil || timing["statusMs"] != nil || timing["readCalls"] != float64(1) {
					t.Fatal("light preparation timing must retain missing maintenance, not invented zero")
				}
			}
		})
	}
}

func TestPrepareStreamCannotBypassAuthorityReadinessOrExecutionIsolation(t *testing.T) {
	for _, name := range []string{"authority", "record", "ready_record", "digest", "execution_only", "run_scope"} {
		t.Run(name, func(t *testing.T) {
			w, f := preparationWorker(t)
			switch name {
			case "authority":
				f.deny = true
			case "record":
				f.denyLookup = 1
			case "ready_record":
				f.denyLookup = 2
			case "digest":
				f.digest = strings.Repeat("0", 64)
			case "execution_only":
				w.ExecutionOnly = true
			case "run_scope":
				w.Use.RunID = "20000000-0000-4000-8000-000000000004"
			}
			response := servePreparation(t, w, "prepareStream")
			if response["error"] == nil || f.requests != 0 {
				t.Fatal("invalid preparation reached a successful result or provider")
			}
			if (name == "execution_only" || name == "run_scope") && f.queries != 0 {
				t.Fatal("out-of-scope light preparation touched the database")
			}
		})
	}
}

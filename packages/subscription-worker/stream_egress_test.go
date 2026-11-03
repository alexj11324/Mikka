package worker

import (
	"context"
	"database/sql"
	"net"
	"os"
	"sync/atomic"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
)

type streamQueryCounter struct{ calls, received atomic.Int64 }
type streamCountedConnection struct {
	net.Conn
	count *streamQueryCounter
}

func (c streamCountedConnection) Read(data []byte) (int, error) {
	n, err := c.Conn.Read(data)
	c.count.received.Add(int64(n))
	return n, err
}

func (c *streamQueryCounter) TraceQueryStart(ctx context.Context, _ *pgx.Conn, _ pgx.TraceQueryStartData) context.Context {
	c.calls.Add(1)
	return ctx
}
func (*streamQueryCounter) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

func TestStreamChecksAuthorizeEveryChunkWithoutFetchingUnusedCredentialRecord(t *testing.T) {
	w, _, _ := fixtureWorker(t, "claude")
	initial := mustAcquire(t, w)
	config, err := pgx.ParseConfig(os.Getenv("MIKKA_BYOS_TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal("isolated test configuration unavailable")
	}
	count := &streamQueryCounter{}
	config.Tracer = count
	config.DialFunc = func(ctx context.Context, network, address string) (net.Conn, error) {
		connection, err := (&net.Dialer{}).DialContext(ctx, network, address)
		if err != nil {
			return nil, err
		}
		return streamCountedConnection{connection, count}, nil
	}
	key := stdlib.RegisterConnConfig(config)
	defer stdlib.UnregisterConnConfig(key)
	database, err := sql.Open("pgx", key)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	w.Repo = &Repository{DB: database}
	if err := database.Ping(); err != nil {
		t.Fatal(err)
	}
	beforeBytes := count.received.Load()
	for i := 0; i < 20; i++ {
		if err := w.activeRuntime(context.Background(), initial.Revision, "fixture-model"); err != nil {
			t.Fatal(err)
		}
	}
	t.Logf("20 independently authorized live checks: %d PostgreSQL response bytes", count.received.Load()-beforeBytes)
	if calls := count.calls.Load(); calls != 20 {
		t.Fatalf("20 live checks made %d database reads; want 20", calls)
	}

	for _, change := range []string{
		`update byos_connections set paused=true where id=$1`,
		`update byos_connections set state='disconnected' where id=$1`,
		`update byos_connections set epoch=epoch+1 where id=$1`,
	} {
		if _, err := database.Exec(change, w.Scope.ConnectionID); err != nil {
			t.Fatal(err)
		}
		if err := w.activeRuntime(context.Background(), initial.Revision, "fixture-model"); err == nil {
			t.Fatal("changed authority allowed another chunk")
		}
		if _, err := database.Exec(`update byos_connections set paused=false,state='connected',epoch=$2 where id=$1`, w.Scope.ConnectionID, initial.Revision); err != nil {
			t.Fatal(err)
		}
	}
	original := w.Scope
	for _, changed := range []Scope{
		{OwnerID: "different-owner", WorkspaceID: original.WorkspaceID, ConnectionID: original.ConnectionID, Provider: original.Provider},
		{OwnerID: original.OwnerID, WorkspaceID: "different-workspace", ConnectionID: original.ConnectionID, Provider: original.Provider},
		{OwnerID: original.OwnerID, WorkspaceID: original.WorkspaceID, ConnectionID: original.ConnectionID, Provider: "codex"},
	} {
		w.Scope = changed
		if err := w.activeRuntime(context.Background(), initial.Revision, "fixture-model"); err == nil {
			t.Fatal("changed scope read authority")
		}
	}
	w.Scope = original
	if _, err := database.Exec(`delete from byos_bindings where id=$1`, w.Use.BindingID); err != nil {
		t.Fatal(err)
	}
	if err := w.activeRuntime(context.Background(), initial.Revision, "fixture-model"); err == nil {
		t.Fatal("deleted binding allowed another chunk")
	}
	if _, err := database.Exec(`delete from byos_oauth_attempts where "connectionId"=$1`, w.Scope.ConnectionID); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`delete from byos_connections where id=$1`, w.Scope.ConnectionID); err != nil {
		t.Fatal(err)
	}
	if err := w.activeRuntime(context.Background(), initial.Revision, "fixture-model"); err == nil {
		t.Fatal("deleted connection allowed another chunk")
	}
	w.Scope.ConnectionID = "invalid"
	before := count.calls.Load()
	if err := w.activeRuntime(context.Background(), initial.Revision, "fixture-model"); err == nil {
		t.Fatal("malformed scope accepted")
	}
	if count.calls.Load() != before {
		t.Fatal("malformed scope reached database")
	}
}

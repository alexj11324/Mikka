package worker

import (
	"context"
	"os"
	"testing"
	"time"
)

func TestAuthorityNotificationPayloadsAreScoped(t *testing.T) {
	connection := "11111111-1111-4111-8111-111111111111"
	binding := "22222222-2222-4222-8222-222222222222"
	run := "33333333-3333-4333-8333-333333333333"
	for _, test := range []struct {
		payload string
		want    bool
	}{
		{"connection:" + connection, true},
		{"binding:" + binding, true},
		{"run:" + run, true},
		{"connection:" + binding, false},
		{"", false},
	} {
		if got := authorityNotificationMatches(test.payload, connection, binding, run); got != test.want {
			t.Errorf("payload %q matched=%v, want %v", test.payload, got, test.want)
		}
	}
	if authorityNotificationMatches("run:"+run, connection, binding, "") {
		t.Fatal("run notification matched a non-run subscription")
	}
}

func TestRunLeaseExpiryCancelsWithoutPolling(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stop := runLeaseExpiryContext(time.Now().Add(20*time.Millisecond), cancel)
	defer stop()
	select {
	case <-ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("run lease expiry did not cancel the active stream")
	}
}

func TestAuthorityListenerUsesDirectNeonSessionWithoutChangingCredentials(t *testing.T) {
	input := "postgresql://user:secret@ep-example-pooler.us-east-1.aws.neon.tech/db?sslmode=require"
	cfg, err := authorityListenerConfig(input)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Host != "ep-example.us-east-1.aws.neon.tech" || cfg.User != "user" || cfg.Password != "secret" || cfg.Database != "db" || cfg.TLSConfig == nil {
		t.Fatalf("listener endpoint changed unexpected connection properties: host=%q user=%q database=%q", cfg.Host, cfg.User, cfg.Database)
	}
	if _, err := authorityListenerConfig("postgresql://user:secret@unexpected.neon.tech/db"); err == nil {
		t.Fatal("unrecognized Neon host was accepted")
	}
}

// The real isolated-Postgres acceptance proves that authorization changes are
// delivered after commit and that a fresh RPC must reauthorize after loss.
func assertAuthorityChangeCancels(t *testing.T, w *Worker, statement string, args ...any) {
	t.Helper()
	ctx, stop, listening := w.watchActiveAuthority(context.Background())
	if !listening {
		t.Fatal("direct Postgres LISTEN session was unavailable")
	}
	defer stop()
	if _, err := w.Repo.DB.Exec(statement, args...); err != nil {
		t.Fatal(err)
	}
	select {
	case <-ctx.Done():
	case <-time.After(3 * time.Second):
		t.Fatalf("committed authority change did not cancel stream: %s", statement)
	}
}

func TestAuthorityPushCancelsAndReconnectRequiresFreshAuthorization(t *testing.T) {
	databaseURL := os.Getenv("MIKKA_BYOS_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("isolated BYOS Postgres is required")
	}
	w, _, _ := fixtureWorker(t, "claude")
	initial := mustAcquire(t, w)
	w.DatabaseURL = databaseURL

	ctx, stop, listening := w.watchActiveAuthority(context.Background())
	if !listening {
		t.Fatal("direct Postgres LISTEN session was unavailable")
	}
	if err := w.authorizeRuntime(ctx, initial.Revision, "model", "fixture-model"); err != nil {
		stop()
		t.Fatal("initial authorization failed", err)
	}
	if _, err := w.Repo.DB.Exec(`update byos_connections set paused=true where id=$1`, w.Scope.ConnectionID); err != nil {
		stop()
		t.Fatal(err)
	}
	select {
	case <-ctx.Done():
	case <-time.After(3 * time.Second):
		stop()
		t.Fatal("committed pause did not cancel the active authority context")
	}
	if err := w.authorizeRuntime(ctx, initial.Revision, "model", "fixture-model"); err == nil {
		stop()
		t.Fatal("cancelled stream context remained usable")
	}
	stop()

	// LISTEN carries no replay. A new stream must get a new listener and a fresh
	// read; it cannot resume using the old authorization snapshot.
	freshCtx, freshStop, freshListening := w.watchActiveAuthority(context.Background())
	if !freshListening {
		t.Fatal("fresh direct Postgres LISTEN session was unavailable")
	}
	if err := w.authorizeRuntime(freshCtx, initial.Revision, "model", "fixture-model"); err == nil {
		freshStop()
		t.Fatal("new stream reused authorization after pause")
	}
	freshStop()

	// Changes to credential publication, quota, connection state/epoch and
	// the selected binding all terminate an active stream after commit.
	assertAuthorityChangeCancels(t, w, `update byos_connections set "credentialVersion"="credentialVersion"+1 where id=$1`, w.Scope.ConnectionID)
	if _, err := w.Repo.DB.Exec(`update byos_connections set "credentialVersion"="credentialVersion"-1 where id=$1`, w.Scope.ConnectionID); err != nil {
		t.Fatal(err)
	}
	assertAuthorityChangeCancels(t, w, `update byos_connections set quota=jsonb_set(quota, '{windows,0,used}', '0.3'::jsonb) where id=$1`, w.Scope.ConnectionID)
	if _, err := w.Repo.DB.Exec(`update byos_connections set quota=jsonb_set(quota, '{windows,0,used}', '0.2'::jsonb) where id=$1`, w.Scope.ConnectionID); err != nil {
		t.Fatal(err)
	}
	assertAuthorityChangeCancels(t, w, `update byos_connections set state='reconnect_required' where id=$1`, w.Scope.ConnectionID)
	if _, err := w.Repo.DB.Exec(`update byos_connections set state='connected' where id=$1`, w.Scope.ConnectionID); err != nil {
		t.Fatal(err)
	}
	assertAuthorityChangeCancels(t, w, `update byos_connections set epoch=epoch+1 where id=$1`, w.Scope.ConnectionID)
	if _, err := w.Repo.DB.Exec(`update byos_connections set epoch=epoch-1 where id=$1`, w.Scope.ConnectionID); err != nil {
		t.Fatal(err)
	}
	assertAuthorityChangeCancels(t, w, `update byos_bindings set "modelId"='revoked-model' where id=$1`, w.Use.BindingID)
	if _, err := w.Repo.DB.Exec(`update byos_bindings set "modelId"='fixture-model' where id=$1`, w.Use.BindingID); err != nil {
		t.Fatal(err)
	}

	// Run stop is an active authorization change on a native stream. Its
	// lease expires without a write, so the watcher arms a local expiry timer.
	if _, err := w.Repo.DB.Exec(`update byos_connections set paused=false where id=$1`, w.Scope.ConnectionID); err != nil {
		t.Fatal(err)
	}
	runID := bindNativeRunFixture(t, w, initial.Revision, "claude_code_cli")
	runCtx, runStop, runListening := w.watchActiveAuthority(context.Background())
	if !runListening {
		t.Fatal("native run listener was unavailable")
	}
	if err := w.authorizeRuntime(runCtx, initial.Revision, "native", "fixture-model"); err != nil {
		runStop()
		t.Fatal("initial native run authorization failed", err)
	}
	if _, err := w.Repo.DB.Exec(`update agent_runs set "stopRequestedAt"=now() where id=$1`, runID); err != nil {
		runStop()
		t.Fatal(err)
	}
	select {
	case <-runCtx.Done():
	case <-time.After(3 * time.Second):
		runStop()
		t.Fatal("committed run stop did not cancel the active stream")
	}
	runStop()
}

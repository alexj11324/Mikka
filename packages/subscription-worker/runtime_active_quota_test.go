package worker

import (
	"context"
	"database/sql"
	"encoding/json"
	"net"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
)

func TestActiveChecksOmitUnusedQuotaButAdmissionStillEnforcesIt(t *testing.T) {
	for _, native := range []bool{false, true} {
		name := "active"
		if native {
			name = "native_active"
		}
		t.Run(name, func(t *testing.T) {
			w, _, _ := fixtureWorker(t, "claude")
			initial := mustAcquire(t, w)
			admission := "model"
			if native {
				bindFixture(t, w, initial.Revision, "claude_code_cli")
				admission = "native"
			}
			config, err := pgx.ParseConfig(os.Getenv("MIKKA_BYOS_TEST_DATABASE_URL"))
			if err != nil {
				t.Fatal("isolated test configuration unavailable")
			}
			count := &streamQueryCounter{}
			config.Tracer = count
			config.DialFunc = func(ctx context.Context, network, address string) (net.Conn, error) {
				conn, e := (&net.Dialer{}).DialContext(ctx, network, address)
				if e != nil {
					return nil, e
				}
				return streamCountedConnection{conn, count}, nil
			}
			key := stdlib.RegisterConnConfig(config)
			defer stdlib.UnregisterConnConfig(key)
			database, err := sql.Open("pgx", key)
			if err != nil {
				t.Fatal(err)
			}
			defer database.Close()
			w.Repo = &Repository{DB: database}
			quota := map[string]any{"vendor": "claude_code", "status": "ok", "observedAt": time.Now().UTC().Format(time.RFC3339Nano), "windows": []map[string]any{{"used": .2}}, "syntheticPadding": strings.Repeat("SYNTHETIC_PRIVATE", 8192)}
			raw, _ := json.Marshal(quota)
			if _, err = database.Exec(`update byos_connections set quota=$2 where id=$1`, w.Scope.ConnectionID, raw); err != nil {
				t.Fatal(err)
			}
			for _, execution := range []string{name, admission} {
				if err = w.authorizeRuntime(context.Background(), initial.Revision, execution, "fixture-model"); err != nil {
					t.Fatal(err)
				}
			}
			before := count.received.Load()
			if err = w.authorizeRuntime(context.Background(), initial.Revision, name, "fixture-model"); err != nil {
				t.Fatal(err)
			}
			activeBytes := count.received.Load() - before
			before = count.received.Load()
			if err = w.authorizeRuntime(context.Background(), initial.Revision, admission, "fixture-model"); err != nil {
				t.Fatal(err)
			}
			admissionBytes := count.received.Load() - before
			t.Logf("active check %d vs admission %d protocol response bytes for synthetic quota", activeBytes, admissionBytes)
			if activeBytes >= 4096 || activeBytes >= admissionBytes/100 {
				t.Fatal("active stream still fetched unused quota payload")
			}
			quota["windows"] = []map[string]any{{"used": 1.0}}
			raw, _ = json.Marshal(quota)
			if _, err = database.Exec(`update byos_connections set quota=$2 where id=$1`, w.Scope.ConnectionID, raw); err != nil {
				t.Fatal(err)
			}
			if err = w.authorizeRuntime(context.Background(), initial.Revision, admission, "fixture-model"); err == nil {
				t.Fatal("exhausted quota was not enforced at admission")
			}
			if err = w.authorizeRuntime(context.Background(), initial.Revision, name, "fixture-model"); err != nil {
				t.Fatal("active check changed existing quota semantics")
			}
			if _, err = database.Exec(`update byos_connections set paused=true where id=$1`, w.Scope.ConnectionID); err != nil {
				t.Fatal(err)
			}
			if err = w.authorizeRuntime(context.Background(), initial.Revision, name, "fixture-model"); err == nil {
				t.Fatal("paused connection continued streaming")
			}
		})
	}
}

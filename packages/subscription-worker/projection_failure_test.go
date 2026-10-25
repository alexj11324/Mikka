package worker

import (
	"context"
	"strings"
	"testing"
)

type projectionReadFailure struct {
	SecretStore
	calls, failAt int
	beforeFailure func()
}

func (s *projectionReadFailure) Read(ctx context.Context, name string) ([]byte, error) {
	s.calls++
	if s.calls == s.failAt {
		if s.beforeFailure != nil {
			s.beforeFailure()
		}
		return nil, ErrStore
	}
	return s.SecretStore.Read(ctx, name)
}

func TestLegacyProjectionPreStageFailureIsDurableAndReconnectable(t *testing.T) {
	for _, failAt := range []int{1, 2} {
		t.Run(map[int]string{1: "initial_read", 2: "save_read"}[failAt], func(t *testing.T) {
			w, _, issuer := fixtureWorker(t, "codex")
			initial := mustAcquire(t, w)
			ctx := context.Background()
			if _, err := w.Repo.DB.Exec(`update byos_connections set "accessSecretName"=null,"accessDigest"=null where id=$1`, w.Scope.ConnectionID); err != nil {
				t.Fatal(err)
			}
			original := w.Secrets
			w.Secrets = &projectionReadFailure{SecretStore: original, failAt: failAt}
			if _, err := w.PrepareRuntime(ctx, initial.Revision); err != ErrStore {
				t.Fatal("wrong failure", err)
			}
			r, err := w.Repo.Lookup(ctx, w.Scope)
			if err != nil || r.State != "reconnect_required" {
				t.Fatal("failure stranded operation", r.State, err)
			}
			var code string
			if err = w.Repo.DB.QueryRow(`select "lastErrorCode" from byos_connections where id=$1`, w.Scope.ConnectionID).Scan(&code); err != nil || code != "publication_failed" {
				t.Fatal("failure not persisted", err)
			}
			if _, err = w.Execute(ctx, initial.Revision, "fixture-model", nil); err != ErrUnavailable {
				t.Fatal("failed projection remained usable", err)
			}
			w.Secrets = original
			recovered, err := w.Acquire(ctx, initial.Revision)
			if err != nil || recovered.State != "connected" || recovered.Revision <= initial.Revision {
				t.Fatal("explicit reconnect failed", err)
			}
			if issuer.refreshes.Load() != 0 {
				t.Fatal("projection replayed upstream refresh")
			}
		})
	}
}

func TestLegacyProjectionFailurePersistenceErrorIsNotHidden(t *testing.T) {
	w, _, _ := fixtureWorker(t, "codex")
	initial := mustAcquire(t, w)
	if _, err := w.Repo.DB.Exec(`update byos_connections set "accessSecretName"=null,"accessDigest"=null where id=$1`, w.Scope.ConnectionID); err != nil {
		t.Fatal(err)
	}
	// A real PG trigger rejects only this connection's failure transition.
	fn := "projection_fail_" + strings.ReplaceAll(newID(), "-", "")
	sql := `create function ` + fn + `() returns trigger language plpgsql as $$ begin if NEW.id='` + w.Scope.ConnectionID + `' and NEW.state='reconnect_required' then raise exception 'fixture persistence failure'; end if; return NEW; end $$; create trigger ` + fn + ` before update on byos_connections for each row execute function ` + fn + `() `
	if _, err := w.Repo.DB.Exec(sql); err != nil {
		t.Fatal(err)
	}
	defer w.Repo.DB.Exec(`drop trigger ` + fn + ` on byos_connections; drop function ` + fn + `() `)
	w.Secrets = &projectionReadFailure{SecretStore: w.Secrets, failAt: 1}
	if _, err := w.PrepareRuntime(context.Background(), initial.Revision); err != ErrDatabase {
		t.Fatal("persistence failure hidden", err)
	}
}

func TestLegacyProjectionCancellationStillPersistsFailure(t *testing.T) {
	w, _, _ := fixtureWorker(t, "codex")
	initial := mustAcquire(t, w)
	if _, err := w.Repo.DB.Exec(`update byos_connections set "accessSecretName"=null,"accessDigest"=null where id=$1`, w.Scope.ConnectionID); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	w.Secrets = &projectionReadFailure{SecretStore: w.Secrets, failAt: 1, beforeFailure: cancel}
	if _, err := w.PrepareRuntime(ctx, initial.Revision); err != ErrStore {
		t.Fatal("unexpected cancellation result", err)
	}
	r, err := w.Repo.Lookup(context.Background(), w.Scope)
	if err != nil || r.State != "reconnect_required" {
		t.Fatal("cancellation stranded projection", r.State, err)
	}
}

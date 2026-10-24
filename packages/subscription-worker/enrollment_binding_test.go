package worker

import (
	"context"
	"encoding/json"
	core "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func enrollmentBindingFixture(t *testing.T) (*EnrollmentBinder, *enrollmentOAuth, string, *enrollmentMemory, *enrollmentMemory) {
	t.Helper()
	e, o, _, _, _ := enrollmentFixture()
	start, err := e.Start(context.Background(), "operator:fixture-principal")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = e.Complete(context.Background(), "operator:fixture-principal", start.ID, enrollmentCallback(start)); err != nil {
		t.Fatal(err)
	}
	canonical, access := &enrollmentMemory{values: map[string][]byte{}}, &enrollmentMemory{values: map[string][]byte{}}
	return &EnrollmentBinder{Enrollment: e, Repo: &Repository{DB: testDB(t)}, Secrets: canonical, AccessSecrets: access, DatabaseIdentity: hashText("fixture-target-database")}, o, start.ID, canonical, access
}

type enrollmentRefresh struct {
	CPAClaudeLifecycle
	calls atomic.Int32
}

func (x *enrollmentRefresh) Refresh(_ context.Context, a *core.Auth) (*core.Auth, error) {
	x.calls.Add(1)
	next := a.Clone()
	next.Metadata = cloneMap(a.Metadata)
	next.Metadata["access_token"] = "fixture-rotated-access"
	next.Metadata["refresh_token"] = "fixture-rotated-refresh"
	next.Metadata["expired"] = time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	return next, nil
}
func TestEnrollmentBindingPublishesOneOwnedConnectionAndReusesRefresh(t *testing.T) {
	b, o, id, canonical, access := enrollmentBindingFixture(t)
	ctx := context.Background()
	owner, workspace := "fixture-owner-"+newID(), newID()
	meta, err := b.Bind(ctx, "operator:fixture-principal", id, owner, workspace)
	if err != nil || meta.State != "connected" || meta.Revision != 2 || meta.CredentialVersion != 1 {
		t.Fatal("binding failed", err)
	}
	if len(canonical.values) != 1 || len(access.values) != 1 || o.calls.Load() != 1 {
		t.Fatal("unexpected grant acquisition/publication")
	}
	scope := Scope{OwnerID: owner, WorkspaceID: workspace, ConnectionID: meta.ID, Provider: "claude"}
	var full bundle
	for _, raw := range canonical.values {
		if json.Unmarshal(raw, &full) != nil {
			t.Fatal("bad canonical bundle")
		}
	}
	if full.OwnerID != owner || full.WorkspaceID != workspace || full.Payload["refresh_token"] != "fixture-enrollment-refresh" {
		t.Fatal("owner or refresh grant lost")
	}
	for _, raw := range access.values {
		var a bundle
		_ = json.Unmarshal(raw, &a)
		if _, ok := a.Payload["refresh_token"]; ok {
			t.Fatal("refresh grant entered access projection")
		}
	}
	if _, err = b.Enrollment.Grants.Read(ctx, "mikka-byos-"+id); err != nil {
		t.Fatal("sole escrow was deleted")
	}
	if repeated, err := b.Bind(ctx, "operator:fixture-principal", id, owner, workspace); err != nil || repeated.ID != meta.ID || len(canonical.values) != 1 {
		t.Fatal("idempotent binding changed connection", err)
	}
	x := &enrollmentRefresh{}
	w := Worker{Repo: b.Repo, Scope: scope, Secrets: canonical, AccessSecrets: access, Executor: x}
	bindFixture(t, &w, meta.Revision, "claude_cpa")
	rotated, err := w.Refresh(ctx, meta.Revision)
	if err != nil || rotated.Revision != meta.Revision || rotated.CredentialVersion != 2 || x.calls.Load() != 1 || o.calls.Load() != 1 {
		t.Fatal("refresh did not reuse imported grant", err)
	}
	if err = w.authorizeRuntime(ctx, meta.Revision, "model", "fixture-model"); err != nil {
		t.Fatal("routine refresh invalidated binding", err)
	}
	if repeated, err := b.Bind(ctx, "operator:fixture-principal", id, owner, workspace); err != nil || repeated.CredentialVersion != 2 || x.calls.Load() != 1 {
		t.Fatal("migration replay overwrote refresh", err)
	}
	if _, err = b.Bind(ctx, "operator:fixture-principal", id, "another-owner", workspace); err == nil {
		t.Fatal("cross-owner migration allowed")
	}
	if _, err = b.Bind(ctx, "operator:other-principal", id, owner, workspace); err == nil {
		t.Fatal("source principal bypass")
	}
	if err = w.Repo.Disconnect(ctx, scope, meta.Revision); err != nil {
		t.Fatal(err)
	}
	if _, err = b.Bind(ctx, "operator:fixture-principal", id, owner, workspace); err == nil {
		t.Fatal("old migration resurrected disconnect")
	}
}

type enrollmentDelayedStore struct {
	SecretStore
	entered, release chan struct{}
}

func (s enrollmentDelayedStore) Create(ctx context.Context, name string, raw []byte) error {
	close(s.entered)
	select {
	case <-s.release:
	case <-ctx.Done():
		return ctx.Err()
	}
	return s.SecretStore.Create(ctx, name, raw)
}
func TestEnrollmentBindingLatePublicationCannotUndoDisconnect(t *testing.T) {
	b, _, id, canonical, _ := enrollmentBindingFixture(t)
	ctx := context.Background()
	owner, workspace := "fixture-owner-"+newID(), newID()
	entered, release := make(chan struct{}), make(chan struct{})
	b.Secrets = enrollmentDelayedStore{canonical, entered, release}
	finished := make(chan error, 1)
	go func() { _, err := b.Bind(ctx, "operator:fixture-principal", id, owner, workspace); finished <- err }()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("publication did not reach controlled store")
	}
	var connection string
	if err := b.Repo.DB.QueryRow(`select "connectionId"::text from byos_enrollment_transfers where "enrollmentId"=$1`, id).Scan(&connection); err != nil {
		t.Fatal(err)
	}
	scope := Scope{OwnerID: owner, WorkspaceID: workspace, ConnectionID: connection, Provider: "claude"}
	before, err := b.Repo.Lookup(ctx, scope)
	if err != nil {
		t.Fatal(err)
	}
	if err = b.Repo.Disconnect(ctx, scope, before.Epoch); err != nil {
		t.Fatal(err)
	}
	close(release)
	if err = <-finished; err == nil {
		t.Fatal("late publication reported connection")
	}
	after, _ := b.Repo.Lookup(ctx, scope)
	if after.State != "disconnected" || after.Epoch != before.Epoch+1 {
		t.Fatal("late publication resurrected connection")
	}
	b.Secrets = canonical
	if _, err = b.Bind(ctx, "operator:fixture-principal", id, owner, workspace); err == nil {
		t.Fatal("old transfer retried after disconnect")
	}
	if _, err = b.Enrollment.Grants.Read(ctx, "mikka-byos-"+id); err != nil {
		t.Fatal("failed migration deleted sole escrow")
	}
}
func TestEnrollmentBindingResumesExpiredOriginalReservationWithoutNewEpoch(t *testing.T) {
	b, _, id, _, _ := enrollmentBindingFixture(t)
	ctx := context.Background()
	owner, workspace := "fixture-owner-"+newID(), newID()
	raw, err := b.Enrollment.Grants.Read(ctx, "mikka-byos-"+id)
	if err != nil {
		t.Fatal(err)
	}
	var g enrollmentGrant
	_ = json.Unmarshal(raw, &g)
	tx, err := b.reserve(ctx, id, "operator:fixture-principal", owner, workspace, hashText(string(raw)), (bundle{Provider: "claude", Payload: g.Payload}).subject())
	if err != nil {
		t.Fatal(err)
	}
	if _, err = b.Repo.DB.Exec(`update byos_connections set "operationDeadline"=now()-interval '1 minute' where id=$1`, tx.Scope.ConnectionID); err != nil {
		t.Fatal(err)
	}
	meta, err := b.Bind(ctx, "operator:fixture-principal", id, owner, workspace)
	if err != nil || meta.ID != tx.Scope.ConnectionID || meta.Revision != tx.Epoch {
		t.Fatal("reservation restarted instead of resuming", err)
	}
}
func TestEnrollmentBindingRecoversExactStagedGrantAndProjection(t *testing.T) {
	for _, failed := range []string{"grant", "access"} {
		t.Run(failed, func(t *testing.T) {
			b, o, id, canonical, access := enrollmentBindingFixture(t)
			ctx := context.Background()
			owner, workspace := "fixture-owner-"+newID(), newID()
			if failed == "grant" {
				canonical.fail = true
			} else {
				access.fail = true
			}
			if _, err := b.Bind(ctx, "operator:fixture-principal", id, owner, workspace); err == nil {
				t.Fatal("failed store reported success")
			}
			var connection, operation string
			var epoch int64
			if err := b.Repo.DB.QueryRow(`select "connectionId"::text,"operationId"::text,epoch from byos_enrollment_transfers where "enrollmentId"=$1`, id).Scan(&connection, &operation, &epoch); err != nil {
				t.Fatal(err)
			}
			scope := Scope{OwnerID: owner, WorkspaceID: workspace, ConnectionID: connection, Provider: "claude"}
			before, err := b.Repo.Lookup(ctx, scope)
			if err != nil || before.State != "publication_pending" {
				t.Fatal("missing staged recovery", err)
			}
			canonical.fail = false
			access.fail = false
			meta, err := b.Bind(ctx, "operator:fixture-principal", id, owner, workspace)
			if err != nil || meta.ID != connection || meta.Revision != epoch || meta.CredentialVersion != 1 {
				t.Fatal("migration recovery failed", err)
			}
			after, _ := b.Repo.Lookup(ctx, scope)
			if after.SecretName != before.StagedName || after.AccessName != before.StagedAccessName || o.calls.Load() != 1 {
				t.Fatal("recovery changed staged names or OAuth")
			}
			if _, err = b.Enrollment.Grants.Read(ctx, "mikka-byos-"+id); err != nil {
				t.Fatal("recovery lost escrow")
			}
		})
	}
}
func TestEnrollmentBindingRefusesReconnectAndIndependentTargetDatabase(t *testing.T) {
	b, _, id, _, _ := enrollmentBindingFixture(t)
	ctx := context.Background()
	owner, workspace := "fixture-owner-"+newID(), newID()
	meta, err := b.Bind(ctx, "operator:fixture-principal", id, owner, workspace)
	if err != nil {
		t.Fatal(err)
	}
	other := *b
	other.DatabaseIdentity = hashText("different-preview-database")
	if _, err = other.Bind(ctx, "operator:fixture-principal", id, owner, workspace); err == nil {
		t.Fatal("cloned ledger accepted different DB identity")
	}
	scope := Scope{OwnerID: owner, WorkspaceID: workspace, ConnectionID: meta.ID, Provider: "claude"}
	if _, err = b.Repo.BeginAcquire(ctx, scope, meta.Revision); err != nil {
		t.Fatal(err)
	}
	if _, err = b.Bind(ctx, "operator:fixture-principal", id, owner, workspace); err == nil {
		t.Fatal("old migration accepted explicit reconnect")
	}
}
func TestEnrollmentBindingGlobalClaimSurvivesMetadataLoss(t *testing.T) {
	b, _, id, canonical, _ := enrollmentBindingFixture(t)
	ctx := context.Background()
	owner, workspace := "fixture-owner-"+newID(), newID()
	if _, err := b.Bind(ctx, "operator:fixture-principal", id, owner, workspace); err != nil {
		t.Fatal(err)
	}
	writes := canonical.writes
	// Remove only this fixture's local transfer row to simulate another empty
	// metadata target. The independent immutable vault claim must still win.
	if _, err := b.Repo.DB.Exec(`delete from byos_enrollment_transfers where "enrollmentId"=$1`, id); err != nil {
		t.Fatal(err)
	}
	other := *b
	other.DatabaseIdentity = hashText("fresh-target-database")
	if _, err := other.Bind(ctx, "operator:fixture-principal", id, "second-owner", newID()); err == nil || canonical.writes != writes {
		t.Fatal("global claim allowed second ownership")
	}
}
func TestEnrollmentBindingConcurrentRequestsNeverCreateTwoConnections(t *testing.T) {
	b, _, id, _, _ := enrollmentBindingFixture(t)
	ctx := context.Background()
	owner, workspace := "fixture-owner-"+newID(), newID()
	var wg sync.WaitGroup
	for range 5 {
		wg.Add(1)
		go func() { defer wg.Done(); _, _ = b.Bind(ctx, "operator:fixture-principal", id, owner, workspace) }()
	}
	wg.Wait()
	if _, err := b.Bind(ctx, "operator:fixture-principal", id, owner, workspace); err != nil {
		t.Fatal("safe concurrent migration could not settle", err)
	}
	var count int
	if err := b.Repo.DB.QueryRow(`select count(*) from byos_enrollment_transfers where "enrollmentId"=$1`, id).Scan(&count); err != nil || count != 1 {
		t.Fatal("duplicated transfer", err)
	}
}

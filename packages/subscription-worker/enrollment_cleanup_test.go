package worker

import (
	"context"
	"encoding/json"
	core "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	"testing"
)

func enrollmentWorker(b *EnrollmentBinder, scope Scope) *Worker {
	return &Worker{Repo: b.Repo, Scope: scope, Secrets: b.Secrets, AccessSecrets: b.AccessSecrets, Enrollment: b.Enrollment, DatabaseIdentity: b.DatabaseIdentity}
}
func reserveEnrollment(t *testing.T, b *EnrollmentBinder, id string, claim bool) enrollmentTransfer {
	t.Helper()
	raw, err := b.Enrollment.Grants.Read(context.Background(), "mikka-byos-"+id)
	if err != nil {
		t.Fatal(err)
	}
	var g enrollmentGrant
	if json.Unmarshal(raw, &g) != nil {
		t.Fatal("invalid fixture")
	}
	x, err := b.reserve(context.Background(), id, "operator:fixture-principal", "fixture-owner-"+newID(), newID(), hashText(string(raw)), (bundle{Provider: "claude", Payload: g.Payload}).subject())
	if err != nil {
		t.Fatal(err)
	}
	if claim {
		raw, _ = json.Marshal(x)
		if err = b.Enrollment.Claims.Create(context.Background(), bindingClaimName(id), raw); err != nil {
			t.Fatal(err)
		}
	}
	return x
}
func TestEnrollmentCleanupPreservesOnlyRecoveryCopyUntilPublicationOrExplicitDisconnect(t *testing.T) {
	b, _, id, _, _ := enrollmentBindingFixture(t)
	ctx := context.Background()
	x := reserveEnrollment(t, b, id, true)
	w := enrollmentWorker(b, x.Scope)
	status, err := w.Cleanup(ctx)
	if err != nil || status.Enrollment == nil || status.Enrollment.Protected != 2 || status.Enrollment.State != "awaiting_publication" {
		t.Fatal("unpublished recovery not protected", status, err)
	}
	if _, err = b.Enrollment.Grants.Read(ctx, "mikka-byos-"+id); err != nil {
		t.Fatal("only grant deleted")
	}
	if err = b.Repo.Disconnect(ctx, x.Scope, x.Epoch); err != nil {
		t.Fatal(err)
	}
	status, err = w.Cleanup(ctx)
	if err != nil || status.Pending != 0 || status.Enrollment.State != "complete" || status.ProviderRevocation != "not_implemented" {
		t.Fatal("explicit disconnect failed to clean owned source", status, err)
	}
	if _, err = b.Enrollment.Grants.Read(ctx, "mikka-byos-"+id); err != ErrMissing {
		t.Fatal("source retained")
	}
	if _, err = b.Bind(ctx, x.Principal, id, x.Scope.OwnerID, x.Scope.WorkspaceID); err == nil {
		t.Fatal("old epoch resurrected")
	}
}
func TestEnrollmentCleanupFailureRetriesAllCopiesAfterImmediateDisconnectFence(t *testing.T) {
	b, _, id, canonical, access := enrollmentBindingFixture(t)
	ctx := context.Background()
	grants := b.Enrollment.Grants.(*enrollmentMemory)
	attempts := b.Enrollment.Attempts.(*enrollmentMemory)
	grants.deleteFail = true
	attempts.deleteFail = true
	meta, err := b.Bind(ctx, "operator:fixture-principal", id, "fixture-owner-"+newID(), newID())
	if err != nil || meta.Cleanup == nil || meta.Cleanup.Enrollment.Failed != 2 {
		t.Fatal("cleanup failure hidden", meta, err)
	}
	var scope Scope // Load the authoritative fixture owner, never caller-supplied replacements.
	if err = b.Repo.DB.QueryRow(`select "ownerId","workspaceId",id::text,provider from byos_connections where id=$1`, meta.ID).Scan(&scope.OwnerID, &scope.WorkspaceID, &scope.ConnectionID, &scope.Provider); err != nil {
		t.Fatal(err)
	}
	w := enrollmentWorker(b, scope)
	canonical.deleteFail = true
	access.deleteFail = true
	disconnected, err := w.Disconnect(ctx, meta.Revision)
	if err != nil || disconnected.State != "disconnected" || disconnected.Cleanup == nil || disconnected.Cleanup.Failed != 4 {
		t.Fatal("disconnect falsely claimed deletion", disconnected, err)
	}
	current, err := b.Repo.Lookup(ctx, scope)
	if err != nil || current.Epoch <= meta.Revision || current.SecretName != "" || current.AccessName != "" {
		t.Fatal("use not fenced before cleanup")
	}
	grants.deleteFail = false
	attempts.deleteFail = false
	canonical.deleteFail = false
	access.deleteFail = false
	status, err := w.Cleanup(ctx)
	if err != nil || status.Pending != 0 || status.Failed != 0 || len(canonical.values) != 0 || len(access.values) != 0 {
		t.Fatal("retry did not purge all copies", status, err)
	}
	if len(grants.values) != 0 || len(attempts.values) != 0 || len(b.Enrollment.Claims.(*enrollmentMemory).values) != 3 {
		t.Fatal("token-bearing copies retained or immutable metadata lost")
	}
}
func TestEnrollmentCleanupRequiresGlobalClaimAndConfiguredDatabaseIdentity(t *testing.T) {
	b, _, id, _, _ := enrollmentBindingFixture(t)
	ctx := context.Background()
	x := reserveEnrollment(t, b, id, false)
	if err := b.Repo.Disconnect(ctx, x.Scope, x.Epoch); err != nil {
		t.Fatal(err)
	}
	w := enrollmentWorker(b, x.Scope)
	status, err := w.Cleanup(ctx)
	if err != nil || status.Enrollment.State != "ownership_unconfirmed" {
		t.Fatal("local reservation became deletion authority", status, err)
	}
	grants := b.Enrollment.Grants.(*enrollmentMemory)
	if grants.deletes != 0 || len(grants.values) != 1 {
		t.Fatal("losing database deleted shared grant")
	}
	raw, _ := json.Marshal(x)
	if err = b.Enrollment.Claims.Create(ctx, bindingClaimName(id), raw); err != nil {
		t.Fatal(err)
	}
	w.DatabaseIdentity = hashText("another-database")
	status, err = w.Cleanup(ctx)
	if err != nil || status.Enrollment.State != "ownership_unconfirmed" || grants.deletes != 0 {
		t.Fatal("database identity bypass", status, err)
	}
	w.DatabaseIdentity = b.DatabaseIdentity
	w.Enrollment = nil
	if _, err = b.Repo.DB.Exec(`update byos_enrollment_sources set "lastAttemptAt"=null where "connectionId"=$1`, x.Scope.ConnectionID); err != nil {
		t.Fatal(err)
	}
	status, err = w.Cleanup(ctx)
	if err != nil || status.Enrollment.State != "configuration_required" || grants.deletes != 0 {
		t.Fatal("missing source configuration hidden", status, err)
	}
	var unattempted int
	if err = b.Repo.DB.QueryRow(`select count(*) from byos_enrollment_sources where "connectionId"=$1 and "lastAttemptAt" is null`, x.Scope.ConnectionID).Scan(&unattempted); err != nil || unattempted != 0 {
		t.Fatal("unconfigured source can starve later jobs", err)
	}
	w.Enrollment = b.Enrollment
	status, err = w.Cleanup(ctx)
	if err != nil || status.Pending != 0 {
		t.Fatal("proof/config recovery failed", status, err)
	}
}
func TestEnrollmentCleanupPublicationProofSurvivesDisconnectBeforeBoundMarker(t *testing.T) {
	b, _, id, _, _ := enrollmentBindingFixture(t)
	ctx := context.Background()
	x := reserveEnrollment(t, b, id, true)
	raw, _ := b.Enrollment.Grants.Read(ctx, "mikka-byos-"+id)
	var g enrollmentGrant
	_ = json.Unmarshal(raw, &g)
	r, err := b.Repo.Lookup(ctx, x.Scope)
	if err != nil {
		t.Fatal(err)
	}
	op := Operation{r}
	store := Store{Repo: b.Repo, Scope: x.Scope, Secrets: b.Secrets, AccessSecrets: b.AccessSecrets, Operation: &op}
	if _, err = store.Save(ctx, &core.Auth{ID: x.Scope.ConnectionID, Provider: "claude", Metadata: g.Payload}); err != nil {
		t.Fatal(err)
	}
	var published, bound bool
	if err = b.Repo.DB.QueryRow(`select "canonicalPublishedAt" is not null,"boundAt" is not null from byos_enrollment_transfers where "enrollmentId"=$1`, id).Scan(&published, &bound); err != nil || !published || bound {
		t.Fatal("publication proof not atomic", err)
	}
	if err = b.Repo.Disconnect(ctx, x.Scope, x.Epoch); err != nil {
		t.Fatal(err)
	}
	status, err := enrollmentWorker(b, x.Scope).Cleanup(ctx)
	if err != nil || status.Pending != 0 {
		t.Fatal("publish/finish race leaked source", status, err)
	}
}

// Simulate a timed-out HTTP create committing after a later successful create
// and cleanup. Only synthetic bytes are held; no provider/vault is contacted.
type enrollmentLateCreate struct {
	*enrollmentMemory
	lateName string
	lateRaw  []byte
	first    bool
}

func (s *enrollmentLateCreate) Create(ctx context.Context, name string, raw []byte) error {
	if !s.first {
		s.first = true
		s.lateName = name
		s.lateRaw = append([]byte{}, raw...)
		return ErrCreateUncertain
	}
	return s.enrollmentMemory.Create(ctx, name, raw)
}
func TestEnrollmentCleanupUnknownAndLateCreatesNeverReportFullyDeleted(t *testing.T) {
	for _, legacy := range []bool{false, true} {
		t.Run(map[bool]string{false: "uncertain_late_commit", true: "legacy_missing_receipt"}[legacy], func(t *testing.T) {
			b, _, _, _, _ := enrollmentBindingFixture(t)
			e, _, _, claims, grants := enrollmentFixture()
			b.Enrollment = e
			ctx := context.Background()
			late := &enrollmentLateCreate{enrollmentMemory: grants}
			if !legacy {
				e.Grants = late
			}
			start, err := e.Start(ctx, "operator:fixture-principal")
			if err != nil {
				t.Fatal(err)
			}
			if _, err = e.Complete(ctx, "operator:fixture-principal", start.ID, enrollmentCallback(start)); err != nil {
				t.Fatal(err)
			}
			if legacy {
				name := enrollmentCreationName(start.ID)
				if err := retainFixtureValue(name, claims.values[name]); err != nil {
					t.Fatal(err)
				}
				delete(claims.values, name)
			}
			meta, err := b.Bind(ctx, "operator:fixture-principal", start.ID, "fixture-owner-"+newID(), newID())
			if err != nil || meta.Cleanup.Enrollment.State != "creation_outcome_unknown" || meta.Cleanup.Uncertain == 0 {
				t.Fatal("uncertainty hidden", meta, err)
			}
			if _, err = e.Grants.Read(ctx, "mikka-byos-"+start.ID); err != ErrMissing {
				t.Fatal("first cleanup did not delete")
			}
			if !legacy {
				if err := retainFixtureValue(late.lateName, late.lateRaw); err != nil {
					t.Fatal(err)
				}
				grants.mu.Lock()
				grants.values[late.lateName] = late.lateRaw
				grants.mu.Unlock()
			}
			var scope Scope
			if err = b.Repo.DB.QueryRow(`select "ownerId","workspaceId",id::text,provider from byos_connections where id=$1`, meta.ID).Scan(&scope.OwnerID, &scope.WorkspaceID, &scope.ConnectionID, &scope.Provider); err != nil {
				t.Fatal(err)
			}
			status, err := enrollmentWorker(b, scope).Cleanup(ctx)
			if err != nil || status.Enrollment.Pending == 0 || status.Uncertain == 0 || status.Enrollment.State != "creation_outcome_unknown" || len(grants.values) != 0 {
				t.Fatal("late remote commit escaped repeat deletion", status, err)
			}
			if _, err = b.Bind(ctx, "operator:fixture-principal", start.ID, scope.OwnerID, scope.WorkspaceID); err != nil {
				t.Fatal("uncertain cleanup broke connected reuse", err)
			}
		})
	}
}

func TestEnrollmentRetentionBlocksImplicitBindingAndCleanupDeletion(t *testing.T) {
	b, _, id, _, _ := enrollmentBindingFixture(t)
	b.Enrollment.RetainSources = true
	ctx := context.Background()
	attempts := b.Enrollment.Attempts.(*enrollmentMemory)
	before := attempts.deletes
	owner, workspace := "fixture-owner-"+newID(), newID()
	meta, err := b.Bind(ctx, "operator:fixture-principal", id, owner, workspace)
	if err != nil || meta.Cleanup.Enrollment.State != "deletion_not_authorized" || meta.Cleanup.Enrollment.Pending != 2 {
		t.Fatal("binding bypassed explicit retention", meta, err)
	}
	w := enrollmentWorker(b, Scope{OwnerID: owner, WorkspaceID: workspace, ConnectionID: meta.ID, Provider: "claude"})
	disconnected, err := w.Disconnect(ctx, meta.Revision)
	if err != nil || disconnected.State != "disconnected" || disconnected.Cleanup.Enrollment.State != "deletion_not_authorized" {
		t.Fatal("disconnect retention/status regressed", err)
	}
	if _, err = w.Cleanup(ctx); err != nil {
		t.Fatal(err)
	}
	if attempts.deletes != before || b.Enrollment.Grants.(*enrollmentMemory).deletes != 0 {
		t.Fatal("cleanup bypassed retained source policy")
	}
	b.Enrollment.RetainSources = false // Local synthetic fixture simulates a later specifically approved cleanup.
	status, err := w.Cleanup(ctx)
	if err != nil || status.Pending != 0 {
		t.Fatal("explicitly authorized cleanup regressed", status, err)
	}
}

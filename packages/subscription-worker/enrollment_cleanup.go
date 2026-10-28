package worker

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"time"
)

type EnrollmentCleanupStatus struct {
	Pending   int    `json:"pending"`
	Failed    int    `json:"failed"`
	Protected int    `json:"protected"`
	Uncertain int    `json:"uncertainCreates"`
	State     string `json:"state"`
}

func (b *EnrollmentBinder) existing(ctx context.Context, id, principal, owner, workspace string) (enrollmentTransfer, bool, error) {
	t := enrollmentTransfer{EnrollmentID: id}
	var storedOwner, storedWorkspace string
	err := b.Repo.DB.QueryRowContext(ctx, `select "transferId"::text,"connectionId"::text,"ownerId","workspaceId",principal,"databaseIdentity","escrowDigest","providerSubject",epoch,"operationId"::text,"boundAt" is not null from byos_enrollment_transfers where "enrollmentId"=$1`, id).Scan(&t.TransferID, &t.Scope.ConnectionID, &storedOwner, &storedWorkspace, &t.Principal, &t.DatabaseIdentity, &t.EscrowDigest, &t.Subject, &t.Epoch, &t.OperationID, &t.Bound)
	if err == sql.ErrNoRows {
		return t, false, nil
	}
	if err != nil {
		return t, false, ErrDatabase
	}
	if storedOwner != owner || storedWorkspace != workspace || t.Principal != principal || t.DatabaseIdentity != b.DatabaseIdentity {
		return t, false, ErrStale
	}
	t.Scope.OwnerID = owner
	t.Scope.WorkspaceID = workspace
	t.Scope.Provider = "claude"
	return t, true, nil
}
func verifyEnrollmentClaim(ctx context.Context, e *Enrollment, t enrollmentTransfer) error {
	if e == nil || e.Claims == nil {
		return ErrUnsupported
	}
	expected, _ := json.Marshal(t)
	actual, err := e.Claims.Read(ctx, bindingClaimName(t.EnrollmentID))
	if err != nil || !bytes.Equal(expected, actual) {
		return ErrStale
	}
	return nil
}
func (w *Worker) enrollmentCleanupStatus(ctx context.Context) (*EnrollmentCleanupStatus, error) {
	s := &EnrollmentCleanupStatus{State: "complete"}
	var total int
	var ownershipFailed bool
	err := w.Repo.DB.QueryRowContext(ctx, `select count(*),count(*) filter(where a."deletedAt" is null),count(*) filter(where a."deletedAt" is null and a."lastError"='deletion_failed'),count(*) filter(where a."deletedAt" is null and not(t."canonicalPublishedAt" is not null or t."boundAt" is not null or c.epoch>t.epoch)),count(*) filter(where a."deletedAt" is null and case a.kind when 'escrow' then t."sourceCreationState"<>'settled' else not t."attemptCreationSettled" end),coalesce(bool_or(a."deletedAt" is null and a."lastError"='ownership_unconfirmed'),false) from byos_enrollment_sources a join byos_enrollment_transfers t on t."enrollmentId"=a."enrollmentId" join byos_connections c on c.id=a."connectionId" where c.id=$1 and c."ownerId"=$2 and c."workspaceId"=$3 and c.provider=$4 and t."ownerId"=$2 and t."workspaceId"=$3`, w.Scope.ConnectionID, w.Scope.OwnerID, w.Scope.WorkspaceID, w.Scope.Provider).Scan(&total, &s.Pending, &s.Failed, &s.Protected, &s.Uncertain, &ownershipFailed)
	if err != nil {
		return nil, ErrDatabase
	}
	if total == 0 {
		return nil, nil
	}
	if s.Pending == 0 {
		return s, nil
	}
	switch {
	case s.Protected > 0:
		s.State = "awaiting_publication"
	case w.Enrollment == nil || w.DatabaseIdentity == "":
		s.State = "configuration_required"
	case w.Enrollment.RetainSources:
		s.State = "deletion_not_authorized"
	case ownershipFailed:
		s.State = "ownership_unconfirmed"
	case s.Failed > 0:
		s.State = "deletion_failed"
	case s.Uncertain > 0:
		s.State = "creation_outcome_unknown"
	default:
		s.State = "pending"
	}
	return s, nil
}
func (w *Worker) cleanupEnrollment(ctx context.Context) error {
	status, err := w.enrollmentCleanupStatus(ctx)
	if err != nil || status == nil || status.Pending == 0 || status.Protected == status.Pending {
		return err
	}
	if w.Enrollment == nil || w.DatabaseIdentity == "" || w.Enrollment.RetainSources {
		// Unconfigured/retained jobs remain visible but must not occupy every first
		// batch forever ahead of connections whose cleanup can make progress.
		if _, err = w.Repo.DB.ExecContext(ctx, `update byos_enrollment_sources set "lastAttemptAt"=now() where "connectionId"=$1 and "deletedAt" is null`, w.Scope.ConnectionID); err != nil {
			return ErrDatabase
		}
		return nil
	}
	var id, principal string
	if w.Repo.DB.QueryRowContext(ctx, `select "enrollmentId"::text,principal from byos_enrollment_transfers where "connectionId"=$1 and "ownerId"=$2 and "workspaceId"=$3`, w.Scope.ConnectionID, w.Scope.OwnerID, w.Scope.WorkspaceID).Scan(&id, &principal) != nil {
		return ErrDatabase
	}
	b := EnrollmentBinder{Repo: w.Repo, DatabaseIdentity: w.DatabaseIdentity}
	t, found, lookupErr := b.existing(ctx, id, principal, w.Scope.OwnerID, w.Scope.WorkspaceID)
	proof, cancel := context.WithTimeout(ctx, 3*time.Second)
	if lookupErr != nil || !found || verifyEnrollmentClaim(proof, w.Enrollment, t) != nil {
		cancel()
		_, err = w.Repo.DB.ExecContext(ctx, `update byos_enrollment_sources set "lastError"='ownership_unconfirmed',"lastAttemptAt"=now() where "connectionId"=$1 and "deletedAt" is null`, w.Scope.ConnectionID)
		if err != nil {
			return ErrDatabase
		}
		return nil
	}
	cancel()
	// Creation receipts are metadata, never provider tokens. Unknown/uncertain
	// writes stay repeat-delete eligible even after a 404, like canonical GC.
	var creation enrollmentCreation
	read, cancel := context.WithTimeout(ctx, 3*time.Second)
	raw, readErr := w.Enrollment.Claims.Read(read, enrollmentCreationName(id))
	cancel()
	creationState := "unknown"
	attemptSettled := false
	if readErr == nil && json.Unmarshal(raw, &creation) == nil && creation.Schema == "mikka.byos.creation-result.v1" && creation.Principal == principal && creation.ID == id && creation.Digest == t.EscrowDigest {
		creationState = "settled"
		if creation.GrantUncertain {
			creationState = "uncertain"
		}
		attemptSettled = creation.AttemptSettled
	}
	if _, err = w.Repo.DB.ExecContext(ctx, `update byos_enrollment_transfers set "claimConfirmedAt"=coalesce("claimConfirmedAt",now()),"sourceCreationState"=case when "sourceCreationState"='uncertain' or $2='uncertain' then 'uncertain' when $2='settled' then 'settled' else "sourceCreationState" end,"attemptCreationSettled"="attemptCreationSettled" or $3 where "enrollmentId"=$1 and "transferId"=$4`, id, creationState, attemptSettled, t.TransferID); err != nil {
		return ErrDatabase
	}
	rows, err := w.Repo.DB.QueryContext(ctx, `with candidates as(select a."enrollmentId",a.kind from byos_enrollment_sources a join byos_enrollment_transfers t on t."enrollmentId"=a."enrollmentId" join byos_connections c on c.id=a."connectionId" where c.id=$1 and c."ownerId"=$2 and c."workspaceId"=$3 and a."deletedAt" is null and (t."canonicalPublishedAt" is not null or t."boundAt" is not null or c.epoch>t.epoch) order by coalesce(a."lastAttemptAt",'epoch'::timestamptz),a.kind limit 2 for update of a skip locked) update byos_enrollment_sources a set "lastAttemptAt"=now() from candidates x where a."enrollmentId"=x."enrollmentId" and a.kind=x.kind returning a.kind`, w.Scope.ConnectionID, w.Scope.OwnerID, w.Scope.WorkspaceID)
	if err != nil {
		return ErrDatabase
	}
	kinds := []string{}
	for rows.Next() {
		var kind string
		if rows.Scan(&kind) != nil {
			rows.Close()
			return ErrDatabase
		}
		kinds = append(kinds, kind)
	}
	readErr = rows.Err()
	rows.Close()
	if readErr != nil {
		return ErrDatabase
	}
	for _, kind := range kinds {
		store := w.Enrollment.Grants
		if kind == "attempt" {
			store = w.Enrollment.Attempts
		}
		if store == nil {
			return ErrUnsupported
		}
		call, cancel := context.WithTimeout(ctx, 3*time.Second)
		deleteErr := store.Delete(call, "mikka-byos-"+id)
		cancel()
		if deleteErr != nil {
			if _, err = w.Repo.DB.ExecContext(ctx, `update byos_enrollment_sources set "lastError"='deletion_failed' where "enrollmentId"=$1 and kind=$2`, id, kind); err != nil {
				return ErrDatabase
			}
			continue
		}
		_, err = w.Repo.DB.ExecContext(ctx, `update byos_enrollment_sources a set "deletedAt"=case when case a.kind when 'escrow' then t."sourceCreationState"='settled' else t."attemptCreationSettled" end then now() else null end,"lastError"=case when case a.kind when 'escrow' then t."sourceCreationState"='settled' else t."attemptCreationSettled" end then null else 'creation_outcome_unknown' end from byos_enrollment_transfers t where a."enrollmentId"=t."enrollmentId" and a."enrollmentId"=$1 and a.kind=$2`, id, kind)
		if err != nil {
			return ErrDatabase
		}
	}
	return nil
}

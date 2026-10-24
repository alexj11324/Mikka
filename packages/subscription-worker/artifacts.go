package worker

import (
	"bytes"
	"context"
	"errors"
	"time"
)

// Register before any network create: losing a response, a database insert, or
// publication must not lose the immutable secret's owner or cleanup reference.
func (r *Repository) artifact(ctx context.Context, op Operation, kind, name string) error {
	if !validSecretName(name) {
		return ErrStore
	}
	deadline := op.Deadline.Add(30 * time.Second)
	if minimum := time.Now().Add(time.Minute); deadline.Before(minimum) {
		deadline = minimum
	}
	result, err := r.DB.ExecContext(ctx, `insert into byos_secret_artifacts (name,"connectionId","ownerId","workspaceId",provider,kind,"operationId","notBefore") select $1,$2,$3,$4,$5,$6,$7,$8 where exists(select 1 from byos_connections c where c.id=$2 and c."ownerId"=$3 and c."workspaceId"=$4 and c.provider=$5 and c."operationId"=$7 and c.epoch=$9 and c.state in ('pending','refreshing','publication_pending')) on conflict(name) do update set "notBefore"=greatest(byos_secret_artifacts."notBefore",excluded."notBefore") where byos_secret_artifacts."connectionId"=excluded."connectionId" and byos_secret_artifacts."operationId"=excluded."operationId" and byos_secret_artifacts.kind=excluded.kind and byos_secret_artifacts."deletedAt" is null and byos_secret_artifacts."deletingAt" is null`, name, op.ConnectionID, op.OwnerID, op.WorkspaceID, op.Provider, kind, op.OperationID, deadline, op.Epoch)
	if err != nil {
		return ErrDatabase
	}
	n, _ := result.RowsAffected()
	if n != 1 {
		return ErrStale
	}
	return nil
}
func createArtifact(ctx context.Context, r *Repository, secrets SecretStore, op Operation, kind, name string, raw []byte) error {
	if secrets == nil {
		return ErrUnsupported
	}
	if err := r.artifact(ctx, op, kind, name); err != nil {
		return err
	}
	result, err := r.DB.ExecContext(ctx, `update byos_secret_artifacts a set "createStarted"=true,"createSettled"=false where name=$1 and "connectionId"=$2 and "operationId"=$3 and "deletedAt" is null and "deletingAt" is null and exists(select 1 from byos_connections c where c.id=$2 and c."operationId"=$3 and c.epoch=$4 and c.state in ('pending','refreshing','publication_pending'))`, name, op.ConnectionID, op.OperationID, op.Epoch)
	if err != nil {
		return ErrDatabase
	}
	n, _ := result.RowsAffected()
	if n != 1 {
		return ErrStale
	}
	createErr := secrets.Create(ctx, name, raw)
	// A timed-out HTTP request does not establish remote rollback. Keep such an
	// artifact eligible for repeated deletion; never permanently tombstone it on
	// a 404 that could precede the remote commit.
	uncertain := errors.Is(createErr, ErrCreateUncertain)
	updateCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	if _, err = r.DB.ExecContext(updateCtx, `update byos_secret_artifacts set "createSettled"=true,"createUncertain"="createUncertain" or $3 where name=$1 and "connectionId"=$2`, name, op.ConnectionID, uncertain); err != nil {
		return ErrDatabase
	}
	if createErr != nil {
		actual, readErr := secrets.Read(ctx, name)
		if readErr != nil {
			return ErrStore
		}
		if !bytes.Equal(raw, actual) {
			return ErrIntegrity
		}
	}
	current, err := r.Lookup(ctx, op.Scope)
	if err != nil || current.OperationID != op.OperationID || current.Epoch != op.Epoch {
		return ErrStale
	}

	return nil
}

type CleanupStatus struct {
	Pending            int                      `json:"pending"`
	Failed             int                      `json:"failed"`
	ProviderRevocation string                   `json:"providerRevocation"`
	Uncertain          int                      `json:"uncertainCreates"`
	Enrollment         *EnrollmentCleanupStatus `json:"enrollment,omitempty"`
}

// No verified provider-specific revocation adapter is installed. Deleting a
// vault artifact and fencing Mikka use never claims to revoke upstream grants.
func (w *Worker) CleanupStatus(ctx context.Context) (CleanupStatus, error) {
	result := CleanupStatus{ProviderRevocation: "not_implemented"}
	err := w.Repo.DB.QueryRowContext(ctx, `select count(*) filter(where "deletedAt" is null),count(*) filter(where "deletedAt" is null and "lastError"='deletion_failed'),count(*) filter(where "deletedAt" is null and ("createUncertain" or ("createStarted" and not "createSettled"))) from byos_secret_artifacts a where "connectionId"=$1 and "ownerId"=$2 and "workspaceId"=$3 and provider=$4 and not exists(select 1 from byos_connections c where c.id=a."connectionId" and a.name in(c."secretName",c."accessSecretName",c."stagedSecretName",c."stagedAccessName")) and not exists(select 1 from byos_oauth_attempts o join byos_connections c on c.id=o."connectionId" where o."secretName"=a.name and o."consumedAt" is null and o."expiresAt">now() and o."operationId"=c."operationId" and c.state='pending')`, w.Scope.ConnectionID, w.Scope.OwnerID, w.Scope.WorkspaceID, w.Scope.Provider).Scan(&result.Pending, &result.Failed, &result.Uncertain)
	if err != nil {
		return result, ErrDatabase
	}
	source, sourceErr := w.enrollmentCleanupStatus(ctx)
	if sourceErr != nil {
		return result, sourceErr
	}
	result.Enrollment = source
	if source != nil {
		result.Pending += source.Pending
		result.Failed += source.Failed
		result.Uncertain += source.Uncertain
	}
	return result, nil
}
func (w *Worker) Cleanup(ctx context.Context) (CleanupStatus, error) {
	if w.Secrets == nil || w.AccessSecrets == nil {
		return CleanupStatus{}, ErrUnsupported
	}
	rows, err := w.Repo.DB.QueryContext(ctx, `with candidates as(select a.name from byos_secret_artifacts a where "connectionId"=$1 and "ownerId"=$2 and "workspaceId"=$3 and provider=$4 and "deletedAt" is null and ("publishedAt" is not null or "notBefore"<=now()) and not exists(select 1 from byos_connections c where c.id=a."connectionId" and a.name in(c."secretName",c."accessSecretName",c."stagedSecretName",c."stagedAccessName")) and not exists(select 1 from byos_oauth_attempts o join byos_connections c on c.id=o."connectionId" where o."secretName"=a.name and o."consumedAt" is null and o."expiresAt">now() and o."operationId"=c."operationId" and c.state='pending') order by coalesce(a."deletingAt",'epoch'::timestamptz),a.name limit 4 for update skip locked) update byos_secret_artifacts a set "deletingAt"=now() from candidates c where a.name=c.name returning a.name,a.kind`, w.Scope.ConnectionID, w.Scope.OwnerID, w.Scope.WorkspaceID, w.Scope.Provider)
	if err != nil {
		return CleanupStatus{}, ErrDatabase
	}
	type item struct{ name, kind string }
	var items []item
	for rows.Next() {
		var i item
		if rows.Scan(&i.name, &i.kind) != nil {
			rows.Close()
			return CleanupStatus{}, ErrDatabase
		}
		items = append(items, i)
	}
	readErr := rows.Err()
	rows.Close()
	if readErr != nil {
		return CleanupStatus{}, ErrDatabase
	}
	for _, i := range items {
		store := w.Secrets
		if i.kind == "access" {
			store = w.AccessSecrets
		}
		call, cancel := context.WithTimeout(ctx, 3*time.Second)
		err := store.Delete(call, i.name)
		cancel()
		if err != nil {
			_, _ = w.Repo.DB.ExecContext(ctx, `update byos_secret_artifacts set "lastError"='deletion_failed' where name=$1 and "connectionId"=$2`, i.name, w.Scope.ConnectionID)
			continue
		}
		if _, err = w.Repo.DB.ExecContext(ctx, `update byos_secret_artifacts set "deletedAt"=case when "createUncertain" or ("createStarted" and not "createSettled") then null else now() end,"lastError"=case when "createUncertain" or ("createStarted" and not "createSettled") then 'creation_outcome_unknown' else null end where name=$1 and "connectionId"=$2`, i.name, w.Scope.ConnectionID); err != nil {
			return CleanupStatus{}, ErrDatabase
		}
	}
	_, err = w.Repo.DB.ExecContext(ctx, `delete from byos_oauth_attempts o using byos_secret_artifacts a where o."secretName"=a.name and a."connectionId"=$1 and a."deletedAt" is not null`, w.Scope.ConnectionID)
	if err != nil {
		return CleanupStatus{}, ErrDatabase
	}
	if err = w.cleanupEnrollment(ctx); err != nil {
		return CleanupStatus{}, err
	}
	return w.CleanupStatus(ctx)
}

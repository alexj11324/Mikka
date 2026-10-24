package worker

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"fmt"
	"regexp"
	"time"
)

// Scope is constructed by the authenticated control plane, never by model input.
type Scope struct {
	OwnerID      string `json:"ownerId"`
	WorkspaceID  string `json:"workspaceId"`
	ConnectionID string `json:"connectionId"`
	Provider     string `json:"provider"`
}
type Record struct {
	Scope
	State                                                string
	Epoch, Version                                       int64
	SecretName, Digest, Subject                          string
	OperationID, OperationKind, StagedName, StagedDigest string
	Deadline                                             time.Time
}
type Operation struct{ Record }
type Repository struct{ DB *sql.DB }

var uuidPattern = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)
var scopePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

func validScope(s Scope) bool {
	return uuidPattern.MatchString(s.ConnectionID) && scopePattern.MatchString(s.OwnerID) && scopePattern.MatchString(s.WorkspaceID) && (s.Provider == "codex" || s.Provider == "claude")
}
func newID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("system entropy unavailable")
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b[:])
	return fmt.Sprintf("%s-%s-%s-%s-%s", h[:8], h[8:12], h[12:16], h[16:20], h[20:])
}

const columns = `id::text,"ownerId","workspaceId",provider,state,epoch,"credentialVersion",coalesce("secretName",''),coalesce("secretDigest",''),coalesce("providerSubject",''),coalesce("operationId"::text,''),coalesce("operationKind",''),coalesce("stagedSecretName",''),coalesce("stagedDigest",''),coalesce("operationDeadline",'epoch'::timestamptz)`

func scanRecord(row interface{ Scan(...any) error }) (Record, error) {
	var r Record
	err := row.Scan(&r.ConnectionID, &r.OwnerID, &r.WorkspaceID, &r.Provider, &r.State, &r.Epoch, &r.Version, &r.SecretName, &r.Digest, &r.Subject, &r.OperationID, &r.OperationKind, &r.StagedName, &r.StagedDigest, &r.Deadline)
	if err == sql.ErrNoRows {
		return r, ErrUnavailable
	}
	if err != nil {
		return r, ErrDatabase
	}
	return r, nil
}
func (r *Repository) Create(ctx context.Context, s Scope) error {
	if !validScope(s) {
		return ErrUnavailable
	}
	result, err := r.DB.ExecContext(ctx, `insert into byos_connections (id,"ownerId","workspaceId",provider) values ($1,$2,$3,$4) on conflict do nothing`, s.ConnectionID, s.OwnerID, s.WorkspaceID, s.Provider)
	if err != nil {
		return ErrDatabase
	}
	n, _ := result.RowsAffected()
	if n != 1 {
		return ErrStale
	}
	return nil
}
func (r *Repository) Lookup(ctx context.Context, s Scope) (Record, error) {
	if !validScope(s) {
		return Record{}, ErrUnavailable
	}
	return scanRecord(r.DB.QueryRowContext(ctx, `select `+columns+` from byos_connections where id=$1 and "ownerId"=$2 and "workspaceId"=$3 and provider=$4`, s.ConnectionID, s.OwnerID, s.WorkspaceID, s.Provider))
}
func (r *Repository) BeginAcquire(ctx context.Context, s Scope, epoch int64) (Operation, error) {
	if !validScope(s) {
		return Operation{}, ErrUnavailable
	}
	operation := newID()
	record, err := scanRecord(r.DB.QueryRowContext(ctx, `update byos_connections set epoch=epoch+1,state='pending',quota=null,"operationId"=$5,"operationKind"='acquire',"operationDeadline"=now()+interval '5 minutes',"stagedSecretName"=null,"stagedDigest"=null,"lastErrorCode"=null,"updatedAt"=now() where id=$1 and "ownerId"=$2 and "workspaceId"=$3 and provider=$4 and epoch=$6 returning `+columns, s.ConnectionID, s.OwnerID, s.WorkspaceID, s.Provider, operation, epoch))
	if err == ErrUnavailable {
		return Operation{}, ErrStale
	}
	return Operation{record}, err
}
func (r *Repository) ClaimRefresh(ctx context.Context, s Scope, epoch, version int64) (Operation, error) {
	if !validScope(s) {
		return Operation{}, ErrUnavailable
	}
	record, err := scanRecord(r.DB.QueryRowContext(ctx, `update byos_connections set state='refreshing',"operationId"=$5,"operationKind"='refresh',"operationDeadline"=now()+interval '2 minutes',"stagedSecretName"=null,"stagedDigest"=null,"lastErrorCode"=null,"updatedAt"=now() where id=$1 and "ownerId"=$2 and "workspaceId"=$3 and provider=$4 and epoch=$6 and "credentialVersion"=$7 and state='connected' and "operationId" is null returning `+columns, s.ConnectionID, s.OwnerID, s.WorkspaceID, s.Provider, newID(), epoch, version))
	if err == ErrUnavailable {
		return Operation{}, ErrBusy
	}
	return Operation{record}, err
}
func (r *Repository) Stage(ctx context.Context, o Operation, digest string) (string, error) {
	name := "mikka-byos-" + o.OperationID
	result, err := r.DB.ExecContext(ctx, `update byos_connections set state='publication_pending',"stagedSecretName"=$8,"stagedDigest"=$9,"updatedAt"=now() where id=$1 and "ownerId"=$2 and "workspaceId"=$3 and provider=$4 and epoch=$5 and "credentialVersion"=$6 and "operationId"=$7 and "operationDeadline">now() and state in ('pending','refreshing')`, o.ConnectionID, o.OwnerID, o.WorkspaceID, o.Provider, o.Epoch, o.Version, o.OperationID, name, digest)
	if err != nil {
		return "", ErrDatabase
	}
	n, _ := result.RowsAffected()
	if n != 1 {
		return "", ErrStale
	}
	return name, nil
}
func (r *Repository) Publish(ctx context.Context, o Operation, name, digest, subject string) error {
	result, err := r.DB.ExecContext(ctx, `update byos_connections set state='connected',"credentialVersion"="credentialVersion"+1,"secretName"=$8,"secretDigest"=$9,"providerSubject"=$10,"operationId"=null,"operationKind"=null,"operationDeadline"=null,"stagedSecretName"=null,"stagedDigest"=null,"lastErrorCode"=null,"updatedAt"=now() where id=$1 and "ownerId"=$2 and "workspaceId"=$3 and provider=$4 and epoch=$5 and "credentialVersion"=$6 and "operationId"=$7 and state='publication_pending' and "stagedSecretName"=$8 and "stagedDigest"=$9`, o.ConnectionID, o.OwnerID, o.WorkspaceID, o.Provider, o.Epoch, o.Version, o.OperationID, name, digest, subject)
	if err != nil {
		return ErrDatabase
	}
	n, _ := result.RowsAffected()
	if n != 1 {
		return ErrStale
	}
	return nil
}
func (r *Repository) Fail(ctx context.Context, o Operation, code string) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	// Pending publications remain recoverable. A new refresh must never replay
	// a rotating grant whose previous outcome is uncertain.
	_, err := r.DB.ExecContext(ctx, `update byos_connections set state=case when state='publication_pending' then state else 'reconnect_required' end,"lastErrorCode"=$8,"updatedAt"=now() where id=$1 and "ownerId"=$2 and "workspaceId"=$3 and provider=$4 and epoch=$5 and "credentialVersion"=$6 and "operationId"=$7`, o.ConnectionID, o.OwnerID, o.WorkspaceID, o.Provider, o.Epoch, o.Version, o.OperationID, code)
	if err != nil {
		return ErrDatabase
	}
	return nil
}
func (r *Repository) Connected(ctx context.Context, s Scope, epoch, version int64) (Record, error) {
	record, err := r.Lookup(ctx, s)
	if err != nil {
		return record, err
	}
	if record.State != "connected" || record.Epoch != epoch || record.Version != version {
		return Record{}, ErrUnavailable
	}
	return record, nil
}
func (r *Repository) Disconnect(ctx context.Context, s Scope, epoch int64) error {
	if !validScope(s) {
		return ErrUnavailable
	}
	result, err := r.DB.ExecContext(ctx, `update byos_connections set state='disconnected',epoch=epoch+1,quota=null,"operationId"=null,"operationKind"=null,"operationDeadline"=null,"stagedSecretName"=null,"stagedDigest"=null,"updatedAt"=now() where id=$1 and "ownerId"=$2 and "workspaceId"=$3 and provider=$4 and epoch=$5`, s.ConnectionID, s.OwnerID, s.WorkspaceID, s.Provider, epoch)
	if err != nil {
		return ErrDatabase
	}
	n, _ := result.RowsAffected()
	if n != 1 {
		return ErrStale
	}
	return nil
}

package worker

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	core "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	"net/url"
	"strings"
	"time"
)

// Binding requires an authenticated Mikka owner/workspace supplied by the host,
// plus the source operator principal. The browser cannot supply either identity.
type EnrollmentBinder struct {
	Enrollment             *Enrollment
	Repo                   *Repository
	Secrets, AccessSecrets SecretStore
	DatabaseIdentity       string
}

func EnrollmentDatabaseIdentity(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") || u.Hostname() == "" || u.Path == "" {
		return "", ErrDatabase
	}
	port := u.Port()
	if port == "" {
		port = "5432"
	}
	return hashText(strings.ReplaceAll(strings.ToLower(u.Hostname()), "-pooler.", ".") + ":" + port + u.Path), nil
}

type enrollmentTransfer struct {
	EnrollmentID     string `json:"enrollmentId"`
	TransferID       string `json:"transferId"`
	Scope            Scope  `json:"scope"`
	Principal        string `json:"principal"`
	DatabaseIdentity string `json:"databaseIdentity"`
	EscrowDigest     string `json:"escrowDigest"`
	Subject          string `json:"providerSubject"`
	Epoch            int64  `json:"epoch"`
	OperationID      string `json:"operationId"`
	Bound            bool   `json:"-"`
}

func bindingClaimName(id string) string {
	return derivedEnrollmentName("mikka.byos.binding-claim.v1:", id)
}
func derivedEnrollmentName(namespace, id string) string {
	digest := sha256.Sum256([]byte(namespace + id))
	digest[6] = (digest[6] & 15) | 0x40
	digest[8] = (digest[8] & 63) | 0x80
	h := hex.EncodeToString(digest[:16])
	return "mikka-byos-" + h[:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}
func (b *EnrollmentBinder) reserve(ctx context.Context, id, principal, owner, workspace, digest, subject string) (enrollmentTransfer, error) {
	t := enrollmentTransfer{EnrollmentID: id, Principal: principal, DatabaseIdentity: b.DatabaseIdentity, EscrowDigest: digest, Subject: subject}
	tx, err := b.Repo.DB.BeginTx(ctx, nil)
	if err != nil {
		return t, ErrDatabase
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `select pg_advisory_xact_lock(hashtextextended($1,0))`, "byos-enrollment:"+id); err != nil {
		return t, ErrDatabase
	}
	var storedOwner, storedWorkspace string
	err = tx.QueryRowContext(ctx, `select "transferId"::text,"connectionId"::text,"ownerId","workspaceId",principal,"databaseIdentity","escrowDigest","providerSubject",epoch,"operationId"::text,"boundAt" is not null from byos_enrollment_transfers where "enrollmentId"=$1 for update`, id).Scan(&t.TransferID, &t.Scope.ConnectionID, &storedOwner, &storedWorkspace, &t.Principal, &t.DatabaseIdentity, &t.EscrowDigest, &t.Subject, &t.Epoch, &t.OperationID, &t.Bound)
	if err == sql.ErrNoRows {
		t.TransferID = newID()
		t.Scope = Scope{OwnerID: owner, WorkspaceID: workspace, ConnectionID: newID(), Provider: "claude"}
		if !validScope(t.Scope) {
			return t, ErrUnavailable
		}
		if _, err = tx.ExecContext(ctx, `insert into byos_connections (id,"ownerId","workspaceId",provider) values ($1,$2,$3,'claude')`, t.Scope.ConnectionID, owner, workspace); err != nil {
			return t, ErrDatabase
		}
		op, beginErr := beginAcquire(ctx, tx, t.Scope, 1)
		if beginErr != nil {
			return t, beginErr
		}
		t.Epoch = op.Epoch
		t.OperationID = op.OperationID
		_, err = tx.ExecContext(ctx, `insert into byos_enrollment_transfers ("enrollmentId","transferId","connectionId","ownerId","workspaceId",principal,"databaseIdentity","escrowDigest","providerSubject",epoch,"operationId") values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, id, t.TransferID, t.Scope.ConnectionID, owner, workspace, principal, b.DatabaseIdentity, digest, subject, t.Epoch, t.OperationID)
		if err != nil {
			return t, ErrDatabase
		}
		if _, err = tx.ExecContext(ctx, `insert into byos_enrollment_sources ("enrollmentId",kind,"connectionId") values ($1,'escrow',$2),($1,'attempt',$2)`, id, t.Scope.ConnectionID); err != nil {
			return t, ErrDatabase
		}
	} else if err != nil {
		return t, ErrDatabase
	} else {
		if storedOwner != owner || storedWorkspace != workspace || t.Principal != principal || t.DatabaseIdentity != b.DatabaseIdentity || t.EscrowDigest != digest || t.Subject != subject {
			return t, ErrStale
		}
		t.Scope.OwnerID = owner
		t.Scope.WorkspaceID = workspace
		t.Scope.Provider = "claude"
	}
	if tx.Commit() != nil {
		return t, ErrDatabase
	}
	return t, nil
}
func (b *EnrollmentBinder) Bind(ctx context.Context, principal, id, owner, workspace string) (Metadata, error) {
	if b.Enrollment == nil || b.Repo == nil || b.Secrets == nil || b.AccessSecrets == nil || !uuidPattern.MatchString(id) || !validPrincipal(principal) || !scopePattern.MatchString(owner) || !scopePattern.MatchString(workspace) || len(b.DatabaseIdentity) != 64 {
		return Metadata{}, ErrUnsupported
	}
	// Completed bindings remain idempotent after redundant escrow is purged.
	// Verify actual target ownership and immutable claim before reading secrets.
	existing, found, lookupErr := b.existing(ctx, id, principal, owner, workspace)
	if lookupErr != nil {
		return Metadata{}, lookupErr
	}
	if found {
		current, readErr := b.Repo.Lookup(ctx, existing.Scope)
		if readErr != nil {
			return Metadata{}, readErr
		}
		if current.Epoch != existing.Epoch {
			return Metadata{}, ErrStale
		}
		if existing.Bound || current.State == "connected" {
			if claimErr := verifyEnrollmentClaim(ctx, b.Enrollment, existing); claimErr != nil {
				if errors.Is(claimErr, ErrSourceStoreDenied) {
					return Metadata{}, ErrSourceStoreDenied
				}
				return Metadata{}, ErrStale
			}
			if current.State != "connected" {
				return Metadata{}, ErrBusy
			}
			return b.finish(ctx, existing, current)
		}
	}
	// Check the source principal receipt before reading any full escrow payload.
	state, err := b.Enrollment.Status(ctx, principal, id)
	if errors.Is(err, ErrSourceStoreDenied) {
		return Metadata{}, ErrSourceStoreDenied
	}
	if err != nil || state.State != "pending_unbound" {
		return Metadata{}, ErrUnavailable
	}
	raw, err := b.Enrollment.Grants.Read(ctx, "mikka-byos-"+id)
	if err != nil {
		return Metadata{}, err
	}
	var escrow enrollmentGrant
	if json.Unmarshal(raw, &escrow) != nil || escrow.Principal != principal || escrow.ID != id || escrow.Schema != "mikka.byos.unbound-grant.v1" || escrow.BindingState != "pending_unbound" || escrow.Provider != "claude" {
		return Metadata{}, ErrIntegrity
	}
	payload, err := filterPayload("claude", escrow.Payload)
	if err != nil {
		return Metadata{}, err
	}
	subject := (bundle{Provider: "claude", Payload: payload}).subject()
	t, err := b.reserve(ctx, id, principal, owner, workspace, hashText(string(raw)), subject)
	if err != nil {
		return Metadata{}, err
	}
	// This immutable claim is global to the escrow, including across preview DBs.
	claim, _ := json.Marshal(t)
	if err = b.Enrollment.Claims.Create(ctx, bindingClaimName(id), claim); err != nil {
		if errors.Is(err, ErrSourceStoreDenied) {
			return Metadata{}, ErrSourceStoreDenied
		}
		stored, readErr := b.Enrollment.Claims.Read(ctx, bindingClaimName(id))
		if errors.Is(readErr, ErrSourceStoreDenied) {
			return Metadata{}, ErrSourceStoreDenied
		}
		if readErr != nil || !bytes.Equal(stored, claim) {
			return Metadata{}, ErrStale
		}
	}
	record, err := b.Repo.Lookup(ctx, t.Scope)
	if err != nil {
		return Metadata{}, err
	}
	if record.Epoch != t.Epoch {
		return Metadata{}, ErrStale
	}
	if record.State == "connected" {
		if record.Subject != subject {
			return Metadata{}, ErrIntegrity
		}
		return b.finish(ctx, t, record)
	}
	if t.Bound || record.OperationID != t.OperationID || record.OperationKind != "acquire" {
		return Metadata{}, ErrStale
	}
	auth := &core.Auth{ID: t.Scope.ConnectionID, Provider: "claude", Metadata: cloneMap(payload)}
	op := Operation{record}
	store := &Store{Repo: b.Repo, Secrets: b.Secrets, AccessSecrets: b.AccessSecrets, Scope: t.Scope, Operation: &op}
	if record.State == "pending" {
		// The escrow grant is already durable, unlike an expiring OAuth code.
		// Extend only this original reserved operation; never adopt a new epoch.
		updated, updateErr := scanRecord(b.Repo.DB.QueryRowContext(ctx, `update byos_connections c set "operationDeadline"=now()+interval '5 minutes' where c.id=$1 and c."ownerId"=$2 and c."workspaceId"=$3 and c.epoch=$4 and c."operationId"=$5 and c.state='pending' and exists(select 1 from byos_enrollment_transfers t where t."enrollmentId"=$6 and t."connectionId"=c.id and t.epoch=c.epoch and t."operationId"=c."operationId" and t."boundAt" is null) returning `+columns, t.Scope.ConnectionID, t.Scope.OwnerID, t.Scope.WorkspaceID, t.Epoch, t.OperationID, t.EnrollmentID))
		if updateErr != nil {
			return Metadata{}, ErrStale
		}
		op = Operation{updated}
		store.Operation = &op
		if _, err = store.Save(ctx, auth); err != nil {
			return Metadata{}, err
		}
	} else if record.State == "publication_pending" {
		// Escrow is still intact. Reconstruct only the original staged artifact;
		// never reacquire against a newer epoch or choose new publication names.
		canonical, normalErr := normalizeAuth(t.Scope, auth, nil)
		if normalErr != nil {
			return Metadata{}, normalErr
		}
		encoded, digest, encodeErr := encodeBundle(canonical)
		if encodeErr != nil || digest != record.StagedDigest {
			return Metadata{}, ErrIntegrity
		}
		stored, readErr := b.Secrets.Read(ctx, record.StagedName)
		if readErr == ErrMissing {
			if err = createArtifact(ctx, b.Repo, b.Secrets, op, "grant", record.StagedName, encoded); err != nil {
				return Metadata{}, err
			}
		} else if readErr != nil {
			return Metadata{}, readErr
		} else if !bytes.Equal(stored, encoded) {
			return Metadata{}, ErrIntegrity
		}
		if _, err = store.Recover(ctx); err != nil {
			return Metadata{}, err
		}
	} else {
		return Metadata{}, ErrStale
	}
	record, err = b.Repo.Lookup(ctx, t.Scope)
	if err != nil {
		return Metadata{}, err
	}
	return b.finish(ctx, t, record)
}
func (b *EnrollmentBinder) finish(ctx context.Context, t enrollmentTransfer, r Record) (Metadata, error) {
	if r.State != "connected" || r.Epoch != t.Epoch || r.Subject != t.Subject {
		return Metadata{}, ErrStale
	}
	result, err := b.Repo.DB.ExecContext(ctx, `update byos_enrollment_transfers t set "boundAt"=coalesce(t."boundAt",now()) where t."enrollmentId"=$1 and t."transferId"=$2 and t."ownerId"=$3 and t."workspaceId"=$4 and exists(select 1 from byos_connections c where c.id=t."connectionId" and c.epoch=t.epoch and c.state='connected' and c."providerSubject"=t."providerSubject")`, t.EnrollmentID, t.TransferID, t.Scope.OwnerID, t.Scope.WorkspaceID)
	if err != nil {
		return Metadata{}, ErrDatabase
	}
	n, _ := result.RowsAffected()
	if n != 1 {
		return Metadata{}, ErrStale
	}
	// Queue registration predates publication. Attempt bounded deletion now;
	// failures remain durable and visible to the shared cleanup RPC/cron.
	w := Worker{Repo: b.Repo, Scope: t.Scope, Secrets: b.Secrets, AccessSecrets: b.AccessSecrets, Enrollment: b.Enrollment, DatabaseIdentity: b.DatabaseIdentity}
	cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
	_ = w.cleanupEnrollment(cleanup)
	cancel()
	statusCtx, statusCancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer statusCancel()
	status, err := w.CleanupStatus(statusCtx)
	if err != nil {
		return Metadata{}, err
	}
	meta := public(r)
	meta.Cleanup = &status
	return meta, nil
}

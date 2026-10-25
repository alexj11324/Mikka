package worker

// Cross-environment custody is an explicit server operation, not a credential
// import endpoint. The server supplies its approved manifest; the authenticated
// request supplies only the already-authorized owner/workspace and enrollment ID.
import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"time"
)

type TransferStore struct {
	Origin      string `json:"origin"`
	ProjectID   string `json:"projectId"`
	Environment string `json:"environment"`
	GrantPath   string `json:"grantPath"`
}
type TransferApproval struct {
	TransferID                  string        `json:"transferId"`
	EnrollmentID                string        `json:"enrollmentId"`
	OwnerID                     string        `json:"ownerId"`
	WorkspaceID                 string        `json:"workspaceId"`
	Provider                    string        `json:"provider"`
	SourcePrincipal             string        `json:"sourcePrincipal"`
	ProviderSubject             string        `json:"providerSubject"`
	Source                      TransferStore `json:"source"`
	Destination                 TransferStore `json:"destination"`
	DestinationOrigin           string        `json:"destinationOrigin"`
	DestinationDatabaseIdentity string        `json:"destinationDatabaseIdentity"`
	SourceDigest                string        `json:"sourceDigest"`
	SourceRevision              int           `json:"sourceRevision"`
	ExpiresAt                   time.Time     `json:"expiresAt"`
	DeleteSource                bool          `json:"deleteSource"`
}

func (a TransferApproval) validate(b *EnrollmentBinder, id, owner, workspace, origin string) error {
	if !uuidPattern.MatchString(a.TransferID) || a.EnrollmentID != id || !uuidPattern.MatchString(id) || a.OwnerID != owner || a.WorkspaceID != workspace || !scopePattern.MatchString(owner) || !uuidPattern.MatchString(workspace) || a.Provider != "claude" || a.ProviderSubject == "" || len(a.ProviderSubject) > 256 || a.DeleteSource || a.SourceRevision != 1 || len(a.SourceDigest) != 64 || a.DestinationDatabaseIdentity != b.DatabaseIdentity || a.DestinationOrigin != origin || origin != "https://app.aspectlylabs.com" {
		return ErrUnsupported
	}
	for _, s := range []TransferStore{a.Source, a.Destination} {
		if s.Origin != "https://app.infisical.com" || s.ProjectID != "89850d6a-f020-4936-863e-df77380dfe40" {
			return ErrUnsupported
		}
	}
	if a.Source.Environment != "staging" || a.Source.GrantPath != "/byos/pending-grants" || a.Destination.Environment != "prod" || a.Destination.GrantPath != "/byos/grants" {
		return ErrUnsupported
	}
	// Validate the actual constructed HTTP clients, not merely approval labels.
	matches := func(s SecretStore, ref TransferStore, path string) bool {
		i, ok := s.(*Infisical)
		return ok && i.config.Origin == ref.Origin && i.config.ProjectID == ref.ProjectID && i.config.Environment == ref.Environment && i.config.Path == path
	}
	if b.Enrollment == nil || !matches(b.Enrollment.Grants, a.Source, a.Source.GrantPath) || !matches(b.Enrollment.Claims, a.Source, "/byos/enrollment-claims") || !matches(b.Enrollment.Attempts, a.Source, "/byos/enrollment-attempts") || !matches(b.Secrets, a.Destination, a.Destination.GrantPath) || !matches(b.AccessSecrets, a.Destination, "/byos/access") {
		return ErrUnsupported
	}
	return nil
}

// pinnedTransferSource enforces the approved immutable v1 digest on EVERY read,
// including the binder's independent reload. It cannot delete or overwrite escrow.
type sourceTransferStore struct{ SecretStore }

func (s sourceTransferStore) Read(ctx context.Context, name string) ([]byte, error) {
	raw, err := s.SecretStore.Read(ctx, name)
	if err == ErrStoreDenied {
		err = ErrSourceStoreDenied
	}
	return raw, err
}
func (s sourceTransferStore) Create(ctx context.Context, name string, raw []byte) error {
	err := s.SecretStore.Create(ctx, name, raw)
	if err == ErrStoreDenied {
		return ErrSourceStoreDenied
	}
	return err
}
func (sourceTransferStore) Delete(context.Context, string) error { return ErrUnsupported }

type pinnedTransferSource struct {
	SecretStore
	name, digest, subject, principal string
}

func (s pinnedTransferSource) Read(ctx context.Context, name string) ([]byte, error) {
	if name != s.name {
		return nil, ErrStale
	}
	raw, err := s.SecretStore.Read(ctx, name)
	if err == ErrStoreDenied {
		return nil, ErrSourceStoreDenied
	}
	if err != nil {
		return nil, err
	}
	var g enrollmentGrant
	if hashText(string(raw)) != s.digest || json.Unmarshal(raw, &g) != nil || g.Principal != s.principal || g.Schema != "mikka.byos.unbound-grant.v1" || g.BindingState != "pending_unbound" || g.Provider != "claude" || "mikka-byos-"+g.ID != name || (bundle{Provider: "claude", Payload: g.Payload}).subject() != s.subject {
		return nil, ErrIntegrity
	}
	return raw, nil
}
func (pinnedTransferSource) Create(context.Context, string, []byte) error { return ErrUnsupported }
func (pinnedTransferSource) Delete(context.Context, string) error         { return ErrUnsupported }

// Destination read-back happens BEFORE canonical publication, including after
// an uncertain Create. No token values escape this trusted process.
type verifiedTransferDestination struct {
	SecretStore
	source pinnedTransferSource
}

func (s verifiedTransferDestination) Read(ctx context.Context, name string) ([]byte, error) {
	if _, err := s.source.Read(ctx, s.source.name); err != nil {
		return nil, err
	}
	return s.SecretStore.Read(ctx, name)
}
func (s verifiedTransferDestination) Create(ctx context.Context, name string, raw []byte) error {
	err := s.SecretStore.Create(ctx, name, raw)
	actual, readErr := s.SecretStore.Read(ctx, name)
	if readErr != nil {
		if err != nil {
			return err
		}
		return readErr
	}
	if !bytes.Equal(actual, raw) {
		return ErrIntegrity
	}
	if _, err = s.source.Read(ctx, s.source.name); err != nil {
		return err
	}
	return nil
}

func (b *EnrollmentBinder) Transfer(ctx context.Context, a TransferApproval, principal, id, owner, workspace, origin string) (Metadata, error) {
	if err := a.validate(b, id, owner, workspace, origin); err != nil {
		return Metadata{}, err
	}
	if !validPrincipal(principal) || a.SourcePrincipal != principal || b.Repo == nil {
		return Metadata{}, ErrUnsupported
	}
	raw, _ := json.Marshal(a)
	digest := hashText(string(raw))
	// A short transaction records the exact immutable approval before any remote
	// secret access. Existing journal permits recovery after approval expiry, but
	// only with identical scope/manifest; the binder still fences current epoch.
	tx, err := b.Repo.DB.BeginTx(ctx, nil)
	if err != nil {
		return Metadata{}, ErrDatabase
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `select pg_advisory_xact_lock(hashtextextended($1,0))`, "byos-environment:"+id); err != nil {
		return Metadata{}, ErrDatabase
	}
	var previous string
	err = tx.QueryRowContext(ctx, `select "approvalDigest" from byos_environment_transfers where "enrollmentId"=$1 for update`, id).Scan(&previous)
	if err == sql.ErrNoRows {
		now := time.Now()
		if !a.ExpiresAt.After(now) || a.ExpiresAt.After(now.Add(15*time.Minute)) {
			return Metadata{}, ErrStale
		}
		_, err = tx.ExecContext(ctx, `insert into byos_environment_transfers ("enrollmentId","approvalId","approvalDigest","ownerId","workspaceId","databaseIdentity","sourceDigest","sourceRevision") values($1,$2,$3,$4,$5,$6,$7,$8)`, id, a.TransferID, digest, owner, workspace, b.DatabaseIdentity, a.SourceDigest, a.SourceRevision)
	} else if err == nil && previous != digest {
		return Metadata{}, ErrStale
	}
	if err != nil || tx.Commit() != nil {
		return Metadata{}, ErrDatabase
	}
	source := pinnedTransferSource{b.Enrollment.Grants, "mikka-byos-" + id, a.SourceDigest, a.ProviderSubject, principal}
	if _, err = source.Read(ctx, source.name); err != nil {
		return Metadata{}, err
	}
	enrollment := *b.Enrollment
	enrollment.Grants = source
	enrollment.Claims = sourceTransferStore{enrollment.Claims}
	enrollment.Attempts = sourceTransferStore{enrollment.Attempts}
	enrollment.RetainSources = true
	copy := *b
	copy.Enrollment = &enrollment
	copy.Secrets = verifiedTransferDestination{b.Secrets, source}
	copy.AccessSecrets = verifiedTransferDestination{b.AccessSecrets, source}
	meta, err := copy.Bind(ctx, principal, id, owner, workspace)
	if err != nil {
		return Metadata{}, err
	}
	// Verify current canonical + projection, including an idempotent retry after
	// legitimate refresh. Never compare a newer bundle to the older source payload.
	scope := Scope{OwnerID: owner, WorkspaceID: workspace, ConnectionID: meta.ID, Provider: "claude"}
	record, err := b.Repo.Connected(ctx, scope, meta.Revision, meta.CredentialVersion)
	if err != nil {
		return Metadata{}, err
	}
	full, err := b.Secrets.Read(ctx, record.SecretName)
	if err != nil {
		return Metadata{}, err
	}
	if _, err = decodeBundle(scope, full, record.Digest); err != nil {
		return Metadata{}, err
	}
	access, err := b.AccessSecrets.Read(ctx, record.AccessName)
	if err != nil {
		return Metadata{}, err
	}
	if _, err = decodeAccessBundle(scope, access, record.AccessDigest); err != nil {
		return Metadata{}, err
	}
	if _, err = source.Read(ctx, source.name); err != nil {
		return Metadata{}, err
	}
	result, err := b.Repo.DB.ExecContext(ctx, `update byos_environment_transfers t set "verifiedAt"=coalesce("verifiedAt",now()) where "enrollmentId"=$1 and "approvalDigest"=$2 and exists(select 1 from byos_connections c where c.id=$3 and c."ownerId"=t."ownerId" and c."workspaceId"=t."workspaceId" and c.epoch=$4 and c.state='connected')`, id, digest, meta.ID, meta.Revision)
	if err != nil {
		return Metadata{}, ErrDatabase
	}
	n, _ := result.RowsAffected()
	if n != 1 {
		return Metadata{}, ErrStale
	}
	return meta, nil
}

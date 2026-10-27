package worker

import (
	"context"
	"time"

	core "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

// Store implements the actual CPA persistence interface. It has immutable
// owner scope and an optional durable operation; never a process-global tenant switch.
type Store struct {
	Repo          *Repository
	Secrets       SecretStore
	AccessSecrets SecretStore
	Scope         Scope
	Operation     *Operation
}

var _ core.Store = (*Store)(nil)

func (s *Store) load(ctx context.Context, r Record) (bundle, error) {
	raw, err := s.Secrets.Read(ctx, r.SecretName)
	if err != nil {
		return bundle{}, err
	}
	return decodeBundle(s.Scope, raw, r.Digest)
}
func (s *Store) List(ctx context.Context) ([]*core.Auth, error) {
	r, err := s.Repo.Lookup(ctx, s.Scope)
	if err != nil {
		return nil, err
	}
	if s.Operation != nil && s.Operation.OperationKind == "acquire" {
		if r.OperationID != s.Operation.OperationID || r.Epoch != s.Operation.Epoch || r.State != "pending" {
			return nil, ErrStale
		}
		return nil, nil
	}
	refresh := s.Operation != nil && s.Operation.OperationKind == "refresh"
	if refresh {
		o := s.Operation
		if r.OperationID != o.OperationID || r.Epoch != o.Epoch || r.Version != o.Version || r.State != "refreshing" || !r.Deadline.After(time.Now()) {
			return nil, ErrStale
		}
	} else if r.State != "connected" {
		return nil, ErrUnavailable
	}
	var b bundle
	if refresh {
		b, err = s.load(ctx, r)
	} else {
		if s.AccessSecrets == nil || r.AccessName == "" {
			return nil, ErrUnavailable
		}
		var raw []byte
		raw, err = s.AccessSecrets.Read(ctx, r.AccessName)
		if err == nil {
			b, err = decodeAccessBundle(s.Scope, raw, r.AccessDigest)
		}
	}
	if err != nil {
		return nil, err
	}
	return []*core.Auth{hydrate(r, b, refresh)}, nil
}
func (s *Store) Save(ctx context.Context, a *core.Auth) (string, error) {
	// A rotating grant may already have changed upstream. Capture its result
	// despite caller cancellation, with a bounded persistence budget.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 20*time.Second)
	defer cancel()
	if s.Operation == nil {
		return "", ErrStale
	}
	o := *s.Operation
	current, err := s.Repo.Lookup(ctx, s.Scope)
	if err != nil {
		return "", err
	}
	if current.Epoch != o.Epoch || current.Version != o.Version || current.OperationID != o.OperationID {
		return "", ErrStale
	}
	var latest *bundle
	if o.OperationKind == "refresh" {
		b, e := s.load(ctx, current)
		if e != nil {
			return "", e
		}
		latest = &b
	}
	next, err := normalizeAuth(s.Scope, a, latest)
	if err != nil {
		return "", err
	}
	if latest != nil && latest.subject() != next.subject() {
		return "", ErrCredential
	}
	raw, digest, err := encodeBundle(next)
	if err != nil {
		return "", err
	}
	projection, err := accessProjection(next)
	if err != nil {
		return "", err
	}
	accessRaw, accessDigest, err := encodeBundle(projection)
	if err != nil {
		return "", err
	}
	accessName := "mikka-byos-" + newID()
	name, err := s.Repo.Stage(ctx, o, digest, accessName, accessDigest)
	if err != nil {
		return "", err
	}
	// Persist both references before either create. Register both even if the first
	// fails, so recovery/cleanup can account for every possible late write.
	if err = s.Repo.artifact(ctx, o, "grant", name); err != nil {
		return "", err
	}
	if err = s.Repo.artifact(ctx, o, "access", accessName); err != nil {
		return "", err
	}
	if err = createArtifact(ctx, s.Repo, s.Secrets, o, "grant", name, raw); err != nil {
		_ = s.Repo.Fail(context.WithoutCancel(ctx), o, "publication_failed")
		return "", err
	}
	if err = createArtifact(ctx, s.Repo, s.AccessSecrets, o, "access", accessName, accessRaw); err != nil {
		_ = s.Repo.Fail(context.WithoutCancel(ctx), o, "publication_failed")
		return "", err
	}
	if err = s.Repo.Publish(ctx, o, name, digest, accessName, accessDigest, next.subject()); err != nil {
		return "", err
	}
	// CPA expects a persisted identifier, not necessarily a filesystem path.
	return name, nil
}
func (s *Store) Delete(ctx context.Context, id string) error {
	if id != s.Scope.ConnectionID {
		return ErrUnavailable
	}
	r, err := s.Repo.Lookup(ctx, s.Scope)
	if err != nil {
		return err
	}
	// This fences use before any optional provider logout / remote-secret GC.
	return s.Repo.Disconnect(ctx, s.Scope, r.Epoch)
}
func (s *Store) Recover(ctx context.Context) (Record, error) {
	r, err := s.Repo.Lookup(ctx, s.Scope)
	if err != nil {
		return Record{}, err
	}
	if r.State == "connected" {
		return r, nil
	}
	if r.State != "publication_pending" || r.StagedName == "" || r.StagedDigest == "" {
		return Record{}, ErrUnavailable
	}
	raw, err := s.Secrets.Read(ctx, r.StagedName)
	if err != nil {
		return Record{}, err
	}
	b, err := decodeBundle(s.Scope, raw, r.StagedDigest)
	if err != nil {
		return Record{}, err
	}
	if r.OperationKind == "refresh" && r.Subject != b.subject() {
		return Record{}, ErrIntegrity
	}
	projection, err := accessProjection(b)
	if err != nil {
		return Record{}, err
	}
	accessRaw, accessDigest, err := encodeBundle(projection)
	if err != nil {
		return Record{}, err
	}
	if r.StagedAccessName == "" && s.AccessSecrets != nil {
		r.StagedAccessName = "mikka-byos-" + newID()
		r.StagedAccessDigest = accessDigest
		result, e := s.Repo.DB.ExecContext(ctx, `update byos_connections set "stagedAccessName"=$3,"stagedAccessDigest"=$4 where id=$1 and "operationId"=$2 and state='publication_pending' and "stagedAccessName" is null`, r.ConnectionID, r.OperationID, r.StagedAccessName, accessDigest)
		if e != nil {
			return Record{}, ErrDatabase
		}
		n, _ := result.RowsAffected()
		if n != 1 {
			return Record{}, ErrStale
		}
	}
	if accessDigest != r.StagedAccessDigest || !validSecretName(r.StagedAccessName) || s.AccessSecrets == nil {
		return Record{}, ErrIntegrity
	}
	existing, readErr := s.AccessSecrets.Read(ctx, r.StagedAccessName)
	if readErr == ErrMissing {
		if err = createArtifact(ctx, s.Repo, s.AccessSecrets, Operation{r}, "access", r.StagedAccessName, accessRaw); err != nil {
			return Record{}, err
		}
	} else if readErr != nil {
		return Record{}, readErr
	} else if _, err = decodeAccessBundle(s.Scope, existing, accessDigest); err != nil {
		return Record{}, err
	}
	if err = s.Repo.Publish(ctx, Operation{r}, r.StagedName, r.StagedDigest, r.StagedAccessName, r.StagedAccessDigest, b.subject()); err != nil {
		return Record{}, err
	}

	return s.Repo.Lookup(ctx, s.Scope)
}

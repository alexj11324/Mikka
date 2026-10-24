package worker

import (
	"context"
	"time"

	core "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

// Store implements the actual CPA persistence interface. It has immutable
// owner scope and an optional durable operation; never a process-global tenant switch.
type Store struct {
	Repo      *Repository
	Secrets   SecretStore
	Scope     Scope
	Operation *Operation
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
	b, err := s.load(ctx, r)
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
	name, err := s.Repo.Stage(ctx, o, digest)
	if err != nil {
		return "", err
	}
	if err = s.Secrets.Create(ctx, name, raw); err != nil {
		// The create response can be lost after acceptance. Re-read only this
		// operation's immutable name; never repeat OAuth/refresh automatically.
		stored, readErr := s.Secrets.Read(ctx, name)
		if readErr != nil {
			_ = s.Repo.Fail(context.WithoutCancel(ctx), o, "publication_failed")
			return "", ErrStore
		}
		if _, checkErr := decodeBundle(s.Scope, stored, digest); checkErr != nil {
			_ = s.Repo.Fail(context.WithoutCancel(ctx), o, "integrity_failed")
			return "", ErrIntegrity
		}
	}
	if err = s.Repo.Publish(ctx, o, name, digest, next.subject()); err != nil {
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
	if err = s.Repo.Publish(ctx, Operation{r}, r.StagedName, r.StagedDigest, b.subject()); err != nil {
		return Record{}, err
	}
	return s.Repo.Lookup(ctx, s.Scope)
}

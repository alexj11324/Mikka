package worker

import (
	"context"
	"net/http"
	"regexp"
	"time"

	sdkauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/auth"
	core "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	exec "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/config"
)

type Metadata struct {
	ID                string `json:"id"`
	Provider          string `json:"provider"`
	State             string `json:"state"`
	Revision          int64  `json:"revision"`
	CredentialVersion int64  `json:"credentialVersion"`
}

func public(r Record) Metadata {
	return Metadata{r.ConnectionID, r.Provider, r.State, r.Epoch, r.Version}
}

// Each worker is permanently bound to one authenticated owner's connection.
// Registrations are trusted host objects, never input-supplied executables.
type Worker struct {
	Repo          *Repository
	Secrets       SecretStore
	Scope         Scope
	Authenticator sdkauth.Authenticator
	Executor      core.ProviderExecutor
}

func (w *Worker) store(operation *Operation) *Store {
	return &Store{w.Repo, w.Secrets, w.Scope, operation}
}
func (w *Worker) Status(ctx context.Context) (Metadata, error) {
	r, e := w.Repo.Lookup(ctx, w.Scope)
	return public(r), e
}

type scopedAuthenticator struct {
	base  sdkauth.Authenticator
	scope Scope
}

func (a scopedAuthenticator) Provider() string            { return a.scope.Provider }
func (a scopedAuthenticator) RefreshLead() *time.Duration { return a.base.RefreshLead() }
func (a scopedAuthenticator) Login(ctx context.Context, cfg *config.Config, opts *sdkauth.LoginOptions) (*core.Auth, error) {
	record, err := a.base.Login(ctx, cfg, opts)
	if err != nil {
		return nil, ErrProvider
	}
	if record == nil || record.Provider != a.scope.Provider {
		return nil, ErrCredential
	}
	copy := record.Clone()
	copy.ID = a.scope.ConnectionID
	copy.FileName = ""
	return copy, nil
}
func (w *Worker) Acquire(ctx context.Context, expectedEpoch int64) (Metadata, error) {
	if w.Authenticator == nil || w.Authenticator.Provider() != w.Scope.Provider {
		return Metadata{}, ErrUnsupported
	}
	o, err := w.Repo.BeginAcquire(ctx, w.Scope, expectedEpoch)
	if err != nil {
		return Metadata{}, err
	}
	store := w.store(&o)
	manager := sdkauth.NewManager(store, scopedAuthenticator{w.Authenticator, w.Scope})
	// Empty AuthDir prevents the SDK's optional legacy auth-dir file merge.
	// Real CLI-oriented authenticators are not registered by the shipped entrypoint.
	_, _, err = manager.Login(ctx, w.Scope.Provider, &config.Config{}, &sdkauth.LoginOptions{NoBrowser: true})
	if err != nil {
		_ = w.Repo.Fail(context.WithoutCancel(ctx), o, "publication_failed")
		return Metadata{}, Refusal(safeCode(err))
	}
	r, err := w.Repo.Lookup(ctx, w.Scope)
	if err != nil || r.State != "connected" || r.Epoch != o.Epoch {
		return Metadata{}, ErrStore
	}
	return public(r), nil
}

// Sanitize before errors enter CPA's own diagnostic logger as well as IPC.
type safeExecutor struct{ core.ProviderExecutor }

func (e safeExecutor) Refresh(ctx context.Context, a *core.Auth) (*core.Auth, error) {
	next, err := e.ProviderExecutor.Refresh(ctx, a)
	if err != nil {
		return nil, ErrProvider
	}
	return next, nil
}
func (e safeExecutor) HttpRequest(context.Context, *core.Auth, *http.Request) (*http.Response, error) {
	return nil, ErrUnsupported
}
func (w *Worker) Refresh(ctx context.Context, expectedEpoch int64) (Metadata, error) {
	if w.Executor == nil || w.Executor.Identifier() != w.Scope.Provider {
		return Metadata{}, ErrUnsupported
	}
	r, err := w.Repo.Lookup(ctx, w.Scope)
	if err != nil {
		return Metadata{}, err
	}
	if r.Epoch != expectedEpoch || r.State != "connected" {
		return Metadata{}, ErrUnavailable
	}
	o, err := w.Repo.ClaimRefresh(ctx, w.Scope, r.Epoch, r.Version)
	if err != nil {
		return Metadata{}, err
	}
	store := w.store(&o)
	manager := core.NewManager(store, nil, nil)
	manager.RegisterExecutor(safeExecutor{w.Executor})
	if err = manager.Load(ctx); err == nil {
		_, err = manager.ForceRefreshAuth(ctx, w.Scope.ConnectionID)
	}
	if err != nil {
		_ = w.Repo.Fail(context.WithoutCancel(ctx), o, "refresh_failed")
		return Metadata{}, Refusal(safeCode(err))
	}
	// CPA's own registration/persistence behavior cannot override durable fencing.
	current, err := w.Repo.Connected(ctx, w.Scope, o.Epoch, o.Version+1)
	if err != nil {
		return Metadata{}, ErrStore
	}
	return public(current), nil
}

var modelPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)

func (w *Worker) readyAuth(ctx context.Context, expectedEpoch int64) (Record, *core.Auth, error) {
	load := func() (Record, *core.Auth, error) {
		r, err := w.Repo.Lookup(ctx, w.Scope)
		if err != nil {
			return Record{}, nil, err
		}
		if r.State != "connected" || r.Epoch != expectedEpoch {
			return Record{}, nil, ErrUnavailable
		}
		auths, err := w.store(nil).List(ctx)
		if err != nil {
			return Record{}, nil, err
		}
		return r, auths[0], nil
	}
	r, a, err := load()
	if err != nil {
		return Record{}, nil, err
	}
	expires, known := a.AccessTokenExpirationTime()
	if !known {
		return Record{}, nil, ErrCredential
	}
	if !expires.After(time.Now().Add(time.Minute)) {
		if _, err = w.Refresh(ctx, expectedEpoch); err != nil {
			return Record{}, nil, err
		}
		r, a, err = load()
		if err != nil {
			return Record{}, nil, err
		}
		expires, known = a.AccessTokenExpirationTime()
		if !known || !expires.After(time.Now()) {
			return Record{}, nil, ErrProvider
		}
	}
	if _, err = w.Repo.Connected(ctx, w.Scope, r.Epoch, r.Version); err != nil {
		return Record{}, nil, err
	}
	return r, a, nil
}

func (w *Worker) Execute(ctx context.Context, expectedEpoch int64, model string, payload []byte) ([]byte, error) {
	if w.Executor == nil || w.Executor.Identifier() != w.Scope.Provider {
		return nil, ErrUnsupported
	}
	if !modelPattern.MatchString(model) || len(payload) > 65536 {
		return nil, ErrProvider
	}
	_, auth, err := w.readyAuth(ctx, expectedEpoch)
	if err != nil {
		return nil, err
	}
	// One explicit account, no pool, fallback, retry or refresh token in inference.
	response, err := w.Executor.Execute(ctx, auth, exec.Request{Model: model, Payload: payload}, exec.Options{})
	if err != nil || len(response.Payload) > 1048576 {
		return nil, ErrProvider
	}
	return response.Payload, nil
}
func (w *Worker) Disconnect(ctx context.Context, expectedEpoch int64) (Metadata, error) {
	if err := w.Repo.Disconnect(ctx, w.Scope, expectedEpoch); err != nil {
		return Metadata{}, err
	}
	return w.Status(ctx)
}
func (w *Worker) Recover(ctx context.Context) (Metadata, error) {
	r, e := w.store(nil).Recover(ctx)
	return public(r), e
}

// A private runtime handoff, not part of Status or the browser/agent RPC.
// This implements the official host-managed Codex auth parameter shape only;
// actual CPA token audience/CLI-version compatibility still needs validation.
type CodexNativeAuth struct {
	Type             string `json:"type"`
	AccessToken      string `json:"accessToken"`
	ChatGPTAccountID string `json:"chatgptAccountId"`
	ChatGPTPlanType  string `json:"chatgptPlanType,omitempty"`
}

func (CodexNativeAuth) String() string   { return "[native auth redacted]" }
func (CodexNativeAuth) GoString() string { return "[native auth redacted]" }
func (w *Worker) CodexNativeAuth(ctx context.Context, expectedEpoch int64) (CodexNativeAuth, error) {
	if w.Scope.Provider != "codex" {
		return CodexNativeAuth{}, ErrUnsupported
	}
	_, auth, err := w.readyAuth(ctx, expectedEpoch)
	if err != nil {
		return CodexNativeAuth{}, err
	}
	// Native Codex's ChatGPT access grant and SIWC direct-model grants are not
	// interchangeable. Do not silently select the outer token of a SIWC route.
	if core.IsCodexUseSIWC(auth) {
		return CodexNativeAuth{}, ErrUnsupported
	}
	access, _ := auth.Metadata["access_token"].(string)
	account, _ := auth.Metadata["account_id"].(string)
	plan, _ := auth.Metadata["plan_type"].(string)
	return CodexNativeAuth{"chatgptAuthTokens", access, account, plan}, nil
}

// Private access lease for the documented CLAUDE_CODE_OAUTH_TOKEN input. It
// conveys no refresh grant or native credential-file configuration. Real CPA
// grant scopes/native acceptance remain an activation gate.
type ClaudeNativeAuth struct {
	AccountID   string    `json:"accountId"`
	AccessToken string    `json:"accessToken"`
	ExpiresAt   time.Time `json:"expiresAt"`
}

func (ClaudeNativeAuth) String() string   { return "[native auth redacted]" }
func (ClaudeNativeAuth) GoString() string { return "[native auth redacted]" }
func (w *Worker) ClaudeNativeAuth(ctx context.Context, expectedEpoch int64) (ClaudeNativeAuth, error) {
	if w.Scope.Provider != "claude" {
		return ClaudeNativeAuth{}, ErrUnsupported
	}
	r, auth, err := w.readyAuth(ctx, expectedEpoch)
	if err != nil {
		return ClaudeNativeAuth{}, err
	}
	expires, known := auth.AccessTokenExpirationTime()
	if !known {
		return ClaudeNativeAuth{}, ErrCredential
	}
	access, _ := auth.Metadata["access_token"].(string)
	return ClaudeNativeAuth{r.Subject, access, expires}, nil
}

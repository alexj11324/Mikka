package worker

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"time"

	sdkauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/auth"
	core "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/config"
	compat "github.com/router-for-me/CLIProxyAPI/v8/sdk/mikkaadapter"
)

// Implementations are control-plane registrations, never callback-supplied URLs.
type OAuthProvider interface {
	Authorize(state, verifier string) (string, error)
	Exchange(context.Context, string, string, string) (*core.Auth, error)
}
type OAuthStart struct {
	Flow             string    `json:"flow"`
	State            string    `json:"state"`
	UserCode         string    `json:"userCode,omitempty"`
	Interval         int       `json:"interval,omitempty"`
	ExpiresAt        time.Time `json:"expiresAt"`
	AuthorizationURL string    `json:"authorizationUrl"`
	Revision         int64     `json:"revision"`
}
type oauthSecret struct {
	Scope       Scope          `json:"scope"`
	SessionHash string         `json:"sessionHash"`
	Device      *DeviceAttempt `json:"device,omitempty"`
	Verifier    string         `json:"verifier"`
	OperationID string         `json:"operationId"`
	// Only the owning session can recover this encrypted presentation. SQL
	// retains its state hash, never the raw state or the private provider code.
	Start *OAuthStart `json:"start,omitempty"`
}

func hashText(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}
func randomCode() string {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("system entropy unavailable")
	}
	return base64.RawURLEncoding.EncodeToString(b[:])
}

func (w *Worker) StartOAuth(ctx context.Context, epoch int64, sessionID string) (OAuthStart, error) {
	if w.ExecutionOnly || w.Secrets == nil {
		return OAuthStart{}, ErrUnsupported
	}
	if w.OAuth == nil || sessionID == "" || len(sessionID) > 512 {
		return OAuthStart{}, ErrUnsupported
	}
	current, err := w.Repo.Lookup(ctx, w.Scope)
	if err != nil {
		return OAuthStart{}, err
	}
	// A reserved connection starts at epoch 1. Every later pending epoch
	// belongs to a start; another tab must resume it, never replace it.
	if current.State == "pending" && current.Epoch > 1 && current.Deadline.After(time.Now()) {
		if epoch != current.Epoch && epoch+1 != current.Epoch {
			return OAuthStart{}, ErrStale
		}
		return w.ResumeOAuth(ctx, sessionID)
	}
	if current.Epoch != epoch {
		return OAuthStart{}, ErrStale
	}
	if device, ok := w.OAuth.(DeviceOAuth); ok {
		return w.startDevice(ctx, epoch, sessionID, device)
	}
	state, verifier := randomCode(), randomCode()
	authURL, err := w.OAuth.Authorize(state, verifier)
	if err != nil {
		return OAuthStart{}, ErrUnsupported
	}
	parsed, err := url.Parse(authURL)
	if err != nil || parsed.Scheme != "https" || parsed.User != nil || parsed.Host == "" || parsed.Query().Get("state") != state || parsed.Query().Get("code_challenge_method") != "S256" {
		return OAuthStart{}, ErrUnsupported
	}
	op, err := w.Repo.BeginAcquire(ctx, w.Scope, epoch)
	if err != nil {
		if err == ErrStale {
			return w.ResumeOAuth(ctx, sessionID)
		}
		return OAuthStart{}, err
	}
	name := "mikka-byos-" + newID()
	start := OAuthStart{Flow: "callback_handoff", State: state, AuthorizationURL: authURL, Revision: op.Epoch, ExpiresAt: op.Deadline}
	raw, _ := json.Marshal(oauthSecret{Scope: w.Scope, SessionHash: hashText(sessionID), Verifier: verifier, OperationID: op.OperationID, Start: &start})
	if err = createArtifact(ctx, w.Repo, w.Secrets, op, "oauth", name, raw); err != nil {
		_ = w.Repo.Fail(context.WithoutCancel(ctx), op, "publication_failed")
		return OAuthStart{}, ErrStore
	}
	_, err = w.Repo.DB.ExecContext(ctx, `insert into byos_oauth_attempts ("stateHash","sessionHash","connectionId","ownerId","workspaceId","operationId","secretName","expiresAt") select $1,$2,$3,$4,$5,$6,$7,$8 where exists(select 1 from byos_connections where id=$3 and "ownerId"=$4 and "workspaceId"=$5 and "operationId"=$6 and epoch=$9 and state='pending' and "operationDeadline">now())`, hashText(state), hashText(sessionID), w.Scope.ConnectionID, w.Scope.OwnerID, w.Scope.WorkspaceID, op.OperationID, name, op.Deadline, op.Epoch)
	if err != nil {
		_ = w.Repo.Fail(context.WithoutCancel(ctx), op, "publication_failed")
		return OAuthStart{}, ErrDatabase
	}
	return w.ResumeOAuth(ctx, sessionID)
}

// ResumeOAuth reads an existing acquisition without contacting the provider.
// Navigation cannot change its owner, session, operation, revision or deadline.
func (w *Worker) ResumeOAuth(ctx context.Context, sessionID string) (OAuthStart, error) {
	if w.ExecutionOnly || w.Secrets == nil || sessionID == "" || len(sessionID) > 512 {
		return OAuthStart{}, ErrUnsupported
	}
	record, err := w.Repo.Lookup(ctx, w.Scope)
	if err != nil || record.State != "pending" || record.OperationKind != "acquire" || !record.Deadline.After(time.Now()) {
		return OAuthStart{}, ErrStale
	}
	var name, stateHash, sessionHash string
	err = w.Repo.DB.QueryRowContext(ctx, `select "secretName","stateHash","sessionHash" from byos_oauth_attempts where "connectionId"=$1 and "ownerId"=$2 and "workspaceId"=$3 and "operationId"=$4 and "expiresAt">now()`, w.Scope.ConnectionID, w.Scope.OwnerID, w.Scope.WorkspaceID, record.OperationID).Scan(&name, &stateHash, &sessionHash)
	if err == sql.ErrNoRows {
		return OAuthStart{}, ErrBusy // the first start has not published its attempt yet
	}
	if err != nil {
		return OAuthStart{}, ErrDatabase
	}
	if sessionHash != hashText(sessionID) {
		return OAuthStart{}, ErrStale
	}
	raw, err := w.Secrets.Read(ctx, name)
	if err != nil {
		return OAuthStart{}, ErrStore
	}
	var secret oauthSecret
	if json.Unmarshal(raw, &secret) != nil || secret.Scope != w.Scope || secret.SessionHash != sessionHash || secret.OperationID != record.OperationID {
		return OAuthStart{}, ErrIntegrity
	}
	if secret.Start == nil { // Legacy attempts retain their bounded expiry.
		return OAuthStart{}, ErrReauthenticate
	}
	start := *secret.Start
	if !validState(start.State) || hashText(start.State) != stateHash || start.Revision != record.Epoch || !start.ExpiresAt.Equal(record.Deadline) {
		return OAuthStart{}, ErrIntegrity
	}
	// A secret read can race Cancel or expiry. Recheck before returning the URL.
	current, err := w.Repo.Lookup(ctx, w.Scope)
	if err != nil || current.State != "pending" || current.OperationID != record.OperationID || current.Epoch != record.Epoch || !current.Deadline.After(time.Now()) {
		return OAuthStart{}, ErrStale
	}
	return start, nil
}

type codeAuthenticator struct {
	provider string
	exchange func(context.Context) (*core.Auth, error)
}

func (a codeAuthenticator) Provider() string            { return a.provider }
func (a codeAuthenticator) RefreshLead() *time.Duration { return nil }
func (a codeAuthenticator) Login(ctx context.Context, _ *config.Config, _ *sdkauth.LoginOptions) (*core.Auth, error) {
	return a.exchange(ctx)
}
func (w *Worker) CompleteOAuth(ctx context.Context, sessionID, state, code string) (Metadata, error) {
	if w.ExecutionOnly || w.Secrets == nil {
		return Metadata{}, ErrUnsupported
	}
	if w.OAuth == nil || sessionID == "" || len(sessionID) > 512 || !validState(state) || len(code) == 0 || len(code) > 4096 || strings.ContainsAny(code, "#\r\n\x00") {
		return Metadata{}, ErrUnsupported
	}
	var opID, name string
	err := w.Repo.DB.QueryRowContext(ctx, `update byos_oauth_attempts a set "consumedAt"=now() where "stateHash"=$1 and "sessionHash"=$2 and "connectionId"=$3 and "ownerId"=$4 and "workspaceId"=$5 and flow='pkce' and "consumedAt" is null and "expiresAt">now() and exists(select 1 from byos_connections c where c.id=a."connectionId" and c."operationId"=a."operationId" and c.state='pending' and c."operationDeadline">now()) returning "operationId"::text,"secretName"`, hashText(state), hashText(sessionID), w.Scope.ConnectionID, w.Scope.OwnerID, w.Scope.WorkspaceID).Scan(&opID, &name)
	if err != nil {
		return Metadata{}, ErrStale
	}
	r, err := w.Repo.Lookup(ctx, w.Scope)
	if err != nil || r.OperationID != opID || r.State != "pending" {
		return Metadata{}, ErrStale
	}
	op := Operation{r}
	fail := func(e error) (Metadata, error) {
		_ = w.Repo.Fail(context.WithoutCancel(ctx), op, "publication_failed")
		return Metadata{}, e
	}
	raw, err := w.Secrets.Read(ctx, name)
	if err != nil {
		return fail(ErrStore)
	}
	var attempt oauthSecret
	if json.Unmarshal(raw, &attempt) != nil || attempt.Scope != w.Scope || attempt.SessionHash != hashText(sessionID) || attempt.OperationID != opID || len(attempt.Verifier) != 43 {
		return fail(ErrIntegrity)
	}
	return w.publishOAuth(ctx, op, code, state, attempt.Verifier)
}
func newOAuthManager(w *Worker, op Operation, code, state, verifier string) func(context.Context) error {
	return func(ctx context.Context) error {
		manager := sdkauth.NewManager(w.store(&op), scopedAuthenticator{codeAuthenticator{w.Scope.Provider, func(ctx context.Context) (*core.Auth, error) {
			return w.OAuth.Exchange(ctx, code, state, verifier)
		}}, w.Scope})
		_, _, err := manager.Login(ctx, w.Scope.Provider, &config.Config{}, &sdkauth.LoginOptions{NoBrowser: true})
		return err
	}

}

// Codex acquisition uses CPA's plain OAuth service, not its legacy inference
// executor or CLI-oriented callback listener/logger. Redirect is fixed by host.
type CPACodexOAuth struct {
	Client *http.Client
}

func (p CPACodexOAuth) service() interface {
	GenerateAuthURL(string, *compat.CodexPKCECodes) (string, error)
	ExchangeCodeForTokensWithRedirect(context.Context, string, string, *compat.CodexPKCECodes) (*compat.CodexAuthBundle, error)
	CreateTokenStorage(*compat.CodexAuthBundle) *compat.CodexTokenStorage
} {
	return compat.NewCodexAuthWithHTTPClient(plainOAuthClient(p.Client))
}

func (p CPACodexOAuth) Authorize(string, string) (string, error) { return "", ErrUnsupported }
func (p CPACodexOAuth) Exchange(ctx context.Context, code, _ string, verifier string) (*core.Auth, error) {
	svc := p.service()
	b, err := svc.ExchangeCodeForTokensWithRedirect(ctx, code, codexDeviceRedirect, &compat.CodexPKCECodes{CodeVerifier: verifier})
	if err != nil {
		return nil, ErrProvider
	}
	return &core.Auth{Provider: "codex", Storage: svc.CreateTokenStorage(b)}, nil
}

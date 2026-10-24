package worker

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
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
	if w.OAuth == nil || sessionID == "" || len(sessionID) > 512 {
		return OAuthStart{}, ErrUnsupported
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
		return OAuthStart{}, err
	}
	name := "mikka-byos-" + newID()
	raw, _ := json.Marshal(oauthSecret{Scope: w.Scope, SessionHash: hashText(sessionID), Verifier: verifier, OperationID: op.OperationID})
	if err = w.Secrets.Create(ctx, name, raw); err != nil {
		_ = w.Repo.Fail(context.WithoutCancel(ctx), op, "publication_failed")
		return OAuthStart{}, ErrStore
	}
	_, err = w.Repo.DB.ExecContext(ctx, `insert into byos_oauth_attempts ("stateHash","sessionHash","connectionId","ownerId","workspaceId","operationId","secretName","expiresAt") values ($1,$2,$3,$4,$5,$6,$7,now()+interval '5 minutes')`, hashText(state), hashText(sessionID), w.Scope.ConnectionID, w.Scope.OwnerID, w.Scope.WorkspaceID, op.OperationID, name)
	if err != nil {
		_ = w.Repo.Fail(context.WithoutCancel(ctx), op, "publication_failed")
		return OAuthStart{}, ErrDatabase
	}
	return OAuthStart{Flow: "callback_handoff", State: state, AuthorizationURL: authURL, Revision: op.Epoch, ExpiresAt: time.Now().Add(5 * time.Minute)}, nil
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
	if w.OAuth == nil || sessionID == "" || len(sessionID) > 512 || !validState(state) || len(code) == 0 || len(code) > 4096 || strings.ContainsAny(code, "#\r\n\x00") {
		return Metadata{}, ErrUnsupported
	}
	var opID, name string
	err := w.Repo.DB.QueryRowContext(ctx, `update byos_oauth_attempts set "consumedAt"=now() where "stateHash"=$1 and "sessionHash"=$2 and "connectionId"=$3 and "ownerId"=$4 and "workspaceId"=$5 and flow='pkce' and "consumedAt" is null and "expiresAt">now() returning "operationId"::text,"secretName"`, hashText(state), hashText(sessionID), w.Scope.ConnectionID, w.Scope.OwnerID, w.Scope.WorkspaceID).Scan(&opID, &name)
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

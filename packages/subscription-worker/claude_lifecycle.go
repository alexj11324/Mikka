package worker

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	core "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	compat "github.com/router-for-me/CLIProxyAPI/v8/sdk/mikkaadapter"
	"net/http"
	"net/url"
	"time"
)

// CPA-derived OAuth adapter using ordinary HTTPS. Never constructs CPA's
// Firefox-fingerprint client, device pool, roles replay or model cloaking path.
type CPAClaudeOAuth struct {
	RedirectURI string
	Client      *http.Client
}

func (p CPAClaudeOAuth) Authorize(state, verifier string) (string, error) {
	redirect, err := url.Parse(p.RedirectURI)
	if err != nil || redirect.User != nil || redirect.RawQuery != "" || redirect.Fragment != "" || !((redirect.Scheme == "https" && redirect.Host != "") || p.RedirectURI == "http://localhost:54545/callback") {
		return "", ErrUnsupported
	}
	sum := sha256.Sum256([]byte(verifier))
	svc := compat.NewClaudeAuthWithHTTPClient(plainOAuthClient(p.Client))
	raw, returned, err := svc.GenerateAuthURL(state, &compat.ClaudePKCECodes{CodeVerifier: verifier, CodeChallenge: base64.RawURLEncoding.EncodeToString(sum[:])})
	if err != nil || returned != state {
		return "", ErrUnsupported
	}
	parsed, _ := url.Parse(raw)
	query := parsed.Query()
	query.Set("redirect_uri", p.RedirectURI)
	parsed.RawQuery = query.Encode()
	return parsed.String(), nil
}
func (p CPAClaudeOAuth) Exchange(ctx context.Context, code, state, verifier string) (*core.Auth, error) {
	svc := compat.NewClaudeAuthWithHTTPClient(plainOAuthClient(p.Client))
	value, err := svc.ExchangeMikkaCodeForTokens(ctx, code, state, p.RedirectURI, &compat.ClaudePKCECodes{CodeVerifier: verifier})
	if err != nil {
		return nil, ErrProvider
	}
	return &core.Auth{Provider: "claude", Storage: svc.CreateTokenStorage(value)}, nil
}

type CPAClaudeLifecycle struct {
	CPACodexLifecycle
	Client *http.Client
}

func (CPAClaudeLifecycle) Identifier() string { return "claude" }
func (e CPAClaudeLifecycle) Refresh(ctx context.Context, a *core.Auth) (*core.Auth, error) {
	token, _ := a.Metadata["refresh_token"].(string)
	next, err := compat.NewClaudeAuthWithHTTPClient(plainOAuthClient(e.Client)).RefreshTokens(ctx, token)
	if err != nil {
		return nil, ErrProvider
	}
	copy := a.Clone()
	copy.Metadata = cloneMap(a.Metadata)
	for key, value := range map[string]string{"access_token": next.AccessToken, "refresh_token": next.RefreshToken, "account_uuid": next.AccountUUID, "organization_uuid": next.OrganizationUUID, "expired": next.Expire} {
		if value != "" {
			copy.Metadata[key] = value
		}
	}
	copy.Metadata["last_refresh"] = time.Now().UTC().Format(time.RFC3339)
	return copy, nil
}

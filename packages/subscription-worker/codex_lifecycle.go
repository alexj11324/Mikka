package worker

import (
	"context"
	core "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	exec "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
	compat "github.com/router-for-me/CLIProxyAPI/v8/sdk/mikkaadapter"
	"net/http"
	"time"
)

// Uses CPA's plain Codex OAuth refresh service. Deliberately excludes the legacy
// model executor's Codex CLI identity headers/undocumented inference endpoint.
type CPACodexLifecycle struct{}

func (CPACodexLifecycle) Identifier() string { return "codex" }
func (CPACodexLifecycle) Refresh(ctx context.Context, a *core.Auth) (*core.Auth, error) {
	if core.IsCodexUseSIWC(a) {
		return nil, ErrUnsupported
	}
	token, _ := a.Metadata["refresh_token"].(string)
	client := plainOAuthClient(nil)
	next, err := compat.NewCodexAuthWithHTTPClient(client).RefreshTokens(ctx, token)
	if err != nil {
		return nil, ErrProvider
	}
	before := cloneMap(a.Metadata)
	after := cloneMap(before)
	after["access_token"] = next.AccessToken
	if next.RefreshToken != "" {
		after["refresh_token"] = next.RefreshToken
	}
	if next.IDToken != "" {
		after["id_token"] = next.IDToken
	}
	if next.AccountID != "" {
		after["account_id"] = next.AccountID
	}
	after["expired"] = next.Expire
	after["last_refresh"] = time.Now().UTC().Format(time.RFC3339)
	copy := a.Clone()
	copy.Metadata = after
	copy.CodexRefreshPatch = compat.NewCredentialRefreshPatch(before, after, true, false)
	return copy, nil
}
func (CPACodexLifecycle) Execute(context.Context, *core.Auth, exec.Request, exec.Options) (exec.Response, error) {
	return exec.Response{}, ErrUnsupported
}
func (CPACodexLifecycle) ExecuteStream(context.Context, *core.Auth, exec.Request, exec.Options) (*exec.StreamResult, error) {
	return nil, ErrUnsupported
}
func (CPACodexLifecycle) CountTokens(context.Context, *core.Auth, exec.Request, exec.Options) (exec.Response, error) {
	return exec.Response{}, ErrUnsupported
}
func (CPACodexLifecycle) HttpRequest(context.Context, *core.Auth, *http.Request) (*http.Response, error) {
	return nil, ErrUnsupported
}

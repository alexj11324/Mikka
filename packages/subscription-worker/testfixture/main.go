//go:build mikka_byos_fixture

// Acceptance-only process. Not compiled into the production worker; refuses
// any database except an explicit isolated loopback *_e2e database.
package main

import (
	"bufio"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	w "github.com/alexj11324/Mikka/subscription-worker"
	_ "github.com/jackc/pgx/v5/stdlib"
	core "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	ex "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
	compat "github.com/router-for-me/CLIProxyAPI/v8/sdk/mikkaadapter"
)

type fixtureTransport func(*http.Request) (*http.Response, error)

func (f fixtureTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

type fixture struct{ provider string }

func (f fixture) Authorize(state, verifier string) (string, error) {
	sum := sha256.Sum256([]byte(verifier))
	host := "https://auth.openai.com/oauth/authorize"
	if f.provider == "claude" {
		host = "https://claude.ai/oauth/authorize"
	}
	q := url.Values{"state": {state}, "code_challenge": {base64.RawURLEncoding.EncodeToString(sum[:])}, "code_challenge_method": {"S256"}, "redirect_uri": {"http://localhost/fixture-callback"}}
	return host + "?" + q.Encode(), nil
}
func (f fixture) Exchange(_ context.Context, code, _ string, verifier string) (*core.Auth, error) {
	if code != "fixture-grant" || len(verifier) != 43 {
		return nil, w.ErrProvider
	}
	expiry := time.Now().Add(2 * time.Hour).UTC().Format(time.RFC3339)
	a := &core.Auth{Provider: f.provider}
	if f.provider == "codex" {
		a.Storage = &compat.CodexTokenStorage{AccessToken: "fixture-access", RefreshToken: "fixture-refresh", IDToken: "fixture-id", AccountID: "fixture-account", Expire: expiry, PlanType: "plus"}
	} else {
		a.Storage = &compat.ClaudeTokenStorage{AccessToken: "fixture-access", RefreshToken: "fixture-refresh", AccountUUID: "fixture-account", OrganizationUUID: "fixture-org", Expire: expiry}
	}
	return a, nil
}
func (f fixture) Identifier() string { return f.provider }
func (f fixture) Refresh(_ context.Context, a *core.Auth) (*core.Auth, error) {
	if a.Metadata["refresh_token"] == nil {
		return nil, w.ErrCredential
	}
	copy := a.Clone()
	copy.Metadata = map[string]any{}
	for k, v := range a.Metadata {
		copy.Metadata[k] = v
	}
	copy.Metadata["access_token"] = "fixture-access-rotated"
	copy.Metadata["refresh_token"] = "fixture-refresh-rotated"
	copy.Metadata["expired"] = time.Now().Add(2 * time.Hour).UTC().Format(time.RFC3339)
	if f.provider == "codex" {
		copy.CodexRefreshPatch = compat.NewCredentialRefreshPatch(a.Metadata, copy.Metadata, true, false)
	}
	return copy, nil
}
func (f fixture) Execute(context.Context, *core.Auth, ex.Request, ex.Options) (ex.Response, error) {
	return ex.Response{}, w.ErrUnsupported
}
func (f fixture) CountTokens(context.Context, *core.Auth, ex.Request, ex.Options) (ex.Response, error) {
	return ex.Response{}, w.ErrUnsupported
}
func (f fixture) ExecuteStream(context.Context, *core.Auth, ex.Request, ex.Options) (*ex.StreamResult, error) {
	return nil, w.ErrUnsupported
}
func (f fixture) HttpRequest(context.Context, *core.Auth, *http.Request) (*http.Response, error) {
	return nil, w.ErrUnsupported
}
func main() {
	if run() != nil {
		fmt.Fprintln(os.Stderr, "fixture_worker_unavailable")
		os.Exit(1)
	}
}
func run() error {
	input := bufio.NewReaderSize(os.Stdin, 65537)
	line, err := input.ReadBytes('\n')
	if err != nil || len(line) > 65536 {
		return w.ErrUnsupported
	}
	var c struct {
		Scope       w.Scope `json:"scope"`
		DatabaseURL string  `json:"databaseUrl"`
		Origin      string  `json:"infisicalOrigin"`
		Project     string  `json:"project"`
		Environment string  `json:"environment"`
		Path        string  `json:"path"`
		Token       string  `json:"workloadToken"`
	}
	if json.Unmarshal(line, &c) != nil {
		return w.ErrUnsupported
	}
	u, err := url.Parse(c.DatabaseURL)
	if err != nil || u.Hostname() != "127.0.0.1" || !strings.HasSuffix(u.Path, "_e2e") {
		return w.ErrUnsupported
	}
	db, err := sql.Open("pgx", c.DatabaseURL)
	if err != nil {
		return err
	}
	defer db.Close()
	secrets, err := w.NewInfisical(w.InfisicalConfig{Origin: c.Origin, ProjectID: c.Project, Environment: c.Environment, Path: c.Path, Token: func(context.Context) (string, error) { return c.Token, nil }})
	if err != nil {
		return err
	}
	worker := w.Worker{Repo: &w.Repository{DB: db}, Secrets: secrets, Scope: c.Scope, OAuth: fixture{c.Scope.Provider}, Executor: fixture{c.Scope.Provider}}
	upstream, err := url.Parse(os.Getenv("MIKKA_BYOS_FIXTURE_UPSTREAM_ORIGIN"))
	if err != nil || upstream.Scheme != "https" || upstream.Hostname() != "127.0.0.1" {
		return w.ErrUnsupported
	}
	client := &http.Client{Transport: fixtureTransport(func(request *http.Request) (*http.Response, error) {
		if request.URL.String() != "https://api.anthropic.com/v1/messages" && request.URL.String() != "https://chatgpt.com/backend-api/codex/responses" {
			return nil, w.ErrUnsupported
		}
		clone := request.Clone(request.Context())
		target := *upstream
		target.Path = "/provider/" + c.Scope.Provider
		clone.URL = &target
		clone.Host = upstream.Host
		return http.DefaultTransport.RoundTrip(clone)
	})}
	worker.Executor = w.CPAPlainModel{ProviderExecutor: fixture{c.Scope.Provider}, Provider: c.Scope.Provider, Client: client}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM)
	defer stop()
	return worker.Serve(ctx, input, os.Stdout)
}

//go:build mikka_byos_fixture

// Acceptance-only process. Not compiled into the production worker; refuses
// any database except an explicit isolated loopback *_e2e database.
package main

import (
	"bufio"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	log "github.com/sirupsen/logrus"
	"io"
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
	log.SetOutput(io.Discard)
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
		Scope         w.Scope       `json:"scope"`
		Use           *w.RuntimeUse `json:"use"`
		ExecutionOnly bool          `json:"executionOnly"`
		AccessPath    string        `json:"accessPath"`
		AccessToken   string        `json:"accessToken"`
		DatabaseURL   string        `json:"databaseUrl"`
		Origin        string        `json:"infisicalOrigin"`
		Project       string        `json:"project"`
		Environment   string        `json:"environment"`
		Path          string        `json:"path"`
		Token         string        `json:"workloadToken"`
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
	grantPath, grantToken := c.Path, c.Token
	if c.ExecutionOnly {
		grantPath, grantToken = c.AccessPath, c.AccessToken
	}
	secrets, err := w.NewInfisical(w.InfisicalConfig{Origin: c.Origin, ProjectID: c.Project, Environment: c.Environment, Path: grantPath, Token: func(context.Context) (string, error) { return grantToken, nil }})
	if err != nil {
		return err
	}
	worker := w.Worker{Repo: &w.Repository{DB: db}, Secrets: secrets, AccessSecrets: secrets, Use: c.Use, ExecutionOnly: c.ExecutionOnly, AllowNativeAuth: !c.ExecutionOnly, Scope: c.Scope, Executor: fixture{c.Scope.Provider}}
	upstream, err := url.Parse(os.Getenv("MIKKA_BYOS_FIXTURE_UPSTREAM_ORIGIN"))
	if err != nil || upstream.Scheme != "https" || upstream.Hostname() != "127.0.0.1" {
		return w.ErrUnsupported
	}
	client := &http.Client{Transport: fixtureTransport(func(request *http.Request) (*http.Response, error) {
		model := request.URL.String() == "https://api.anthropic.com/v1/messages" || request.URL.String() == "https://api.anthropic.com/v1/messages?beta=true" || request.URL.String() == "https://chatgpt.com/backend-api/codex/responses"
		quota := request.URL.String() == "https://chatgpt.com/backend-api/wham/usage" || request.URL.String() == "https://api.anthropic.com/api/oauth/usage"
		oauth := request.URL.String() == "https://auth.openai.com/api/accounts/deviceauth/usercode" || request.URL.String() == "https://auth.openai.com/api/accounts/deviceauth/token" || request.URL.String() == "https://auth.openai.com/oauth/token" || request.URL.String() == "https://platform.claude.com/v1/oauth/token"
		if !model && !oauth && !quota {
			return nil, w.ErrUnsupported
		}
		clone := request.Clone(request.Context())
		target := *upstream
		if model {
			target.Path = "/provider/" + c.Scope.Provider
		} else if quota {
			target.Path = "/quota/" + c.Scope.Provider
		} else {
			target.Path = "/oauth/" + c.Scope.Provider + request.URL.Path
		}
		clone.URL = &target
		clone.Host = upstream.Host
		return http.DefaultTransport.RoundTrip(clone)
	})}
	if c.Scope.Provider == "codex" {
		worker.OAuth = w.CPACodexOAuth{Client: client}
	} else {
		worker.OAuth = w.CPAClaudeOAuth{Client: client}
	}
	worker.QuotaClient = client
	worker.NativeClient = client
	if c.ExecutionOnly {
		worker.Secrets = nil
	}
	worker.Executor = w.CPAPlainModel{ProviderExecutor: fixture{c.Scope.Provider}, Provider: c.Scope.Provider, Client: client}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM)
	defer stop()
	return worker.Serve(ctx, input, os.Stdout)
}

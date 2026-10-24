// The executable exposes metadata/recovery/disconnect on private stdio.
// Live provider authenticators/executors remain unregistered until reviewed;
// the library's acquisition/refresh/execution path is tested with HTTP fakes.
package main

import (
	"bufio"
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"
	"time"

	worker "github.com/alexj11324/Mikka/subscription-worker"
	_ "github.com/jackc/pgx/v5/stdlib"
	log "github.com/sirupsen/logrus"
)

func main() {
	// CPA diagnostics can embed upstream response bodies; never publish them.
	log.SetOutput(io.Discard)
	if len(os.Args) == 2 && os.Args[1] == "--version" {
		fmt.Println("mikka-subscription-worker CPA 8289ec4c71ad914d0612c2776352b76ba3d355a6")
		return
	}
	if run() != nil {
		fmt.Fprintln(os.Stderr, "subscription_worker_unavailable")
		os.Exit(1)
	}
}
func run() error {
	input := bufio.NewReaderSize(io.LimitReader(os.Stdin, 16<<20), 65537)
	// First frame comes only from the trusted control plane. No env, auth files,
	// secrets-manager fallback, password prompt or public HTTP listener exists.
	frame, err := input.ReadSlice('\n')
	if err != nil || len(frame) > 65536 {
		return worker.ErrUnsupported
	}
	var config struct {
		Scope                 worker.Scope       `json:"scope"`
		Use                   *worker.RuntimeUse `json:"use"`
		ExecutionOnly         bool               `json:"executionOnly"`
		AccessPath            string             `json:"accessPath"`
		AccessToken           string             `json:"accessToken"`
		DatabaseURL           string             `json:"databaseUrl"`
		Origin                string             `json:"infisicalOrigin"`
		Project               string             `json:"project"`
		Environment           string             `json:"environment"`
		Path                  string             `json:"path"`
		Token                 string             `json:"workloadToken"`
		EnableCodexOAuth      bool               `json:"enableCodexOAuth"`
		EnableRuntime         bool               `json:"enableRuntime"`
		EnablePlainModels     bool               `json:"enablePlainModels"`
		EnableClaudeOAuth     bool               `json:"enableClaudeOAuth"`
		EnrollmentAttemptPath string             `json:"enrollmentAttemptPath"`
		EnrollmentClaimPath   string             `json:"enrollmentClaimPath"`
		EnrollmentGrantPath   string             `json:"enrollmentGrantPath"`
	}
	decoder := json.NewDecoder(bytes.NewReader(frame))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&config) != nil {
		return worker.ErrUnsupported
	}
	if config.DatabaseURL == "" {
		return worker.ErrDatabase
	}
	db, err := sql.Open("pgx", config.DatabaseURL)
	if err != nil {
		return worker.ErrDatabase
	}
	defer db.Close()
	db.SetMaxOpenConns(3)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if db.PingContext(ctx) != nil {
		return worker.ErrDatabase
	}
	var grants worker.SecretStore
	if config.ExecutionOnly {
		if config.Token != "" || config.Path != "" || config.EnableCodexOAuth || config.EnableClaudeOAuth || config.EnrollmentAttemptPath != "" || config.EnrollmentClaimPath != "" || config.EnrollmentGrantPath != "" {
			return worker.ErrUnsupported
		}
	} else {
		secrets, err := worker.NewInfisical(worker.InfisicalConfig{Origin: config.Origin, ProjectID: config.Project, Environment: config.Environment, Path: config.Path, Token: func(context.Context) (string, error) { return config.Token, nil }})
		if err != nil {
			return err
		}
		grants = secrets
	}
	var access worker.SecretStore
	if config.AccessPath != "" || config.EnableRuntime || config.EnableCodexOAuth || config.EnableClaudeOAuth {
		if config.AccessPath == "" || (config.ExecutionOnly && config.AccessToken == "") || (!config.ExecutionOnly && (config.AccessPath == config.Path || (config.AccessToken != "" && config.AccessToken == config.Token))) {
			return worker.ErrUnsupported
		}
		credential := config.AccessToken
		if !config.ExecutionOnly {
			credential = config.Token
		} // Custody writes both paths; execution receives only the read identity.
		secrets, err := worker.NewInfisical(worker.InfisicalConfig{Origin: config.Origin, ProjectID: config.Project, Environment: config.Environment, Path: config.AccessPath, Token: func(context.Context) (string, error) { return credential, nil }})
		if err != nil {
			return err
		}
		access = secrets
	}
	// No production native credential export until a verified runner/broker path
	// avoids exposing tokens to untrusted tools. Config flags cannot attest that.
	w := worker.Worker{Repo: &worker.Repository{DB: db}, Secrets: grants, AccessSecrets: access, Scope: config.Scope, Use: config.Use, ExecutionOnly: config.ExecutionOnly}
	if !config.ExecutionOnly {
		// Source custody is optional for canonical status/disconnect. Invalid or
		// incomplete source configuration must never prevent the epoch fence;
		// the journal reports configuration_required and remains retryable.
		makeEnrollment := func() *worker.Enrollment {
			paths := map[string]bool{}
			for _, path := range []string{config.Path, config.AccessPath, config.EnrollmentAttemptPath, config.EnrollmentClaimPath, config.EnrollmentGrantPath} {
				if path == "" || paths[path] {
					return nil
				}
				paths[path] = true
			}
			makeStore := func(path string) (worker.SecretStore, error) {
				return worker.NewInfisical(worker.InfisicalConfig{Origin: config.Origin, ProjectID: config.Project, Environment: config.Environment, Path: path, Token: func(context.Context) (string, error) { return config.Token, nil }})
			}
			a, err := makeStore(config.EnrollmentAttemptPath)
			if err != nil {
				return nil
			}
			c, err := makeStore(config.EnrollmentClaimPath)
			if err != nil {
				return nil
			}
			g, err := makeStore(config.EnrollmentGrantPath)
			if err != nil {
				return nil
			}
			return &worker.Enrollment{Attempts: a, Claims: c, Grants: g}
		}
		w.Enrollment = makeEnrollment()
		if w.Enrollment != nil {
			identity, err := worker.EnrollmentDatabaseIdentity(config.DatabaseURL)
			if err == nil {
				w.DatabaseIdentity = identity
			}
		}
	}

	if config.EnableRuntime {
		if config.Scope.Provider == "codex" {
			w.Executor = worker.CPACodexLifecycle{}
		} else if config.Scope.Provider == "claude" {
			w.Executor = worker.CPAClaudeLifecycle{}
		}
	}
	if config.EnableCodexOAuth && config.Scope.Provider == "codex" {
		w.OAuth = worker.CPACodexOAuth{}
		w.Executor = worker.CPACodexLifecycle{}
	}
	if config.EnableClaudeOAuth && config.Scope.Provider == "claude" {
		w.OAuth = worker.CPAClaudeOAuth{}
		w.Executor = worker.CPAClaudeLifecycle{}
	}
	if config.EnablePlainModels && w.Executor != nil {
		w.Executor = worker.CPAPlainModel{ProviderExecutor: w.Executor, Provider: config.Scope.Provider}
	}
	runtimeCtx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	return w.Serve(runtimeCtx, input, os.Stdout)
}

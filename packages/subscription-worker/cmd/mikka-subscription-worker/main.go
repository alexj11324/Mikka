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
		Scope             worker.Scope `json:"scope"`
		DatabaseURL       string       `json:"databaseUrl"`
		Origin            string       `json:"infisicalOrigin"`
		Project           string       `json:"project"`
		Environment       string       `json:"environment"`
		Path              string       `json:"path"`
		Token             string       `json:"workloadToken"`
		EnableCodexOAuth  bool         `json:"enableCodexOAuth"`
		EnableRuntime     bool         `json:"enableRuntime"`
		EnablePlainModels bool         `json:"enablePlainModels"`
		EnableClaudeOAuth bool         `json:"enableClaudeOAuth"`
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
	secrets, err := worker.NewInfisical(worker.InfisicalConfig{Origin: config.Origin, ProjectID: config.Project, Environment: config.Environment, Path: config.Path, Token: func(context.Context) (string, error) { return config.Token, nil }})
	if err != nil {
		return err
	}
	w := worker.Worker{Repo: &worker.Repository{DB: db}, Secrets: secrets, Scope: config.Scope}
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

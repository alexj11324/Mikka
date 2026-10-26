// Private server custody only. No database, user CLI, local auth files, model
// calls, inference reader or native runner is needed to receive a new grant.
package main

import (
	"bufio"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	worker "github.com/alexj11324/Mikka/subscription-worker"
	_ "github.com/jackc/pgx/v5/stdlib"
	log "github.com/sirupsen/logrus"
	"io"
	"os"
	"time"
)

func main() {
	log.SetOutput(io.Discard)
	if run() != nil {
		fmt.Fprintln(os.Stderr, "subscription_enrollment_unavailable")
		os.Exit(1)
	}
}
func run() error {
	input := bufio.NewScanner(io.LimitReader(os.Stdin, 131072))
	input.Buffer(make([]byte, 4096), 65536)
	var config struct {
		Origin             string `json:"infisicalOrigin"`
		Project            string `json:"project"`
		Environment        string `json:"environment"`
		Token              string `json:"workloadToken"`
		AttemptPath        string `json:"attemptPath"`
		ClaimPath          string `json:"claimPath"`
		GrantPath          string `json:"grantPath"`
		Principal          string `json:"principal"`
		DatabaseURL        string `json:"databaseUrl"`
		CanonicalGrantPath string `json:"canonicalGrantPath"`
		AccessPath         string `json:"accessPath"`
		RetainSources      bool   `json:"retainSources"`
	}
	if !input.Scan() || json.Unmarshal(input.Bytes(), &config) != nil || config.Token == "" || config.AttemptPath == config.ClaimPath || config.AttemptPath == config.GrantPath || config.ClaimPath == config.GrantPath {
		return worker.ErrUnsupported
	}
	store := func(path string) (worker.SecretStore, error) {
		return worker.NewInfisical(worker.InfisicalConfig{Origin: config.Origin, ProjectID: config.Project, Environment: config.Environment, Path: path, Token: func(context.Context) (string, error) { return config.Token, nil }})
	}
	attempts, err := store(config.AttemptPath)
	if err != nil {
		return err
	}
	claims, err := store(config.ClaimPath)
	if err != nil {
		return err
	}
	grants, err := store(config.GrantPath)
	if err != nil {
		return err
	}
	e := worker.Enrollment{Attempts: attempts, Claims: claims, Grants: grants, OAuth: worker.CPAClaudeOAuth{}, RetainSources: config.RetainSources}
	var request struct {
		Method      string `json:"method"`
		ID          string `json:"id"`
		CallbackURL string `json:"callbackUrl"`
		OwnerID     string `json:"ownerId"`
		WorkspaceID string `json:"workspaceId"`
		Provider    string `json:"provider"`
		HandoffKey  string `json:"handoffKey"`
	}
	if !input.Scan() || json.Unmarshal(input.Bytes(), &request) != nil {
		return worker.ErrUnsupported
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	var result any
	switch request.Method {
	case "start":
		result, err = e.Start(ctx, config.Principal)
	case "handoff":
		result, err = e.Handoff(ctx, request.ID, request.Provider, request.HandoffKey, request.CallbackURL)
	case "complete":
		result, err = e.Complete(ctx, config.Principal, request.ID, request.CallbackURL)
	case "status":
		result, err = e.Status(ctx, config.Principal, request.ID)
	case "bind":
		paths := map[string]bool{}
		for _, path := range []string{config.AttemptPath, config.ClaimPath, config.GrantPath, config.CanonicalGrantPath, config.AccessPath} {
			if path == "" || paths[path] {
				return worker.ErrUnsupported
			}
			paths[path] = true
		}
		identity, identityErr := worker.EnrollmentDatabaseIdentity(config.DatabaseURL)
		if identityErr != nil {
			return identityErr
		}
		db, openErr := sql.Open("pgx", config.DatabaseURL)
		if openErr != nil {
			return worker.ErrDatabase
		}
		defer db.Close()
		db.SetMaxOpenConns(3)
		canonical, storeErr := store(config.CanonicalGrantPath)
		if storeErr != nil {
			return storeErr
		}
		access, storeErr := store(config.AccessPath)
		if storeErr != nil {
			return storeErr
		}
		binder := worker.EnrollmentBinder{Enrollment: &e, Repo: &worker.Repository{DB: db}, Secrets: canonical, AccessSecrets: access, DatabaseIdentity: identity}
		result, err = binder.Bind(ctx, config.Principal, request.ID, request.OwnerID, request.WorkspaceID)
	default:
		err = worker.ErrUnsupported
	}
	if err != nil {
		return json.NewEncoder(os.Stdout).Encode(map[string]any{"error": "subscription_enrollment_unavailable"})
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]any{"result": result})
}

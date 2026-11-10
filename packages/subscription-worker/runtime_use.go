package worker

import (
	"context"
	"time"
)

// Immutable parent configuration, not model/RPC input. This is a Mikka task
// authorization, not a newly minted or provider-downscoped bearer token.
type RuntimeUse struct {
	BindingID  string `json:"bindingId"`
	ConsumerID string `json:"consumerId"`
	RunID      string `json:"runId,omitempty"`
}

func (w *Worker) authorizeRuntime(ctx context.Context, epoch int64, execution, model string) error {
	if w.Use == nil || !uuidPattern.MatchString(w.Use.BindingID) || w.Use.ConsumerID == "" || len(w.Use.ConsumerID) > 128 {
		return ErrUnavailable
	}
	var runModelMode, runModel string
	if w.Use.RunID != "" {
		if !uuidPattern.MatchString(w.Use.RunID) {
			return ErrUnavailable
		}
		if w.Repo.DB.QueryRowContext(ctx, `select coalesce(r."agentDefinition"->>'cliModelSelection',''),coalesce(r."agentDefinition"->>'model','') from agent_runs r join byos_native_runs n on n."runId"=r.id join byos_bindings b on b.id=n."bindingId" where r.id=$1 and `+runMayUseCredential+` and r."agentId"::text=$3 and n."bindingId"=$4 and r.status in ('preparing','running','waiting_input') and r."leaseExpiresAt">now() and r."stopRequestedAt" is null`, w.Use.RunID, w.Scope.OwnerID, w.Use.ConsumerID, w.Use.BindingID).Scan(&runModelMode, &runModel) != nil {
			return ErrUnavailable
		}
	}
	// The binding belongs to the run's workspace; the connection keeps the one it was made in
	// (decision 2026-10-31-2130). Both stay fenced to the owner.
	var route, boundModel, state string
	var current int64
	var quota []byte
	var paused bool
	requiresQuota := execution == "model" || execution == "native"
	// Active stream checks keep all live authority fields, but never consume quota.
	err := w.Repo.DB.QueryRowContext(ctx, `select b.route,b."modelId",c.state,c.epoch,CASE WHEN $8::boolean THEN c.quota ELSE NULL::jsonb END,c.paused from byos_bindings b join byos_connections c on c.id=b."connectionId" where b.id=$1 and b."consumerId"=$2 and b."ownerId"=$3 and c.id=$5 and c."ownerId"=$3 and c."workspaceId"=$4 and c.provider=$6 and b."connectionRevision"=$7 and c.epoch=$7`, w.Use.BindingID, w.Use.ConsumerID, w.Scope.OwnerID, w.Scope.WorkspaceID, w.Scope.ConnectionID, w.Scope.Provider, epoch, requiresQuota).Scan(&route, &boundModel, &state, &current, &quota, &paused)
	if err != nil || current != epoch || (state != "connected" && state != "refreshing" && state != "publication_pending") {
		return ErrUnavailable
	}
	// 暂停 also ends a stream in progress: native_active rechecks here.
	if paused && execution != "quota" {
		return ErrUnavailable
	}
	expected := w.Scope.Provider + "_cpa"
	if execution == "native" || execution == "native_active" {
		expected = "codex_cli"
		if w.Scope.Provider == "claude" {
			expected = "claude_code_cli"
		}
	}
	if execution != "quota" && route != expected {
		return ErrUnavailable
	}
	nativeRoute := "codex_cli"
	if w.Scope.Provider == "claude" {
		nativeRoute = "claude_code_cli"
	}
	if execution == "quota" && route != w.Scope.Provider+"_cpa" && route != nativeRoute {
		return ErrUnavailable
	}
	// Only a server-frozen native run can delegate model choice to the CLI.
	// Hosted model calls and historical native runs keep their exact binding.
	if execution == "native" && w.Use.RunID != "" {
		if runModelMode == "auto" {
			boundModel = model
		} else if runModelMode == "explicit" && runModel != "" {
			boundModel = runModel
		}
	}
	if model != "" && model != boundModel {
		return ErrUnavailable
	}
	if requiresQuota {
		if !runtimeQuotaAvailable(quota, w.Scope.Provider, boundModel, time.Now()) {
			return ErrUnavailable
		}
	}
	return nil
}
func (w *Worker) PrepareRuntime(ctx context.Context, epoch int64) (Metadata, error) {
	return w.prepareRuntime(ctx, epoch, true)
}

// Plain shared streams need the same fresh readiness and refresh/migration
// boundary, but never consume maintenance metadata. Dedicated cleanup,
// Disconnect and the original PrepareRuntime keep their maintenance behavior.
func (w *Worker) prepareRuntime(ctx context.Context, epoch int64, maintenance bool) (Metadata, error) {
	if w.ExecutionOnly || w.Secrets == nil {
		return Metadata{}, ErrUnsupported
	}
	authorizeDone := timingSpan(ctx, timingAuthorize)
	err := w.authorizeRuntime(ctx, epoch, "quota", "")
	authorizeDone()
	if err != nil {
		return Metadata{}, err
	}
	recordDone := timingSpan(ctx, timingPrepareRecord)
	record, err := w.Repo.Lookup(ctx, w.Scope)
	recordDone()
	if err != nil {
		return Metadata{}, err
	}
	// Explicit trusted migration of an existing full-bundle record, without a new
	// OAuth ceremony or provider token refresh. Execution children cannot do this.
	if record.State == "connected" && record.AccessName == "" {
		if w.ExecutionOnly || w.Secrets == nil || w.AccessSecrets == nil {
			return Metadata{}, ErrUnavailable
		}
		migrationDone := timingSpan(ctx, timingMigration)
		defer migrationDone()
		op, e := w.Repo.ClaimRefresh(ctx, w.Scope, epoch, record.Version)
		if e != nil {
			return Metadata{}, e
		}
		store := w.store(&op)
		b, e := store.load(ctx, record)
		if e != nil {
			_ = w.Repo.Fail(ctx, op, "projection_failed")
			return Metadata{}, e
		}
		if _, e = store.Save(ctx, hydrate(record, b, true)); e != nil {
			_ = w.Repo.Fail(ctx, op, "projection_failed")
			return Metadata{}, e
		}
		migrationDone()
	}
	if _, _, err := w.readyAuth(ctx, epoch); err != nil {
		return Metadata{}, err
	}
	if !maintenance {
		return Metadata{}, nil
	}
	cleanupDone := timingSpan(ctx, timingCleanup)
	_, _ = w.Cleanup(ctx)
	cleanupDone()
	statusDone := timingSpan(ctx, timingStatus)
	defer statusDone()
	return w.Status(ctx)
}
func (w *Worker) activeRuntime(ctx context.Context, epoch int64, model string) error {
	if !validScope(w.Scope) {
		return ErrUnavailable
	}
	// Every chunk and heartbeat still rechecks revocation and the exact binding.
	// The caller never uses a credential record here: fetching its nineteen
	// columns after authorization only repeats database transfer for each chunk.
	return w.authorizeRuntime(ctx, epoch, "active", model)
}

// Personal subscriptions never serve another member's run, including historical
// sharing rows. Mirrors the server's owner-only admission and renewal policy.
const runMayUseCredential = `($2=r."userId" AND coalesce(r."agentDefinition"#>>'{executionIdentity,actor}',r."userId")=r."userId")`

package worker

import (
	"context"
	"encoding/json"
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
	err := w.Repo.DB.QueryRowContext(ctx, `select b.route,b."modelId",c.state,c.epoch,c.quota,c.paused from byos_bindings b join byos_connections c on c.id=b."connectionId" where b.id=$1 and b."consumerId"=$2 and b."ownerId"=$3 and c.id=$5 and c."ownerId"=$3 and c."workspaceId"=$4 and c.provider=$6 and b."connectionRevision"=$7 and c.epoch=$7`, w.Use.BindingID, w.Use.ConsumerID, w.Scope.OwnerID, w.Scope.WorkspaceID, w.Scope.ConnectionID, w.Scope.Provider, epoch).Scan(&route, &boundModel, &state, &current, &quota, &paused)
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
	if execution == "model" || execution == "native" {
		var q struct {
			Vendor     string `json:"vendor"`
			Status     string `json:"status"`
			ObservedAt string `json:"observedAt"`
			Windows    []struct {
				Used  *float64 `json:"used"`
				Meter string   `json:"meter"`
			} `json:"windows"`
		}
		vendor := "codex"
		if w.Scope.Provider == "claude" {
			vendor = "claude_code"
		}
		if json.Unmarshal(quota, &q) != nil || q.Status != "ok" || q.Vendor != vendor || len(q.Windows) == 0 {
			return ErrUnavailable
		}
		observed, err := time.Parse(time.RFC3339Nano, q.ObservedAt)
		if err != nil || observed.After(time.Now()) || time.Since(observed) > time.Minute {
			return ErrUnavailable
		}
		for _, window := range q.Windows {
			if window.Used == nil || *window.Used < 0 || *window.Used >= 1 || window.Meter == "api" || window.Meter == "on_demand" || window.Meter == "team_on_demand" {
				return ErrUnavailable
			}
		}
	}
	return nil
}
func (w *Worker) PrepareRuntime(ctx context.Context, epoch int64) (Metadata, error) {
	if w.ExecutionOnly || w.Secrets == nil {
		return Metadata{}, ErrUnsupported
	}
	if err := w.authorizeRuntime(ctx, epoch, "quota", ""); err != nil {
		return Metadata{}, err
	}
	record, err := w.Repo.Lookup(ctx, w.Scope)
	if err != nil {
		return Metadata{}, err
	}
	// Explicit trusted migration of an existing full-bundle record, without a new
	// OAuth ceremony or provider token refresh. Execution children cannot do this.
	if record.State == "connected" && record.AccessName == "" {
		if w.ExecutionOnly || w.Secrets == nil || w.AccessSecrets == nil {
			return Metadata{}, ErrUnavailable
		}
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
	}
	if _, _, err := w.readyAuth(ctx, epoch); err != nil {
		return Metadata{}, err
	}
	_, _ = w.Cleanup(ctx)
	return w.Status(ctx)
}
func (w *Worker) activeRuntime(ctx context.Context, epoch int64, model string) (Record, error) {
	if err := w.authorizeRuntime(ctx, epoch, "active", model); err != nil {
		return Record{}, err
	}
	return w.Repo.Lookup(ctx, w.Scope)
}

// The credential owner ($2) may serve this run: it is their own, or they share
// it in the binding's workspace with 分享给团队成员 while the admin allows member
// subscriptions. Mirrors runMayUseCredentialSql in lib/personal-policy.ts;
// membership lives in the workspace database and is checked by the server,
// and leaving stops the runs (stopRequestedAt), which this query refuses.
const runMayUseCredential = `($2=r."userId" OR (
	EXISTS (SELECT 1 FROM workspace_subscription_shares sh WHERE sh."ownerId"=$2 AND sh."allowOthers" AND sh."workspaceId"::text=b."workspaceId"::text)
	AND NOT EXISTS (SELECT 1 FROM workspace_personal_policies pp WHERE pp."workspaceId"::text=b."workspaceId"::text AND NOT pp.subscriptions)))`

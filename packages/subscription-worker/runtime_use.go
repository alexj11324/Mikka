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
	if w.Use.RunID != "" {
		if !uuidPattern.MatchString(w.Use.RunID) {
			return ErrUnavailable
		}
		var active bool
		if w.Repo.DB.QueryRowContext(ctx, `select exists(select 1 from agent_runs r join byos_native_runs n on n."runId"=r.id where r.id=$1 and r."userId"=$2 and r."agentId"::text=$3 and n."bindingId"=$4 and r.status in ('preparing','running','waiting_input') and r."leaseExpiresAt">now() and r."stopRequestedAt" is null)`, w.Use.RunID, w.Scope.OwnerID, w.Use.ConsumerID, w.Use.BindingID).Scan(&active) != nil || !active {
			return ErrUnavailable
		}
	}
	var route, boundModel, state string
	var current int64
	var quota []byte
	err := w.Repo.DB.QueryRowContext(ctx, `select b.route,b."modelId",c.state,c.epoch,c.quota from byos_bindings b join byos_connections c on c.id=b."connectionId" where b.id=$1 and b."consumerId"=$2 and b."ownerId"=$3 and b."workspaceId"=$4 and c.id=$5 and c."ownerId"=$3 and c."workspaceId"=$4 and c.provider=$6 and b."connectionRevision"=$7 and c.epoch=$7`, w.Use.BindingID, w.Use.ConsumerID, w.Scope.OwnerID, w.Scope.WorkspaceID, w.Scope.ConnectionID, w.Scope.Provider, epoch).Scan(&route, &boundModel, &state, &current, &quota)
	if err != nil || current != epoch || (state != "connected" && state != "refreshing" && state != "publication_pending") {
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

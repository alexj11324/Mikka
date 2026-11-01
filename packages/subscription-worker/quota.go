package worker

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"time"

	core "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

type QuotaResult struct {
	Status int            `json:"status"`
	Body   map[string]any `json:"body"`
}

// Fixed destinations and a numeric/boolean projection. Neither a token nor an
// arbitrary provider error/JSON string crosses into the web/model process.
func (w *Worker) Quota(ctx context.Context, epoch int64) (QuotaResult, error) {
	if err := w.authorizeRuntime(ctx, epoch, "quota", ""); err != nil {
		return QuotaResult{}, err
	}
	_, auth, err := w.readyAuth(ctx, epoch)
	if err != nil {
		return QuotaResult{}, err
	}
	result, err := w.fetchQuota(ctx, auth)
	if err != nil {
		return QuotaResult{}, err
	}
	if err = w.authorizeRuntime(ctx, epoch, "quota", ""); err != nil {
		return QuotaResult{}, err
	}
	return result, nil
}

// UsageResult is the owner's Settings view: the same projection as Quota and
// the account's sign-in email. No token, account id or provider text.
type UsageResult struct {
	Status  int            `json:"status"`
	Body    map[string]any `json:"body"`
	Account string         `json:"account,omitempty"`
	Plan    string         `json:"plan,omitempty"`
}

var emailPattern = regexp.MustCompile(`^[^\s@<>"\x00-\x1f\x7f]{1,64}@[^\s@<>"\x00-\x1f\x7f]{1,190}$`)

// Usage reads the connection's own allowance for its owner's Settings page. It
// needs no model binding: the custody scope (owner, workspace, connection) and
// the connected epoch are the authorization, as for status. It never forces a
// refresh and never changes the connection: a provider 401/403 is reported for
// this read only. (readyAuth renews only a token about to expire, as every
// runtime read does.) Status 0 means the provider could not be reached.
func (w *Worker) Usage(ctx context.Context, epoch int64) (UsageResult, error) {
	if w.ExecutionOnly || w.Use != nil {
		return UsageResult{}, ErrUnsupported
	}
	_, auth, err := w.readyAuth(ctx, epoch)
	if err != nil {
		return UsageResult{}, err
	}
	result := UsageResult{Body: map[string]any{}, Account: accountEmail(auth)}
	if quota, err := w.fetchQuota(ctx, auth); err == nil {
		result.Status, result.Body = quota.Status, quota.Body
	}
	if w.Scope.Provider == "claude" && result.Status == http.StatusOK {
		result.Plan = w.fetchClaudePlan(ctx, auth)
	}
	if current, err := w.Repo.Lookup(ctx, w.Scope); err != nil || current.Epoch != epoch || current.State != "connected" {
		return UsageResult{}, ErrUnavailable
	}
	return result, nil
}

func accountEmail(auth *core.Auth) string {
	if email, ok := auth.Metadata["email"].(string); ok && emailPattern.MatchString(email) {
		return email
	}
	return ""
}

// fetchClaudePlan names the Claude plan from the account profile. Only known
// labels leave this function; any failure leaves the plan unnamed, never the row.
func (w *Worker) fetchClaudePlan(ctx context.Context, auth *core.Auth) string {
	// Short, so a slow profile can't use up the row's read after the quota took its own 10s.
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.anthropic.com/api/oauth/profile", nil)
	if err != nil {
		return ""
	}
	token, _ := auth.Metadata["access_token"].(string)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "Mikka/1.0")
	req.Header.Set("anthropic-beta", "oauth-2025-04-20")
	client := http.Client{}
	if w.QuotaClient != nil {
		client = *w.QuotaClient
	}
	client.Timeout = 3 * time.Second
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	response, err := client.Do(req)
	if err != nil {
		return ""
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return ""
	}
	var body map[string]any
	if json.NewDecoder(io.LimitReader(response.Body, 131072)).Decode(&body) != nil {
		return ""
	}
	switch objectMap(body["organization"])["organization_type"] {
	case "claude_pro":
		return "Pro"
	case "claude_max":
		return "Max"
	case "claude_team":
		return "Team"
	case "claude_enterprise":
		return "Enterprise"
	}
	return ""
}

func (w *Worker) fetchQuota(ctx context.Context, auth *core.Auth) (QuotaResult, error) {
	endpoint := "https://chatgpt.com/backend-api/wham/usage"
	if w.Scope.Provider == "claude" {
		endpoint = "https://api.anthropic.com/api/oauth/usage"
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	token, _ := auth.Metadata["access_token"].(string)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "Mikka/1.0")
	if w.Scope.Provider == "claude" {
		req.Header.Set("anthropic-beta", "oauth-2025-04-20")
	} else {
		account, _ := auth.Metadata["account_id"].(string)
		req.Header.Set("ChatGPT-Account-Id", account)
	}
	client := http.Client{Timeout: 10 * time.Second}
	if w.QuotaClient != nil {
		client = *w.QuotaClient
	}
	client.Timeout = 10 * time.Second
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	response, err := client.Do(req)
	if err != nil {
		return QuotaResult{}, ErrProvider
	}
	defer response.Body.Close()
	result := QuotaResult{Status: response.StatusCode, Body: map[string]any{}}
	if response.StatusCode != 200 {
		return result, nil
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, 131073))
	if err != nil || len(raw) > 131072 {
		return QuotaResult{}, ErrProvider
	}
	var body map[string]any
	if json.Unmarshal(raw, &body) != nil {
		return QuotaResult{}, ErrProvider
	}
	project := func(value any, claude bool) map[string]any {
		source := objectMap(value)
		out := map[string]any{}
		for _, key := range []string{"used_percent", "limit_window_seconds", "reset_at", "utilization", "percent"} {
			if n, ok := source[key].(float64); ok {
				out[key] = n
			}
		}
		if claude {
			if text, ok := source["resets_at"].(string); ok {
				if at, err := time.Parse(time.RFC3339, text); err == nil {
					out["resets_at"] = at.UTC().Format(time.RFC3339)
				}
			}
		}
		return out
	}
	if w.Scope.Provider == "codex" {
		controls := objectMap(body["credits"])
		result.Body["credits"] = map[string]any{}
		for _, key := range []string{"has_credits", "unlimited"} {
			if value, ok := controls[key].(bool); ok {
				result.Body["credits"].(map[string]any)[key] = value
			}
		}
		limits := objectMap(body["rate_limit"])
		result.Body["rate_limit"] = map[string]any{"primary_window": project(limits["primary_window"], false), "secondary_window": project(limits["secondary_window"], false)}
		if extra, ok := body["additional_rate_limits"].([]any); ok {
			if len(extra) > 128 {
				return QuotaResult{}, ErrProvider
			}
			out := []any{}
			for _, entry := range extra {
				limits := objectMap(objectMap(entry)["rate_limit"])
				out = append(out, map[string]any{"limit_name": "Additional", "rate_limit": map[string]any{"primary_window": project(limits["primary_window"], false), "secondary_window": project(limits["secondary_window"], false)}})
			}
			result.Body["additional_rate_limits"] = out
		}
		if plan, ok := body["plan_type"].(string); ok {
			switch plan {
			case "plus", "pro", "free", "team", "business", "enterprise", "go":
				result.Body["plan_type"] = plan
			}
		}
	} else {
		result.Body["extra_usage"] = map[string]any{}
		if enabled, ok := objectMap(body["extra_usage"])["is_enabled"].(bool); ok {
			result.Body["extra_usage"].(map[string]any)["is_enabled"] = enabled
		}
		for _, key := range []string{"five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"} {
			result.Body[key] = project(body[key], true)
		}
		if limits, ok := body["limits"].([]any); ok {
			if len(limits) > 128 {
				return QuotaResult{}, ErrProvider
			}
			out := []any{}
			for i, entry := range limits {
				row := objectMap(entry)
				if row["kind"] != "weekly_scoped" {
					continue
				}
				value := project(row, true)
				value["kind"] = "weekly_scoped"
				value["scope"] = map[string]any{"model": map[string]any{"display_name": fmt.Sprintf("Scoped %d", i)}}
				out = append(out, value)
			}
			result.Body["limits"] = out
		}
	}
	return result, nil
}

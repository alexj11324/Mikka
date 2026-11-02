package worker

import (
	"encoding/json"
	"regexp"
	"strings"
	"time"
)

var quotaSeparators = regexp.MustCompile(`[ ._]+`)
var quotaDashes = regexp.MustCompile(`-+`)
var claudeQuotaScope = regexp.MustCompile(`^(?:claude-)?(opus|sonnet|haiku|fable)(?:-(\d+(?:-\d+)*))?$`)
var claudeQuotaModel = regexp.MustCompile(`^(?:claude-)?(opus|sonnet|haiku|fable)(?:-|$)`)
var codexQuotaScope = regexp.MustCompile(`^(?:gpt-\d|o\d)[a-z0-9-]*$`)
var versionedClaudeQuotaModel = regexp.MustCompile(`^(?:claude-)?(?:opus|sonnet|haiku|fable)-\d+(?:-\d+)*$`)
var quotaModelDate = regexp.MustCompile(`^\d{8}$`)

func normalizeQuotaModel(value string) string {
	return quotaDashes.ReplaceAllString(quotaSeparators.ReplaceAllString(strings.ToLower(strings.TrimSpace(value)), "-"), "-")
}

// Mirrors protocol subscriptionQuotaScope. Unknown provider labels are retained
// as unknown evidence; they never become a fabricated account-wide limit.
func quotaScope(scope, model string) string {
	if scope == "" {
		return "applicable"
	}
	if model == "" {
		return "unknown"
	}
	scope, model = normalizeQuotaModel(scope), normalizeQuotaModel(model)
	if scoped := claudeQuotaScope.FindStringSubmatch(scope); scoped != nil {
		chosen := claudeQuotaModel.FindStringSubmatch(model)
		if chosen == nil {
			return "unknown"
		}
		if scoped[1] != chosen[1] {
			return "irrelevant"
		}
		if scoped[2] == "" {
			return "applicable"
		}
		if !versionedClaudeQuotaModel.MatchString(model) {
			return "unknown"
		}
		scope, model = strings.TrimPrefix(scope, "claude-"), strings.TrimPrefix(model, "claude-")
		if model == scope || (strings.HasPrefix(model, scope+"-") && quotaModelDate.MatchString(strings.TrimPrefix(model, scope+"-"))) {
			return "applicable"
		}
		return "irrelevant"
	}
	if codexQuotaScope.MatchString(scope) {
		if !codexQuotaScope.MatchString(model) {
			return "unknown"
		}
		if scope == model {
			return "applicable"
		}
		return "irrelevant"
	}
	return "unknown"
}

func runtimeQuotaAvailable(raw []byte, provider, model string, now time.Time) bool {
	var quota struct {
		Vendor     string `json:"vendor"`
		Status     string `json:"status"`
		ObservedAt string `json:"observedAt"`
		Windows    []struct {
			Used     *float64 `json:"used"`
			Meter    string   `json:"meter"`
			Model    string   `json:"model"`
			ResetsAt *string  `json:"resetsAt"`
		} `json:"windows"`
	}
	vendor := "codex"
	if provider == "claude" {
		vendor = "claude_code"
	}
	if json.Unmarshal(raw, &quota) != nil || quota.Vendor != vendor || quota.Status != "ok" || len(quota.Windows) == 0 || len(quota.Windows) > 12 {
		return false
	}
	observed, err := time.Parse(time.RFC3339Nano, quota.ObservedAt)
	if err != nil || observed.After(now) || now.Sub(observed) > time.Minute {
		return false
	}
	applicable := false
	for _, window := range quota.Windows {
		if window.Used == nil || *window.Used < 0 || *window.Used > 1 {
			return false
		}
		scope := quotaScope(window.Model, model)
		if scope == "irrelevant" {
			continue
		}
		if window.Meter == "api" || window.Meter == "on_demand" || window.Meter == "team_on_demand" {
			return false
		}
		if scope == "unknown" {
			if *window.Used >= 1 {
				return false
			}
			continue
		}
		applicable = true
		// Exhausted windows require a new provider observation even after their
		// reset time. A local clock does not establish remaining allowance.
		if *window.Used >= 1 {
			return false
		}
	}
	return applicable
}

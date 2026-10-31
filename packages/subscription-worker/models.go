package worker

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode"
)

// ModelOption is the only provider catalogue data sent to the web process.
// Credentials, descriptions, capabilities and provider error bodies stay here.
type ModelOption struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

var modelIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)

// Models reads only the owner's connected account. Like Usage it is a custody
// read, not an inference call, and does not require or create a model binding.
func (w *Worker) Models(ctx context.Context, epoch int64) ([]ModelOption, error) {
	if w.ExecutionOnly || w.Use != nil {
		return nil, ErrUnsupported
	}
	_, auth, err := w.readyAuth(ctx, epoch)
	if err != nil {
		return nil, err
	}
	// Codex's ModelsClient appends client_version to the fixed /models path.
	// The query pins the catalogue protocol compatibility, not a model name.
	// Sources: openai/codex codex-rs/codex-api/src/endpoint/models.rs;
	// anthropics/anthropic-sdk-typescript src/resources/models.ts.
	endpoint := "https://chatgpt.com/backend-api/codex/models?client_version=0.159.0"
	if w.Scope.Provider == "claude" {
		endpoint = "https://api.anthropic.com/v1/models?limit=100"
	} else if w.Scope.Provider != "codex" {
		return nil, ErrUnsupported
	}
	client := http.Client{Timeout: 10 * time.Second}
	if w.ModelsClient != nil {
		client = *w.ModelsClient
	}
	client.Timeout = 10 * time.Second
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	options := []ModelOption{}
	seen := map[string]bool{}
	for page := 0; page < 5; page++ {
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
		token, _ := auth.Metadata["access_token"].(string)
		if token == "" {
			return nil, ErrCredential
		}
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Accept", "application/json")
		req.Header.Set("User-Agent", "Mikka/1.0")
		if w.Scope.Provider == "claude" {
			req.Header.Set("anthropic-version", "2023-06-01")
			req.Header.Set("anthropic-beta", "oauth-2025-04-20")
		} else {
			account, _ := auth.Metadata["account_id"].(string)
			req.Header.Set("ChatGPT-Account-Id", account)
		}
		response, err := client.Do(req)
		if err != nil {
			return nil, ErrProvider
		}
		raw, readErr := io.ReadAll(io.LimitReader(response.Body, 1048577))
		response.Body.Close()
		if readErr != nil || len(raw) > 1048576 || response.StatusCode != http.StatusOK {
			return nil, ErrProvider
		}
		var body struct {
			Models []struct {
				Slug       string `json:"slug"`
				Name       string `json:"display_name"`
				Visibility string `json:"visibility"`
			} `json:"models"`
			Data []struct {
				ID   string `json:"id"`
				Name string `json:"display_name"`
			} `json:"data"`
			HasMore bool   `json:"has_more"`
			LastID  string `json:"last_id"`
		}
		if json.Unmarshal(raw, &body) != nil {
			return nil, ErrProvider
		}
		entries := []ModelOption{}
		if w.Scope.Provider == "codex" {
			if body.Models == nil {
				return nil, ErrProvider
			}
			for _, m := range body.Models {
				if m.Visibility == "" || m.Visibility == "list" {
					entries = append(entries, ModelOption{m.Slug, m.Name})
				}
			}
		} else {
			if body.Data == nil {
				return nil, ErrProvider
			}
			for _, m := range body.Data {
				entries = append(entries, ModelOption{m.ID, m.Name})
			}
		}
		if len(entries) > 500 {
			return nil, ErrProvider
		}
		for _, m := range entries {
			if !modelIDPattern.MatchString(m.ID) {
				continue
			}
			if seen[m.ID] {
				continue
			}
			name := strings.TrimSpace(m.Name)
			if len(name) == 0 || len(name) > 200 || strings.ContainsFunc(name, unicode.IsControl) {
				name = m.ID
			}
			options = append(options, ModelOption{m.ID, name})
			seen[m.ID] = true
			if len(options) > 500 {
				return nil, ErrProvider
			}
		}
		if w.Scope.Provider == "codex" || !body.HasMore {
			break
		}
		if page == 4 || !modelIDPattern.MatchString(body.LastID) {
			return nil, ErrProvider
		}
		next, _ := url.Parse("https://api.anthropic.com/v1/models")
		query := url.Values{"limit": {"100"}, "after_id": {body.LastID}}
		next.RawQuery = query.Encode()
		endpoint = next.String()
	}
	if current, err := w.Repo.Lookup(ctx, w.Scope); err != nil || current.Epoch != epoch || current.State != "connected" {
		return nil, ErrUnavailable
	}
	return options, nil
}

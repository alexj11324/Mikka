package worker

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Credential custody boundary. Tokens authenticate the trusted worker only.
// It does not read local .env files, existing user credentials or task env vars.
type SecretStore interface {
	Create(context.Context, string, []byte) error
	Read(context.Context, string) ([]byte, error)
	Delete(context.Context, string) error
}
type InfisicalConfig struct {
	Origin, ProjectID, Environment, Path string
	Token                                func(context.Context) (string, error)
	Client                               *http.Client
}
type Infisical struct {
	config InfisicalConfig
	client *http.Client
}

func NewInfisical(config InfisicalConfig) (*Infisical, error) {
	origin, err := url.Parse(config.Origin)
	if err != nil || origin.Scheme != "https" || origin.Host == "" || origin.User != nil || (origin.Path != "" && origin.Path != "/") || origin.RawQuery != "" || origin.Fragment != "" || config.Token == nil || config.ProjectID == "" || config.Environment == "" || !strings.HasPrefix(config.Path, "/") {
		return nil, ErrStore
	}
	client := http.Client{Timeout: 15 * time.Second}
	if config.Client != nil {
		client = *config.Client
	}
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	if client.Timeout == 0 {
		client.Timeout = 15 * time.Second
	}
	return &Infisical{config, &client}, nil
}
func validSecretName(name string) bool {
	return strings.HasPrefix(name, "mikka-byos-") && uuidPattern.MatchString(strings.TrimPrefix(name, "mikka-byos-"))
}
func (i *Infisical) request(ctx context.Context, method, name string, raw []byte) ([]byte, error) {
	if !validSecretName(name) {
		return nil, ErrStore
	}
	endpoint := strings.TrimRight(i.config.Origin, "/") + "/api/v4/secrets/" + url.PathEscape(name)
	var body io.Reader
	if method == http.MethodGet {
		query := url.Values{"projectId": {i.config.ProjectID}, "environment": {i.config.Environment}, "secretPath": {i.config.Path}, "type": {"shared"}, "version": {"1"}, "viewSecretValue": {"true"}, "expandSecretReferences": {"false"}, "includeImports": {"false"}}
		endpoint += "?" + query.Encode()
	} else if method == http.MethodDelete {
		payload, _ := json.Marshal(map[string]any{"projectId": i.config.ProjectID, "environment": i.config.Environment, "secretPath": i.config.Path, "type": "shared"})
		body = bytes.NewReader(payload)
	} else {
		payload, _ := json.Marshal(map[string]any{"projectId": i.config.ProjectID, "environment": i.config.Environment, "secretPath": i.config.Path, "type": "shared", "secretValue": string(raw), "skipMultilineEncoding": true})
		body = bytes.NewReader(payload)
	}
	token, err := i.config.Token(ctx)
	if err != nil || token == "" || strings.ContainsAny(token, "\r\n") {
		return nil, ErrStore
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, body)
	if err != nil {
		return nil, ErrStore
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	response, err := i.client.Do(req)
	if err != nil {
		if method == http.MethodPost {
			return nil, ErrCreateUncertain
		}
		return nil, ErrStore
	}
	defer response.Body.Close()
	if response.StatusCode == 404 && method == http.MethodDelete {
		return nil, nil
	}
	if response.StatusCode == 404 && method == http.MethodGet {
		return nil, ErrMissing
	}
	if response.StatusCode == 401 || response.StatusCode == 403 { return nil, ErrStoreDenied }
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		if method == http.MethodPost && response.StatusCode >= 500 {
			_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
			return nil, ErrCreateUncertain
		}
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return nil, ErrStore
	}
	if method == http.MethodDelete {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return nil, nil
	}
	encoded, err := io.ReadAll(io.LimitReader(response.Body, 262145))
	if err != nil || len(encoded) > 262144 {
		if method == http.MethodPost {
			return nil, ErrCreateUncertain
		}
		return nil, ErrStore
	}
	var result struct {
		Secret struct {
			Value   string `json:"secretValue"`
			Key     string `json:"secretKey"`
			Version int    `json:"version"`
			Hidden  bool   `json:"secretValueHidden"`
		} `json:"secret"`
	}
	if json.Unmarshal(encoded, &result) != nil || result.Secret.Key != name || result.Secret.Version != 1 || result.Secret.Hidden {
		return nil, ErrStore
	}
	return []byte(result.Secret.Value), nil
}
func (i *Infisical) Create(ctx context.Context, name string, raw []byte) error {
	// Never PATCH a shared secret. A unique operation name + pinned v1 read
	// removes any need to invent compare-and-swap semantics for Infisical.
	stored, err := i.request(ctx, http.MethodPost, name, raw)
	if err == nil && !bytes.Equal(stored, raw) {
		return ErrIntegrity
	}
	return err
}
func (i *Infisical) Read(ctx context.Context, name string) ([]byte, error) {
	return i.request(ctx, http.MethodGet, name, nil)
}
func (i *Infisical) Delete(ctx context.Context, name string) error {
	_, err := i.request(ctx, http.MethodDelete, name, nil)
	return err
}

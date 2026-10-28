package worker

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	core "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	compat "github.com/router-for-me/CLIProxyAPI/v8/sdk/mikkaadapter"
)

// Private to the worker/store: never a browser, model or public IPC response.
type bundle struct {
	Schema       int            `json:"schema"`
	OwnerID      string         `json:"ownerId"`
	WorkspaceID  string         `json:"workspaceId"`
	ConnectionID string         `json:"connectionId"`
	Provider     string         `json:"provider"`
	Payload      map[string]any `json:"payload"`
}

func (b bundle) String() string   { return "[credential bundle redacted]" }
func (b bundle) GoString() string { return b.String() }
func credentialKeys(provider string) []string {
	common := []string{"type", "access_token", "refresh_token", "id_token", "last_refresh", "email", "expired"}
	if provider == "codex" {
		return append(common, "account_id", "plan_type", "use_siwc", "siwc")
	}
	return append(common, "account_uuid", "organization_uuid", "organization_name")
}
func cloneMap(m map[string]any) map[string]any {
	if m == nil {
		return map[string]any{}
	}
	raw, _ := json.Marshal(m)
	var out map[string]any
	_ = json.Unmarshal(raw, &out)
	return out
}
func filterPayload(provider string, input map[string]any) (map[string]any, error) {
	return filterCredentialPayload(provider, input, true)
}
func filterCredentialPayload(provider string, input map[string]any, full bool) (map[string]any, error) {
	copy := cloneMap(input)
	core.NormalizeCredentialMetadata(copy)
	out := map[string]any{"type": provider}
	for _, key := range credentialKeys(provider) {
		if !full && (key == "refresh_token" || key == "id_token") {
			continue
		}
		value, ok := copy[key]
		if !ok || key == "type" {
			continue
		}
		if key == "use_siwc" {
			if _, ok := value.(bool); !ok {
				return nil, ErrCredential
			}
			out[key] = value
			continue
		}
		if key == "siwc" {
			section, ok := value.(map[string]any)
			if !ok {
				return nil, ErrCredential
			}
			filtered := map[string]any{}
			for _, k := range []string{"access_token", "refresh_token", "id_token", "client_id", "device_id", "expired", "expires_at", "last_refresh", "scope", "scopes"} {
				if !full && (k == "refresh_token" || k == "id_token") {
					continue
				}
				if v, present := section[k]; present {
					filtered[k] = v
				}
			}
			out[key] = filtered
			continue
		}
		text, ok := value.(string)
		if !ok || len(text) > 32768 || strings.ContainsAny(text, "\r\n\x00") {
			return nil, ErrCredential
		}
		out[key] = text
	}
	for _, key := range []string{"access_token", "refresh_token", "expired"} {
		if !full && key == "refresh_token" {
			continue
		}
		if text, _ := out[key].(string); strings.TrimSpace(text) == "" {
			return nil, ErrCredential
		}
	}
	if _, err := time.Parse(time.RFC3339, out["expired"].(string)); err != nil {
		return nil, ErrCredential
	}
	if provider == "codex" {
		if id, _ := out["account_id"].(string); id == "" {
			return nil, ErrCredential
		}
	} else {
		if id, _ := out["account_uuid"].(string); id == "" {
			return nil, ErrCredential
		}
		if id, _ := out["organization_uuid"].(string); id == "" {
			return nil, ErrCredential
		}
	}
	return out, nil
}

func accessProjection(b bundle) (bundle, error) {
	payload, err := filterCredentialPayload(b.Provider, b.Payload, false)
	b.Payload = payload
	return b, err
}
func decodeAccessBundle(s Scope, raw []byte, digest string) (bundle, error) {
	if len(raw) > 131072 {
		return bundle{}, ErrIntegrity
	}
	sum := sha256.Sum256(raw)
	var b bundle
	if hex.EncodeToString(sum[:]) != digest || json.Unmarshal(raw, &b) != nil || b.Schema != 1 || b.OwnerID != s.OwnerID || b.WorkspaceID != s.WorkspaceID || b.ConnectionID != s.ConnectionID || b.Provider != s.Provider {
		return bundle{}, ErrIntegrity
	}
	// Access storage must never be silently reinterpreted as a full grant.
	for _, p := range []map[string]any{b.Payload, objectMap(b.Payload["siwc"])} {
		if _, ok := p["refresh_token"]; ok {
			return bundle{}, ErrIntegrity
		}
		if _, ok := p["id_token"]; ok {
			return bundle{}, ErrIntegrity
		}
	}
	payload, err := filterCredentialPayload(s.Provider, b.Payload, false)
	if err != nil {
		return bundle{}, ErrIntegrity
	}
	b.Payload = payload
	return b, nil
}
func objectMap(value any) map[string]any { out, _ := value.(map[string]any); return out }
func normalizeAuth(s Scope, a *core.Auth, latest *bundle) (bundle, error) {
	if a == nil || a.ID != s.ConnectionID || a.Provider != s.Provider {
		return bundle{}, ErrCredential
	}
	data := cloneMap(a.Metadata)
	if a.Storage != nil {
		// Only actual upstream data structs are accepted. Never call an imported
		// object's SaveTokenToFile, hooks, executable helpers or custom storage.
		switch a.Storage.(type) {
		case *compat.CodexTokenStorage:
			if s.Provider != "codex" {
				return bundle{}, ErrCredential
			}
		case *compat.ClaudeTokenStorage:
			if s.Provider != "claude" {
				return bundle{}, ErrCredential
			}
		default:
			return bundle{}, ErrCredential
		}
		raw, err := json.Marshal(a.Storage)
		if err != nil {
			return bundle{}, ErrCredential
		}
		var storage map[string]any
		if json.Unmarshal(raw, &storage) != nil {
			return bundle{}, ErrCredential
		}
		for key, value := range storage {
			data[key] = value
		}
	}
	if a.CodexRefreshPatch != nil {
		if s.Provider != "codex" || latest == nil || !a.CodexRefreshPatch.CanApplyTo(latest.Payload) {
			return bundle{}, ErrStale
		}
		// Upstream applies only matching partitions, preserving a newer SIWC/outer
		// partition and fields not changed by this particular refresh.
		data = a.CodexRefreshPatch.Apply(latest.Payload)
	}
	payload, err := filterPayload(s.Provider, data)
	if err != nil {
		return bundle{}, err
	}
	return bundle{1, s.OwnerID, s.WorkspaceID, s.ConnectionID, s.Provider, payload}, nil
}
func (b bundle) subject() string {
	if b.Provider == "codex" {
		return fmt.Sprint(b.Payload["account_id"])
	}
	identity, _ := json.Marshal([]any{b.Payload["account_uuid"], b.Payload["organization_uuid"]})
	return string(identity)
}
func encodeBundle(b bundle) ([]byte, string, error) {
	raw, err := json.Marshal(b)
	if err != nil || len(raw) > 131072 {
		return nil, "", ErrCredential
	}
	sum := sha256.Sum256(raw)
	return raw, hex.EncodeToString(sum[:]), nil
}
func decodeBundle(s Scope, raw []byte, digest string) (bundle, error) {
	if len(raw) > 131072 {
		return bundle{}, ErrIntegrity
	}
	sum := sha256.Sum256(raw)
	if hex.EncodeToString(sum[:]) != digest {
		return bundle{}, ErrIntegrity
	}
	var b bundle
	if json.Unmarshal(raw, &b) != nil || b.Schema != 1 || b.OwnerID != s.OwnerID || b.WorkspaceID != s.WorkspaceID || b.ConnectionID != s.ConnectionID || b.Provider != s.Provider {
		return bundle{}, ErrIntegrity
	}
	filtered, err := filterPayload(s.Provider, b.Payload)
	if err != nil {
		return bundle{}, ErrIntegrity
	}
	b.Payload = filtered
	return b, nil
}
func hydrate(record Record, b bundle, refresh bool) *core.Auth {
	metadata := cloneMap(b.Payload)
	if !refresh {
		delete(metadata, "refresh_token")
		delete(metadata, "id_token")
		if siwc, ok := metadata["siwc"].(map[string]any); ok {
			delete(siwc, "refresh_token")
			delete(siwc, "id_token")
		}
	}
	core.NormalizeCredentialMetadata(metadata)
	return &core.Auth{ID: record.ConnectionID, Provider: record.Provider, Status: core.StatusActive, Metadata: metadata, RegistrationEpoch: uint64(record.Epoch), CredentialVersion: uint64(record.Version)}
}

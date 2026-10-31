package worker

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"

	core "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	compat "github.com/router-for-me/CLIProxyAPI/v8/sdk/mikkaadapter"
)

const expiry = "2030-01-01T00:00:00Z"

// Persisted fixtures use real workspace UUIDs, including workspace-deletion guards.
func fixtureScope(provider string) Scope { return Scope{"alice", newID(), newID(), provider} }
func fixturePayload(provider, suffix string) map[string]any {
	p := map[string]any{"type": provider, "access_token": "fixture-" + provider + "-access-" + suffix, "refresh_token": "fixture-" + provider + "-refresh-" + suffix, "id_token": "fixture-" + provider + "-id-" + suffix, "email": "fixture@example.invalid", "expired": expiry, "last_refresh": "2026-10-24T00:00:00Z"}
	if provider == "codex" {
		p["account_id"] = "fixture-account"
		p["plan_type"] = "plus"
	} else {
		p["account_uuid"] = "fixture-account"
		p["organization_uuid"] = "fixture-org"
		p["organization_name"] = "Fixture org"
	}
	return p
}
func actualStorageAuth(s Scope, payload map[string]any) *core.Auth {
	raw, _ := json.Marshal(payload)
	a := &core.Auth{ID: s.ConnectionID, Provider: s.Provider, RegistrationEpoch: 3, CredentialVersion: 7, Generation: 9, Metadata: map[string]any{"email": "fixture@example.invalid", "base-url": "https://untrusted.invalid", "proxy_url": "https://untrusted.invalid", "fingerprint-profile": "forbidden", "hooks": "do-not-execute", "headers": map[string]any{"Authorization": "do-not-copy"}}}
	if s.Provider == "codex" {
		v := new(compat.CodexTokenStorage)
		_ = json.Unmarshal(raw, v)
		a.Storage = v
	} else {
		v := new(compat.ClaudeTokenStorage)
		_ = json.Unmarshal(raw, v)
		a.Storage = v
	}
	return a
}
func TestInitialActualCPAStorageCanonicalization(t *testing.T) {
	for _, provider := range []string{"codex", "claude"} {
		t.Run(provider, func(t *testing.T) {
			s := fixtureScope(provider)
			input := actualStorageAuth(s, fixturePayload(provider, "0"))
			// This reproduces why json.Marshal(Auth) is insufficient on first login.
			naive, _ := json.Marshal(input)
			if strings.Contains(string(naive), "fixture-"+provider+"-access") {
				t.Fatal("fixture no longer exercises upstream json:- storage semantics")
			}
			b, err := normalizeAuth(s, input, nil)
			if err != nil {
				t.Fatal(err)
			}
			for k, v := range fixturePayload(provider, "0") {
				if !reflect.DeepEqual(b.Payload[k], v) {
					t.Errorf("canonical field %s was lost", k)
				}
			}
			for _, key := range []string{"base_url", "proxy_url", "fingerprint_profile", "hooks", "headers"} {
				if _, ok := b.Payload[key]; ok {
					t.Errorf("configuration %s crossed credential boundary", key)
				}
			}
			if input.RegistrationEpoch != 3 || input.CredentialVersion != 7 || input.Generation != 9 {
				t.Fatal("Store normalization mutated CPA lifecycle fields")
			}
			raw, digest, err := encodeBundle(b)
			if err != nil {
				t.Fatal(err)
			}
			loaded, err := decodeBundle(s, raw, digest)
			if err != nil {
				t.Fatal(err)
			}
			record := Record{Scope: s, Epoch: 2, Version: 1}
			for _, refresh := range []bool{false, true} {
				h := hydrate(record, loaded, refresh)
				if h.Metadata["access_token"] != b.Payload["access_token"] {
					t.Fatal("executor did not receive hydrated access")
				}
				_, hasRefresh := h.Metadata["refresh_token"]
				if hasRefresh != refresh {
					t.Fatal("refresh grant crossed inference boundary or was lost for authority")
				}
			}
			if strings.Contains(fmt.Sprintf("%v %#v", b, b), "fixture-"+provider+"-access") {
				t.Fatal("bundle diagnostic exposed credentials")
			}
			other := s
			other.OwnerID = "bob"
			if _, err = decodeBundle(other, raw, digest); err != ErrIntegrity {
				t.Fatal("bundle could move across owners")
			}
		})
	}
}

func TestActualCodexRefreshPatchMergesPartitions(t *testing.T) {
	s := fixtureScope("codex")
	before := fixturePayload("codex", "0")
	before["siwc"] = map[string]any{"access_token": "fixture-siwc-old", "refresh_token": "fixture-siwc-refresh-old", "client_id": "fixture-client", "device_id": "urn:uuid:fixture-host", "expired": expiry}
	after := cloneMap(before)
	after["access_token"] = "fixture-outer-new"
	after["refresh_token"] = "fixture-outer-refresh-new"
	latest := cloneMap(before)
	latest["siwc"].(map[string]any)["access_token"] = "fixture-siwc-concurrent"
	b := bundle{1, s.OwnerID, s.WorkspaceID, s.ConnectionID, s.Provider, latest}
	patch := compat.NewCredentialRefreshPatch(before, after, true, false)
	a := &core.Auth{ID: s.ConnectionID, Provider: "codex", Metadata: after, CodexRefreshPatch: patch}
	next, err := normalizeAuth(s, a, &b)
	if err != nil {
		t.Fatal(err)
	}
	if next.Payload["access_token"] != "fixture-outer-new" || next.Payload["siwc"].(map[string]any)["access_token"] != "fixture-siwc-concurrent" {
		t.Fatal("partition refresh overwrote latest independent grant")
	}
	newer := cloneMap(latest)
	newer["access_token"] = "fixture-even-newer"
	newer["refresh_token"] = "fixture-even-newer-refresh"
	b.Payload = newer
	if _, err = normalizeAuth(s, a, &b); err != ErrStale {
		t.Fatal("stale patch accepted against replaced outer credentials")
	}
}

type hostileStorage struct{ called *bool }

func (h hostileStorage) SaveTokenToFile(string) error { *h.called = true; return nil }
func TestUnknownStorageAndCredentialConfigurationNeverExecute(t *testing.T) {
	s := fixtureScope("codex")
	called := false
	a := &core.Auth{ID: s.ConnectionID, Provider: "codex", Storage: hostileStorage{&called}, Metadata: fixturePayload("codex", "0")}
	if _, err := normalizeAuth(s, a, nil); err != ErrCredential || called {
		t.Fatal("unknown imported storage was accepted or executed")
	}
}

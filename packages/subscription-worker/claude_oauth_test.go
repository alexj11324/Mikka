package worker

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
)

func TestClaudePlainOAuthAndRefreshExcludeNativeIdentityAndFingerprintPaths(t *testing.T) {
	w, inf, _ := fixtureWorker(t, "claude")
	var calls atomic.Int32
	issuer := httptest.NewTLSServer(http.HandlerFunc(func(out http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Header.Get("User-Agent") != "Mikka/1.0" {
			t.Error("OAuth client spoofed another client")
		}
		if r.Method == http.MethodGet && r.URL.Path == "/api/oauth/profile" {
			if r.Header.Get("Authorization") != "Bearer fixture-rotated-access" {
				t.Error("profile used another grant")
			}
			_ = json.NewEncoder(out).Encode(map[string]any{"account": map[string]string{"uuid": "fixture-account", "email": "fixture@example.invalid"}, "organization": map[string]string{"uuid": "fixture-org", "name": "Fixture"}})
			return
		}
		var body map[string]any
		if json.NewDecoder(r.Body).Decode(&body) != nil {
			out.WriteHeader(400)
			return
		}
		if body["grant_type"] == "authorization_code" {
			if body["code"] != "fixture-code" || len(body["code_verifier"].(string)) != 43 || len(body["state"].(string)) != 43 {
				out.WriteHeader(400)
				return
			}
			_ = json.NewEncoder(out).Encode(map[string]any{"access_token": "fixture-access", "refresh_token": "fixture-plain-claude-refresh", "expires_in": 7200, "account": map[string]string{"uuid": "fixture-account", "email_address": "fixture@example.invalid"}, "organization": map[string]string{"uuid": "fixture-org", "name": "Fixture"}})
		} else if body["grant_type"] == "refresh_token" && body["refresh_token"] == "fixture-plain-claude-refresh" {
			_ = json.NewEncoder(out).Encode(map[string]any{"access_token": "fixture-rotated-access", "refresh_token": "fixture-rotated-refresh", "expires_in": 7200})
		} else {
			out.WriteHeader(400)
		}
	}))
	defer issuer.Close()
	target, _ := url.Parse(issuer.URL)
	transport := issuer.Client().Transport
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.String() != "https://platform.claude.com/v1/oauth/token" && r.URL.String() != "https://api.anthropic.com/api/oauth/profile" {
			t.Error("native companion/profile/roles endpoint unexpectedly called")
			return nil, ErrUnsupported
		}
		clone := r.Clone(r.Context())
		u := *r.URL
		u.Scheme = target.Scheme
		u.Host = target.Host
		clone.URL = &u
		return transport.RoundTrip(clone)
	})}
	w.OAuth = CPAClaudeOAuth{RedirectURI: "https://mikka.invalid/api/subscriptions/callback", Client: client}
	w.Executor = CPAClaudeLifecycle{Client: client}
	begin, err := w.StartOAuth(context.Background(), 1, "fixture-session")
	if err != nil {
		t.Fatal(err)
	}
	parsed, _ := url.Parse(begin.AuthorizationURL)
	if parsed.Host != "claude.ai" {
		t.Fatal("authorization target changed")
	}
	done, err := w.CompleteOAuth(context.Background(), "fixture-session", parsed.Query().Get("state"), "fixture-code")
	if err != nil {
		t.Fatal(err)
	}
	current, _ := w.Repo.Lookup(context.Background(), w.Scope)
	inf.mu.Lock()
	raw := string(inf.values[current.SecretName])
	inf.mu.Unlock()
	if strings.Contains(raw, "device_id") || strings.Contains(raw, "fingerprint") || strings.Contains(raw, "hooks") {
		t.Fatal("native identity or executable fields persisted")
	}
	rotated, err := w.Refresh(context.Background(), done.Revision)
	if err != nil || rotated.Revision != done.Revision || rotated.CredentialVersion != 2 {
		t.Fatal("plain refresh did not preserve binding", err)
	}
	lease, err := w.ClaudeNativeAuth(context.Background(), done.Revision)
	if err != nil || lease.AccessToken != "fixture-rotated-access" || calls.Load() != 3 {
		t.Fatal("native access lease did not reuse platform OAuth lifecycle", err)
	}
}

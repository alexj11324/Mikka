package worker

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestOAuthActualCPAExchangeOwnerSessionPKCEOneUseAndTTL(t *testing.T) {
	w, _, _ := fixtureWorker(t, "codex")
	ctx := context.Background()
	var exchanges atomic.Int32
	var redirect atomic.Bool
	issuer := httptest.NewTLSServer(http.HandlerFunc(func(out http.ResponseWriter, r *http.Request) {
		exchanges.Add(1)
		if redirect.Load() {
			out.Header().Set("Location", "https://untrusted.invalid/leak")
			out.WriteHeader(307)
			return
		}
		raw, _ := io.ReadAll(r.Body)
		values, _ := url.ParseQuery(string(raw))
		if values.Get("code") != "fixture-code" || values.Get("grant_type") != "authorization_code" || len(values.Get("code_verifier")) != 43 || values.Get("redirect_uri") != "https://mikka.invalid/api/subscriptions/callback" {
			out.WriteHeader(400)
			return
		}
		header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none"}`))
		payload := base64.RawURLEncoding.EncodeToString([]byte(`{"email":"fixture@example.invalid","https://api.openai.com/auth":{"chatgpt_account_id":"fixture-account","chatgpt_plan_type":"plus"}}`))
		_ = json.NewEncoder(out).Encode(map[string]any{"access_token": "fixture-access", "refresh_token": "fixture-refresh", "id_token": header + "." + payload + ".fixture", "expires_in": 7200})
	}))
	defer issuer.Close()
	target, _ := url.Parse(issuer.URL)
	transport := issuer.Client().Transport
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.String() != "https://auth.openai.com/oauth/token" {
			t.Error("OAuth attempted a foreign endpoint")
			return nil, ErrUnsupported
		}
		clone := r.Clone(r.Context())
		u := *r.URL
		u.Scheme = target.Scheme
		u.Host = target.Host
		clone.URL = &u
		return transport.RoundTrip(clone)
	})}
	w.OAuth = CPACodexOAuth{RedirectURI: "https://mikka.invalid/api/subscriptions/callback", Client: client}
	begin, err := w.StartOAuth(ctx, 1, "fixture-session")
	if err != nil {
		t.Fatal(err)
	}
	parsed, _ := url.Parse(begin.AuthorizationURL)
	state := parsed.Query().Get("state")
	if parsed.Host != "auth.openai.com" || parsed.Query().Get("code_challenge_method") != "S256" || len(parsed.Query().Get("code_challenge")) != 43 {
		t.Fatal("CPA authorization URL missing PKCE")
	}
	if _, err = w.CompleteOAuth(ctx, "another-session", state, "fixture-code"); err != ErrStale {
		t.Fatal("callback changed login owner session")
	}
	if _, err = w.CompleteOAuth(ctx, "fixture-session", strings.Repeat("x", 43), "fixture-code"); err != ErrStale {
		t.Fatal("unknown state accepted")
	}
	if _, err = w.CompleteOAuth(ctx, "fixture-session", state, "fixture-code#other-state"); err != ErrUnsupported {
		t.Fatal("state fragment override accepted")
	}
	done, err := w.CompleteOAuth(ctx, "fixture-session", state, "fixture-code")
	if err != nil || done.State != "connected" || done.Revision != begin.Revision {
		t.Fatal("actual CPA exchange did not durably publish", err)
	}
	if _, err = w.CompleteOAuth(ctx, "fixture-session", state, "fixture-code"); err != ErrStale || exchanges.Load() != 1 {
		t.Fatal("OAuth code/state replayed")
	}
	next, err := w.StartOAuth(ctx, done.Revision, "fixture-session")
	if err != nil {
		t.Fatal(err)
	}
	parsed, _ = url.Parse(next.AuthorizationURL)
	state = parsed.Query().Get("state")
	if _, err = w.Repo.DB.Exec(`update byos_oauth_attempts set "expiresAt"=now()-interval '1 second' where "connectionId"=$1`, w.Scope.ConnectionID); err != nil {
		t.Fatal(err)
	}
	if _, err = w.CompleteOAuth(ctx, "fixture-session", state, "fixture-code"); err != ErrStale || exchanges.Load() != 1 {
		t.Fatal("expired attempt exchanged a grant")
	}
	redirect.Store(true)
	if _, err = w.OAuth.Exchange(ctx, "fixture-code", state, strings.Repeat("v", 43)); err != ErrProvider {
		t.Fatal("token endpoint redirect accepted")
	}
}

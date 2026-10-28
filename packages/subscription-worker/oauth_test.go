package worker

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestCodexDeviceCPAProtocolOwnerSessionIntervalPKCEOneUseAndExpiry(t *testing.T) {
	w, _, _ := fixtureWorker(t, "codex")
	ctx := context.Background()
	var polls, exchanges atomic.Int32
	var pending, redirect, badChallenge, block atomic.Bool
	entered, release := make(chan struct{}), make(chan struct{})
	verifier := strings.Repeat("v", 43)
	sum := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])
	issuer := httptest.NewTLSServer(http.HandlerFunc(func(out http.ResponseWriter, r *http.Request) {
		if r.Header.Get("User-Agent") != "Mikka/1.0" {
			t.Error("unexpected identity")
		}
		switch r.URL.Path {
		case "/api/accounts/deviceauth/usercode":
			var body map[string]string
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["client_id"] == "" {
				t.Error("CPA client absent")
			}
			_ = json.NewEncoder(out).Encode(map[string]any{"device_auth_id": "fixture-private-device", "user_code": "ABCD-EFGH", "interval": "5"})
		case "/api/accounts/deviceauth/token":
			polls.Add(1)
			if block.Load() {
				close(entered)
				select {
				case <-release:
				case <-r.Context().Done():
					return
				}
			}
			var body map[string]string
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["device_auth_id"] != "fixture-private-device" || body["user_code"] != "ABCD-EFGH" {
				t.Error("device context lost")
			}
			if pending.Load() {
				out.WriteHeader(403)
				return
			}
			c := challenge
			if badChallenge.Load() {
				c = "wrong"
			}
			_ = json.NewEncoder(out).Encode(map[string]string{"authorization_code": "fixture-code", "code_verifier": verifier, "code_challenge": c})
		case "/oauth/token":
			exchanges.Add(1)
			if redirect.Load() {
				out.Header().Set("Location", "https://untrusted.invalid/leak")
				out.WriteHeader(307)
				return
			}
			_ = r.ParseForm()
			if r.Form.Get("redirect_uri") != codexDeviceRedirect || r.Form.Get("code_verifier") != verifier || r.Form.Get("code") != "fixture-code" {
				t.Error("registered device redirect/PKCE changed")
			}
			payload := base64.RawURLEncoding.EncodeToString([]byte(`{"email":"fixture@example.invalid","https://api.openai.com/auth":{"chatgpt_account_id":"fixture-account","chatgpt_plan_type":"plus"}}`))
			_ = json.NewEncoder(out).Encode(map[string]any{"access_token": "fixture-access", "refresh_token": "fixture-refresh", "id_token": "e30." + payload + ".fixture", "expires_in": 7200})
		default:
			t.Error("unexpected OAuth endpoint")
			out.WriteHeader(400)
		}
	}))
	defer issuer.Close()
	target, _ := url.Parse(issuer.URL)
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		clone := r.Clone(r.Context())
		u := *r.URL
		u.Scheme = target.Scheme
		u.Host = target.Host
		clone.URL = &u
		return issuer.Client().Transport.RoundTrip(clone)
	})}
	w.OAuth = CPACodexOAuth{Client: client}
	start, err := w.StartOAuth(ctx, 1, "session")
	if err != nil {
		t.Fatal(err)
	}
	if start.Flow != "device" || start.AuthorizationURL != "https://auth.openai.com/codex/device" || start.UserCode != "ABCD-EFGH" || !validState(start.State) {
		t.Fatal("device public response wrong")
	}
	if _, err = w.PollOAuth(ctx, "other", start.State); err != ErrStale {
		t.Fatal("session changed")
	}
	if _, err = w.PollOAuth(ctx, "session", start.State); err != ErrStale || polls.Load() != 0 {
		t.Fatal("poll interval bypassed")
	}
	ready := func() {
		t.Helper()
		_, err := w.Repo.DB.Exec(`update byos_oauth_attempts set "nextPollAt"=now()-interval '1 second' where "connectionId"=$1`, w.Scope.ConnectionID)
		if err != nil {
			t.Fatal(err)
		}
	}
	pending.Store(true)
	ready()
	result, err := w.PollOAuth(ctx, "session", start.State)
	if err != nil || result.(map[string]any)["pending"] != true {
		t.Fatal("pending response mishandled", err)
	}
	if _, err = w.PollOAuth(ctx, "session", start.State); err != ErrStale || polls.Load() != 1 {
		t.Fatal("repeat poll too fast")
	}
	pending.Store(false)
	ready()
	result, err = w.PollOAuth(ctx, "session", start.State)
	if err != nil || result.(Metadata).State != "connected" {
		t.Fatal("actual CPA exchange did not publish", err)
	}
	if _, err = w.PollOAuth(ctx, "session", start.State); err != ErrStale || exchanges.Load() != 1 {
		t.Fatal("device code replayed")
	}
	next, err := w.StartOAuth(ctx, start.Revision, "session")
	if err != nil {
		t.Fatal(err)
	}
	ready()
	_, _ = w.Repo.DB.Exec(`update byos_oauth_attempts set "expiresAt"=now()-interval '1 second' where "stateHash"=$1`, hashText(next.State))
	if _, err = w.PollOAuth(ctx, "session", next.State); err != ErrStale || exchanges.Load() != 1 {
		t.Fatal("expired grant used")
	}
	next, err = w.StartOAuth(ctx, next.Revision, "session")
	if err != nil {
		t.Fatal(err)
	}
	ready()
	badChallenge.Store(true)
	if _, err = w.PollOAuth(ctx, "session", next.State); err != ErrIntegrity || exchanges.Load() != 1 {
		t.Fatal("provider PKCE mismatch exchanged")
	}
	badChallenge.Store(false)
	next, err = w.StartOAuth(ctx, next.Revision, "session")
	if err != nil {
		t.Fatal(err)
	}
	ready()
	block.Store(true)
	outcome := make(chan error, 1)
	go func() { _, e := w.PollOAuth(ctx, "session", next.State); outcome <- e }()
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("poll did not start")
	}
	// A second process cannot poll concurrently even if nextPollAt is in the past.
	if _, err = w.PollOAuth(ctx, "session", next.State); err != ErrStale {
		t.Fatal("concurrent poll entered provider")
	}
	replacement, err := w.StartOAuth(ctx, next.Revision, "session")
	if err != nil {
		t.Fatal(err)
	}
	close(release)
	if err = <-outcome; err != ErrStale || exchanges.Load() != 1 {
		t.Fatal("late device result exchanged after reconnect", err)
	}
	block.Store(false)
	ready()
	// Simulate an owned worker dying after its durable claim but before response.
	_, _ = w.Repo.DB.Exec(`update byos_oauth_attempts set polling=true where "stateHash"=$1`, hashText(replacement.State))
	before := polls.Load()
	if _, err = w.PollOAuth(ctx, "session", replacement.State); err != ErrStale || polls.Load() != before {
		t.Fatal("uncertain grant was retried")
	}
	newer, err := w.StartOAuth(ctx, replacement.Revision, "session")
	if err != nil {
		t.Fatal(err)
	}
	ready()
	if _, err = w.Disconnect(ctx, newer.Revision); err != nil {
		t.Fatal(err)
	}
	if _, err = w.PollOAuth(ctx, "session", newer.State); err != ErrStale || polls.Load() != before {
		t.Fatal("disconnected attempt made a provider request")
	}
	redirect.Store(true)
	if _, err = w.OAuth.Exchange(ctx, "fixture-code", "", verifier); err != ErrProvider {
		t.Fatal("token redirect followed")
	}
}

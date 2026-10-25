package worker

// Custody-only enrollment deliberately has no SQL dependency and creates no
// task binding. Its vault envelope cannot be decoded as an execution bundle.
import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/url"
	"strings"
	"time"
)

type Enrollment struct {
	Attempts, Claims, Grants SecretStore
	OAuth                    OAuthProvider
	Now                      func() time.Time
	RetainSources            bool
}
type enrollmentAttempt struct {
	Schema        string    `json:"schema"`
	Principal     string    `json:"principal"`
	ID            string    `json:"id"`
	State         string    `json:"state"`
	Verifier      string    `json:"verifier"`
	ExpiresAt     time.Time `json:"expiresAt"`
	Provider      string    `json:"provider,omitempty"`
	HandoffDigest string    `json:"handoffDigest,omitempty"`
}
type enrollmentGrant struct {
	Schema       string         `json:"schema"`
	Principal    string         `json:"principal"`
	ID           string         `json:"id"`
	BindingState string         `json:"bindingState"`
	Provider     string         `json:"provider"`
	CreatedAt    time.Time      `json:"createdAt"`
	Payload      map[string]any `json:"payload"`
}
type enrollmentCreation struct {
	Schema         string `json:"schema"`
	Principal      string `json:"principal"`
	ID             string `json:"id"`
	Digest         string `json:"digest"`
	GrantUncertain bool   `json:"grantUncertain"`
	AttemptSettled bool   `json:"attemptSettled"`
}

func enrollmentCreationName(id string) string {
	return derivedEnrollmentName("mikka.byos.creation-result.v1:", id)
}

type EnrollmentStatus struct {
	ID             string `json:"id"`
	Provider       string `json:"provider"`
	State          string `json:"state"`
	TaskUseAllowed bool   `json:"taskUseAllowed"`
}
type EnrollmentStart struct {
	EnrollmentStatus
	AuthorizationURL string    `json:"authorizationUrl"`
	ExpiresAt        time.Time `json:"expiresAt"`
	HandoffKey       string    `json:"handoffKey"`
}

func (e *Enrollment) now() time.Time {
	if e.Now != nil {
		return e.Now().UTC()
	}
	return time.Now().UTC()
}
func validPrincipal(principal string) bool {
	return len(principal) >= 16 && len(principal) <= 256 && !strings.ContainsAny(principal, "\r\n\x00")
}
func enrollmentName(id string) (string, error) {
	if !uuidPattern.MatchString(id) {
		return "", ErrUnsupported
	}
	return "mikka-byos-" + id, nil
}
func (e *Enrollment) Start(ctx context.Context, principal string) (EnrollmentStart, error) {
	if !validPrincipal(principal) || e.OAuth == nil || e.Attempts == nil || e.Claims == nil || e.Grants == nil {
		return EnrollmentStart{}, ErrUnsupported
	}
	id, state, verifier := newID(), randomCode(), randomCode()
	authorization, err := e.OAuth.Authorize(state, verifier)
	if err != nil {
		return EnrollmentStart{}, ErrProvider
	}
	u, err := url.Parse(authorization)
	if err != nil || u.Scheme != "https" || u.Host != "claude.ai" || u.Path != "/oauth/authorize" || u.User != nil || u.Fragment != "" || u.Query().Get("state") != state || u.Query().Get("redirect_uri") != claudeCallbackURI || u.Query().Get("code_challenge_method") != "S256" {
		return EnrollmentStart{}, ErrUnsupported
	}
	handoffKey := randomCode()
	a := enrollmentAttempt{Schema: "mikka.byos.attempt.v1", Principal: principal, ID: id, State: state, Verifier: verifier, ExpiresAt: e.now().Add(5 * time.Minute), Provider: "claude"}
	a.HandoffDigest = a.handoffDigest(handoffKey)
	raw, _ := json.Marshal(a)
	// Do not release a provider link until PKCE/state has a confirmed durable home.
	if err = e.Attempts.Create(ctx, "mikka-byos-"+id, raw); err != nil {
		return EnrollmentStart{}, err
	}
	return EnrollmentStart{EnrollmentStatus{id, "claude", "awaiting_consent", false}, authorization, a.ExpiresAt, handoffKey}, nil
}
func (a enrollmentAttempt) handoffDigest(key string) string {
	// Bind the scoped capability to the complete original ceremony. A capability
	// copied to another owner/attempt/state/verifier/provider/expiry cannot work.
	raw, _ := json.Marshal([]string{"mikka.byos.handoff.v1", a.Principal, a.ID, a.Provider, a.State, a.Verifier, a.ExpiresAt.UTC().Format(time.RFC3339Nano), key})
	return hashText(string(raw))
}
func (e *Enrollment) Handoff(ctx context.Context, id, provider, key, callback string) (EnrollmentStatus, error) {
	if provider != "claude" || !validState(key) {
		return EnrollmentStatus{}, ErrUnsupported
	}
	return e.complete(ctx, "", id, callback, key)
}
func (e *Enrollment) Complete(ctx context.Context, principal, id, callback string) (EnrollmentStatus, error) {
	if !validPrincipal(principal) {
		return EnrollmentStatus{}, ErrUnsupported
	}
	return e.complete(ctx, principal, id, callback, "")
}
func (e *Enrollment) complete(ctx context.Context, principal, id, callback, handoffKey string) (EnrollmentStatus, error) {
	name, err := enrollmentName(id)
	if err != nil || len(callback) > 8192 || e.OAuth == nil {
		return EnrollmentStatus{}, ErrUnsupported
	}
	raw, err := e.Attempts.Read(ctx, name)
	if err != nil {
		return EnrollmentStatus{}, ErrStale
	}
	var a enrollmentAttempt
	if json.Unmarshal(raw, &a) != nil {
		return EnrollmentStatus{}, ErrStale
	}
	if handoffKey != "" {
		if a.Provider != "claude" || !validPrincipal(a.Principal) || len(a.HandoffDigest) != 64 || subtle.ConstantTimeCompare([]byte(a.HandoffDigest), []byte(a.handoffDigest(handoffKey))) != 1 {
			return EnrollmentStatus{}, ErrStale
		}
		principal = a.Principal // Original stored principal, never browser input/current operator key.
	}
	if !validPrincipal(principal) || a.Schema != "mikka.byos.attempt.v1" || a.Principal != principal || a.ID != id || !e.now().Before(a.ExpiresAt) || !validState(a.State) || len(a.Verifier) != 43 {
		return EnrollmentStatus{}, ErrStale
	}
	u, err := url.Parse(callback)
	if err != nil || u.Scheme != "http" || u.Host != "localhost:54545" || u.Path != "/callback" || u.RawPath != "" || u.User != nil || u.Fragment != "" || u.Opaque != "" {
		return EnrollmentStatus{}, ErrUnsupported
	}
	q, err := url.ParseQuery(u.RawQuery)
	if err != nil || len(q) != 2 || len(q["state"]) != 1 || len(q["code"]) != 1 || q.Get("state") != a.State || q.Get("code") == "" || len(q.Get("code")) > 4096 || strings.ContainsAny(q.Get("code"), "#\r\n\x00") {
		return EnrollmentStatus{}, ErrUnsupported
	}
	// A create-only immutable claim is the one-use latch across workers/restarts.
	// A duplicate or uncertain claim is NEVER permission to repeat token exchange.
	claim, _ := json.Marshal(map[string]any{"schema": "mikka.byos.claim.v1", "principal": principal, "id": id, "claimedAt": e.now()})
	if err = e.Claims.Create(ctx, name, claim); err != nil {
		if err == ErrStoreDenied {
			return EnrollmentStatus{}, err
		}
		return EnrollmentStatus{}, ErrStale
	}
	grant, err := e.OAuth.Exchange(ctx, q.Get("code"), a.State, a.Verifier)
	if err != nil || grant == nil {
		return EnrollmentStatus{}, ErrProvider
	}
	grant.ID = id
	// Reuse actual CPA Auth.Storage normalization; never JSON(Auth), which omits it.
	normal, err := normalizeAuth(Scope{ConnectionID: id, Provider: "claude"}, grant, nil)
	if err != nil {
		return EnrollmentStatus{}, err
	}
	escrow := enrollmentGrant{"mikka.byos.unbound-grant.v1", principal, id, "pending_unbound", "claude", e.now(), normal.Payload}
	encoded, _ := json.Marshal(escrow)
	persist, persistCancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
	defer persistCancel()
	uncertain := false
	if err = e.Grants.Create(persist, name, encoded); err != nil {
		uncertain = err == ErrCreateUncertain
		// Recover an uncertain committed create without exchanging the code twice.
		stored, readErr := e.Grants.Read(persist, name)
		// Retry only an uncertain create that still reads missing, using the same
		// immutable name and captured payload. Never repeat provider exchange or a
		// definitively refused vault write. A late original commit is read back.
		if err == ErrCreateUncertain && readErr == ErrMissing && persist.Err() == nil {
			if e.Grants.Create(persist, name, encoded) == nil {
				stored, readErr = encoded, nil
			} else {
				stored, readErr = e.Grants.Read(persist, name)
			}
		}
		want, got := sha256.Sum256(encoded), sha256.Sum256(stored)
		if readErr != nil || want != got {
			return EnrollmentStatus{}, ErrStore
		}
	}
	// Token-free immutable evidence distinguishes known-complete creates from
	// requests that may still commit after a later delete/404.
	creation, _ := json.Marshal(enrollmentCreation{"mikka.byos.creation-result.v1", principal, id, hashText(string(encoded)), uncertain, true})
	if err = e.Claims.Create(persist, enrollmentCreationName(id), creation); err != nil {
		stored, readErr := e.Claims.Read(persist, enrollmentCreationName(id))
		if readErr != nil || hashText(string(stored)) != hashText(string(creation)) {
			return EnrollmentStatus{}, ErrStore
		}
	}
	// Only temporary PKCE/state is removed; the real grant and one-use claim stay.
	cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	if !e.RetainSources {
		_ = e.Attempts.Delete(cleanup, name)
	}
	return EnrollmentStatus{id, "claude", "pending_unbound", false}, nil
}
func (e *Enrollment) Status(ctx context.Context, principal, id string) (EnrollmentStatus, error) {
	name, err := enrollmentName(id)
	if err != nil || !validPrincipal(principal) {
		return EnrollmentStatus{}, ErrUnsupported
	}
	claim, err := e.Claims.Read(ctx, name)
	if errors.Is(err, ErrSourceStoreDenied) {
		return EnrollmentStatus{}, ErrSourceStoreDenied
	}
	if err != nil {
		return EnrollmentStatus{}, ErrUnavailable
	}
	var receipt struct {
		Schema    string `json:"schema"`
		Principal string `json:"principal"`
		ID        string `json:"id"`
	}
	if json.Unmarshal(claim, &receipt) != nil || receipt.Schema != "mikka.byos.claim.v1" || receipt.Principal != principal || receipt.ID != id {
		return EnrollmentStatus{}, ErrUnavailable
	}
	raw, err := e.Grants.Read(ctx, name)
	if err == ErrMissing {
		return EnrollmentStatus{id, "claude", "custody_unconfirmed", false}, nil
	}
	if errors.Is(err, ErrSourceStoreDenied) {
		return EnrollmentStatus{}, ErrSourceStoreDenied
	}
	if err != nil {
		return EnrollmentStatus{}, ErrUnavailable
	}
	var g enrollmentGrant
	if json.Unmarshal(raw, &g) != nil || g.Schema != "mikka.byos.unbound-grant.v1" || g.ID != id || g.Principal != principal || g.BindingState != "pending_unbound" || g.Provider != "claude" {
		return EnrollmentStatus{}, ErrUnavailable
	}
	return EnrollmentStatus{id, "claude", "pending_unbound", false}, nil
}

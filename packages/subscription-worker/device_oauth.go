package worker

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	compat "github.com/router-for-me/CLIProxyAPI/v8/sdk/mikkaadapter"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const codexDeviceRedirect = "https://auth.openai.com/deviceauth/callback"
const claudeCallbackURI = "http://localhost:54545/callback"

// The split-phase shape follows pinned CPA sdk/auth/codex_device.go. We reuse
// its client constant and actual token exchange/storage; no CLI callback server,
// stdout, browser launch, identity cloaking, or local credential acquisition.
type DeviceAttempt struct {
	DeviceAuthID string `json:"device_auth_id"`
	UserCode     string `json:"user_code"`
	Interval     int    `json:"interval"`
}
type DeviceOAuth interface {
	BeginDevice(context.Context) (DeviceAttempt, error)
	PollDevice(context.Context, DeviceAttempt) (*DeviceGrant, error)
}
type DeviceGrant struct{ Code, Verifier string }

func (p CPACodexOAuth) deviceRequest(ctx context.Context, endpoint string, body any) ([]byte, int, error) {
	raw, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(raw))
	if err != nil {
		return nil, 0, ErrProvider
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	response, err := plainOAuthClient(p.Client).Do(req)
	if err != nil {
		return nil, 0, ErrProvider
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil || len(data) > 262144 {
		return nil, 0, ErrProvider
	}
	return data, response.StatusCode, nil
}
func (p CPACodexOAuth) BeginDevice(ctx context.Context) (DeviceAttempt, error) {
	raw, status, err := p.deviceRequest(ctx, "https://auth.openai.com/api/accounts/deviceauth/usercode", map[string]string{"client_id": compat.CodexClientID})
	if err != nil || status < 200 || status >= 300 {
		return DeviceAttempt{}, ErrProvider
	}
	var value struct {
		DeviceAuthID string          `json:"device_auth_id"`
		UserCode     string          `json:"user_code"`
		Alternate    string          `json:"usercode"`
		Interval     json.RawMessage `json:"interval"`
	}
	if json.Unmarshal(raw, &value) != nil {
		return DeviceAttempt{}, ErrProvider
	}
	if value.UserCode == "" {
		value.UserCode = value.Alternate
	}
	interval := 5
	var number int
	var text string
	if json.Unmarshal(value.Interval, &number) == nil && number > 0 {
		interval = number
	} else if json.Unmarshal(value.Interval, &text) == nil {
		if json.Unmarshal([]byte(text), &number) == nil && number > 0 {
			interval = number
		}
	}
	// Bound user-visible code, private id and provider polling schedule. Refuse
	// unexpected output rather than letting it control URLs or timers unboundedly.
	if len(value.DeviceAuthID) == 0 || len(value.DeviceAuthID) > 4096 || len(value.UserCode) == 0 || len(value.UserCode) > 64 || strings.ContainsAny(value.UserCode, "\r\n\x00") || interval > 900 {
		return DeviceAttempt{}, ErrProvider
	}
	if interval < 5 {
		interval = 5
	}
	return DeviceAttempt{value.DeviceAuthID, value.UserCode, interval}, nil
}
func (p CPACodexOAuth) PollDevice(ctx context.Context, a DeviceAttempt) (*DeviceGrant, error) {
	raw, status, err := p.deviceRequest(ctx, "https://auth.openai.com/api/accounts/deviceauth/token", map[string]string{"device_auth_id": a.DeviceAuthID, "user_code": a.UserCode})
	if err != nil {
		return nil, err
	}
	if status == 403 || status == 404 {
		return nil, nil
	}
	if status < 200 || status >= 300 {
		return nil, ErrProvider
	}
	var value struct {
		Code      string `json:"authorization_code"`
		Verifier  string `json:"code_verifier"`
		Challenge string `json:"code_challenge"`
	}
	if json.Unmarshal(raw, &value) != nil {
		return nil, ErrProvider
	}
	sum := sha256.Sum256([]byte(value.Verifier))
	if len(value.Code) == 0 || len(value.Code) > 4096 || strings.ContainsAny(value.Code, "#\r\n\x00") || len(value.Verifier) < 43 || len(value.Verifier) > 128 || base64.RawURLEncoding.EncodeToString(sum[:]) != value.Challenge {
		return nil, ErrIntegrity
	}
	return &DeviceGrant{value.Code, value.Verifier}, nil
}
func (w *Worker) startDevice(ctx context.Context, epoch int64, session string, d DeviceOAuth) (OAuthStart, error) {
	op, err := w.Repo.BeginAcquire(ctx, w.Scope, epoch)
	if err != nil {
		return OAuthStart{}, err
	}
	fail := func(e error) (OAuthStart, error) {
		_ = w.Repo.Fail(context.WithoutCancel(ctx), op, "publication_failed")
		return OAuthStart{}, e
	}
	device, err := d.BeginDevice(ctx)
	if err != nil {
		return fail(err)
	}
	state, name := randomCode(), "mikka-byos-"+newID()
	raw, _ := json.Marshal(oauthSecret{Scope: w.Scope, SessionHash: hashText(session), OperationID: op.OperationID, Device: &device})
	op.Deadline = time.Now().Add(15 * time.Minute)
	if createArtifact(ctx, w.Repo, w.Secrets, op, "oauth", name, raw) != nil {
		return fail(ErrStore)
	}
	// Extend the publication deadline to match CPA's 15-minute device lifetime.
	_, err = w.Repo.DB.ExecContext(ctx, `update byos_connections set "operationDeadline"=now()+interval '15 minutes' where id=$1 and "operationId"=$2 and state='pending'`, w.Scope.ConnectionID, op.OperationID)
	if err != nil {
		return fail(ErrDatabase)
	}
	expires := time.Now().Add(15 * time.Minute)
	_, err = w.Repo.DB.ExecContext(ctx, `insert into byos_oauth_attempts ("stateHash","sessionHash","connectionId","ownerId","workspaceId","operationId","secretName","expiresAt",flow,"nextPollAt") values ($1,$2,$3,$4,$5,$6,$7,$8,'device',now()+$9*interval '1 second')`, hashText(state), hashText(session), w.Scope.ConnectionID, w.Scope.OwnerID, w.Scope.WorkspaceID, op.OperationID, name, expires, device.Interval)
	if err != nil {
		return fail(ErrDatabase)
	}
	return OAuthStart{Flow: "device", State: state, UserCode: device.UserCode, Interval: device.Interval, AuthorizationURL: "https://auth.openai.com/codex/device", Revision: op.Epoch, ExpiresAt: expires}, nil
}
func validState(state string) bool {
	if len(state) != 43 {
		return false
	}
	raw, err := base64.RawURLEncoding.DecodeString(state)
	return err == nil && len(raw) == 32
}

// Claims persist before network use. A crash/uncertain poll leaves polling=true:
// reconnect is required; another worker must not retry a possibly consumed grant.
func (w *Worker) PollOAuth(ctx context.Context, session, state string) (any, error) {
	if w.ExecutionOnly || w.Secrets == nil {
		return nil, ErrUnsupported
	}
	d, ok := w.OAuth.(DeviceOAuth)
	if !ok || session == "" || len(session) > 512 || !validState(state) {
		return nil, ErrUnsupported
	}
	var opID, name string
	err := w.Repo.DB.QueryRowContext(ctx, `update byos_oauth_attempts a set polling=true where "stateHash"=$1 and "sessionHash"=$2 and "connectionId"=$3 and "ownerId"=$4 and "workspaceId"=$5 and flow='device' and "consumedAt" is null and not polling and "expiresAt">now() and "nextPollAt"<=now() and exists(select 1 from byos_connections c where c.id=a."connectionId" and c."operationId"=a."operationId" and c.state='pending') returning "operationId"::text,"secretName"`, hashText(state), hashText(session), w.Scope.ConnectionID, w.Scope.OwnerID, w.Scope.WorkspaceID).Scan(&opID, &name)
	if err != nil {
		return nil, ErrStale
	}
	record, err := w.Repo.Lookup(ctx, w.Scope)
	if err != nil || record.State != "pending" || record.OperationID != opID {
		return nil, ErrStale
	}
	op := Operation{record}
	fail := func(e error) (any, error) {
		_ = w.Repo.Fail(context.WithoutCancel(ctx), op, "publication_failed")
		return nil, e
	}
	raw, err := w.Secrets.Read(ctx, name)
	if err != nil {
		return fail(ErrStore)
	}
	var attempt oauthSecret
	if json.Unmarshal(raw, &attempt) != nil || attempt.Scope != w.Scope || attempt.SessionHash != hashText(session) || attempt.OperationID != opID || attempt.Device == nil {
		return fail(ErrIntegrity)
	}
	grant, err := d.PollDevice(ctx, *attempt.Device)
	if err != nil {
		return fail(err)
	}
	if grant == nil {
		_, err = w.Repo.DB.ExecContext(ctx, `update byos_oauth_attempts set polling=false,"nextPollAt"=now()+$2*interval '1 second' where "stateHash"=$1 and polling and "consumedAt" is null`, hashText(state), attempt.Device.Interval)
		if err != nil {
			return fail(ErrDatabase)
		}
		return map[string]any{"pending": true, "interval": attempt.Device.Interval}, nil
	}
	result, err := w.Repo.DB.ExecContext(ctx, `update byos_oauth_attempts set "consumedAt"=now() where "stateHash"=$1 and polling and "consumedAt" is null and "expiresAt">now()`, hashText(state))
	if err != nil {
		return fail(ErrDatabase)
	}
	n, _ := result.RowsAffected()
	if n != 1 {
		return fail(ErrStale)
	}
	// Never use the provider's verifier/challenge as a client-supplied redirect.
	return w.publishOAuth(ctx, op, grant.Code, "", grant.Verifier)
}
func (w *Worker) CompleteHandoff(ctx context.Context, session, state, callback string) (Metadata, error) {
	if w.Scope.Provider != "claude" || !validState(state) || len(callback) > 8192 || strings.ContainsAny(callback, "\r\n\x00") {
		return Metadata{}, ErrUnsupported
	}
	parsed, err := url.Parse(callback)
	if err != nil || parsed.Scheme != "http" || parsed.Host != "localhost:54545" || parsed.Path != "/callback" || parsed.RawPath != "" || parsed.User != nil || parsed.Fragment != "" || parsed.Opaque != "" {
		return Metadata{}, ErrUnsupported
	}
	q, err := url.ParseQuery(parsed.RawQuery)
	if err != nil || len(q) != 2 || len(q["code"]) != 1 || len(q["state"]) != 1 || q.Get("state") != state {
		return Metadata{}, ErrUnsupported
	}
	return w.CompleteOAuth(ctx, session, state, q.Get("code"))
}

// Both flows publish through the same actual CPA login manager and durable Store.
func (w *Worker) publishOAuth(ctx context.Context, op Operation, code, state, verifier string) (Metadata, error) {
	current, err := w.Repo.Lookup(ctx, w.Scope)
	if err != nil || current.OperationID != op.OperationID || current.Epoch != op.Epoch || current.State != "pending" {
		return Metadata{}, ErrStale
	}
	manager := newOAuthManager(w, op, code, state, verifier)
	if err := manager(ctx); err != nil {
		_ = w.Repo.Fail(context.WithoutCancel(ctx), op, "publication_failed")
		return Metadata{}, Refusal(safeCode(err))
	}
	return w.Status(ctx)
}

// Keep interface checks beside the adapter; no generic SaaS OAuth is substituted.
var _ OAuthProvider = CPACodexOAuth{}
var _ DeviceOAuth = CPACodexOAuth{}

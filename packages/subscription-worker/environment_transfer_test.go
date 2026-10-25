package worker

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

type transferVault struct {
	mu                     sync.Mutex
	values                 map[string][]byte
	server                 *httptest.Server
	failCreate, loseCreate string
	deletes                int
}

func newTransferVault(t *testing.T, environment, token string) *transferVault {
	v := &transferVault{values: map[string][]byte{}}
	v.server = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		v.mu.Lock()
		defer v.mu.Unlock()
		if r.Header.Get("Authorization") != "Bearer "+token {
			w.WriteHeader(403)
			return
		}
		name := strings.TrimPrefix(r.URL.Path, "/api/v4/secrets/")
		if !validSecretName(name) {
			w.WriteHeader(400)
			return
		}
		env, path := r.URL.Query().Get("environment"), r.URL.Query().Get("secretPath")
		project := r.URL.Query().Get("projectId")
		var value string
		if r.Method != "GET" {
			var body struct {
				Environment string `json:"environment"`
				Path        string `json:"secretPath"`
				Project     string `json:"projectId"`
				Value       string `json:"secretValue"`
			}
			if json.NewDecoder(r.Body).Decode(&body) != nil {
				w.WriteHeader(400)
				return
			}
			env, path, project, value = body.Environment, body.Path, body.Project, body.Value
		}
		if env != environment || project != "89850d6a-f020-4936-863e-df77380dfe40" {
			w.WriteHeader(403)
			return
		}
		key := path + "/" + name
		if r.Method == "DELETE" {
			v.deletes++
			w.WriteHeader(403)
			return
		}
		if r.Method == "POST" {
			if path == v.failCreate {
				w.WriteHeader(503)
				return
			}
			if _, ok := v.values[key]; ok {
				w.WriteHeader(409)
				return
			}
			v.values[key] = []byte(value)
			if path == v.loseCreate {
				w.WriteHeader(503)
				return
			}
		} else if r.Method != "GET" || r.URL.Query().Get("version") != "1" || r.URL.Query().Get("expandSecretReferences") != "false" || r.URL.Query().Get("includeImports") != "false" {
			w.WriteHeader(400)
			return
		}
		raw, ok := v.values[key]
		if !ok {
			w.WriteHeader(404)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"secret": map[string]any{"secretKey": name, "secretValue": string(raw), "version": 1}})
	}))
	t.Cleanup(v.server.Close)
	return v
}
func (v *transferVault) store(t *testing.T, env, path, token string) *Infisical {
	target, _ := url.Parse(v.server.URL)
	clientCopy := *v.server.Client()
	client := &clientCopy
	transport := client.Transport
	client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != "app.infisical.com" {
			t.Error("unexpected outbound host")
			return nil, ErrStore
		}
		cloned := r.Clone(r.Context())
		u := *r.URL
		u.Scheme = target.Scheme
		u.Host = target.Host
		cloned.URL = &u
		return transport.RoundTrip(cloned)
	})
	s, err := NewInfisical(InfisicalConfig{Origin: "https://app.infisical.com", ProjectID: "89850d6a-f020-4936-863e-df77380dfe40", Environment: env, Path: path, Token: func(context.Context) (string, error) { return token, nil }, Client: client})
	if err != nil {
		t.Fatal(err)
	}
	return s
}
func transferFixture(t *testing.T) (*EnrollmentBinder, TransferApproval, *transferVault, *transferVault) {
	b, _, id, _, _ := enrollmentBindingFixture(t)
	principal := "operator:" + strings.Repeat("f", 64)
	src, dst := newTransferVault(t, "staging", "fixture-source"), newTransferVault(t, "prod", "fixture-destination")
	for path, store := range map[string]SecretStore{"/byos/enrollment-attempts": b.Enrollment.Attempts, "/byos/enrollment-claims": b.Enrollment.Claims, "/byos/pending-grants": b.Enrollment.Grants} {
		m := store.(*enrollmentMemory)
		for key, raw := range m.values {
			// Synthetic fixture replaces its operator identity before hashing approval.
			src.values[path+"/"+key] = bytes.ReplaceAll(raw, []byte("operator:fixture-principal"), []byte(principal))
		}
	}
	b.Enrollment = &Enrollment{Attempts: src.store(t, "staging", "/byos/enrollment-attempts", "fixture-source"), Claims: src.store(t, "staging", "/byos/enrollment-claims", "fixture-source"), Grants: src.store(t, "staging", "/byos/pending-grants", "fixture-source")}
	b.Secrets = dst.store(t, "prod", "/byos/grants", "fixture-destination")
	b.AccessSecrets = dst.store(t, "prod", "/byos/access", "fixture-destination")
	raw := src.values["/byos/pending-grants/mikka-byos-"+id]
	var grant enrollmentGrant
	_ = json.Unmarshal(raw, &grant)
	a := TransferApproval{TransferID: newID(), EnrollmentID: id, OwnerID: "fixture-owner-" + newID(), WorkspaceID: newID(), Provider: "claude", SourcePrincipal: principal, ProviderSubject: (bundle{Provider: "claude", Payload: grant.Payload}).subject(), Source: TransferStore{"https://app.infisical.com", "89850d6a-f020-4936-863e-df77380dfe40", "staging", "/byos/pending-grants"}, Destination: TransferStore{"https://app.infisical.com", "89850d6a-f020-4936-863e-df77380dfe40", "prod", "/byos/grants"}, DestinationOrigin: "https://app.aspectlylabs.com", DestinationDatabaseIdentity: b.DatabaseIdentity, SourceDigest: hashText(string(raw)), SourceRevision: 1, ExpiresAt: time.Now().Add(10 * time.Minute)}
	return b, a, src, dst
}
func transferCall(b *EnrollmentBinder, a TransferApproval) (Metadata, error) {
	return b.Transfer(context.Background(), a, a.SourcePrincipal, a.EnrollmentID, a.OwnerID, a.WorkspaceID, a.DestinationOrigin)
}
func TestEnvironmentTransferHTTPStoresJournalRetryRefreshAndDisconnect(t *testing.T) {
	b, a, src, dst := transferFixture(t)
	original := append([]byte(nil), src.values["/byos/pending-grants/mikka-byos-"+a.EnrollmentID]...)
	meta, err := transferCall(b, a)
	if err != nil {
		t.Fatal("transfer", err)
	}
	if meta.Cleanup == nil || meta.Cleanup.Enrollment.State != "external_source_retained" {
		t.Fatal("source retention invisible")
	}
	again, err := transferCall(b, a)
	if err != nil || again.ID != meta.ID || len(dst.values) != 2 {
		t.Fatal("retry duplicated publication", err)
	}
	w := Worker{Repo: b.Repo, Scope: Scope{OwnerID: a.OwnerID, WorkspaceID: a.WorkspaceID, ConnectionID: meta.ID, Provider: "claude"}, Secrets: b.Secrets, AccessSecrets: b.AccessSecrets, Executor: &enrollmentRefresh{}}
	bindFixture(t, &w, meta.Revision, "claude_cpa")
	if _, err = w.Refresh(context.Background(), meta.Revision); err != nil {
		t.Fatal(err)
	}
	newer, err := transferCall(b, a)
	if err != nil || newer.CredentialVersion != 2 {
		t.Fatal("retry overwrote rotated grant", err)
	}
	if err = w.Repo.Disconnect(context.Background(), w.Scope, meta.Revision); err != nil {
		t.Fatal(err)
	}
	// Later ordinary runtime has no source token/configuration, and must not GC
	// external names through its local production stores.
	w.Enrollment = &Enrollment{Attempts: b.Secrets, Claims: b.Secrets, Grants: b.Secrets}
	w.DatabaseIdentity = b.DatabaseIdentity
	if err = w.cleanupEnrollment(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err = transferCall(b, a); err == nil {
		t.Fatal("disconnected epoch resurrected")
	}
	if src.deletes != 0 || dst.deletes != 0 || !bytes.Equal(original, src.values["/byos/pending-grants/mikka-byos-"+a.EnrollmentID]) {
		t.Fatal("source mutated or deleted")
	}
	var verified bool
	if err = b.Repo.DB.QueryRow(`select "verifiedAt" is not null from byos_environment_transfers where "enrollmentId"=$1`, a.EnrollmentID).Scan(&verified); err != nil || !verified {
		t.Fatal("verification journal missing", err)
	}
}
func TestEnvironmentTransferRejectsWrongApprovalBeforeSecretAccess(t *testing.T) {
	for _, kind := range []string{"owner", "database", "destination", "subject", "digest", "expired", "revision", "provider", "delete"} {
		t.Run(kind, func(t *testing.T) {
			b, a, _, dst := transferFixture(t)
			switch kind {
			case "owner":
				a.OwnerID = "not an owner"
			case "database":
				a.DestinationDatabaseIdentity = strings.Repeat("0", 64)
			case "destination":
				a.Destination.Environment = "staging"
			case "subject":
				a.ProviderSubject = "other"
			case "digest":
				a.SourceDigest = strings.Repeat("0", 64)
			case "expired":
				a.ExpiresAt = time.Now().Add(-time.Minute)
			case "revision":
				a.SourceRevision = 2
			case "provider":
				a.Provider = "codex"
			case "delete":
				a.DeleteSource = true
			}
			if _, err := transferCall(b, a); err == nil {
				t.Fatal("unapproved transfer accepted")
			}
			if len(dst.values) != 0 {
				t.Fatal("unapproved destination written")
			}
		})
	}
}
func TestEnvironmentTransferRecoversHTTPFailuresWithoutSourceDeletion(t *testing.T) {
	for _, mode := range []string{"grant_failure", "access_failure", "uncertain_create"} {
		t.Run(mode, func(t *testing.T) {
			b, a, src, dst := transferFixture(t)
			if mode == "grant_failure" {
				dst.failCreate = "/byos/grants"
			} else if mode == "access_failure" {
				dst.failCreate = "/byos/access"
			} else {
				dst.loseCreate = "/byos/grants"
			}
			_, err := transferCall(b, a)
			if mode != "uncertain_create" && err == nil {
				t.Fatal("failed persistence reported success")
			}
			dst.mu.Lock()
			dst.failCreate = ""
			dst.loseCreate = ""
			dst.mu.Unlock()
			meta, err := transferCall(b, a)
			if err != nil || meta.State != "connected" || len(dst.values) != 2 {
				t.Fatal("recovery failed", err)
			}
			modified := a
			modified.TransferID = newID()
			if _, err = transferCall(b, modified); err == nil {
				t.Fatal("changed approval reused journal")
			}
			if src.deletes != 0 {
				t.Fatal("source deleted")
			}
		})
	}
}

// Ensure test failures never format request bodies or secrets.

func TestEnvironmentTransferJournalFailureAndConcurrentRetries(t *testing.T) {
	b, a, src, dst := transferFixture(t)
	fn := "transfer_fail_" + strings.ReplaceAll(newID(), "-", "")
	query := `create function ` + fn + `() returns trigger language plpgsql as $$ begin if NEW."enrollmentId"='` + a.EnrollmentID + `' and NEW."verifiedAt" is not null then raise exception 'fixture journal failure'; end if; return NEW; end $$; create trigger ` + fn + ` before update on byos_environment_transfers for each row execute function ` + fn + `() `
	if _, err := b.Repo.DB.Exec(query); err != nil {
		t.Fatal(err)
	}
	remove := func() {
		if _, err := b.Repo.DB.Exec(`drop trigger if exists ` + fn + ` on byos_environment_transfers; drop function if exists ` + fn + `() `); err != nil {
			t.Error("fixture cleanup failed")
		}
	}
	defer remove()
	if _, err := transferCall(b, a); err != ErrDatabase {
		t.Fatal("journal failure reported success", err)
	}
	if len(dst.values) != 2 || src.deletes != 0 {
		t.Fatal("failed receipt lost publication or source")
	}
	remove()
	// Concurrent retries reuse exact publication; at least one succeeds, and no
	// retry can mint a second connection or rotate the original refresh grant.
	var wg sync.WaitGroup
	results := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); _, err := transferCall(b, a); results <- err }()
	}
	wg.Wait()
	close(results)
	for err := range results {
		if err != nil {
			t.Fatal("idempotent concurrent retry", err)
		}
	}
	var count int
	if err := b.Repo.DB.QueryRow(`select count(*) from byos_enrollment_transfers where "enrollmentId"=$1`, a.EnrollmentID).Scan(&count); err != nil || count != 1 {
		t.Fatal("duplicate connection", err)
	}
	if len(dst.values) != 2 || src.deletes != 0 {
		t.Fatal("retry altered custody")
	}
}

func TestEnvironmentTransferSourceMutationCannotPublish(t *testing.T) {
	b, a, src, dst := transferFixture(t)
	// Approval was made for an immutable v1. A mismatching response is refused,
	// and the durable journal cannot be replaced with a newly invented approval.
	key := "/byos/pending-grants/mikka-byos-" + a.EnrollmentID
	src.values[key] = append(src.values[key], byte(' '))
	if _, err := transferCall(b, a); err != ErrIntegrity {
		t.Fatal("source digest not enforced", err)
	}
	if len(dst.values) != 0 {
		t.Fatal("mismatching source published")
	}
}

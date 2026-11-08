package worker

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// Fixed provider URLs still reach a real TLS server. No public host is dialed.
func allowanceHTTP(t *testing.T, w *Worker, status int, afterQuota func()) func() []string {
	t.Helper()
	var mu sync.Mutex
	var requests []string
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet || !strings.HasPrefix(request.Header.Get("Authorization"), "Bearer fixture-") {
			t.Error("unexpected fixture method or authorization")
			response.WriteHeader(http.StatusBadRequest)
			return
		}
		mu.Lock()
		requests = append(requests, request.URL.Path)
		mu.Unlock()
		if request.URL.Path == "/api/oauth/profile" {
			_ = json.NewEncoder(response).Encode(map[string]any{"organization": map[string]any{"organization_type": "claude_max"}})
			return
		}
		if request.URL.Path != "/api/oauth/usage" && request.URL.Path != "/backend-api/wham/usage" {
			t.Error("unexpected provider endpoint")
			response.WriteHeader(http.StatusNotFound)
			return
		}
		if afterQuota != nil {
			afterQuota()
		}
		response.WriteHeader(status)
		if status != http.StatusOK {
			_ = json.NewEncoder(response).Encode(map[string]any{"error": request.Header.Get("Authorization")})
			return
		}
		if w.Scope.Provider == "claude" {
			_ = json.NewEncoder(response).Encode(map[string]any{
				"five_hour":  map[string]any{"utilization": 25, "resets_at": "2030-01-01T00:00:00Z"},
				"seven_day":  map[string]any{"utilization": 60, "resets_at": "2030-01-08T00:00:00Z"},
				"diagnostic": request.Header.Get("Authorization"),
			})
		} else {
			_ = json.NewEncoder(response).Encode(map[string]any{
				"plan_type":  "plus",
				"rate_limit": map[string]any{"primary_window": map[string]any{"used_percent": 25, "limit_window_seconds": 18000, "reset_at": 1893456000}},
				"credits":    map[string]any{"has_credits": false, "unlimited": false},
				"diagnostic": request.Header.Get("Authorization"),
			})
		}
	}))
	t.Cleanup(server.Close)
	roots := x509.NewCertPool()
	roots.AddCert(server.Certificate())
	transport := server.Client().Transport.(*http.Transport).Clone()
	transport.TLSClientConfig = &tls.Config{RootCAs: roots, ServerName: "example.com", MinVersion: tls.VersionTLS12}
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		if address != "api.anthropic.com:443" && address != "chatgpt.com:443" {
			return nil, errors.New("unexpected fixture destination")
		}
		return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
	}
	t.Cleanup(transport.CloseIdleConnections)
	w.QuotaClient = &http.Client{Transport: transport}
	return func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), requests...)
	}
}

func TestStartupAllowanceKeepsQuotaWithoutSettingsProfileHTTP(t *testing.T) {
	for _, provider := range []string{"claude", "codex"} {
		t.Run(provider, func(t *testing.T) {
			w, _, issuer := fixtureWorker(t, provider)
			initial := mustAcquire(t, w)
			w.Use = nil
			requests := allowanceHTTP(t, w, http.StatusOK, nil)
			ctx := context.Background()

			settings, err := w.Usage(ctx, initial.Revision)
			if err != nil || settings.Status != 200 || settings.Account != "fixture@example.invalid" {
				t.Fatal("Settings usage lost its original projection", err)
			}
			if provider == "claude" && settings.Plan != "Max" {
				t.Fatal("Settings no longer reads its plan")
			}
			before := len(requests())
			wantSettings := 1
			if provider == "claude" {
				wantSettings = 2
			}
			if before != wantSettings {
				t.Fatalf("Settings HTTP count %d, want %d", before, wantSettings)
			}
			result, err := w.Allowance(ctx, initial.Revision)
			if err != nil || result.Status != 200 {
				t.Fatal("startup allowance unavailable", err)
			}
			after := requests()
			if len(after)-before != 1 {
				t.Fatalf("startup allowance used %d provider HTTP requests, want 1; paths=%v", len(after)-before, after[before:])
			}
			if after[before] == "/api/oauth/profile" {
				t.Fatal("startup asked for Settings profile")
			}
			raw, _ := json.Marshal(result)
			for _, forbidden := range []string{"account", "fixture@", "Bearer", "diagnostic", "fixture-" + provider} {
				if bytes.Contains(raw, []byte(forbidden)) {
					t.Fatal("startup allowance exported non-quota data")
				}
			}
			wantBody, _ := json.Marshal(settings.Body)
			body, _ := json.Marshal(result.Body)
			if !bytes.Equal(body, wantBody) || issuer.refreshes.Load() != 0 {
				t.Fatal("startup changed quota projection or forced OAuth refresh")
			}
			t.Logf("real provider HTTP: Settings=%d startup=1", wantSettings)
		})
	}
}

func TestStartupAllowanceKeepsOwnerAndEpochFences(t *testing.T) {
	for _, provider := range []string{"claude", "codex"} {
		t.Run(provider, func(t *testing.T) {
			w, _, _ := fixtureWorker(t, provider)
			initial := mustAcquire(t, w)
			requests := allowanceHTTP(t, w, http.StatusOK, nil)
			if _, err := w.Allowance(context.Background(), initial.Revision); err != ErrUnsupported {
				t.Fatal("model binding gained owner allowance access")
			}
			w.Use = nil
			w.ExecutionOnly = true
			if _, err := w.Allowance(context.Background(), initial.Revision); err != ErrUnsupported {
				t.Fatal("execution-only role gained owner allowance access")
			}
			w.ExecutionOnly = false
			if _, err := w.Allowance(context.Background(), initial.Revision+1); err == nil {
				t.Fatal("stale epoch read quota")
			}
			if _, err := w.Quota(context.Background(), initial.Revision); err == nil {
				t.Fatal("runtime quota lost its original binding requirement")
			}
			cancelled, cancel := context.WithCancel(context.Background())
			cancel()
			if _, err := w.Allowance(cancelled, initial.Revision); err == nil {
				t.Fatal("cancelled allowance succeeded")
			}
			if len(requests()) != 0 {
				t.Fatal("a refused owner scope made a provider request")
			}
		})
	}
}

func TestStartupAllowanceDiscardsProviderAnswerAfterConnectionChanges(t *testing.T) {
	for _, change := range []string{"epoch", "disconnect"} {
		t.Run(change, func(t *testing.T) {
			w, _, _ := fixtureWorker(t, "claude")
			initial := mustAcquire(t, w)
			w.Use = nil
			requests := allowanceHTTP(t, w, http.StatusOK, func() {
				sql := `UPDATE byos_connections SET epoch=epoch+1 WHERE id=$1`
				if change == "disconnect" {
					sql = `UPDATE byos_connections SET state='disconnected' WHERE id=$1`
				}
				if _, err := w.Repo.DB.Exec(sql, w.Scope.ConnectionID); err != nil {
					t.Error("fixture connection update failed")
				}
			})
			result, err := w.Allowance(context.Background(), initial.Revision)
			if err != ErrUnavailable || result.Status != 0 || len(result.Body) != 0 {
				t.Fatal("stale provider answer escaped final connection fence")
			}
			if len(requests()) != 1 {
				t.Fatalf("refused response used %d HTTP requests, want 1", len(requests()))
			}
		})
	}
}

func TestStartupAllowanceRPCRemainsOwnerOnlyAndDoesNotRefreshOnProviderRefusal(t *testing.T) {
	for _, status := range []int{http.StatusUnauthorized, http.StatusForbidden} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			w, _, issuer := fixtureWorker(t, "claude")
			initial := mustAcquire(t, w)
			use := w.Use
			w.Use = nil
			requests := allowanceHTTP(t, w, status, nil)
			invoke := func() map[string]any {
				var input, output bytes.Buffer
				_ = json.NewEncoder(&input).Encode(map[string]any{"id": "allowance", "method": "allowance", "revision": initial.Revision})
				if err := w.Serve(context.Background(), &input, &output); err != nil {
					t.Fatal("allowance RPC unavailable", err)
				}
				var frame map[string]any
				if json.Unmarshal(output.Bytes(), &frame) != nil {
					t.Fatal("invalid allowance frame")
				}
				if bytes.Contains(output.Bytes(), []byte("fixture-")) || bytes.Contains(output.Bytes(), []byte("Bearer")) {
					t.Fatal("allowance RPC leaked provider text")
				}
				return frame
			}
			frame := invoke()
			result, ok := frame["result"].(map[string]any)
			if !ok || result["status"] != float64(status) || len(result["body"].(map[string]any)) != 0 || len(result) != 2 {
				t.Fatal("refusal projection changed")
			}
			if issuer.refreshes.Load() != 0 || len(requests()) != 1 {
				t.Fatal("provider refusal caused extra requests or refresh")
			}
			for _, mode := range []string{"binding", "execution"} {
				w.Use, w.ExecutionOnly = nil, false
				if mode == "binding" {
					w.Use = use
				} else {
					w.ExecutionOnly = true
				}
				if invoke()["error"] != string(ErrUnsupported) {
					t.Fatal("RPC admitted non-owner role")
				}
			}
			if len(requests()) != 1 {
				t.Fatal("refused RPC reached provider")
			}
			record, err := w.Repo.Lookup(context.Background(), w.Scope)
			if err != nil || record.Epoch != initial.Revision || record.State != "connected" {
				t.Fatal("allowance refusal mutated connection")
			}
		})
	}
}
